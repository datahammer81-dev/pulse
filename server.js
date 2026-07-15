// Pulse — local PC health dashboard. Serves the UI, keeps 30-minute stat history,
// and streams live updates over SSE.
const express = require('express');
const path = require('path');
const { execFile, exec } = require('child_process');
const si = require('systeminformation');

// When packaged as a single .exe (node:sea), the UI is embedded as an asset.
let sea = null;
try { sea = require('node:sea'); } catch {}
const isExe = !!(sea && sea.isSea && sea.isSea());

// Errors must never vanish with the console window — log somewhere writable and keep serving.
// SEA exe: next to the exe. Electron (app folder may be read-only): %LOCALAPPDATA%\Pulse. Dev: project root.
const fs = require('fs');
const LOG_DIR = isExe ? path.dirname(process.execPath)
  : (process.versions.electron && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Pulse') : __dirname);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG = path.join(LOG_DIR, 'pulse.log');
const logErr = (tag, err) => {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || err}\n`); } catch {}
};
process.on('uncaughtException', err => logErr('uncaughtException', err));
process.on('unhandledRejection', err => logErr('unhandledRejection', err));

const PORT = 7377;
const app = express();
app.use(express.json());
if (isExe) {
  const html = Buffer.from(sea.getAsset('index.html'));
  app.get('/', (req, res) => res.type('html').send(html));
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

const openBrowser = () => {
  if (isExe && !process.env.PULSE_NO_OPEN) exec(`start "" http://localhost:${PORT}`);
};

function psQuery(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 20000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(stdout.trim() || null); }
      });
  });
}

// nvidia-smi CSV query → object array (one per GPU). null if no NVIDIA GPU/driver.
function nvidiaQuery(fields) {
  return new Promise((resolve) => {
    execFile('nvidia-smi', [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits'],
      { timeout: 10000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(null);
        resolve(stdout.trim().split('\n').map(line => {
          const vals = line.split(', ');
          const o = {};
          fields.forEach((f, i) => {
            const v = (vals[i] || '').trim();
            o[f] = v === '' || v.startsWith('[') ? null : (isNaN(Number(v)) ? v : Number(v));
          });
          return o;
        }));
      });
  });
}

let elevated = null;
psQuery(`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`)
  .then(r => { elevated = String(r).trim() === 'True'; });

// ---------- always-on stat collector with 30-minute history ----------
const TICK_MS = 2000, HIST_LEN = 900;        // 30 min of 2s samples
const PROC_MS = 5000, PROC_HIST_LEN = 360;   // 30 min of 5s samples

const hist = { t: [], cpu: [], mem: [], rx: [], tx: [], gpuUtil: [], gpuTemp: [], gpuVram: [] };
function pushHist(p) {
  for (const k of Object.keys(hist)) {
    hist[k].push(p[k] ?? null);
    if (hist[k].length > HIST_LEN) hist[k].shift();
  }
}

const latest = { fast: null, gpu: null, disks: null };
const sseClients = new Set();
function broadcast(event, data) {
  for (const send of sseClients) send(event, data);
}

const GPU_LIVE_FIELDS = ['name', 'utilization.gpu', 'memory.used', 'memory.total', 'temperature.gpu', 'fan.speed', 'power.draw', 'clocks.sm'];

async function fastTick() {
  try {
    const [load, mem, net, temp, time] = await Promise.all([
      si.currentLoad(), si.mem(), si.networkStats(), si.cpuTemperature(), si.time(),
    ]);
    const activeNet = net.reduce((a, n) => ({ rx: a.rx + n.rx_sec, tx: a.tx + n.tx_sec }), { rx: 0, tx: 0 });
    const g = latest.gpu;
    latest.fast = {
      cpu: { avg: load.currentLoad, cores: load.cpus.map(c => c.load) },
      mem: { used: mem.active, total: mem.total, swapUsed: mem.swapused, swapTotal: mem.swaptotal },
      net: { rx: activeNet.rx, tx: activeNet.tx },
      temp: temp.main ?? lhmCpuTemp(),
      uptime: time.uptime,
    };
    pushHist({
      t: Date.now(),
      cpu: +load.currentLoad.toFixed(1),
      mem: +(mem.active / mem.total * 100).toFixed(1),
      rx: Math.round(activeNet.rx),
      tx: Math.round(activeNet.tx),
      gpuUtil: g ? g['utilization.gpu'] : null,
      gpuTemp: g ? g['temperature.gpu'] : null,
      gpuVram: g && g['memory.total'] ? +(g['memory.used'] / g['memory.total'] * 100).toFixed(1) : null,
    });
    broadcast('fast', latest.fast);
  } catch (err) {
    logErr('fastTick', err);
  }
}

async function gpuTick() {
  const g = await nvidiaQuery(GPU_LIVE_FIELDS);
  if (g && g[0]) {
    latest.gpu = g[0];
    broadcast('gpu', g[0]);
  }
}

async function diskTick() {
  try {
    const fsSizes = await si.fsSize();
    latest.disks = fsSizes.filter(d => d.size > 0).map(d => ({ mount: d.mount, size: d.size, used: d.used }));
    broadcast('disks', latest.disks);
  } catch (err) {
    logErr('diskTick', err);
  }
}

// Per-process history: track anything that shows up among the top CPU/memory users.
const procHist = new Map(); // pid → {name, lastSeen, t[], cpu[], mem[]}
let procCache = { all: 0, list: [] };

async function procTick() {
  try {
    const procs = await si.processes();
    const list = procs.list
      .filter(p => p.pid > 4)
      .sort((a, b) => b.cpu - a.cpu)
      .map(p => ({ pid: p.pid, name: p.name, cpu: p.cpu, memRss: p.memRss * 1024 }));
    procCache = { all: procs.all, list };

    const now = Date.now();
    const track = new Map();
    for (const p of list.slice(0, 15)) track.set(p.pid, p);
    for (const p of [...list].sort((a, b) => b.memRss - a.memRss).slice(0, 5)) track.set(p.pid, p);
    for (const p of track.values()) {
      let h = procHist.get(p.pid);
      if (!h) { h = { name: p.name, lastSeen: 0, t: [], cpu: [], mem: [] }; procHist.set(p.pid, h); }
      h.lastSeen = now;
      h.t.push(now); h.cpu.push(+p.cpu.toFixed(1)); h.mem.push(p.memRss);
      if (h.t.length > PROC_HIST_LEN) { h.t.shift(); h.cpu.shift(); h.mem.shift(); }
    }
    for (const [pid, h] of procHist) if (now - h.lastSeen > 600000) procHist.delete(pid);
  } catch (err) {
    logErr('procTick', err);
  }
}

// ---------- LibreHardwareMonitor bridge (optional deep sensors) ----------
// If LHM is running with its HTTP server enabled (default port 8085), Pulse
// picks up CPU temps, fan RPMs, voltages, power and board temps automatically.
const LHM_URL = 'http://127.0.0.1:8085/data.json';
let lhm = { available: false, sensors: [], at: 0 };
const sensorHist = new Map(); // id → {t[], v[]}
const SENSOR_HIST_LEN = 360;  // 30 min of 5s samples

function parseLhmValue(s) {
  if (typeof s !== 'string') return null;
  const m = s.replace(/,/g, '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function flattenLhm(node, path, out) {
  if (node.Children && node.Children.length) {
    for (const c of node.Children) flattenLhm(c, path.concat(node.Text), out);
  } else if (node.Value !== undefined && node.Value !== '') {
    // path: [root, machine, hardware, (subchip…), category]
    out.push({
      id: path.slice(2).concat(node.Text).join('|'),
      hw: path[2] || '',
      category: path[path.length - 1] || '',
      name: node.Text,
      value: parseLhmValue(node.Value),
      unit: (String(node.Value).match(/[^\d.,\s-][^\d]*$/) || [''])[0].trim(),
    });
  }
}

function lhmCpuTemp() {
  if (!lhm.available) return null;
  const pick = lhm.sensors.find(s => s.category === 'Temperatures' && /^(CPU Package|Core \(Tctl|CPU Core$)/.test(s.name))
    || lhm.sensors.find(s => s.category === 'Temperatures' && /cpu/i.test(s.hw));
  return pick && pick.value != null ? pick.value : null;
}

async function lhmTick() {
  try {
    const res = await fetch(LHM_URL, { signal: AbortSignal.timeout(2500) });
    const tree = await res.json();
    const out = [];
    flattenLhm(tree, [], out);
    const now = Date.now();
    lhm = { available: true, sensors: out, at: now };
    for (const s of out) {
      if (s.value == null) continue;
      let h = sensorHist.get(s.id);
      if (!h) { h = { t: [], v: [] }; sensorHist.set(s.id, h); }
      h.t.push(now); h.v.push(s.value);
      if (h.t.length > SENSOR_HIST_LEN) { h.t.shift(); h.v.shift(); }
    }
    broadcast('sensors', { available: true, sensors: out });
  } catch {
    if (lhm.available) broadcast('sensors', { available: false, sensors: [] });
    lhm = { available: false, sensors: [], at: Date.now() };
  }
}

// Poll every 5s while LHM answers; retry every 15s while it doesn't.
let lastLhmAttempt = 0;
setInterval(() => {
  const wait = lhm.available ? 5000 : 15000;
  if (Date.now() - lastLhmAttempt >= wait) { lastLhmAttempt = Date.now(); lhmTick(); }
}, 2500);
lhmTick();

app.get('/api/sensors', (req, res) => res.json(lhm));
app.get('/api/sensorhistory', (req, res) => {
  const h = sensorHist.get(String(req.query.id || ''));
  res.json(h ? { t: h.t, v: h.v } : { t: [], v: [] });
});

setInterval(fastTick, TICK_MS);
setInterval(gpuTick, 3000);
setInterval(diskTick, 30000);
setInterval(procTick, PROC_MS);
fastTick(); gpuTick(); diskTick(); procTick();

// ---------- live stream (SSE) ----------
app.get('/api/live', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();

  let closed = false;
  const send = (event, data) => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      closed = true;
      sseClients.delete(send);
      logErr('sse-write', err);
    }
  };
  sseClients.add(send);
  if (latest.fast) send('fast', latest.fast);
  if (latest.gpu) send('gpu', latest.gpu);
  if (latest.disks) send('disks', latest.disks);
  send('sensors', { available: lhm.available, sensors: lhm.sensors });

  const drop = () => { closed = true; sseClients.delete(send); };
  req.on('close', drop);
  req.on('error', drop);
  res.on('error', drop);
});

// ---------- history ----------
app.get('/api/history', (req, res) => {
  res.json({ tickMs: TICK_MS, ...hist });
});

app.get('/api/prochistory', (req, res) => {
  const ranked = [...procHist.entries()]
    .map(([pid, h]) => {
      const recent = h.cpu.slice(-24); // last ~2 minutes
      const score = recent.reduce((s, v) => s + v, 0) / Math.max(1, recent.length);
      return { pid, h, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  res.json({
    tickMs: PROC_MS,
    procs: ranked.map(({ pid, h }) => ({ pid, name: h.name, t: h.t, cpu: h.cpu, mem: h.mem })),
  });
});

// ---------- one-time system info ----------
app.get('/api/static', async (req, res) => {
  try {
    const [os, cpu, mem, graphics, system, diskLayout] = await Promise.all([
      si.osInfo(), si.cpu(), si.mem(), si.graphics(), si.system(), si.diskLayout(),
    ]);
    res.json({
      os: { distro: os.distro, release: os.release, build: os.build, arch: os.arch, hostname: os.hostname },
      cpu: { brand: cpu.brand, cores: cpu.cores, physicalCores: cpu.physicalCores, speedMax: cpu.speedMax },
      memTotal: mem.total,
      gpus: graphics.controllers.map(g => ({ model: g.model, vram: g.vram })),
      system: { manufacturer: system.manufacturer, model: system.model },
      disks: diskLayout.map(d => ({ name: d.name, size: d.size, type: d.type, interfaceType: d.interfaceType })),
      elevated,
      version: require('./package.json').version,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- drill-down detail endpoints ----------
app.get('/api/detail/cpu', async (req, res) => {
  try {
    const [cpu, load, temp, perf] = await Promise.all([
      si.cpu(), si.currentLoad(), si.cpuTemperature(),
      psQuery(`Get-Counter -Counter '\\Processor Information(*)\\% Processor Performance' | ForEach-Object { $_.CounterSamples } | Where-Object { $_.InstanceName -notmatch '_total' } | Select-Object InstanceName,CookedValue | ConvertTo-Json`),
    ]);
    // Effective clock = base clock × % processor performance (turbo pushes it past 100%).
    const perfList = perf ? [].concat(perf) : [];
    const coreClocks = perfList
      .map(p => ({ core: parseInt(String(p.InstanceName).split(',')[1] ?? p.InstanceName, 10), ghz: cpu.speed * p.CookedValue / 100 }))
      .filter(c => Number.isInteger(c.core))
      .sort((a, b) => a.core - b.core);
    res.json({
      brand: cpu.brand, vendor: cpu.vendor, family: cpu.family, model: cpu.model, stepping: cpu.stepping,
      baseGhz: cpu.speed, maxGhz: cpu.speedMax,
      physicalCores: cpu.physicalCores, threads: cpu.cores,
      cache: cpu.cache, virtualization: cpu.virtualization,
      socket: cpu.socket || null,
      loadAvg: load.currentLoad, loadUser: load.currentLoadUser, loadSystem: load.currentLoadSystem,
      coreLoads: load.cpus.map(c => c.load),
      coreClocks,
      tempC: temp.main ?? lhmCpuTemp(),
      tempSource: temp.main != null ? 'windows' : (lhmCpuTemp() != null ? 'lhm' : null),
      elevated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/detail/gpu', async (req, res) => {
  const g = await nvidiaQuery([
    'name', 'driver_version', 'vbios_version', 'pstate',
    'utilization.gpu', 'utilization.memory',
    'memory.used', 'memory.total', 'memory.reserved',
    'temperature.gpu', 'fan.speed',
    'power.draw', 'power.limit',
    'clocks.sm', 'clocks.mem', 'clocks.max.sm', 'clocks.max.mem',
    'pcie.link.gen.current', 'pcie.link.gen.max', 'pcie.link.width.current',
  ]);
  if (!g) {
    const graphics = await si.graphics().catch(() => null);
    return res.json({ nvidia: false, controllers: graphics ? graphics.controllers : [] });
  }
  res.json({ nvidia: true, ...g[0] });
});

app.get('/api/detail/memory', async (req, res) => {
  try {
    const [mem, layout] = await Promise.all([si.mem(), si.memLayout()]);
    res.json({
      total: mem.total, used: mem.active, free: mem.available, cached: mem.cached,
      swapTotal: mem.swaptotal, swapUsed: mem.swapused,
      modules: layout.map(m => ({
        size: m.size, type: m.type, clock: m.clockSpeed, bank: m.bank,
        manufacturer: m.manufacturer, partNum: m.partNum, voltage: m.voltageConfigured,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/detail/storage', async (req, res) => {
  try {
    const [layout, fsSizes, reliability] = await Promise.all([
      si.diskLayout(), si.fsSize(),
      psQuery(`try { Get-PhysicalDisk | ForEach-Object { $r = $_ | Get-StorageReliabilityCounter -ErrorAction Stop; [PSCustomObject]@{ Name = $_.FriendlyName; Health = $_.HealthStatus; TempC = $r.Temperature; Wear = $r.Wear; PowerOnHours = $r.PowerOnHours; ReadErrors = $r.ReadErrorsTotal; WriteErrors = $r.WriteErrorsTotal } } | ConvertTo-Json } catch { '"ACCESS_DENIED"' }`),
    ]);
    const rel = reliability === 'ACCESS_DENIED' || !reliability ? null : [].concat(reliability);
    res.json({
      disks: layout.map(d => {
        const r = rel && rel.find(x => x.Name === d.name);
        return {
          name: d.name, type: d.type, interfaceType: d.interfaceType, size: d.size,
          vendor: d.vendor || null, firmware: d.firmwareRevision || null, smartStatus: d.smartStatus,
          tempC: r ? r.TempC : null, wearPct: r ? r.Wear : null, powerOnHours: r ? r.PowerOnHours : null,
          readErrors: r ? r.ReadErrors : null, writeErrors: r ? r.WriteErrors : null,
        };
      }),
      volumes: fsSizes.filter(v => v.size > 0).map(v => ({ mount: v.mount, fs: v.type, size: v.size, used: v.used })),
      reliabilityAvailable: !!rel,
      elevated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/detail/network', async (req, res) => {
  try {
    const [ifaces, stats] = await Promise.all([si.networkInterfaces(), si.networkStats('*')]);
    res.json({
      interfaces: ifaces
        .filter(i => !i.internal)
        .map(i => {
          const s = stats.find(x => x.iface === i.iface);
          return {
            name: i.ifaceName || i.iface, state: i.operstate, type: i.type,
            ip4: i.ip4, ip6: i.ip6, mac: i.mac, speedMbit: i.speed, dhcp: i.dhcp,
            rx: s ? s.rx_sec : null, tx: s ? s.tx_sec : null,
            rxTotal: s ? s.rx_bytes : null, txTotal: s ? s.tx_bytes : null,
          };
        })
        .sort((a, b) => (b.state === 'up') - (a.state === 'up')),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/detail/system', async (req, res) => {
  try {
    const [system, baseboard, bios, chassis, os, time, fans] = await Promise.all([
      si.system(), si.baseboard(), si.bios(), si.chassis(), si.osInfo(), si.time(),
      psQuery('(Get-CimInstance Win32_Fan | Where-Object { $_.ActiveCooling }).Count'),
    ]);
    res.json({
      manufacturer: system.manufacturer, model: system.model,
      board: { manufacturer: baseboard.manufacturer, model: baseboard.model, version: baseboard.version },
      bios: { vendor: bios.vendor, version: bios.version, releaseDate: bios.releaseDate },
      chassis: { type: chassis.type },
      os: { distro: os.distro, release: os.release, build: os.build, arch: os.arch, hostname: os.hostname },
      bootTime: new Date(Date.now() - time.uptime * 1000).toISOString(),
      activeFans: Number(fans) || null,
      elevated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- processes ----------
app.get('/api/processes', (req, res) => {
  res.json(procCache);
});

app.post('/api/kill', (req, res) => {
  const pid = Number(req.body.pid);
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) {
    return res.status(400).json({ error: 'Refusing to kill that PID.' });
  }
  try {
    process.kill(pid);
    res.json({ ok: true });
  } catch (err) {
    const denied = err.code === 'EPERM';
    res.status(denied ? 403 : 500).json({
      error: denied
        ? 'Windows blocked this — the process is protected or running with higher privileges.'
        : err.message,
      adminHint: denied && !elevated,
    });
  }
});

// Relaunch Pulse elevated (triggers a UAC prompt). Only meaningful for packaged builds.
app.post('/api/relaunch-elevated', (req, res) => {
  if (elevated) return res.json({ ok: false, message: 'Already running as administrator.' });
  const inDev = !isExe && !process.versions.electron;
  if (inDev) return res.status(400).json({ error: 'Dev mode — restart your terminal as administrator instead.' });
  res.json({ ok: true });
  // Spawn detached so the elevated copy survives this instance quitting; the
  // sleep lets this instance release the port before the new one binds it.
  const { spawn } = require('child_process');
  const exe = process.execPath.replace(/'/g, "''");
  spawn('powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Sleep -Milliseconds 1200; Start-Process -FilePath '${exe}' -Verb RunAs`],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => {
    try { require('electron').app.quit(); } catch { process.exit(0); }
  }, 400);
});

// ---------- health checks (read-only PowerShell queries, cached) ----------
let healthCache = { at: 0, data: null };

app.get('/api/health', async (req, res) => {
  if (healthCache.data && Date.now() - healthCache.at < 30000) return res.json(healthCache.data);
  try {
    const [physicalDisks, defender, rebootPending, fsSizes, mem, time, battery] = await Promise.all([
      psQuery('Get-PhysicalDisk | Select-Object FriendlyName,MediaType,HealthStatus | ConvertTo-Json'),
      psQuery(`Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,@{n='SigUpdated';e={$_.AntivirusSignatureLastUpdated.ToString('o')}} | ConvertTo-Json`),
      psQuery(`@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') | ForEach-Object { Test-Path $_ } | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count`),
      si.fsSize(), si.mem(), si.time(), si.battery(),
    ]);

    const checks = [];
    // Each check carries: name, status, a live detail line, plus `what` (what it
    // measures, in plain English) and `rule` (the thresholds that decide the color).
    const add = (name, status, detail, what, rule) => checks.push({ name, status, detail, what, rule });

    const disks = physicalDisks ? [].concat(physicalDisks) : [];
    if (disks.length) {
      const bad = disks.filter(d => d.HealthStatus !== 'Healthy' && d.HealthStatus !== 0);
      add('Drive hardware (SMART)', bad.length ? 'fail' : 'pass',
        bad.length ? `${bad.map(d => d.FriendlyName).join(', ')} reporting problems` : `All ${disks.length} physical drives healthy`,
        "Your drives' built-in SMART self-diagnostics — the early warning a disk gives when it may be failing.",
        "Passes when every physical drive reports healthy. Fails the moment any drive reports a problem.");
    } else {
      add('Drive hardware (SMART)', 'warn', 'Could not read drive health (may need admin)',
        "Your drives' built-in SMART self-diagnostics.",
        "Reading SMART status needs administrator rights on some systems — run Pulse as admin to enable this check.");
    }

    for (const d of fsSizes.filter(v => v.size > 0)) {
      const freePct = 100 - (d.used / d.size) * 100;
      add(`Free space on ${d.mount}`, freePct < 5 ? 'fail' : freePct < 15 ? 'warn' : 'pass',
        `${freePct.toFixed(1)}% free (${((d.size - d.used) / 1e9).toFixed(0)} GB)`,
        `How much room is left on drive ${d.mount}. Windows and apps slow down and can misbehave when a drive is nearly full.`,
        "Healthy above 15% free · warning at 5–15% · problem below 5%.");
    }

    const memPct = (mem.active / mem.total) * 100;
    add('Memory pressure', memPct > 92 ? 'fail' : memPct > 80 ? 'warn' : 'pass', `${memPct.toFixed(0)}% of RAM in use`,
      "How much of your RAM is in use right now. When it fills up, Windows falls back to the much slower page file on disk.",
      "Healthy below 80% · warning at 80–92% · problem above 92%.");

    if (defender) {
      const sigDate = new Date(defender.SigUpdated);
      const sigAgeDays = (Date.now() - sigDate.getTime()) / 86400000;
      const on = defender.AntivirusEnabled && defender.RealTimeProtectionEnabled;
      add('Antivirus (Defender)', !on ? 'fail' : sigAgeDays > 7 ? 'warn' : 'pass',
        !on ? 'Real-time protection is OFF' : `Protected, definitions ${sigAgeDays < 1 ? 'up to date' : Math.floor(sigAgeDays) + ' day(s) old'}`,
        "Whether Windows Defender's real-time protection is switched on and its virus definitions are current.",
        "Healthy when protection is on and definitions are under a week old · warns if definitions are stale · fails if real-time protection is off.");
    } else {
      add('Antivirus (Defender)', 'warn', 'Could not read Defender status',
        "Whether Windows Defender is actively protecting this PC.",
        "Could not be read — you may be running third-party antivirus instead, or it needs admin rights.");
    }

    add('Pending reboot', Number(rebootPending) > 0 ? 'warn' : 'pass',
      Number(rebootPending) > 0 ? 'Windows is waiting on a restart to finish updates' : 'No restart pending',
      "Whether Windows is holding a restart to finish installing updates.",
      "Healthy when nothing is pending · warns when a restart is queued (updates aren't fully applied until you reboot).");

    const upDays = time.uptime / 86400;
    add('Uptime', upDays > 14 ? 'warn' : 'pass',
      upDays > 14 ? `Up ${upDays.toFixed(0)} days — a reboot wouldn't hurt` : `Up ${upDays < 1 ? (time.uptime / 3600).toFixed(1) + ' hours' : upDays.toFixed(1) + ' days'}`,
      "How long since your last restart. Very long uptime lets memory leaks and small glitches accumulate.",
      "Healthy under 14 days · warns beyond that.");

    const g = latest.gpu;
    if (g && g['temperature.gpu'] != null) {
      const t = g['temperature.gpu'];
      add('GPU temperature', t > 90 ? 'fail' : t > 82 ? 'warn' : 'pass', `${g.name} at ${t}°C`,
        "Your graphics card's core temperature under its current load.",
        "Healthy below 83°C · warning at 83–90°C · problem above 90°C.");
    }

    // CPU temperature (only when a sensor source exposes it)
    const cpuT = lhmCpuTemp();
    if (cpuT != null) {
      add('CPU temperature', cpuT > 95 ? 'fail' : cpuT > 85 ? 'warn' : 'pass', `CPU package at ${cpuT.toFixed(0)}°C`,
        "Your processor package temperature, read from a sensor source like LibreHardwareMonitor.",
        "Healthy below 85°C · warning at 85–95°C · problem above 95°C.");
    }

    if (battery.hasBattery) {
      add('Battery health', battery.maxCapacity && battery.designedCapacity && battery.maxCapacity / battery.designedCapacity < 0.6 ? 'warn' : 'pass',
        battery.designedCapacity ? `${Math.round((battery.maxCapacity / battery.designedCapacity) * 100)}% of design capacity` : `${battery.percent}% charged`,
        "How much of your battery's original design capacity it can still hold — batteries wear down with age and charge cycles.",
        "Warns once the battery drops below 60% of its original capacity.");
    }

    const score = Math.max(0, 100 - checks.reduce((s, c) => s + (c.status === 'fail' ? 25 : c.status === 'warn' ? 8 : 0), 0));
    const data = { score, checks, at: new Date().toISOString() };
    healthCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Windows can surface EADDRINUSE a beat *after* 'listening' fires, so hold the
// success message briefly and let the error handler win if it shows up.
let bindFailed = false;
const server = app.listen(PORT, '127.0.0.1');
server.on('listening', () => {
  setTimeout(() => {
    if (bindFailed) return;
    console.log(`Pulse running at http://localhost:${PORT}${isExe ? ' — close this window to stop it.' : ''}`);
    openBrowser();
  }, 300);
});
const inElectron = !!process.versions.electron;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Already running. In the desktop app the window just loads the existing
    // instance; standalone we open the browser and bow out.
    bindFailed = true;
    console.log('Pulse is already running — reusing it.');
    if (!inElectron) {
      openBrowser();
      setTimeout(() => process.exit(0), 300);
    }
  } else {
    throw err;
  }
});
