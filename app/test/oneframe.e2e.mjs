// P0-A (independent audit): a ONE-FRAME selection made in Source, brought in with "＋ Add block",
// must become a one-frame block from a one-frame slice — at 25, 30 and 60 fps, where one frame is
// under the old 0.04 s floor that silently turned it into a whole-file import. Drives the real UI
// path (Source scrub → I → . → O → Add block) against the real engine, one fresh profile per rate,
// each project adopting its clip's rate.
//   node app/test/oneframe.e2e.mjs                (dev build: node app/build.mjs first)
//   MOSHPIT_EXE=<built .exe> node app/test/oneframe.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-oneframe');
const media = path.join(out, 'media');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(media, { recursive: true });
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
// Default: 25 / 30 (fixtures) and 60 (generated). ONEFRAME_RATES="24000/1001,30000/1001,..." generates each.
const RATES = (process.env.ONEFRAME_RATES ?? '25,30,60').split(',');
const label = (r) => { const [n, d = '1'] = r.split('/'); return String(Math.round((Number(n) / Number(d)) * 1000) / 1000); };
for (const r of RATES) {
  const file = path.join(media, `clip-${label(r)}.mp4`);
  if (r === '25' || r === '30') fs.copyFileSync(path.join(root, 'fixtures', r === '25' ? 'src-b.mp4' : 'src-a.mp4'), file);
  else execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=${r}:duration=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
}

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

async function launch(ud) {
  const env = { ...process.env, MOSHPIT_LIBRARY: media };
  if (process.env.MOSHPIT_EXE) {
    const port = 9700 + Math.floor(Math.random() * 90);
    const child = spawn(process.env.MOSHPIT_EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
    let browser, win;
    for (let i = 0; i < 400 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 300)); } }
    // The packaged exe unpacks ~800 MB first: allow 120 s, and never leave an app running if attaching fails.
    if (!browser) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } throw new Error('could not attach to the app over CDP in 120 s'); }
    for (let i = 0; i < 100 && !win; i++) { win = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().includes('worker')); if (!win) await new Promise((r) => setTimeout(r, 200)); }
    return { win, pid: child.pid };
  }
  const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], env });
  return { win: await app.firstWindow(), pid: app.process().pid };
}

for (const r of RATES) {
  const rate = label(r);
  const { win, pid } = await launch(path.join(out, `ud-${rate}`));
  const errs = [];
  win.on('pageerror', (e) => errs.push(String(e)));
  try {
    await win.waitForSelector('.topbar', { timeout: 30000 });
    await win.keyboard.press('Alt+1');
    await win.locator('.gcell', { hasText: `clip-${rate}.mp4` }).click({ timeout: 60000 });
    // One frame: I at a frame, step one frame, O (OUT is exclusive, so [f, f+1) = one frame).
    const lane = win.locator('section[aria-label="Preview & slice"] .scrub');
    const lb = await lane.boundingBox();
    await lane.click({ position: { x: lb.width * 0.4, y: lb.height / 2 } });
    await win.keyboard.press('i');
    await win.keyboard.press('.');
    await win.keyboard.press('o');
    const read = (await win.locator('.convbar .selread').innerText()).replace(/\s+/g, ' ');
    check(`${rate} fps: the selection is exactly one frame`, /\bFrames\s+1\s+Duration\b/.test(await win.locator('.convbar .selread > .on > em').innerText()), read);
    await win.locator('.convbar').getByRole('button', { name: /Add block/ }).click();
    const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
    if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click(); // adopt the clip's rate
    const added = await win.locator('.toasts .toast', { hasText: /Added 1 f of clip-[\d.]+\.mp4 \[/ }).first().waitFor({ timeout: 120000 }).then(() => true, () => false);
    check(`${rate} fps: ＋ Add block brings in a one-frame SLICE (not the whole clip)`, added, await win.locator('.toasts').innerText().catch(() => ''));
    await win.keyboard.press('Alt+2');
    await win.locator('.tl .blk').first().waitFor({ timeout: 15000 });
    const blk = (await win.locator('.tl .blk').first().evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip'))) ?? '';
    check(`${rate} fps: the block is one frame long`, /· 1 f ×1/.test(blk), blk);
    const clip = (await win.locator('.clips .clip').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${rate} fps: the project clip is the slice, named for it`, /clip-[\d.]+\.mp4 \[/.test(clip) && (await win.locator('.clips .clip').count()) === 1, clip);
    // The name uses the readout's notation: IN–OUT timecode, OUT exclusive, so the ends differ.
    const [inTc, outTc] = await win.locator('.browse-selected-times .timecode').evaluateAll(times => times.map(time => time.textContent?.trim()));
    const named = /\[(\S+)–(\S+)\]/.exec(clip) ?? [];
    check(`${rate} fps: the slice name reads like the selection (${inTc}–${outTc}), ends distinct`, !!inTc && !!outTc && named[1] === inTc && named[2] === outTc && inTc !== outTc, named[0] ?? clip);
    const slot = (await win.locator('.loupe[data-loupe="A"] .zmeta').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${rate} fps: the slice's conform is one frame, not the file`, /\b1 f ·/.test(slot), slot);
    check(`${rate} fps: no page errors`, !errs.length, errs[0] ?? '');
  } catch (e) {
    check(`${rate} fps: ran to the end`, false, String(e).split('\n')[0]);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
}
console.log(failed ? `oneframe: ${failed} FAILED` : 'oneframe: all ok');
process.exit(failed ? 1 : 0);
