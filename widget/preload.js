const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  close: () => ipcRenderer.send('widget:close'),
  openApp: (target) => ipcRenderer.send('widget:open-app', target),
  getApps: () => ipcRenderer.invoke('widget:get-apps'),
  getBounds: () => ipcRenderer.invoke('widget:get-bounds'),
  setBounds: (b) => ipcRenderer.send('widget:set-bounds', b),
});
