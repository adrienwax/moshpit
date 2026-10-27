// Phase 0.1a: does the UI hold 60 fps while you work? The main-thread probe (window.__moshpitPerf:
// rAF intervals + the browser's long-task reports) around each interaction, on an 8-block project
// with two effects per block. Prints one line per scenario and writes out/app-perf/perf-<tag>.json.
//   node app/test/perf.e2e.mjs <tag>        (dev build: node app/build.mjs first)
//   PERF_DIST=<dist dir> picks another build (a before/after comparison on the same machine state).
// Every scenario runs ROUNDS times; the line shows the median of each number across rounds, since
// one run on a shared desktop is noise. Pass/fail is not the point: it is the measurement.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const tag = process.argv[2] ?? 'run';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-perf');
const ud = path.join(out, `userdata-${tag}`);
fs.mkdirSync(out, { recursive: true });
fs.rmSync(ud, { recursive: true, force: true });

const dist = process.env.PERF_DIST ?? path.join(root, 'app', 'dist');
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 3);
const app = await electron.launch({ args: [path.join(dist, 'main.cjs'), `--user-data-dir=${ud}`], env: { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures') } });
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));
const results = {};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const measure = async (name, fn) => {
  const runs = [];
  for (let i = 0; i < ROUNDS; i++) {
    await win.evaluate(() => window.__moshpitPerf.start());
    await fn();
    runs.push(await win.evaluate(() => window.__moshpitPerf.stop()));
    await win.waitForTimeout(400);
  }
  // PERF_PROFILE=<scenario>: one more round under the CPU profiler; prints where the time went.
  if (process.env.PERF_PROFILE === name) {
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    await fn();
    const { profile } = await cdp.send('Profiler.stop');
    fs.writeFileSync(path.join(out, `${tag}-${name.replace(/\W+/g, '-')}.cpuprofile`), JSON.stringify(profile));
    const dt = new Map(); // node id → sampled ms
    for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    const self = new Map();
    for (const n of profile.nodes) {
      const f = n.callFrame, key = `${f.functionName || '(anon)'}  ${f.url.replace(/^.*\//, '')}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt.get(n.id) ?? 0));
    }
    console.log(`  profile of ${name}: top self time`);
    for (const [k, v] of [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`    ${v.toFixed(1).padStart(7)} ms  ${k}`);
    console.log(`    (idle ${(self.get('(idle)  :0') ?? 0).toFixed(0)} ms · GC ${(self.get('(garbage collector)  :0') ?? 0).toFixed(0)} ms · program ${(self.get('(program)  :0') ?? 0).toFixed(0)} ms)`);
  }
  const m = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, median(runs.map((r) => r[k]))]));
  results[name] = { median: m, runs };
  console.log(`${name.padEnd(22)} p95 ${m.p95} ms · janks ${m.janks} · long tasks ${m.longTasks} (${m.longTaskMs} ms, max ${m.maxLongTask})   [medians of ${ROUNDS}; long-task ms per run: ${runs.map((r) => r.longTaskMs).join(' / ')}]`);
};
/** A pointer drag of `steps` moves, one per ~16 ms, the way a hand drags. */
const drag = async (box, fx0, fx1, steps = 60, fy = 0.5) => {
  await win.mouse.move(box.x + box.width * fx0, box.y + box.height * fy);
  await win.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await win.mouse.move(box.x + box.width * (fx0 + (fx1 - fx0) * (i / steps)), box.y + box.height * fy);
    await win.waitForTimeout(16);
  }
  await win.mouse.up();
};

let ok = false;
try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  // ---------- build: one clip, a block with two effects, duplicated to 8 ----------
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'src-a.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.toasts .toast', { hasText: /usable now/ }).first().waitFor({ timeout: 180000 });
  await win.keyboard.press('Alt+2');
  const lane = win.locator('.loupe[data-loupe="A"] .ztrack');
  const lb = await lane.boundingBox();
  await lane.click({ position: { x: lb.width * 0.05, y: lb.height * 0.7 } });
  await win.keyboard.press('i');
  await lane.click({ position: { x: lb.width * 0.6, y: lb.height * 0.7 } });
  await win.keyboard.press('o');
  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();
  await win.locator('.tl .blk').first().waitFor();
  await win.locator('.tl .blk').first().click();
  await win.locator('.recipe', { hasText: 'Dream Melt' }).click();
  for (let i = 0; i < 7; i++) {
    await win.locator('.tl .blk').first().click();
    await win.getByRole('button', { name: /Duplicate/ }).first().click();
  }
  await win.waitForFunction(() => document.querySelectorAll('.tl .blk').length === 8, null, { timeout: 15000 });
  await win.locator('.tl .blk').nth(3).click();
  await win.waitForTimeout(2500); // let the first frames land

  // ---------- scenarios ----------
  // Calibration: a deliberate 120 ms block must show as one long task, or the probe is blind.
  await measure('calibration 120 ms', () => win.evaluate(() => new Promise((r) => setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120); setTimeout(r, 200); }, 50))));
  await measure('idle 2 s', () => win.waitForTimeout(2000));
  const rng = win.locator('section[aria-label="Effects"] .param .rng[role=slider]').first();
  await rng.scrollIntoViewIfNeeded();
  await measure('param drag', async () => drag(await rng.boundingBox(), 0.1, 0.9));
  const trim = win.locator('.tl .blk').nth(3).locator('.trimh.r');
  await measure('trim drag', async () => { const b = await trim.boundingBox(); await drag({ x: b.x - 120, y: b.y, width: 240, height: b.height }, 0.5, 0.2); });
  await measure('playhead scrub', async () => drag(await win.locator('.bpmruler').boundingBox(), 0.05, 0.95));
  await measure('playback 3 s', async () => { await win.keyboard.press('Space'); await win.waitForTimeout(3000); await win.keyboard.press('Space'); });
  await measure('graph pan', async () => { const g = await win.locator('.gwrap .react-flow__pane').first().boundingBox(); await drag(g, 0.3, 0.7); });
  // A render keeps the worker busy: the UI must not care.
  await win.keyboard.press('Alt+3');
  await win.getByRole('button', { name: /Render · add job/ }).click();
  await win.keyboard.press('Alt+2');
  await win.waitForTimeout(500);
  await measure('scrub while rendering', async () => drag(await win.locator('.bpmruler').boundingBox(), 0.9, 0.1));
  ok = Object.keys(results).length === 8;
} catch (e) {
  console.log('FAIL ran to the end', String(e).split('\n')[0]);
}
fs.writeFileSync(path.join(out, `perf-${tag}.json`), JSON.stringify({ tag, at: new Date().toISOString(), results, errors: errs.slice(0, 3) }, null, 2));
console.log(ok && !errs.length ? `perf: all ok (${tag})` : `perf: FAILED (${errs[0] ?? 'incomplete'})`);
// Not app.close(): the unsaved test project (and a render in flight) would wait on the close prompt.
try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
process.exit(ok ? 0 : 1);
