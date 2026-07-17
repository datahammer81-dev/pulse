// Bridge between the overlay page and the Electron main process:
// drag-to-move, content config, size-to-fit, and the right-click menu.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulseOverlay', {
  dragStart: () => ipcRenderer.send('overlay-drag-start'),
  dragEnd: () => ipcRenderer.send('overlay-drag-end'),
  resize: height => ipcRenderer.send('overlay-resize', height),
  menu: () => ipcRenderer.send('overlay-menu'),
  onConfig: cb => ipcRenderer.on('overlay-config', (e, cfg) => cb(cfg)),
});
