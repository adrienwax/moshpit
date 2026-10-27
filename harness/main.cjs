// Electron main for the headless harness (ported from moshpit-v3-spike/main.js). A hidden window
// runs harness/dist/runner.cjs in the mode named on the command line, with CDP heap sampling for
// the allocation probe and nvidia-smi sampling for VRAM. Exit code 0 only when the mode passes.
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('enable-precise-memory-info');
app.commandLine.appendSwitch('js-flags', '--expose-gc');

const MODE = process.argv.find((a) => ['gate', 'slice', 'service', 'scale', 'colour', 'effects', 'long', 'audio', 'preview', 'preview-audit'].includes(a)) || 'gate';
const OUT = path.join(__dirname, '..', 'out', 'harness');
fs.mkdirSync(OUT, { recursive: true });
let win;

const vram = () => new Promise((res) => execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }, (e, out) => res(e ? null : +String(out).trim())));
ipcMain.handle('vram', vram);
// RAM: working set summed over every process of this app (main, renderer, GPU, utility).
ipcMain.handle('metrics', async () => ({ vram: await vram(), ram: app.getAppMetrics().reduce((s, p) => s + p.memory.workingSetSize, 0) * 1024 }));
ipcMain.on('log', (_e, m) => console.log(m));

ipcMain.handle('heap', async (_e, cmd) => {
  const d = win.webContents.debugger;
  if (!d.isAttached()) d.attach('1.3');
  if (cmd === 'start') {
    await d.sendCommand('HeapProfiler.enable');
    await d.sendCommand('HeapProfiler.collectGarbage');
    await d.sendCommand('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    return null;
  }
  const { profile } = await d.sendCommand('HeapProfiler.stopSampling');
  const by = new Map();
  let total = 0;
  (function walk(n) {
    const self = n.selfSize || 0;
    if (self) {
      const f = n.callFrame;
      const k = `${f.functionName || '(anonymous)'} ${f.url ? path.basename(f.url) + ':' + (f.lineNumber + 1) : '(native/V8)'}`;
      by.set(k, (by.get(k) || 0) + self);
      total += self;
    }
    for (const c of n.children) walk(c);
  })(profile.head);
  return { total, top: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([site, bytes]) => ({ site, bytes })) };
});

ipcMain.on('done', (_e, r) => {
  const file = path.join(OUT, `${MODE}-${r.tag || 'run'}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
  console.log(`\n=== ${MODE.toUpperCase()} ${r.tag || ''} ===`);
  for (const t of r.tests || []) console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.id}  ${t.name} — ${t.evidence}`);
  for (const l of r.notes || []) console.log(l);
  if (r.fatal) console.log(`FATAL  ${r.fatal}`);
  const ok = !r.fatal && (r.tests || []).every((t) => t.pass);
  console.log(`\n${ok ? 'GREEN' : 'NOT GREEN'} — ${(r.tests || []).filter((t) => t.pass).length}/${(r.tests || []).length}, detail in ${path.relative(process.cwd(), file)}`);
  app.exit(ok ? 0 : 1);
});

app.whenReady().then(() => {
  win = new BrowserWindow({ show: false, width: 640, height: 400, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  win.loadFile(path.join(__dirname, 'runner.html'), { query: { mode: MODE } });
  const minutes = +(process.env.HARNESS_TIMEOUT_MIN || (MODE === 'long' ? 240 : 60));
  setTimeout(() => { console.log(`TIMEOUT after ${minutes} min`); app.exit(2); }, minutes * 60_000);
});
