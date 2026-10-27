// F1 (UX round 2): a block already on the arrangement can be trimmed (edge drag, or the Block
// inspector's IN / OUT) and given a speed or reverse, and the arrangement's length is the engine's:
// the exported file has exactly the frames the arrangement says.
//   node app/test/blocktrim.e2e.mjs        (dev)   ·   MOSHPIT_EXE=<exe> node app/test/blocktrim.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-blocktrim');
const exports = path.join(out, 'exports');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const ffprobe = process.env.MOSHPIT_FFPROBE || 'ffprobe';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

let win, pid;
const ud = path.join(out, 'userdata');
const env = { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures') };
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

const trimRead = async () => Number(await win.locator('.blocktrim .trim-kept > b').innerText());
const arrRead = async () => Number(/on the arrangement: (\d+) f/.exec(await win.locator('.blockplay .m').innerText())?.[1]);
const blkTip = async () => win.locator('.tl .blk').first().evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip') ?? '');
const settle = async (fn, ok) => { let v; for (let i = 0; i < 40; i++) { v = await fn(); if (ok(v)) return v; await win.waitForTimeout(100); } return v; };

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  // A 150-frame block from the middle of src-a (30 fps, 300 f).
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'src-a.mp4' }).click({ timeout: 60000 });
  const lane = win.locator('section[aria-label="Preview & slice"] .scrub');
  const lb = await lane.boundingBox();
  await lane.click({ position: { x: lb.width * 0.25, y: lb.height / 2 } }); await win.keyboard.press('i');
  await lane.click({ position: { x: lb.width * 0.75, y: lb.height / 2 } }); await win.keyboard.press('o');
  await win.locator('.convbar').getByRole('button', { name: /Add block/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 2500 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.toasts .toast', { hasText: /Added \d+ f of src-a\.mp4/ }).first().waitFor({ timeout: 120000 });
  await win.keyboard.press('Alt+2');
  await win.locator('.tl .blk').first().click();
  const n0 = await trimRead();
  check('the Block inspector shows the trim (whole slice)', n0 > 100, `${n0} f`);

  // Edge drag: pull the right edge left by a third of the block.
  const bb = await win.locator('.tl .blk').first().boundingBox();
  const h = await win.locator('.tl .blk .trimh.r').first().boundingBox();
  await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await win.mouse.down();
  for (let i = 1; i <= 10; i++) await win.mouse.move(h.x + h.width / 2 - (bb.width / 3) * (i / 10), h.y + h.height / 2);
  await win.mouse.up();
  const n1 = await settle(trimRead, (v) => v < n0);
  check('dragging the right edge trims OUT on the arrangement', n1 < n0 && n1 > 0 && (await blkTip()).includes(`· ${n1} f ×1`), `${n0} → ${n1} f · ${await blkTip()}`);
  await win.locator('.tl').focus();
  await win.keyboard.press('Control+z');
  const nU = await settle(trimRead, (v) => v === n0);
  check('one undo restores the whole drag', nU === n0, `${n1} → ${nU} (was ${n0})`);

  // Inspector: IN up by two steps.
  await win.locator('.blocktrim .nslider').first().focus();
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowRight');
  const n2 = await settle(trimRead, (v) => v < n0);
  check('the inspector IN field trims the start', n2 < n0, `${n0} → ${n2} f`);
  check('…and the arrangement length follows', (await arrRead()) === n2, `arrangement ${await arrRead()} f`);

  // Speed up, then reverse: the arrangement length is the engine's.
  await win.locator('.blockplay').getByRole('button', { name: /Speed/ }).click();
  await win.locator('.blockplay .nslider').first().waitFor({ timeout: 10000 });
  await win.locator('.blockplay .nslider').first().focus();
  for (let i = 0; i < 4; i++) await win.keyboard.press('ArrowRight');
  const L = await settle(arrRead, (v) => v < n2);
  check('faster speed shortens the block on the arrangement', L < n2 && L > 0, `${n2} → ${L} f`);
  await win.locator('.blockplay').getByRole('button', { name: /Reverse/ }).click();
  check('Reverse toggles on, as a node in the block graph', (await win.locator('.blockplay button[aria-pressed=true]', { hasText: 'Reverse' }).count()) === 1 && (await win.locator('.ws-mosh .react-flow__node-mp', { hasText: 'Reverse' }).count()) === 1);

  // The engine agrees: the export has exactly the arrangement's frames.
  await win.keyboard.press('Alt+3');
  await win.locator('.exprow button[aria-haspopup="menu"]').first().click();
  await win.keyboard.press('3'); // H.264
  const dir = win.locator('.exprow .pathfld input').last();
  await dir.fill(exports); await dir.blur();
  await win.locator('.btn-run').first().click();
  await win.locator('.rtable .st.done, .rtable .st.fail').first().waitFor({ timeout: 10 * 60000 });
  const mp4 = fs.readdirSync(exports).find((f) => f.endsWith('.mp4'));
  const frames = mp4 ? Number(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path.join(exports, mp4)], { encoding: 'utf8' }).trim()) : NaN;
  check(`the export has exactly the arrangement's frames (${L})`, frames === L, `${mp4} ${frames} f`);
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('ran to the end', false, String(e).split('\n').slice(0, 3).join(' / '));
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `blocktrim: ${failed} FAILED` : 'blocktrim: all ok');
process.exit(failed ? 1 : 0);
