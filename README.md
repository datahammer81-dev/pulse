# Pulse 💓

**A better Task Manager + PC health checker for Windows, in one dark live dashboard.**

### [⬇ Download Pulse for Windows — Pulse-Setup.exe](https://github.com/datahammer81-dev/pulse/releases/latest/download/Pulse-Setup.exe)

One-click installer, ~95 MB. Run the downloaded file — that's the whole install.
Everything the app needs is inside — no Node.js, no runtimes, nothing else to
install. SmartScreen may prompt once (unsigned): *More info → Run anyway*.

> ⚠️ **Don't use the green "Code → Download ZIP" button** — that downloads the
> source code for developers, not the app. Use the download link above (or the
> [Releases](../../releases) page) to get the installable app.

Everything about your PC on one page — live CPU/GPU/memory/network/disk stats,
a 0–100 health score, and a process manager. Click any card for a deep-dive
panel: per-core clock speeds, GPU fan and power draw, RAM module details,
drive SMART data, and more.

<!-- screenshot goes here: docs/screenshot.png -->

## Features

- **Health score** (0–100) computed from live checks: drive SMART status, free
  space per volume, memory pressure, Windows Defender state, pending reboot,
  uptime, GPU temperature, battery wear (laptops)
- **Gaming-HUD interface** — dark corner-cut panels, sidebar navigation, animated
  live numbers, one page per subsystem
- **30-minute history on every chart** — recorded server-side even while you're
  not looking; hover any chart to scrub back through time
- **Top-offenders chart** — the top CPU-hungry processes tracked over 30 minutes,
  so you can see exactly which app spiked five minutes ago
- **Live updates** — 2-second SSE stream: CPU (total + per-core bars),
  memory, GPU (utilization/VRAM/fan/power via nvidia-smi), network rates, storage
- **Per-subsystem pages:**
  - **CPU** — real per-core *effective* clocks (perf counters, shows actual turbo),
    cache, load split, virtualization
  - **GPU** — load, temp, fan %, power draw vs limit, core/memory clocks vs max,
    P-state, VRAM, PCIe link, driver/VBIOS
  - **Memory** — per-module size, DDR type, configured speed, part number, voltage
  - **Storage** — per-drive SMART, firmware; temperature/wear/power-on hours when
    running as admin
  - **Network** — every adapter with link speed, IPs, MAC, live rates, totals since boot
  - **System** — motherboard, BIOS, boot time, OS build
- **Process manager** — full process list, filter by name or PID, sort by CPU or
  memory, two-click end-process (with a "sure?" confirm)
- Zero frontend dependencies — one HTML file, hand-rolled SVG charts

## Install

### Option A — download a release (no tools needed)

Grab the latest from the [Releases](../../releases) page:

- **[`Pulse-Setup.exe`](https://github.com/datahammer81-dev/pulse/releases/latest/download/Pulse-Setup.exe)**
  ← recommended. One-click installer: installs the desktop app, creates
  Desktop + Start Menu shortcuts, registers an uninstaller in Windows Apps, and
  launches when done. Fully self-contained — no other software needed.
- **`Pulse-win32-x64.zip`** — the same desktop app without an installer. Unzip
  anywhere, run `Pulse.exe`.
- **`Pulse.exe`** (portable) — single file. Run it and the dashboard opens in
  your default browser; close its console window to stop it.

All are unsigned, so Windows SmartScreen may prompt once — "More info → Run anyway".

### Option B — build from source

Requires [Node.js](https://nodejs.org) 24+ on Windows.

```
git clone <this repo>
cd pulse
npm install

npm start            # server only — open http://localhost:7377
npm run app          # desktop app window (dev)
npm run build:installer  # one-click installer → dist/installer/Pulse-Setup-x.y.z.exe
npm run build:app        # unpacked desktop app → dist/app/Pulse-win32-x64/
npm run build:exe        # portable single exe → dist/Pulse.exe
```

**Tip:** run elevated (right-click → Run as administrator) to unlock drive
temperature, wear and power-on hours.

## How it works

- `electron-main.js` — the desktop app shell: runs the server in-process and shows the
  dashboard in a BrowserWindow. Closing the window quits everything.
- `server.js` — Express on `127.0.0.1:7377`. Live stats over SSE (`/api/live`: 2s CPU/mem/net
  tick, 3s GPU tick via nvidia-smi, 30s disks) using `systeminformation`. Detail endpoints
  `/api/detail/{cpu,gpu,memory,storage,network,system}`. Health checks (`/api/health`) run
  read-only PowerShell queries, cached 30s. `POST /api/kill` ends a process by PID (refuses
  system PIDs ≤ 4 and itself).
- `public/index.html` — the whole UI, one file, zero frontend dependencies. Hand-rolled SVG
  sparklines with hover tooltips; sliding drawer for detail panels that live-poll while open.

## Windows sensor reality check

- **GPU fan/temp/clocks**: full data via nvidia-smi (NVIDIA GPUs only; others get basic info).
- **CPU temp / case fan RPM**: not exposed by Windows without a kernel sensor driver
  (LibreHardwareMonitor etc.) — Pulse says so instead of guessing.
- **Drive temp/wear/hours**: `Get-StorageReliabilityCounter`, needs admin.
- **CPU effective clocks**: `% Processor Performance` perf counter × base clock — works unelevated.

## Notes

- **Localhost-only by design** (binds 127.0.0.1) — Pulse never listens on your network.
- Errors are appended to `pulse.log` next to the exe (or the project root in dev).
- The process list freezes while your mouse is over it, so rows can't shift mid-click.
- Windows-only: the health checks and sensors lean on PowerShell and WMI.

## License

[MIT](LICENSE)
