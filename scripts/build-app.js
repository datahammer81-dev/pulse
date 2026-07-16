// Packages the Electron desktop app → dist/app/Pulse-win32-x64/Pulse.exe
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const packagerModule = require('@electron/packager');
const pack = packagerModule.packager || packagerModule;

const root = path.join(__dirname, '..');

(async () => {
  console.log('[1/2] Generating icon…');
  execSync('node scripts/make-icon.js > nul', { cwd: root, stdio: 'inherit' });

  console.log('[2/2] Packaging Electron app…');
  const paths = await pack({
    dir: root,
    name: 'Pulse',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist', 'app'),
    overwrite: true,
    icon: path.join(root, 'dist', 'pulse.ico'),
    prune: true,
    // Ship only what the app needs: server, electron-main, UI, prod deps.
    ignore: [
      /^\/dist($|\/)/,
      /^\/scripts($|\/)/,
      /^\/sea-config\.json$/,
      /^\/README\.md$/,
      /^\/pulse\.log$/,
    ],
    win32metadata: {
      ProductName: 'Pulse',
      FileDescription: 'Pulse — PC health dashboard & task manager',
      CompanyName: 'Trevor',
    },
  });
  // Bundle the sensor engine + tray icon next to the app's resources (same spots the installer uses).
  const res = path.join(paths[0], 'resources');
  const helper = path.join(root, 'dist', 'sensors', 'PulseSensors.exe');
  if (fs.existsSync(helper)) {
    fs.mkdirSync(path.join(res, 'sensors'), { recursive: true });
    fs.copyFileSync(helper, path.join(res, 'sensors', 'PulseSensors.exe'));
    console.log('    bundled sensor engine');
  } else {
    console.warn('    dist/sensors/PulseSensors.exe missing — run `npm run build:sensors` first');
  }
  const ico = path.join(root, 'dist', 'pulse.ico');
  if (fs.existsSync(ico)) fs.copyFileSync(ico, path.join(res, 'pulse.ico'));

  console.log('\nDone →', path.join(paths[0], 'Pulse.exe'));
})().catch(err => { console.error(err); process.exit(1); });
