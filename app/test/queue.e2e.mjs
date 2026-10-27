// Phase 0.1b stage 1: how long does a frame wait while the worker runs a heavy job? A 60 s 1080p
// clip on the timeline; for each job (render, import, conform check, freeze, detect cuts, audio
// peaks) a scrub-like frame request every 150 ms while it runs, timed from the UI (what the user
// waits) and inside the worker (queue wait), plus the worker thread's own event-loop lag.
//   node app/test/queue.e2e.mjs <tag>        (dev build: node app/build.mjs first)
// It is a measurement: it fails only if a job errors or the run does not finish.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const tag = process.argv[2] ?? 'run';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-queue');
const media = path.join(out, 'media');
const ud = path.join(out, `userdata-${tag}`);
const exports = path.join(out, `exports-${tag}`);
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(exports, { recursive: true, force: true });
fs.mkdirSync(media, { recursive: true });
fs.mkdirSync(exports, { recursive: true });
const ffmpeg = process.env.MOSHPIT_FFMPEG || 'ffmpeg';
const gen = (name, src, dur) => {
  const f = path.join(media, name);
  if (!fs.existsSync(f)) execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-t', String(dur), '-i', `${src}=size=1920x1080:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=220:duration=${dur}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  return f;
};
gen('long.mp4', 'testsrc2', 60);
const second = gen('second.mp4', 'mandelbrot', 30);

const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], env: { ...process.env, MOSHPIT_TEST: '1', MOSHPIT_LIBRARY: media } });
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : 0);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s.at(-1) ?? 0) };
};
const results = {};
let ok = true;
try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  // ---------- the project: the whole 60 s clip as one block, masters finished ----------
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'long.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: /Add block/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.toasts .toast', { hasText: /Added \d+ f of long\.mp4/ }).first().waitFor({ timeout: 300000 });
  await win.keyboard.press('Alt+2');
  const bid = await win.locator('.tl .blk').first().getAttribute('data-block', { timeout: 15000 });
  await win.locator('.statusstrip', { hasText: /FINALIZING/i }).waitFor({ state: 'detached', timeout: 15 * 60000 }).catch(() => {});
  await win.keyboard.press('Alt+0'); // Home: no frame views asking for frames of their own
  await win.waitForTimeout(2000);
  const sid = await win.evaluate(async () => (await window.__moshpitEngine.conformStates())[0]?.sourceId);
  const blkTip = await win.evaluate(() => document.querySelector('.tl .blk')?.getAttribute('title') ?? document.querySelector('.tl .blk')?.getAttribute('data-tip') ?? '');
  console.log(`block: ${blkTip.replace(/\s+/g, ' ').slice(0, 120)}`);

  // ---------- the jobs ----------
  // import last: its master keeps encoding in the background afterwards, and would land in a later job's window
  const only = process.env.QUEUE_ONLY ? process.env.QUEUE_ONLY.split(',') : null;
  for (const job of ['idle', 'render', 'verify', 'freeze', 'detect', 'peaks', 'import'].filter((j) => !only || only.includes(j))) {
    const r = await win.evaluate(async ({ job, sid, bid, second, outPath, noPing }) => {
      const e = window.__moshpitEngine;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      await e.queueProbe('reset');
      const t0 = performance.now();
      let p;
      switch (job) {
        case 'idle': p = sleep(5000); break;
        case 'render': p = e.render({ id: `q-${Date.now()}`, name: 'q', config: { format: 'mp4-h264', width: 1920, height: 1080, audio: true }, outPath }, () => {}).promise; break;
        case 'import': p = e.importClip(second, () => {}, {}).promise; break;
        case 'verify': p = e.verifyConforms(() => {}).promise; break;
        case 'freeze': p = e.freeze({ kind: 'block', blockId: bid }, [0, 449]).promise; break;
        case 'detect': p = e.detectCuts(sid, 5).promise; break;
        case 'peaks': p = e.audioPeaks(sid, 8000); break;
      }
      let done = false, err = null;
      p.then(() => (done = true), (x) => ((done = true), (err = String(x?.code ?? x))));
      const lat = [];
      let i = 0;
      while (!done && !noPing && performance.now() - t0 < 240000) {
        const s = performance.now();
        try { (await e.frame({ kind: 'output', frame: (i++ * 37) % 1700 }, { w: 640, h: 360 })).image.close(); } catch { /* counted anyway */ }
        lat.push(performance.now() - s);
        await sleep(150);
      }
      while (!done && performance.now() - t0 < 600000) await sleep(200);
      const pr = await e.queueProbe('read');
      return { jobMs: Math.round(performance.now() - t0), err, lat, workerWait: pr.done.filter((d) => d.method === 'frame').map((d) => d.waitMs), lagMax: Math.round(pr.lagMax), lagP95: Math.round(pr.lagP95), blocked100: pr.blocked100 };
    }, { job, sid, bid, second, outPath: path.join(exports, `q-${job}.mp4`), noPing: (process.env.QUEUE_NOPING ?? '').split(',').includes(job) });
    const ui = stats(r.lat), wq = stats(r.workerWait);
    results[job] = { jobMs: r.jobMs, err: r.err, frameRoundTrip: ui, queueWait: wq, workerLag: { max: r.lagMax, p95: r.lagP95, over100ms: r.blocked100 } };
    console.log(`${job.padEnd(7)} job ${String((r.jobMs / 1000).toFixed(1)).padStart(6)} s${r.err ? ' ERR ' + r.err : ''} · frame round trip p50 ${ui.p50} / p95 ${ui.p95} / max ${ui.max} ms (n ${ui.n}) · queue wait p95 ${wq.p95} max ${wq.max} ms · worker lag max ${r.lagMax} ms, >100 ms ×${r.blocked100}`);
    if (r.err) ok = false;
  }
  // Determinism: the export made while frames were being asked for (above) must be byte-identical
  // to one made with nothing else running. Renders now share the worker with frame requests.
  {
    const quiet = path.join(exports, 'q-render-quiet.mp4');
    const err = await win.evaluate(async (outPath) => {
      try { await window.__moshpitEngine.render({ id: `qq-${Date.now()}`, name: 'qq', config: { format: 'mp4-h264', width: 1920, height: 1080, audio: true }, outPath }, () => {}).promise; return null; } catch (e) { return String(e?.code ?? e); }
    }, quiet);
    const sha = async (f) => (fs.existsSync(f) ? (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16) : 'missing');
    const a = await sha(path.join(exports, 'q-render.mp4')), b = await sha(quiet);
    const same = !err && a === b && a !== 'missing';
    console.log(`${same ? 'ok  ' : 'FAIL'} the export made under frame requests is byte-identical to a quiet one  ${a} vs ${b}${err ? ' ERR ' + err : ''}`);
    results.determinism = { underLoad: a, quiet: b, same };
    if (!same) ok = false;
  }
} catch (e) {
  ok = false;
  console.log('FAIL ran to the end', String(e).split('\n')[0]);
}
fs.writeFileSync(path.join(out, `queue-${tag}.json`), JSON.stringify({ tag, at: new Date().toISOString(), results, errors: errs.slice(0, 3) }, null, 2));
console.log(ok && !errs.length ? `queue: all ok (${tag})` : `queue: FAILED (${errs[0] ?? 'see above'})`);
try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
process.exit(ok ? 0 : 1);
