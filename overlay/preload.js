const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  close: () => ipcRenderer.send('overlay-close'),
  onScrollDown: (callback) => ipcRenderer.on('scroll-down', callback),
  onScrollUp: (callback) => ipcRenderer.on('scroll-up', callback),
  onTriggerCapture: (callback) => ipcRenderer.on('trigger-capture', callback)
});
