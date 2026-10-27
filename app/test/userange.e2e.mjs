// P0 (Waxy, 2026-10-07): "I set IN/OUT in Source, hit Use, and it imported the whole movie — twice".
// Mark IN/OUT on a raw file → Send to A → only that slice is conformed, the block spans only it, a
// second Send of the same slice adds nothing, and rendering it finishes with a file of its length.
//   node app/test/userange.e2e.mjs                (dev build: node app/build.mjs first)
//   MOSHPIT_EXE=<built .exe> node app/test/userange.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-userange');
const ud = path.join(out, 'userdata');
const exports = path.join(out, 'exports');
const ffprobe = process.env.FFPROBE ?? path.join(root, '..', '..', 'toolkit', 'bin', 'ffprobe.exe');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// This profile's Settings cache (where the transient preview slot lives) is under out/, never the real one.
const cache = path.join(out, 'cache'), previewDir = path.join(cache, 'preview');
fs.mkdirSync(path.join(ud, 'config'), { recursive: true });
fs.writeFileSync(path.join(ud, 'config', 'settings.json'), JSON.stringify({ paths: { cache } }));
const previews = () => (fs.existsSync(previewDir) ? fs.readdirSync(previewDir).filter((f) => f.endsWith('.mp4')) : []);
const env = { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures') };

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

let win, pid;
if (process.env.MOSHPIT_EXE) {
  const port = 9950 + Math.floor(Math.random() * 40);
  const child = spawn(process.env.MOSHPIT_EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  pid = child.pid;
  let browser;
  for (let i = 0; i < 400 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 300)); } }
  // The packaged exe unpacks ~800 MB first: allow 120 s, and never leave an app running if attaching fails.
  if (!browser) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } throw new Error('could not attach to the app over CDP in 120 s'); }
  for (let i = 0; i < 100 && !win; i++) { win = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().includes('worker')); if (!win) await new Promise((r) => setTimeout(r, 200)); }
} else {
  const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], env });
  win = await app.firstWindow();
  pid = app.process().pid;
}
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));
const tStart = Date.now();
const toast = (re) => win.locator('.toasts .toast', { hasText: re }).first().waitFor({ timeout: 120000 }).then(() => true, () => false);

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'src-a.mp4' }).click({ timeout: 60000 });
  // src-a: 10 s at 30 fps. Mark 25 %..50 % of the raw file: 2.5 s.
  const lane = win.locator('section[aria-label="Preview & slice"] .scrub');
  const lb = await lane.boundingBox();
  await lane.click({ position: { x: lb.width * 0.25, y: lb.height / 2 } });
  await win.keyboard.press('i');
  await lane.click({ position: { x: lb.width * 0.5, y: lb.height / 2 } });
  await win.keyboard.press('o');
  const use = win.locator('.convbar').getByRole('button', { name: /^Send to A/ });
  const label = await use.innerText();
  check('Send to A names the exact selection it sends', /Send to A · 2\.50 s/i.test(label), label);
  const read = (await win.locator('.convbar .selread').innerText()).replace(/\s+/g, ' ');
  check('the readout shows the whole source and the selection in frames', /Frames\s+300\s+Rate\b/.test(read) && /Frames\s+75\s+Duration\s+2\.50\s+s\b/.test(read), read);
  await use.click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  check('the slice imports', await toast(/src-a\.mp4 \[\d\d:\d\d:\d\d:\d\d–\d\d:\d\d:\d\d:\d\d\] (is in the project|conformed)/));
  check('Source notes the slice in the project and keeps Send for the next one', /1 slice of this file/.test(await win.locator('.convbar').innerText()) && (await use.count()) === 1);

  // A second Send of the same slice adds nothing.
  await use.click();
  check('Send of the same slice again adds no second copy', await toast(/already in the project/));

  await win.keyboard.press('Alt+2');
  const clips = win.locator('.clips .clip');
  check('Compose holds exactly one clip, named for its slice', (await clips.count()) === 1 && /src-a\.mp4 \[/.test(await clips.first().innerText()), await clips.first().innerText().catch(() => ''));
  await clips.first().click();
  const meta = await win.locator('.loupe[data-loupe="A"] .zmeta').innerText();
  const frames = Number(/(\d+) f ·/.exec(meta)?.[1]);
  check('the clip is the slice only: 2.5 s = 75 frames, not 300', Math.abs(frames - 75) <= 1, meta.replace(/\s+/g, ' '));
  check('its IN/OUT span the slice', /IN 00:00:00:00/.test(meta), meta.replace(/\s+/g, ' '));
  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();
  const blk = await win.locator('.tl .blk').first().getAttribute('title');
  check('the block spans the whole slice, last frame included (75 f)', /\b75 f\b/.test(blk ?? ''), blk ?? '');

  // Windows-style shortcut labels on the workspace tabs.
  const tabs = await win.locator('.wsswitch').innerText();
  check('workspace tabs show Alt+1 / Alt+2 / Alt+3, not the Mac ⌥', /Alt\+1/i.test(tabs) && !/⌥/.test(tabs), tabs.replace(/\s+/g, ' '));
  check('workspaces read IN · MOSH · OUT (Waxy), not Source / Compose / Render', [/(^|\s)IN(\s|$)/, /MOSH/, /(^|\s)OUT(\s|$)/].every((r) => r.test(tabs)) && !/SOURCE|COMPOSE|RENDER/.test(tabs), tabs.replace(/\s+/g, ' '));

  // Right-click a block: the common actions, Delete among them.
  await win.locator('.tl .blk').first().click({ button: 'right' });
  const menu = await win.locator('.ctxmenu').innerText().catch(() => '');
  check('right-clicking a block offers its actions, Delete among them', /Delete block/.test(menu) && /Duplicate/.test(menu) && /Open graph/.test(menu), menu.replace(/\s+/g, ' · '));
  await win.keyboard.press('Escape');

  // Quick render: the selected block through the export, played in the overlay.
  await win.locator('.quickbtn').click();
  const playing = await win.waitForFunction(() => { const v = document.querySelector('.quickov video'); return !!v && v.readyState >= 2 && v.videoWidth === 960; }, null, { timeout: 120000 }).then(() => true, () => false);
  check('Quick render plays the rendered block (960×540) in an overlay', playing, await win.locator('.quickhd').innerText().catch(() => 'no overlay'));
  await win.keyboard.press('Escape');
  // F5: Preview is one transient slot. A second preview replaces the first; Render lists neither.
  const firstPreview = previews();
  await win.locator('.quickbtn').click();
  const again = await win.waitForFunction(() => { const v = document.querySelector('.quickov video'); return !!v && v.readyState >= 2; }, null, { timeout: 120000 }).then(() => true, () => false);
  await win.keyboard.press('Escape');
  check('a second Preview replaces the first: one file in the preview slot', again && firstPreview.length === 1 && previews().length === 1, `${firstPreview.join(',')} → ${previews().join(',')}`);
  await win.keyboard.press('Alt+3');
  await win.locator('.ws-render').waitFor({ timeout: 10000 });
  check('previews are not listed with the committed renders', (await win.locator('.rtable tbody tr').count()) === 0, `${await win.locator('.rtable tbody tr').count()} rows`);
  check('previews never land in the output folder', !fs.existsSync(exports) || !fs.readdirSync(exports).some((f) => f.startsWith('preview_')));
  await win.keyboard.press('Alt+2');

  // Delete key removes the selected block; Undo brings it back.
  await win.locator('.tl .blk').first().click();
  await win.keyboard.press('Delete');
  const gone = (await win.locator('.tl .blk').count()) === 0;
  await win.locator('.toasts .toast', { hasText: 'Deleted Block 1' }).getByRole('button', { name: 'Undo' }).click();
  check('Delete removes the selected block and Undo restores it', gone && (await win.locator('.tl .blk').count()) === 1);

  // Render it: real progress, then a file of the slice's length.
  await win.keyboard.press('Alt+3');
  await win.locator('.exprow button[aria-haspopup="menu"]').first().click();
  await win.keyboard.press('3'); // H.264
  const dir = win.locator('.exprow .pathfld input').last();
  await dir.fill(exports);
  await dir.blur();
  // Follow the row this click adds, not the last one there.
  const rows = win.locator('.rtable tbody tr');
  const before = await rows.count();
  const t0 = Date.now();
  await win.getByRole('button', { name: /Render · add job/ }).click();
  await win.waitForFunction((n) => document.querySelectorAll('.rtable tbody tr').length > n, before, { timeout: 10000 });
  const last = rows.nth(before);
  const done = await last.locator('.st.done, .st.fail').waitFor({ timeout: 10 * 60000 }).then(() => true, () => false);
  const row = await last.innerText();
  check(`Render · add job renders at once and finishes (${((Date.now() - t0) / 1000).toFixed(1)} s)`, done && /done/.test(row), row.replace(/\s+/g, ' '));
  const mp4 = fs.existsSync(exports) ? fs.readdirSync(exports).find((f) => f.endsWith('.mp4')) : undefined;
  const dur = mp4 && fs.existsSync(ffprobe) ? Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(exports, mp4)], { encoding: 'utf8' }).trim()) : NaN;
  check('the export is the slice long (≈2.5 s)', Math.abs(dur - 2.5) < 0.2, `${mp4} ${dur} s`);
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `userange: ${failed} FAILED` : 'userange: all ok');
process.exit(failed ? 1 : 0);
