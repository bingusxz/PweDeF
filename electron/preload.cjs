// Narrow, typed bridge between the UI and the main process. No raw Node access in the UI.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, cb) {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('acro', {
  openPdfs: (opts) => ipcRenderer.invoke('dialog:openPdfs', opts),
  readPdf: (p) => ipcRenderer.invoke('fs:readPdf', p),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  saveFile: (defaultName, data, filters) => ipcRenderer.invoke('dialog:saveFile', { defaultName, data, filters }),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  writeFile: (filePath, data) => ipcRenderer.invoke('fs:writeFile', { filePath, data }),
  printPages: (pages) => ipcRenderer.invoke('print:pages', pages),
  writeInFolder: (folder, name, data) => ipcRenderer.invoke('fs:writeInFolder', { folder, name, data }),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  version: () => ipcRenderer.invoke('app:version'),
  ready: () => ipcRenderer.invoke('app:ready'),
  confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
  openDefaultApps: () => ipcRenderer.invoke('app:defaultApps'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  checkUpdates: () => ipcRenderer.invoke('app:checkUpdates'),
  matchFont: (pdfName) => ipcRenderer.invoke('fonts:match', pdfName),
  loadFont: (q) => ipcRenderer.invoke('fonts:load', q),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  convertCaps: () => ipcRenderer.invoke('convert:caps'),
  officeToPdf: (kind) => ipcRenderer.invoke('convert:officeToPdf', kind),
  webToPdf: (url, landscape) => ipcRenderer.invoke('convert:webToPdf', { url, landscape }),
  pickHtmlToPdf: () => ipcRenderer.invoke('convert:pickHtmlToPdf'),
  htmlToPdf: (html, name) => ipcRenderer.invoke('convert:htmlToPdf', { html, name }),
  onOpenFiles: (cb) => on('files:open', cb),
  onBeforeClose: (cb) => on('app:before-close', cb),
  onUpdateAvailable: (cb) => on('update:available', cb),
  onUpdateReady: (cb) => on('update:ready', cb),
  onUpdateProgress: (cb) => on('update:progress', cb),
});
