// Pulse desktop app — hosts the dashboard server in-process, lives in the system
// tray, and can show a mini always-on-top overlay pinned to the bottom-right.
const { app, BrowserWindow, Tray, Menu, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PULSE_PORT) || 7377;
const URL = `http://localhost:${PORT}`;
const iconPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'pulse.ico')
  : path.join(__dirname, 'dist', 'pulse.ico');

// Persisted UI prefs (overlay on/off) next to the app's data.
const prefsFile = path.join(app.getPath('userData'), 'prefs.json');
function loadPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { return {}; } }
function savePrefs(p) { try { fs.writeFileSync(prefsFile, JSON.stringify(p)); } catch {} }
let prefs = loadPrefs();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  require('./server.js'); // binds PORT (reuses an existing Pulse if one is already running)

  let win = null, overlay = null, tray = null;
  app.isQuitting = false;

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1500, height: 980, minWidth: 700, minHeight: 500,
      backgroundColor: '#0a0a0c', autoHideMenuBar: true,
      ...(app.isPackaged ? {} : { icon: iconPath() }),
      title: 'Pulse',
    });
    win.webContents.on('did-fail-load', () => setTimeout(() => win.loadURL(URL), 500));
    win.loadURL(URL);
    // Close button hides to tray instead of quitting; quit only from the tray menu.
    win.on('close', e => {
      if (!app.isQuitting) { e.preventDefault(); win.hide(); }
    });
  };

  const showWindow = () => {
    if (!win) createWindow();
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  };

  const positionOverlay = () => {
    if (!overlay) return;
    const wa = screen.getPrimaryDisplay().workArea; // excludes the taskbar
    const [w, h] = overlay.getSize();
    overlay.setPosition(wa.x + wa.width - w - 12, wa.y + wa.height - h - 12);
  };

  const createOverlay = () => {
    if (overlay) { overlay.show(); return; }
    overlay = new BrowserWindow({
      width: 208, height: 132,
      frame: false, transparent: true, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
      show: false, backgroundColor: '#00000000',
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.loadURL(URL + '/overlay.html');
    overlay.webContents.on('did-fail-load', () => setTimeout(() => overlay && overlay.loadURL(URL + '/overlay.html'), 500));
    overlay.once('ready-to-show', () => { positionOverlay(); overlay.showInactive(); });
    overlay.on('closed', () => { overlay = null; });
  };

  const destroyOverlay = () => { if (overlay) { overlay.close(); overlay = null; } };

  // Overlay defaults ON (the user asked for the widget); toggle it off from the tray.
  const overlayEnabled = () => prefs.overlay !== false;
  const setOverlay = on => {
    prefs.overlay = on;
    savePrefs(prefs);
    if (on) createOverlay(); else destroyOverlay();
    buildTrayMenu();
  };

  function buildTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Pulse', click: showWindow },
      { label: 'Mini overlay', type: 'checkbox', checked: overlayEnabled(), click: m => setOverlay(m.checked) },
      { type: 'separator' },
      { label: 'Quit Pulse', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  }

  const createTray = () => {
    let img = nativeImage.createFromPath(iconPath());
    if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('Pulse — PC health monitor');
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    buildTrayMenu();
  };

  app.whenReady().then(() => {
    createWindow();
    createTray();
    if (overlayEnabled()) createOverlay();
  });

  app.on('second-instance', showWindow);
  screen.on && app.whenReady().then(() => screen.on('display-metrics-changed', positionOverlay));
  // Staying resident in the tray is the whole point — don't quit when windows close.
  app.on('window-all-closed', () => {});
}
