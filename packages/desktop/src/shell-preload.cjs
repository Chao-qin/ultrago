const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopShell', {
  action: (name, input) => ipcRenderer.invoke('desktop:shell', name, input),
  subscribe: (callback) => {
    const state = (_event, value) => callback(value);
    const collapse = () => callback({ collapse: true });
    ipcRenderer.on('shell:state', state);
    ipcRenderer.on('shell:collapse', collapse);
    return () => { ipcRenderer.removeListener('shell:state', state); ipcRenderer.removeListener('shell:collapse', collapse); };
  },
});
