const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  close: () => ipcRenderer.send('overlay-close'),
  onScrollDown: (callback) => ipcRenderer.on('scroll-down', callback)
});
