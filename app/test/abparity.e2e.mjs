// A↔B slicing parity (Path-to-Done P3): the incoming clip (B) slices exactly as the outgoing one (A).
// The same steps run on each loupe and the results are compared; then the datamosh act itself: A's
// slice a picture block, B's a motion block, and the Program moshed across the seam.
//   node app/test/abparity.e2e.mjs            MOSHPIT_EXE=<exe> node app/test/abparity.e2e.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp } from './launch.mjs';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-abparity');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const run = await launchApp({ root, userData: ud, port: 9344, env: { MOSHPIT_LIBRARY: path.join(root, 'fixtures') } });
const win = run.win;
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));

const send = async (file, to) => {
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: file }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: new RegExp('^Send to ' + to) }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.convbar .hdnote').waitFor({ timeout: 120000 });
};
const L = (w, sel) => win.locator(`.loupe[data-loupe="${w}"] ${sel}`);
const zio = (w) => L(w, '.zio').innerText();
const drag = async (loc, dx) => { const b = await loc.boundingBox(); await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await win.mouse.down(); await win.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 6 }); await win.mouse.up(); };

/** Everything a person does to slice on one loupe; returns what happened. */
async function slice(w, at) {
  const r = {};
  const track = L(w, '.ztrack');
  const tb = await track.boundingBox();
  await L(w, '.lbl').click();
  r.target = (await L(w, '.tag.slicing').count()) === 1;
  // Clicks at 40 % height: the IN / OUT flags sit at the track's foot and are drag targets themselves.
  await track.click({ position: { x: tb.width * at[0], y: tb.height * 0.4 } }); await win.keyboard.press('i');
  await track.click({ position: { x: tb.width * at[1], y: tb.height * 0.4 } });
  await win.keyboard.press('o');
  r.marked = await zio(w);
  r.handles = (await L(w, '.mkh.in').count()) === 1 && (await L(w, '.mkh.out').count()) === 1;
  await drag(L(w, '.mkh.in'), tb.width * 0.05);
  const afterIn = await zio(w);
  const tc = (t, k) => new RegExp(k + ' ([0-9:]+)').exec(t)?.[1];
  r.inDrag = tc(afterIn, 'IN') !== tc(r.marked, 'IN') && tc(afterIn, 'OUT') === tc(r.marked, 'OUT');
  await drag(L(w, '.mkh.out'), -tb.width * 0.05);
  const afterOut = await zio(w);
  r.outDrag = tc(afterOut, 'OUT') !== tc(afterIn, 'OUT') && tc(afterOut, 'IN') === tc(afterIn, 'IN');
  r.marks = afterOut;
  r.ticks = (await L(w, '.ticks .tk.major').count()) >= 2;
  const z0 = await L(w, '.zbtns .zx').innerText();
  await track.hover({ position: { x: tb.width * 0.5, y: tb.height * 0.7 } });
  for (let i = 0; i < 3; i++) await win.mouse.wheel(0, -100);
  await win.waitForTimeout(150);
  r.zoom = parseFloat(await L(w, '.zbtns .zx').innerText()) > parseFloat(z0);
  r.navigator = (await L(w, '.zoomnav .znwin').count()) === 1;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !(await L(w, '.ztrack .thumbs canvas').evaluateAll((cs) => cs.length > 0 && cs.every((c) => c.width > 1)))) await win.waitForTimeout(200);
  r.thumbs = await L(w, '.ztrack .thumbs canvas').evaluateAll((cs) => cs.length > 0 && cs.every((c) => c.width > 1));
  const n0 = await win.locator('.tl .blk').count();
  await L(w, '.ztools .tbtn.pop').click();
  await win.locator('.tl .blk').nth(n0).waitFor({ timeout: 8000 }).catch(() => {});
  r.block = (await win.locator('.tl .blk').count()) === n0 + 1;
  return r;
}

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  if (!run.packaged) await win.setViewportSize({ width: 1920, height: 1080 });
  await send('src-a.mp4', 'A');
  await send('src-b.mp4', 'B');
  await win.keyboard.press('Alt+2');
  await L('B', '.ztrack').waitFor({ timeout: 15000 });

  const a = await slice('A', [0.55, 0.9]); // A first: the outgoing picture, cut late in the clip
  const b = await slice('B', [0.1, 0.6]); // then B: the incoming motion
  for (const k of ['target', 'handles', 'inDrag', 'outDrag', 'ticks', 'zoom', 'navigator', 'thumbs', 'block']) {
    check(`parity · ${k}: A ${a[k]} · B ${b[k]}`, a[k] === true && b[k] === true);
  }
  check('both clips keep their own marks, visible at once', /^IN .* OUT /.test(await zio('A')) && /^IN .* OUT /.test(await zio('B')) && (await zio('A')) === a.marks && (await zio('B')) === b.marks, `A ${await zio('A')} | B ${await zio('B')}`);

  // ---------- the datamosh act: A's picture, B's motion moshed into it ----------
  const kinds = (await win.locator('.tl .blk').allInnerTexts()).map((t) => t.split(/\s+/)[0]);
  check('A becomes the picture block, B the motion block', kinds[0] === 'PICTURE' && kinds[1] === 'MOTION', kinds.join(' | '));
  const blocks = await win.locator('.tl .blk').all();
  await blocks[1].click();
  const bb = await blocks[1].boundingBox();
  const ruler = await win.locator('.tl .bpmruler').boundingBox();
  await win.mouse.click(bb.x + bb.width * 0.3, ruler.y + ruler.height / 2);
  const prog = win.locator('section[aria-label="Program"]');
  let route = '';
  for (let i = 0; i < 40 && !/moshed/.test(route); i++) { await win.waitForTimeout(250); route = (await prog.innerText()).replace(/\s+/g, ' '); }
  check('the Program shows B moshed into A across the seam', /motion block · moshed/.test(route), route.slice(0, 120));
  await win.screenshot({ path: path.join(out, 'ab.png') });
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
  await win.screenshot({ path: path.join(out, 'error.png') }).catch(() => {});
} finally {
  run.kill();
}
console.log(failed ? `abparity: FAILED (${failed})` : 'abparity: all ok');
process.exitCode = failed ? 1 : 0;
