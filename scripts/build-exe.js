// Builds dist/Pulse.exe — a self-contained single executable (Node SEA).
// Steps: bundle server → generate icon → copy node.exe → set icon/metadata → inject app blob.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const exePath = path.join(dist, 'Pulse.exe');
const run = cmd => execSync(cmd, { cwd: root, stdio: 'inherit' });

fs.mkdirSync(dist, { recursive: true });

console.log('[1/5] Bundling server with esbuild…');
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'server.js')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  outfile: path.join(dist, 'bundle.js'),
  external: ['osx-temperature-sensor'],
  logLevel: 'warning',
});

console.log('[2/5] Generating icon…');
run('node scripts/make-icon.js > nul');

console.log('[3/5] Preparing SEA blob and copying node.exe…');
run('node --experimental-sea-config sea-config.json');
fs.copyFileSync(process.execPath, exePath);

console.log('[4/5] Setting icon and version info…');
(async () => {
  try {
    const { rcedit } = await import('rcedit');
    await rcedit(exePath, {
      icon: path.join(dist, 'pulse.ico'),
      'version-string': {
        ProductName: 'Pulse',
        FileDescription: 'Pulse — PC health dashboard & task manager',
        CompanyName: 'Trevor',
        LegalCopyright: 'MIT',
      },
      'file-version': '2.0.0',
      'product-version': '2.0.0',
    });
  } catch (err) {
    console.warn('    icon/metadata skipped:', err.message);
  }

  console.log('[5/5] Injecting app into the executable…');
  run(`npx postject "${exePath}" NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`);

  const mb = (fs.statSync(exePath).size / 1e6).toFixed(0);
  console.log(`\nDone → ${exePath} (${mb} MB)`);
})();
