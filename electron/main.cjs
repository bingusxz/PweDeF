// PweDeF — Electron main process.
// Owns windows, native dialogs, file system access, and auto-update.
const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell, Menu, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

// Keep existing settings and recent files across the product rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Acrobatics'));

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

// Keep Electron's native surfaces in the app's light paper theme.
nativeTheme.themeSource = 'light';
const chrome = () => ({ color: '#f2e4cf', symbolColor: '#401e41', bg: '#e7d8bf' });

/** Keeps the window inside the usable screen area (not under the taskbar or off the bottom of a small display). */
function fitToScreen() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  if (x !== b.x || y !== b.y || width !== b.width || height !== b.height) win.setBounds({ x, y, width, height });
}

function createWindow() {
  // size to the screen: a 1366x768 laptop has under 730px of usable height
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1400, wa.width),
    height: Math.min(900, wa.height),
    minWidth: Math.min(900, wa.width),
    minHeight: Math.min(600, wa.height),
    backgroundColor: chrome().bg,
    title: 'PweDeF',
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome().color, symbolColor: chrome().symbolColor, height: 40 },
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

  win.once('ready-to-show', fitToScreen);
  win.on('restore', fitToScreen);
  win.on('unmaximize', fitToScreen);
  win.on('show', fitToScreen);

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

// ---------- installed fonts (so edited text keeps the PDF's own typeface) ----------
// Windows lists fonts in the registry: "Tahoma Bold (TrueType)" -> tahomabd.ttf
let fontIndex = null;
const installedFaces = new Map();
const normFont = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function buildFontIndex() {
  if (fontIndex) return fontIndex;
  fontIndex = new Map();
  if (process.platform !== 'win32') return fontIndex;
  const { execFileSync } = require('node:child_process');
  const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const userFonts = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts');
  for (const hive of ['HKLM', 'HKCU']) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts`], {
        windowsHide: true,
        encoding: 'utf8',
      });
    } catch {
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/);
      if (!m) continue;
      const name = m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, '');
      let file = m[2];
      if (!/\.(ttf|otf)$/i.test(file)) continue; // .ttc collections / bitmap fonts aren't embeddable here
      if (!path.isAbsolute(file)) file = path.join(hive === 'HKCU' ? userFonts : winFonts, file);
      const bold = /\bbold\b/i.test(name);
      const italic = /\b(italic|oblique)\b/i.test(name);
      const family = name.replace(/\b(regular|bold|italic|oblique)\b/gi, '').replace(/\s+/g, ' ').trim();
      const key = normFont(family) + (bold ? '|b' : '') + (italic ? '|i' : '');
      const face = { family, bold, italic, file };
      if (!fontIndex.has(key)) fontIndex.set(key, face);
      installedFaces.set(normFont(name), face);
    }
  }
  return fontIndex;
}

/** Map a PDF font name like "ABCDEF+Tahoma-Bold" or "TimesNewRomanPS-BoldItalicMT" to an installed font. */
let fontAliases;
async function readFontAliases(index) {
  const aliases = new Map();
  const fontkit = require('@pdf-lib/fontkit');
  for (const face of index.values()) {
    try {
      const font = fontkit.create(await fs.readFile(face.file));
      for (const name of [font.postscriptName, font.fullName]) {
        if (name) aliases.set(normFont(name), face);
      }
    } catch {
      // Some registry entries point to removed or unsupported files.
    }
  }
  return aliases;
}

async function matchPdfFont(pdfName) {
  const idx = buildFontIndex();
  const name = String(pdfName || '').replace(/^[A-Z]{6}\+/i, '');
  // Word can emit ArialNarrow-Bold, Arial-BoldMT, or TimesNewRomanPSMT.
  // Keep width and weight variants in the family when Windows lists that face.
  const normalized = normFont(name).replace(/(?:ps)?mt$/, '');
  const face = installedFaces.get(normalized) ||
    installedFaces.get(normalized.replace(/ps(?=bold|italic|regular|$)/, ''));
  if (face) return { ...face, exact: true };
  const bold = /bold|black|heavy|demi/i.test(name);
  const italic = /italic|oblique/i.test(name);
  const famKey = normalized.replace(/(?:bold|italic|oblique|regular)+$/, '')
    .replace(/ps$/, '');
  const pick = (b, i) => idx.get(famKey + (b ? '|b' : '') + (i ? '|i' : ''));
  let hit = pick(bold, italic);
  if (!hit) {
    fontAliases ??= readFontAliases(idx);
    const alias = (await fontAliases).get(normFont(name));
    if (alias) return { ...alias, exact: true };
    hit = pick(bold, false) || pick(false, false);
  }
  return hit ? { family: hit.family, bold, italic, file: hit.file, exact: hit.bold === bold && hit.italic === italic } : null;
}

ipcMain.handle('fonts:match', (_e, pdfName) => matchPdfFont(pdfName));
// every installed family that has a regular style, for the font menu
ipcMain.handle('fonts:list', () => {
  const fams = new Set();
  for (const v of buildFontIndex().values()) if (!v.bold && !v.italic && v.family) fams.add(v.family);
  return [...fams].sort((a, b) => a.localeCompare(b));
});
ipcMain.handle('fonts:load', async (_e, { family, bold, italic }) => {
  const idx = buildFontIndex();
  const k = normFont(family);
  const hit = idx.get(k + (bold ? '|b' : '') + (italic ? '|i' : '')) || idx.get(k + (bold ? '|b' : '')) || idx.get(k);
  if (!hit) return null;
  try {
    return { data: new Uint8Array(await fs.readFile(hit.file)), exact: hit.bold === !!bold && hit.italic === !!italic };
  } catch {
    return null;
  }
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
  autoUpdater.on('download-progress', (p) => win && win.webContents.send('update:progress', Math.round(p.percent)));
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
