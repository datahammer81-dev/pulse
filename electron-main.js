// Pulse desktop app — hosts the dashboard server in-process, lives in the system
// tray, and shows a mini always-on-top overlay that is draggable, click-through
// capable, and fully configurable (items + appearance live in the server's
// overlay config, shared with the app's Overlay tab).
const { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PULSE_PORT) || 7377;
const URL = `http://localhost:${PORT}`;
const iconPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'pulse.ico')
  : path.join(__dirname, 'dist', 'pulse.ico');

// Electron-side prefs (overlay on/off, its position, click-through) in userData.
// Item/appearance config lives server-side so the web UI can edit it too.
const prefsFile = path.join(app.getPath('userData'), 'prefs.json');
function loadPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { return {}; } }
function savePrefs(p) { try { fs.writeFileSync(prefsFile, JSON.stringify(p)); } catch {} }
let prefs = loadPrefs();

const METRIC_LABELS = {
  cpu: 'CPU', gpu: 'GPU', mem: 'RAM', net: 'Network', vram: 'VRAM', gpupower: 'GPU power',
  pagefile: 'Page file', uptime: 'Uptime', health: 'Health score', topproc: 'Top process',
  'peak-gputemp': 'Peak GPU temp', 'peak-cputemp': 'Peak CPU temp', alerts: 'Alert banner',
};

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
  const openOverlaySettings = () => {
    showWindow();
    if (win) win.webContents.executeJavaScript(`location.hash = '#/overlay'`).catch(() => {});
  };

  // ----- overlay placement: saved spot (clamped on-screen) or bottom-right default -----
  const clampToDisplay = (x, y, w, h) => {
    const wa = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) }).workArea;
    return {
      x: Math.min(Math.max(x, wa.x), wa.x + wa.width - w),
      y: Math.min(Math.max(y, wa.y), wa.y + wa.height - h),
    };
  };
  const placeOverlay = () => {
    if (!overlay) return;
    const [w, h] = overlay.getSize();
    if (prefs.overlayPos) {
      const p = clampToDisplay(prefs.overlayPos.x, prefs.overlayPos.y, w, h);
      overlay.setPosition(p.x, p.y);
    } else {
      const wa = screen.getPrimaryDisplay().workArea; // excludes the taskbar
      overlay.setPosition(wa.x + wa.width - w - 12, wa.y + wa.height - h - 12);
    }
  };

  const clickThrough = () => prefs.clickThrough === true;
  const applyClickThrough = () => { if (overlay) overlay.setIgnoreMouseEvents(clickThrough()); };

  const createOverlay = () => {
    if (overlay) { overlay.show(); return; }
    overlay = new BrowserWindow({
      width: 208, height: 150,
      frame: false, transparent: true, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
      show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.js') },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    applyClickThrough();
    overlay.loadURL(URL + '/overlay.html');
    overlay.webContents.on('did-fail-load', () => setTimeout(() => overlay && overlay.loadURL(URL + '/overlay.html'), 500));
    overlay.once('ready-to-show', () => { placeOverlay(); overlay.showInactive(); });
    overlay.on('closed', () => { overlay = null; });
  };

  const destroyOverlay = () => { if (overlay) { overlay.close(); overlay = null; } };

  // Overlay defaults ON; toggle from the tray.
  const overlayEnabled = () => prefs.overlay !== false;
  const setOverlay = on => {
    prefs.overlay = on;
    savePrefs(prefs);
    if (on) createOverlay(); else destroyOverlay();
    buildTrayMenu();
  };

  // ----- drag-to-move: main follows the cursor while the mouse is down -----
  let dragTimer = null;
  const endDrag = save => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    if (save && overlay) {
      const [x, y] = overlay.getPosition();
      prefs.overlayPos = { x, y };
      savePrefs(prefs);
    }
  };
  ipcMain.on('overlay-drag-start', e => {
    if (!overlay || e.sender !== overlay.webContents) return;
    const c0 = screen.getCursorScreenPoint();
    const [wx, wy] = overlay.getPosition();
    const offX = c0.x - wx, offY = c0.y - wy;
    endDrag(false);
    dragTimer = setInterval(() => {
      if (!overlay) return endDrag(false);
      const c = screen.getCursorScreenPoint();
      overlay.setPosition(c.x - offX, c.y - offY);
    }, 16);
  });
  ipcMain.on('overlay-drag-end', e => {
    if (overlay && e.sender !== overlay.webContents) return;
    endDrag(true);
  });

  // The page reports its content size ({w,h} — or a bare height from older pages).
  ipcMain.on('overlay-resize', (e, dims) => {
    if (!overlay || e.sender !== overlay.webContents) return;
    const rawW = dims && typeof dims === 'object' ? dims.w : null;
    const rawH = dims && typeof dims === 'object' ? dims.h : dims;
    const width = Math.max(120, Math.min(920, Math.round(Number(rawW) || overlay.getBounds().width)));
    const height = Math.max(40, Math.min(520, Math.round(Number(rawH) || 0)));
    if (!height) return;
    const b = overlay.getBounds();
    if (b.width === width && b.height === height) return;
    overlay.setBounds({ ...b, width, height });
    placeOverlay(); // re-anchor (default) or clamp (custom spot)
  });

  // Right-click menu: item toggles come from the server's overlay config.
  ipcMain.on('overlay-menu', async e => {
    if (!overlay || e.sender !== overlay.webContents) return;
    let cfg = null;
    try { cfg = await (await fetch(URL + '/api/overlay')).json(); } catch {}
    const post = body => fetch(URL + '/api/overlay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
    const itemToggles = (cfg ? cfg.items : []).map(it => ({
      label: it.kind === 'sensor' ? (it.label || it.sensor.split('|').pop()) : (METRIC_LABELS[it.metric] || it.metric),
      type: 'checkbox', checked: it.on !== false,
      click: m => { it.on = m.checked; post(cfg); },
    }));
    Menu.buildFromTemplate([
      { label: 'Overlay items', enabled: false },
      ...itemToggles,
      { type: 'separator' },
      ...(cfg ? [{ label: 'Compact strip', type: 'checkbox', checked: !!cfg.appearance.compact, click: m => { cfg.appearance.compact = m.checked; post(cfg); } }] : []),
      { label: 'Edit in Pulse…', click: openOverlaySettings },
      { type: 'separator' },
      { label: 'Reset position', click: () => { delete prefs.overlayPos; savePrefs(prefs); placeOverlay(); } },
      { label: 'Hide overlay', click: () => setOverlay(false) },
    ]).popup();
  });

  function buildTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Pulse', click: showWindow },
      { type: 'separator' },
      { label: 'Mini overlay', type: 'checkbox', checked: overlayEnabled(), click: m => setOverlay(m.checked) },
      { label: 'Overlay settings…', click: openOverlaySettings },
      { label: 'Click-through overlay', type: 'checkbox', checked: clickThrough(),
        click: m => { prefs.clickThrough = m.checked; savePrefs(prefs); applyClickThrough(); } },
      { label: 'Reset overlay position', click: () => { delete prefs.overlayPos; savePrefs(prefs); placeOverlay(); } },
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
    screen.on('display-metrics-changed', placeOverlay);
  });

  app.on('second-instance', showWindow);
  // Staying resident in the tray is the whole point — don't quit when windows close.
  app.on('window-all-closed', () => {});
}
