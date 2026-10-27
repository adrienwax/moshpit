// Readiness stress run: the user journey, harder than the smoke tests. One profile, real engine.
//   1. Workspace switches while an Add block import is running → the slice still lands, no errors.
//   2. An 8-block timeline cut from three clips through Source (I / O → ＋ Add block).
//   3. A real H.264 export: every frame decodes (ffmpeg full decode, no errors) and the frame count
//      matches the timeline.
//   4. Cancel mid-encode → cancelled, the app's own ffmpeg gone; Retry → a valid file.
//   node app/test/stress.e2e.mjs        (dev)   ·   MOSHPIT_EXE=<exe> node app/test/stress.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-stress');
const media = path.join(out, 'media');
const exports = path.join(out, 'exports');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(media, { recursive: true });
const ffmpeg = process.env.MOSHPIT_FFMPEG || 'ffmpeg';
const ffprobe = process.env.MOSHPIT_FFPROBE || 'ffprobe';
const gen = (name, src, dur) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-t', String(dur), '-i', `${src}=size=1280x720:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${dur}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(media, name)]);
fs.copyFileSync(path.join(root, 'fixtures', 'src-a.mp4'), path.join(media, 'a-src.mp4')); // 30 fps, 10 s
gen('b-long.mp4', 'testsrc2', 24);
gen('c-mandel.mp4', 'mandelbrot', 12);

let failed = 0;
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${lap()}] ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const timed = async (fn) => { const s = Date.now(); await fn(); return `${((Date.now() - s) / 1000).toFixed(1)}s`; };
/** ffmpeg processes the APP spawned (bundled copy in the scratch extract, or the dev build's) — never anyone else's. */
const appFfmpeg = () => execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-Process ffmpeg -ErrorAction Ignore) | Where-Object { $_.Path -match 'moshpit-scratch|_full-build-backup' } | ForEach-Object { $_.Id }; exit 0"], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);

let win, pid;
const ud = path.join(out, 'userdata');
const env = { ...process.env, MOSHPIT_LIBRARY: media };
if (process.env.MOSHPIT_EXE) {
  const port = 9700 + Math.floor(Math.random() * 90);
  pid = spawn(process.env.MOSHPIT_EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' }).pid;
  let browser;
  for (let i = 0; i < 400 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 300)); } }
  // The packaged exe unpacks ~800 MB first: allow 120 s, and never leave an app running if attaching fails.
  if (!browser) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } throw new Error('could not attach to the app over CDP in 120 s'); }
  for (let i = 0; i < 100 && !win; i++) { win = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().includes('worker')); if (!win) await new Promise((r) => setTimeout(r, 200)); }
} else {
  const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], env });
  win = await app.firstWindow();
  pid = app.process().pid;
}
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));

let hopPending = false;
/** Source: mark [a, b) of the clip's scrub width and press ＋ Add block. Returns the selection's frame count. */
async function addBlock(file, a, b, { hop = false } = {}) {
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: file }).click({ timeout: 60000 });
  const lane = win.locator('section[aria-label="Preview & slice"] .scrub');
  const lb = await lane.boundingBox();
  await lane.click({ position: { x: lb.width * a, y: lb.height / 2 } }); await win.keyboard.press('i');
  await lane.click({ position: { x: lb.width * b, y: lb.height / 2 } }); await win.keyboard.press('o');
  const n = Number(/Frames\s+(\d+)\s+Duration\b/.exec(await win.locator('.convbar .selread > .on > em').innerText())?.[1]);
  const before = await win.locator('.toasts .toast', { hasText: /^.*Added \d+ f of/ }).count();
  await win.locator('.convbar').getByRole('button', { name: /Add block/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 2500 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  if (hop) hopPending = (await win.locator('.toasts .toast', { hasText: `Added ${n} f of ${file}` }).count()) === 0;
  if (hop) for (const k of ['Alt+2', 'Alt+3', 'Alt+0', 'Alt+2', 'Alt+1', 'Alt+3', 'Alt+2']) { await win.keyboard.press(k); await win.waitForTimeout(250); }
  await win.locator('.toasts .toast', { hasText: `Added ${n} f of ${file}` }).first().waitFor({ timeout: 180000 });
  return n;
}
const blockTips = async () => {
  await win.keyboard.press('Alt+2');
  await win.locator('.tl .blk').first().waitFor({ timeout: 15000 });
  return win.locator('.tl .blk').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? e.getAttribute('data-tip') ?? ''));
};
const probeFrames = (f) => Number(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
const decodeErrors = (f) => { try { return execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return String(e.stderr || e).trim() || 'exit ' + e.status; } };
const rows = () => win.locator('.rtable tbody tr');

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });

  // ---------- 1. workspace hopping while the import runs ----------
  const hopT = await timed(() => addBlock('b-long.mp4', 0.02, 0.98, { hop: true }));
  check(`a slice imported while hopping Source/Compose/Render/Home lands (${hopT})`, hopPending && (await blockTips()).length === 1, hopPending ? 'the import was still running when the hopping began' : 'the import had ALREADY landed before the hops: not a real test');

  // ---------- 2. an 8-block timeline ----------
  const plan = [['a-src.mp4', 0.05, 0.3], ['c-mandel.mp4', 0.2, 0.5], ['b-long.mp4', 0.7, 0.75], ['a-src.mp4', 0.5, 0.9], ['c-mandel.mp4', 0.6, 0.62], ['b-long.mp4', 0.3, 0.45], ['a-src.mp4', 0.95, 0.99]];
  const buildT = await timed(async () => { for (const [f, a, b] of plan) await addBlock(f, a, b); });
  const tips = await blockTips();
  const total = tips.reduce((s, t) => { const m = /· (\d+) f ×(\d+)/.exec(t); return s + (m ? Number(m[1]) * Number(m[2]) : NaN); }, 0);
  check(`8 blocks cut from 3 clips through Source (${buildT})`, tips.length === 8 && Number.isFinite(total), `${tips.length} blocks, ${total} f`);
  check('the project holds one clip per slice (8), each named for its range', (await win.locator('.clips .clip').count()) === 8 && (await win.locator('.clips .clip', { hasText: /\[/ }).count()) === 8);

  // ---------- 3. a real export, decoded end to end ----------
  await win.keyboard.press('Alt+3');
  await win.locator('.exprow button[aria-haspopup="menu"]').first().click();
  await win.keyboard.press('3'); // H.264
  const dir = win.locator('.exprow .pathfld input').last();
  await dir.fill(exports); await dir.blur();
  const expT = await timed(async () => {
    await win.locator('.btn-run').first().click();
    await rows().first().waitFor();
    await win.locator('.rtable .st.done, .rtable .st.fail').first().waitFor({ timeout: 20 * 60000 });
  });
  const first = (await rows().first().innerText()).replace(/\s+/g, ' ');
  check(`export finished (${expT})`, /done/.test(first), first);
  const f1 = fs.readdirSync(exports).filter((f) => f.endsWith('.mp4')).map((f) => path.join(exports, f))[0];
  if (f1) {
    const frames = probeFrames(f1);
    check(`the export has every timeline frame (${frames} of ${total})`, frames === total);
    const bad = decodeErrors(f1);
    check('the export decodes end to end with no errors (it plays)', bad === '', bad.slice(0, 200));
  } else check('the export file exists', false, fs.readdirSync(exports).join(', '));

  // ---------- 4. cancel mid-encode, then Retry ----------
  await win.locator('.btn-run').first().click();
  await rows().nth(1).waitFor();
  const r2 = rows().nth(1);
  await r2.locator('.st', { hasText: /Encode|%/ }).waitFor({ timeout: 120000 }); // inside the encode, not before it
  const ffBefore = appFfmpeg();
  await r2.locator('button.ghostbtn').first().click();
  const cancelled = await r2.locator('.st', { hasText: 'cancelled' }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  check('cancel mid-encode: the job reads "cancelled" (not failed)', cancelled, (await r2.innerText()).replace(/\s+/g, ' '));
  await win.waitForTimeout(3000);
  const ffAfter = appFfmpeg();
  check("cancel leaves none of the app's ffmpeg running", ffAfter.length === 0, `before ${ffBefore.join(',') || '-'} · after ${ffAfter.join(',') || '-'}`);
  const partial = fs.readdirSync(exports).filter((f) => f !== path.basename(f1 ?? ''));
  console.log(`info [${lap()}] files after cancel besides the first export: ${partial.join(', ') || 'none'}`);
  const retryT = await timed(async () => {
    await r2.locator('button.ghostbtn').first().click(); // ⟳ Queue again
    await r2.locator('.st.done, .st.fail').waitFor({ timeout: 20 * 60000 });
  });
  const r2text = (await r2.innerText()).replace(/\s+/g, ' ');
  check(`Retry re-renders the cancelled job to done (${retryT})`, /done/.test(r2text), r2text);
  const f2 = fs.readdirSync(exports).filter((f) => f.endsWith('.mp4')).map((f) => path.join(exports, f)).find((f) => f !== f1);
  if (f2) {
    check('the retried file has every frame and decodes cleanly', probeFrames(f2) === total && decodeErrors(f2) === '', `${probeFrames(f2)} f`);
  } else check('the retried file exists', false, fs.readdirSync(exports).join(', '));
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('stress ran to the end', false, String(e).split('\n').slice(0, 3).join(' / '));
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `stress: ${failed} FAILED (${lap()})` : `stress: all ok (${lap()})`);
process.exit(failed ? 1 : 0);
