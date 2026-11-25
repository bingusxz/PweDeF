// Acrobatics — Electron main process.
// Owns windows, native dialogs, file system access, and auto-update.
const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');

// Serve the built UI from a privileged custom scheme (safer + works with module workers).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
const pendingFiles = [];

function pdfArgs(argv) {
  return argv.filter((a) => /\.pdf$/i.test(a) && !a.startsWith('--'));
}

async function readPdf(p) {
  const data = await fs.readFile(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(data) };
}

let rendererReady = false;

async function sendOpenFiles(paths) {
  if (!win || !rendererReady) {
    pendingFiles.push(...paths);
    return;
  }
  for (const p of paths) {
    try {
      win.webContents.send('files:open', [await readPdf(p)]);
    } catch (e) {
      console.error('open failed', p, e);
    }
  }
}

const CSP = [
  "default-src 'self' app: blob: data:",
  "script-src 'self' app: blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' app: blob:",
  "connect-src 'self' app: blob: data: https://cdn.jsdelivr.net https://tessdata.projectnaptha.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' app: blob: data:",
  "font-src 'self' app: data:",
].join('; ');

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f24',
    title: 'Acrobatics',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });

  win.on('close', (e) => {
    if (win.__allowClose) return;
    e.preventDefault();
    win.webContents.send('app:before-close');
  });

  win.webContents.on('did-start-loading', () => (rendererReady = false));

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://local/index.html');
}

// ---------- IPC ----------
ipcMain.handle('dialog:openPdfs', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title || 'Open PDF',
    properties: ['openFile', ...(opts.multi === false ? [] : ['multiSelections'])],
    filters: opts.filters || [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled) return [];
  return Promise.all(res.filePaths.map(readPdf));
});

ipcMain.handle('fs:readPdf', async (_e, p) => {
  if (typeof p !== 'string' || !/\.pdf$/i.test(p)) throw new Error('Not a PDF path');
  return readPdf(p);
});

ipcMain.handle('dialog:saveFile', async (_e, { defaultName, data, filters }) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: filters || [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});

ipcMain.handle('dialog:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('fs:writeFile', async (_e, { filePath, data }) => {
  await fs.writeFile(filePath, Buffer.from(data));
  return filePath;
});

ipcMain.handle('fs:writeInFolder', async (_e, { folder, name, data }) => {
  const safe = name.replace(/[<>:"/\\|?*]+/g, '_');
  const target = path.join(folder, safe);
  await fs.writeFile(target, Buffer.from(data));
  return target;
});

// ---------- conversions ----------
const conv = require('./convert.cjs');
const OFFICE_FILTERS = {
  word: { name: 'Word documents', extensions: ['doc', 'docx', 'docm', 'rtf', 'odt', 'txt'] },
  excel: { name: 'Excel workbooks', extensions: ['xls', 'xlsx', 'xlsm', 'csv', 'ods'] },
  ppt: { name: 'PowerPoint presentations', extensions: ['ppt', 'pptx', 'pps', 'ppsx', 'odp'] },
};
ipcMain.handle('convert:caps', () => conv.capabilities());
ipcMain.handle('convert:officeToPdf', async (_e, kind) => {
  const filters = kind && OFFICE_FILTERS[kind] ? [OFFICE_FILTERS[kind]] : Object.values(OFFICE_FILTERS);
  const res = await dialog.showOpenDialog(win, { title: 'Choose files to convert to PDF', properties: ['openFile', 'multiSelections'], filters });
  if (res.canceled) return [];
  const out = [];
  for (const p of res.filePaths) {
    const name = path.basename(p).replace(/\.[^.]+$/, '') + '.pdf';
    try {
      out.push({ name, data: await conv.officeToPdf(p) });
    } catch (e) {
      out.push({ name, error: e.message });
    }
  }
  return out;
});
ipcMain.handle('convert:webToPdf', (_e, { url, landscape }) => conv.webToPdf(String(url).trim(), { landscape }));
ipcMain.handle('convert:pickHtmlToPdf', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Web pages', extensions: ['html', 'htm', 'mhtml', 'svg'] }] });
  if (res.canceled) return null;
  return conv.webToPdf(res.filePaths[0]);
});
ipcMain.handle('convert:htmlToPdf', (_e, { html, name }) => conv.htmlToPdf(String(html), String(name)));

// The UI calls this once its listeners are attached; returns files queued at startup.
ipcMain.handle('app:ready', async () => {
  rendererReady = true;
  const files = pendingFiles.splice(0);
  const out = [];
  for (const p of files) {
    try {
      out.push(await readPdf(p));
    } catch (e) {
      console.error('open failed', p, e);
    }
  }
  return out;
});

ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:confirmClose', () => {
  if (win) {
    win.__allowClose = true;
    win.close();
  }
});
ipcMain.handle('app:installUpdate', () => {
  try {
    require('electron-updater').autoUpdater.quitAndInstall();
  } catch (e) {
    console.error(e);
  }
});

// ---------- Auto update (GitHub Releases) ----------
// Every push to main publishes a new release (see .github/workflows/release.yml).
// Installed copies check on launch + hourly, download in the background, and
// install on restart (the UI shows a "Restart to update" button).
let updaterRef = null;
function setupAutoUpdate() {
  if (DEV_URL || !app.isPackaged) return;
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => win && win.webContents.send('update:available', info.version));
  autoUpdater.on('update-downloaded', (info) => win && win.webContents.send('update:ready', info.version));
  autoUpdater.on('error', (err) => console.error('updater', err));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 1000 * 60 * 60);
  updaterRef = autoUpdater;
}

// "Check for updates" button on the home screen
ipcMain.handle('app:checkUpdates', async () => {
  if (!updaterRef) return { status: 'dev', message: 'Updates only work in the installed app' };
  try {
    const res = await updaterRef.checkForUpdates();
    const latest = res?.updateInfo?.version;
    if (latest && latest !== app.getVersion()) return { status: 'downloading', message: `Downloading v${latest}…` };
    return { status: 'latest', message: `You're on the latest version (v${app.getVersion()})` };
  } catch (e) {
    return { status: 'error', message: 'Could not check for updates: ' + (e?.message || e) };
  }
});

// ---------- Lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    sendOpenFiles(pdfArgs(argv));
  });

  app.whenReady().then(() => {
    protocol.handle('app', async (req) => {
      const { pathname } = new URL(req.url);
      const filePath = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (!filePath.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
      const res = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    });

    Menu.setApplicationMenu(null);
    pendingFiles.push(...pdfArgs(process.argv.slice(1)));
    createWindow();
    setupAutoUpdate();
  });

  app.on('window-all-closed', () => app.quit());
}
