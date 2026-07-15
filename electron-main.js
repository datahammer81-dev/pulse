// Pulse desktop app — hosts the dashboard server in-process and shows it in its own window.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const URL = 'http://localhost:7377';

// One app instance; a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  require('./server.js'); // starts listening on 7377 (reuses an existing Pulse if one is running)

  let win = null;
  const createWindow = () => {
    win = new BrowserWindow({
      width: 1500,
      height: 980,
      minWidth: 700,
      minHeight: 500,
      backgroundColor: '#0d0d0d',
      autoHideMenuBar: true,
      // Packaged builds inherit the exe's own icon; dev runs need the file.
      ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'dist', 'pulse.ico') }),
      title: 'Pulse',
    });
    // The server binds in the same tick, but give it a beat and retry if we raced it.
    win.webContents.on('did-fail-load', () => setTimeout(() => win.loadURL(URL), 500));
    win.loadURL(URL);
  };

  app.whenReady().then(createWindow);
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
}
