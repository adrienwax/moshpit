// Phase C: the SOURCE browser looks at raw files with no import. Real engine, real footage.
//   thumbnails + hover-scrub + the preview (snap → exact) with zero importClip calls
//   decoders released from the UI side: only the preview pane's file stays open; none after leaving
//   favourites (right-click → pinned, saved to disk) · dragging a clip selects no text
//   IN/OUT marked on the raw file show on the slice track, and on Compose's clip timeline after Use
//   node app/test/preview-browser.e2e.mjs        MOSHPIT_EXE=<exe> for the packaged build
import { _electron as electron, chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Test windows open off-screen and never take focus (electron/main.ts).
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const real = process.env.MOSHPIT_REAL_FOOTAGE ?? path.join(root, '..', 'moshpit-v3-spike', 'fixtures-real');
const out = path.join(root, 'out', 'app-preview-browser');
const userData = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const env = { ...process.env, MOSHPIT_LIBRARY: [real, path.join(root, 'fixtures')].join(path.delimiter) };
const exe = process.env.MOSHPIT_EXE;
let pid, win;
if (exe) {
  pid = spawn(exe, [`--user-data-dir=${userData}`, '--remote-debugging-port=9338'], { env, stdio: 'ignore' }).pid;
  let browser;
  for (let i = 0; i < 120 && !browser; i++) browser = await chromium.connectOverCDP('http://127.0.0.1:9338').catch(() => new Promise((r) => setTimeout(r, 1000)));
  for (let i = 0; i < 60 && !win; i++) {
    win = browser?.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith('index.html'));
    if (!win) await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`packaged: ${exe}`);
} else {
  const app = await electron.launch({ args: [path.join(root, 'app/dist/main.cjs'), `--user-data-dir=${userData}`], cwd: root, timeout: 30000, env });
  pid = app.process().pid;
  win = await app.firstWindow();
}
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

const folder = async (name) => {
  await win.keyboard.press('Alt+1');
  await win.locator('.tnode', { hasText: new RegExp(String.raw`^\W?${name.replace(/-/g, '\\-')}\d+$`) }).first().click({ timeout: 30000 });
  await win.locator('.gcell').first().waitFor({ timeout: 60000 });
};
const openPreviews = () => win.evaluate(() => window.__moshpitPreview.open());

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  await win.evaluate(() => {
    const e = window.__moshpitEngine;
    window.__calls = { importClip: 0, previewFrame: 0 };
    for (const m of ['importClip', 'previewFrame']) {
      const f = e[m].bind(e);
      e[m] = (...a) => (window.__calls[m]++, f(...a));
    }
  });

  // ---------- raw browsing: thumbnails, hover-scrub, preview — no import ----------
  await folder('fixtures-real');
  const cells = win.locator('.gcell');
  await win.waitForFunction(() => document.querySelectorAll('.gcell .cellthumb canvas:not(.hidden), .gcell .cellthumb img').length === document.querySelectorAll('.gcell').length, null, { timeout: 60000 }).catch(() => {});
  const missing = await win.evaluate(() => [...document.querySelectorAll('.gcell')].filter((c) => !c.querySelector('.cellthumb canvas:not(.hidden), .cellthumb img')).map((c) => c.querySelector('.nm')?.textContent));
  check('every cell shows a real thumbnail of the raw file', missing.length === 0, `${await cells.count()} cells${missing.length ? `; none for ${missing.join(', ')}` : ''}`);
  const target = win.locator('.gcell', { hasText: 'ocean-1min-4k.mp4' });
  const box = await target.locator('.cellthumb').boundingBox();
  const before = await win.evaluate(() => window.__calls.previewFrame);
  for (let i = 1; i <= 8; i++) {
    await win.mouse.move(box.x + (box.width * i) / 9, box.y + box.height / 2);
    await win.waitForTimeout(60);
  }
  const hovered = (await win.evaluate(() => window.__calls.previewFrame)) - before;
  check('hovering a raw cell scrubs it (preview frames requested, scrub line shown)', hovered >= 4 && (await target.locator('.cellscrub').count()) === 1, `${hovered} frame requests over 8 moves`);
  await target.click();
  const badge = win.locator('.frameview.raw .rawbadge');
  await badge.waitFor({ timeout: 20000 });
  await win.waitForFunction(() => /exact frame/.test(document.querySelector('.frameview.raw .rawbadge')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
  check('the preview shows the raw file, settling on the exact frame (raw ≈ labelled)', /raw ≈ exact frame/.test(await badge.innerText()), await badge.innerText());
  check('…with RGB parade, histogram and vectorscope above the preview', (await win.locator('.fitpane > .scope-panel .scope-plot canvas').count()) === 3);
  check('no import happened: looking never conforms', (await win.evaluate(() => window.__calls.importClip)) === 0);
  // Regression: the engine serves a repeat from its frame cache (the same object); the bridge must
  // send a copy, or the second request fails on a detached buffer.
  const twice = await win.evaluate(async (file) => {
    const e = window.__moshpitEngine;
    const a = await e.previewFrame(file, 12.5, { size: { w: 320, h: 180 } });
    const b = await e.previewFrame(file, 12.5, { size: { w: 320, h: 180 } });
    e.closePreview(file);
    return [!!a?.image, !!b?.image];
  }, path.join(real, 'gopro-uw-1080p.mp4'));
  check('the same raw frame twice works (cached frame sent as a copy)', twice[0] && twice[1], JSON.stringify(twice));

  // Frame step (Waxy, 2026-10-08): `,` / `.` flashed the keyframe snap (a different frame) before the
  // exact one, and read one frame early (n / fps under the sample's timestamp; GoPro's 0.033 s start).
  // Every frame the pane draws after a step must be the exact target, nothing in between. The GoPro
  // file is 29.97 with a non-zero start, so both causes are in play.
  await win.locator('.gcell', { hasText: 'gopro-uw-1080p.mp4' }).first().click();
  await win.waitForFunction(() => /exact frame/.test(document.querySelector('.frameview.raw .rawbadge')?.textContent ?? ''), null, { timeout: 20000 });
  await win.evaluate(() => (window.__moshpitRawDraws = []));
  await win.keyboard.press('.'); // the first step: its frame is the start the others count from
  await win.waitForTimeout(600);
  const GOPRO = 30000 / 1001;
  const steps = [];
  for (const [key, d] of [['.', 1], ['.', 1], ['.', 1], [',', -1], ['.', 1]]) {
    const before = await win.evaluate(() => window.__moshpitRawDraws.length);
    await win.keyboard.press(key);
    await win.waitForTimeout(600);
    steps.push({ d, draws: await win.evaluate((n) => window.__moshpitRawDraws.slice(n), before) });
  }
  const frameOf = (t) => Math.round(t * GOPRO); // the shown frame's start, from the first frame
  const start = await win.evaluate(() => window.__moshpitRawDraws.slice(0, 1));
  let at = start.length ? frameOf(start[0].time) : NaN;
  const bad = [];
  for (const s of steps) {
    at += s.d;
    if (!s.draws.length || s.draws.some((x) => !x.exact || frameOf(x.time) !== at)) bad.push({ want: at, got: s.draws.map((x) => `${x.exact ? 'e' : 'k'}${frameOf(x.time)}`) });
  }
  check('a frame step draws only the exact target ±1 (no snap, no overshoot)', start.length === 1 && start[0].exact && Math.abs(start[0].time * GOPRO - frameOf(start[0].time)) < 0.05 && bad.length === 0, `start f${start.length ? frameOf(start[0].time) : '?'} · ${bad.length ? JSON.stringify(bad) : '+1 +1 +1 −1 +1, every draw exact'}`);
  // Held key: three quick steps land on +3, and every frame drawn on the way is exact and in order.
  const held0 = await win.evaluate(() => window.__moshpitRawDraws.length);
  for (let i = 0; i < 3; i++) await win.keyboard.press('.');
  await win.waitForTimeout(800);
  const held = await win.evaluate((n) => window.__moshpitRawDraws.slice(n), held0);
  const hf = held.map((x) => frameOf(x.time));
  check('…held: three quick steps end on +3, exact frames only, never backwards', held.length > 0 && held.every((x) => x.exact) && hf.at(-1) === at + 3 && hf.every((f, i) => i === 0 || f >= hf[i - 1]), hf.join(' → '));
  await win.evaluate(() => (window.__moshpitRawDraws = undefined));
  await target.click(); // back to the ocean clip: the decoder checks below expect it pinned

  // ---------- decoders, UI side ----------
  for (const name of ['gopro-uw-1080p.mp4', 'ocean-20min-1080p.mp4', 'gopro-uw-1080p-refs1.mp4']) {
    const b = await win.locator('.gcell', { hasText: name }).locator('.cellthumb').boundingBox();
    for (let i = 1; i <= 4; i++) await win.mouse.move(b.x + (b.width * i) / 5, b.y + b.height / 2);
    await win.waitForTimeout(200);
  }
  await win.mouse.move(5, 300);
  await win.waitForTimeout(400);
  const open1 = await openPreviews();
  check('after hovering other cells, only the preview pane keeps a decoder open', open1.length === 1 && /ocean-1min-4k/.test(open1[0]), JSON.stringify(open1.map((p) => path.basename(p))));
  await win.keyboard.press('Alt+2');
  await win.waitForTimeout(500);
  check('leaving Source releases it too (no decoder left open)', (await openPreviews()).length === 0, JSON.stringify(await openPreviews()));

  // ---------- favourites ----------
  await win.keyboard.press('Alt+1');
  await win.locator('.tnode', { hasText: /^\W?fixtures-real\d+$/ }).first().click({ button: 'right' });
  await win.getByRole('menuitem', { name: /Add to Favourites/ }).click();
  const fav = win.locator('[aria-label="Favourites"] .place', { hasText: 'fixtures-real' });
  check('right-click a folder → Add to Favourites pins it in Places', (await fav.count()) === 1);
  await win.waitForTimeout(800);
  const settings = JSON.parse(fs.readFileSync(path.join(userData, 'config', 'settings.json'), 'utf8'));
  check('…and it is saved to settings.json', settings.favourites?.some((f) => /fixtures-real$/.test(f)), JSON.stringify(settings.favourites));

  // ---------- dragging a clip selects no text ----------
  const nm = win.locator('.gcell .gm .nm').first();
  const nb = await nm.boundingBox();
  await win.mouse.move(nb.x + 4, nb.y + nb.height / 2);
  await win.mouse.down();
  await win.mouse.move(nb.x + nb.width - 4, nb.y + nb.height / 2, { steps: 8 });
  await win.mouse.up();
  check('a drag across a clip cell selects no text', (await win.evaluate(() => window.getSelection()?.toString() ?? '')) === '');

  // ---------- IN/OUT: raw slice → Use → Compose clip timeline ----------
  await folder('fixtures');
  await win.locator('.gcell', { hasText: 'src-b.mp4' }).click();
  const lane = win.locator('section[aria-label="Preview & slice"] .scrub');
  const lb = await lane.boundingBox();
  await lane.click({ position: { x: lb.width * 0.25, y: lb.height / 2 } });
  await win.keyboard.press('i');
  await lane.click({ position: { x: lb.width * 0.6, y: lb.height / 2 } });
  await win.keyboard.press('o');
  check('IN/OUT marked on the raw file show on its slice track', (await lane.locator('.mkh').count()) >= 2, `${await lane.locator('.mkh').count()} marks`);
  await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.convbar .hdnote').waitFor({ timeout: 120000 });
  check('Use imports it — the only import in the run', (await win.evaluate(() => window.__calls.importClip)) === 1);
  await win.keyboard.press('Alt+2');
  await win.locator('.clip', { hasText: 'src-b.mp4' }).click();
  const zt = win.locator('.loupe').first();
  await zt.locator('.ztrack .mkh.in .flag').waitFor({ timeout: 15000 }).catch(() => {});
  const zio = await zt.locator('.zmeta .zio').innerText().catch(() => '');
  check("Compose's clip timeline shows the IN/OUT (labelled flags + timecodes)", (await zt.locator('.ztrack .mkh.in .flag').count()) === 1 && (await zt.locator('.ztrack .mkh.out .flag').count()) === 1 && /IN .* OUT/.test(zio), zio);
  // ---------- the preview takes the clip's shape (portrait clip → portrait box) ----------
  await folder('fixtures');
  await win.locator('.gcell', { hasText: 'pv-rot90.mp4' }).click();
  await win.locator('.frameview.raw .rawbadge').waitFor({ timeout: 20000 });
  const pv = await win.locator('.pvstage > .frameview.bigpv').boundingBox();
  check('a portrait (rotated) clip gets a portrait picture box — no side letterbox', pv.height > pv.width * 1.5, `${Math.round(pv.width)}×${Math.round(pv.height)}`);

  // ---------- thumbnail size slider ----------
  const w0 = (await win.locator('.gcell').first().boundingBox()).width;
  await win.locator('.cellsize input').fill('296');
  await win.waitForTimeout(300);
  const w1 = (await win.locator('.gcell').first().boundingBox()).width;
  check('the size slider changes the thumbnails', w1 > w0 + 40, `${Math.round(w0)} → ${Math.round(w1)} px`);
  await win.locator('.cellsize input').fill('168');

  // ---------- multi-select → Add N clips ----------
  await win.locator('.gcell', { hasText: 'src-a.mp4' }).click();
  await win.locator('.gcell', { hasText: 'src-c.mp4' }).click({ modifiers: ['Control'] });
  const addN = win.locator('.picktools .pop', { hasText: /Add 2 entire clips/ });
  check('Ctrl-click two clips → an "Add 2 entire clips" action', (await addN.count()) === 1 && (await win.locator('.gcell.picked').count()) === 2);
  await addN.click();
  await win.keyboard.press('Alt+2');
  await win.locator('.clip', { hasText: 'src-a.mp4' }).waitFor({ timeout: 120000 }).catch(() => {});
  await win.locator('.clip', { hasText: 'src-c.mp4' }).waitFor({ timeout: 120000 }).catch(() => {});
  check('Add 2 clips imports both (background jobs) into the project', (await win.locator('.clip', { hasText: /src-[ac]\.mp4/ }).count()) === 2 && (await win.evaluate(() => window.__calls.importClip)) === 3);

  // ---------- From Compose's Library: a raw clip is marked in Source (nothing is sent unselected) ----------
  await win.getByRole('tab', { name: 'Library' }).click();
  const row = win.locator('.librow', { hasText: 'src-cuts.mp4' });
  await row.getByRole('button', { name: /Mark in IN/ }).click();
  await win.locator('.stage.ws-browse').waitFor({ timeout: 5000 }).catch(() => {});
  const sel = await win.locator('.convbar .selread').innerText().catch(() => '');
  check('Compose → Library → Mark in Source opens Source on that clip, nothing sent yet', /browse/.test(await win.locator('.stage').getAttribute('class')) && /src-cuts\.mp4/.test(await win.locator('.convbar .pathfld input').inputValue()) && /nothing/i.test(sel), sel.replace(/\s+/g, ' '));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `preview-browser: ${failed} FAILED` : 'preview-browser: all ok');
process.exit(failed ? 1 : 0);
