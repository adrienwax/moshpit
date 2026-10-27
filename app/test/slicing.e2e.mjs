// Phase E slicing: A and B both sliceable (Waxy: "only slices from A"), the timeline kit (ticks,
// IN/OUT handles, wheel zoom, zoom navigator) on the clip timelines, the slice track and the
// arrangement, and grabbable panel handles.
//   node app/test/slicing.e2e.mjs                (dev build: node app/build.mjs first)
//   MOSHPIT_EXE=<built .exe> node app/test/slicing.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-slicing');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures') };

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

let win, pid;
if (process.env.MOSHPIT_EXE) {
  const port = 9800 + Math.floor(Math.random() * 150);
  const child = spawn(process.env.MOSHPIT_EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  pid = child.pid;
  let browser;
  for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 300)); } }
  for (let i = 0; i < 100 && !win; i++) { win = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().includes('worker')); if (!win) await new Promise((r) => setTimeout(r, 200)); }
} else {
  const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], env });
  win = await app.firstWindow();
  pid = app.process().pid;
}
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));

let selFrames = 0;
const importClip = async (file, to = 'A', range = false) => {
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: file }).click({ timeout: 60000 });
  if (range) { // a real I/O selection over the middle half, so the slice path (opts.range) is exercised
    const lane = win.locator('section[aria-label="Preview & slice"] .scrub');
    const lb = await lane.boundingBox();
    await lane.click({ position: { x: lb.width * 0.25, y: lb.height / 2 } }); await win.keyboard.press('i');
    await lane.click({ position: { x: lb.width * 0.75, y: lb.height / 2 } }); await win.keyboard.press('o');
    selFrames = Number(/Frames\s+(\d+)\s+Duration\b/.exec(await win.locator('.convbar .selread > .on > em').innerText())?.[1]);
  } else await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: new RegExp('^Send to ' + to) }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.convbar .hdnote').waitFor({ timeout: 120000 });
};
const zio = (w) => win.locator(`.loupe[data-loupe="${w}"] .zio`).innerText();

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  if (!process.env.MOSHPIT_EXE) await win.setViewportSize({ width: 1920, height: 1080 });
  await importClip('src-a.mp4', 'A', true);
  await importClip('src-b.mp4', 'B');
  await win.keyboard.press('Alt+2');
  await win.locator('.loupe[data-loupe="B"] .ztrack').waitFor({ timeout: 15000 });
  // A arrives as the I/O slice it was sent as; B as the entire clip (an explicit selection either way).
  const aMeta = (await win.locator('.loupe[data-loupe="A"] .zmeta').innerText()).replace(/\s+/g, ' ');
  check(`slot A holds the sent RANGE (${selFrames} f), not the 300 f file`, selFrames > 1 && selFrames < 300 && aMeta.includes(` ${selFrames} f ·`), aMeta);
  const aBefore = await zio('A');
  check('the last Send makes its loupe the slice target (B)', (await win.locator('.loupe[data-loupe="B"] .tag.slicing').count()) === 1);

  // ---------- slice B (the reported bug) ----------
  const bt = win.locator('.loupe[data-loupe="B"] .ztrack');
  const bb = await bt.boundingBox();
  await bt.click({ position: { x: bb.width * 0.25, y: bb.height * 0.7 } });
  check('touching loupe B makes it the slice target', (await win.locator('.loupe[data-loupe="B"] .tag.slicing').count()) === 1);
  await win.keyboard.press('i');
  await bt.click({ position: { x: bb.width * 0.75, y: bb.height * 0.7 } });
  await win.keyboard.press('o');
  const bMarks = await zio('B');
  check('I / O keys mark clip B', /^IN .* OUT /.test(bMarks), bMarks);
  check("…and leave clip A's own range as it was", (await zio('A')) === aBefore, `${aBefore} → ${await zio('A')}`);
  check('slot B carries its own IN/OUT handles (the slice tier is folded into the slots)', (await win.locator('.loupe[data-loupe="B"] .mkh.in').count()) === 1);

  // ---------- drag B's OUT handle ----------
  const outH = win.locator('.loupe[data-loupe="B"] .mkh.out');
  const ob = await outH.boundingBox();
  await win.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await win.mouse.down();
  await win.mouse.move(ob.x - bb.width * 0.2, ob.y + ob.height / 2, { steps: 6 });
  await win.mouse.up();
  const dragged = await zio('B');
  check('dragging the OUT handle moves OUT (and only OUT)', dragged !== bMarks && dragged.split('·')[0] === bMarks.split('·')[0], `${bMarks} → ${dragged}`);

  // ---------- B's slice into the arrangement ----------
  await win.locator('.loupe[data-loupe="B"] .ztools .tbtn.pop').click();
  const toast = await win.locator('.toasts .toast', { hasText: 'slice of src-b.mp4' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('⤓ block on loupe B adds a block cut from src-b', toast && (await win.locator('.tl .blk').count()) === 1);

  // ---------- A is just as sliceable ----------
  await win.locator('.loupe[data-loupe="A"] .lbl').click(); // touching slot A makes it the target
  const at = win.locator('.loupe[data-loupe="A"] .ztrack');
  const ab = await at.boundingBox();
  await at.click({ position: { x: ab.width * 0.1, y: ab.height * 0.7 } });
  await win.keyboard.press('i');
  await at.click({ position: { x: ab.width * 0.4, y: ab.height * 0.7 } });
  await win.keyboard.press('o');
  check('A marks independently once it is the target', /^IN /.test(await zio('A')) && (await zio('A')) !== aBefore && (await zio('B')) === dragged, `A ${await zio('A')} | B ${await zio('B')} vs ${dragged}`);

  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();
  await win.locator('.tl .blk').nth(1).waitFor({ timeout: 5000 });
  check('a fitted arrangement stays fitted as blocks are added (1.0×)', (await win.locator('.tlnav .zx').innerText()) === '1.0×', await win.locator('.tlnav .zx').innerText());

  // ---------- ticks ----------
  const majors = await win.locator('.loupe[data-loupe="B"] .ticks .tk.major').count();
  const minors = await win.locator('.loupe[data-loupe="B"] .ticks .tk.minor').count();
  check('clip timeline ruler has major (labelled) and minor ticks', majors >= 2 && minors >= 2 && /\d:\d\d/.test(await win.locator('.loupe[data-loupe="B"] .ticks .tk.major span').first().innerText()), `${majors} major · ${minors} minor`);
  const bars = await win.locator('.tl .ticks.music .tk.major span').allInnerTexts();
  check('arrangement ruler is musical: bar or bar.beat labels, never repeated', bars.length > 0 && bars.every((t) => /^\d+(\.[234])?$/.test(t)) && new Set(bars).size === bars.length, bars.join(' '));

  // ---------- wheel zoom + navigator ----------
  const zx = () => win.locator('.loupe[data-loupe="B"] .zbtns .zx').innerText();
  const z0 = await zx();
  const major0 = Number(await win.locator('.loupe[data-loupe="B"] .ticks').getAttribute('data-major'));
  await bt.hover({ position: { x: bb.width * 0.5, y: bb.height * 0.7 } });
  for (let i = 0; i < 4; i++) await win.mouse.wheel(0, -100);
  await win.waitForTimeout(150);
  const z1 = await zx();
  check('wheel up over the clip track zooms in', parseFloat(z1) > parseFloat(z0), `${z0} → ${z1}`);
  const fineAfter = await win.locator('.loupe[data-loupe="B"] .ticks').getAttribute('data-major');
  const zl = await win.locator('.loupe[data-loupe="B"] .ticks .tk.major span').allInnerTexts();
  check('zoomed-in ruler labels stay unique (frames shown under a second)', zl.length >= 1 && new Set(zl).size === zl.length, zl.join(' '));
  check('zoomed in, the ruler steps get finer', Number(fineAfter) < major0, `major every ${major0} f → ${fineAfter} f`);
  const view = () => win.locator('.loupe[data-loupe="B"] .zmeta span').nth(1).innerText();
  const v0 = await view();
  const navWin = win.locator('.loupe[data-loupe="B"] .zoomnav .znwin');
  const nb = await navWin.boundingBox();
  await win.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await win.mouse.down();
  await win.mouse.move(nb.x + nb.width / 2 - 60, nb.y + nb.height / 2, { steps: 5 });
  await win.mouse.up();
  check('dragging the navigator window pans the view', (await view()) !== v0, `${v0} → ${await view()}`);
  const rh = win.locator('.loupe[data-loupe="B"] .zoomnav .znh.r');
  const rb = await rh.boundingBox();
  await win.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await win.mouse.down();
  await win.mouse.move(rb.x + 80, rb.y + rb.height / 2, { steps: 5 });
  await win.mouse.up();
  check('dragging the navigator edge zooms out', parseFloat(await zx()) < parseFloat(z1), `${z1} → ${await zx()}`);
  // The zoomed, panned clip timeline draws its thumbnails promptly: superseded frame requests are
  // skipped by the worker instead of queueing ahead of them (measured, ceiling 8 s).
  const lum = () => win.evaluate(() => [...document.querySelectorAll('.loupe[data-loupe="B"] .ztrack .thumbs .frameview')].map((f) => {
    const c = f.querySelector('canvas'); const err = f.querySelector('.frameerr')?.textContent ?? '';
    if (!c || !c.width) return err ? 'err:' + err : 'empty';
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i] + d[i + 1] + d[i + 2];
    return Math.round(s / (d.length / 16));
  }));
  const tz = Date.now();
  let thumbs = await lum();
  while (!thumbs.every((t) => typeof t === 'number' && t > 30) && Date.now() - tz < 8000) { await win.waitForTimeout(200); thumbs = await lum(); }
  check(`the zoomed clip timeline draws its thumbnails (${((Date.now() - tz) / 1000).toFixed(1)} s after the last navigator drag)`, thumbs.every((t) => typeof t === 'number' && t > 30), JSON.stringify(thumbs));
  const tl = win.locator('.tl .tlview');
  await tl.hover();
  for (let i = 0; i < 3; i++) await win.mouse.wheel(0, -100);
  await win.waitForTimeout(150);
  check('the arrangement zooms with the wheel too', parseFloat(await win.locator('.tlnav .zx').innerText()) > 1, await win.locator('.tlnav .zx').innerText());

  await win.mouse.move(5, 300);
  await win.locator('.toasts .toast').first().waitFor({ state: 'detached', timeout: 12000 }).catch(() => {});
  await win.screenshot({ path: path.join(out, 'compose.png') });

  // ---------- panel handles ----------
  const split = win.locator('.vsplit').first();
  // The handle is subtle (presentation pass): at rest only the 1px gutter; hover lights its 1px line (::after).
  const line = () => split.evaluate((e) => getComputedStyle(e, '::after').backgroundColor);
  const before = await line();
  await split.hover();
  const hover = await line();
  check('a column handle lights up under the pointer', before !== hover, `${before} → ${hover}`);

  // ---------- Source's slicer has the same kit ----------
  await win.keyboard.press('Alt+1');
  await win.locator('.slicenav .zoomnav').waitFor({ timeout: 10000 });
  check('Source slice track carries ticks and the zoom navigator', (await win.locator('.scrub .ticks .tk.major').count()) >= 2);
  check('no page errors', !errs.length, errs[0] ?? '');
  await win.screenshot({ path: path.join(out, 'source.png') });
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `slicing: ${failed} FAILED` : 'slicing: all ok');
process.exit(failed ? 1 : 0);
