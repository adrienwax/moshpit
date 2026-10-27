// P0 (Waxy, 2026-10-07): "render sat on an empty bar". An export waits for its clips' full-quality
// masters; that wait used to report nothing (bar at 0 %) and to block the worker's queue, so every
// frame request stalled behind it. Now: real conform progress in the job, frames keep coming, then
// the encode runs and finishes.
//   node app/test/renderwait.e2e.mjs                (dev build: node app/build.mjs first)
//   MOSHPIT_EXE=<built .exe> node app/test/renderwait.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-renderwait');
const ud = path.join(out, 'userdata');
const exports = path.join(out, 'exports');
const real = path.join(root, '..', 'moshpit-v3-spike', 'fixtures-real');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, MOSHPIT_LIBRARY: real };

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

let win, pid;
if (process.env.MOSHPIT_EXE) {
  const port = 9990 + Math.floor(Math.random() * 8);
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

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'gopro-uw-1080p.mp4' }).click({ timeout: 60000 });
  // The source-range contract: with nothing marked, nothing can be sent (no implicit whole file).
  const sendA = win.locator('.convbar').getByRole('button', { name: /^Send to A/ });
  check('with nothing selected, Send to A is disabled (never the whole file by default)', await sendA.isDisabled());
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  check('Select entire clip makes the whole file the explicit selection', /entire clip/.test(await win.locator('.convbar .selread').innerText()), (await win.locator('.convbar .selread').innerText()).replace(/\s+/g, ' '));
  await sendA.click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.toasts .toast', { hasText: /usable now/ }).first().waitFor({ timeout: 180000 });

  await win.keyboard.press('Alt+2');
  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.io:not(.o)').click();
  const tr = win.locator('.loupe[data-loupe="A"] .ztrack');
  const tb = await tr.boundingBox();
  await tr.click({ position: { x: tb.width * 0.1, y: tb.height * 0.7 } });
  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.io.o').click();
  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();

  await win.keyboard.press('Alt+3');
  await win.locator('.exprow button[aria-haspopup="menu"]').first().click();
  await win.keyboard.press('3'); // H.264
  const dir = win.locator('.exprow .pathfld input').last();
  await dir.fill(exports);
  await dir.blur();
  await win.getByRole('button', { name: /Render · add job/ }).click();
  const row = win.locator('.rtable tbody tr').first();
  // Every sample while rendering names a stage and lights it (an empty bar read as "stuck").
  const seen = [], stages = [];
  let unlit = 0;
  for (let i = 0; i < 60; i++) {
    const t = await row.locator('.st').innerText().catch(() => '');
    if (/done|fail/i.test(t)) break;
    const cur = await row.locator('.stagebar .stg.cur i').innerText().catch(() => '');
    if (!cur) unlit++;
    else if (stages.at(-1) !== cur.toLowerCase()) stages.push(cur.toLowerCase());
    const m = /Conform (\d+)%/i.exec(t);
    if (m) seen.push(+m[1]);
    if (seen.length >= 3 && seen.at(-1) > seen[0] && i > 8) break;
    await win.waitForTimeout(1000);
  }
  check('waiting on the master, the job is in the Conform stage with a rising %', seen.length >= 2 && seen.at(-1) > seen[0], seen.join(' → ') || 'never shown');
  check('every sample shows a lit stage (never an empty bar)', unlit === 0, `stages ${stages.join(' → ')}, unlit samples ${unlit}`);
  // The engine is not blocked while it waits: a fresh frame arrives in Compose.
  await win.keyboard.press('Alt+2');
  const t0 = Date.now();
  await tr.click({ position: { x: tb.width * 0.6, y: tb.height * 0.7 } });
  const drew = await win.waitForFunction(() => {
    const c = document.querySelector('.loupe[data-loupe="A"] .slotframe canvas');
    return !!c && !document.querySelector('.loupe[data-loupe="A"] .slotframe .frameerr') && /f 0*\d+/.test(document.querySelector('.loupe[data-loupe="A"] .slotframe')?.textContent ?? '');
  }, null, { timeout: 15000 }).then(() => true, () => false);
  const stillWaiting = /conform \d+%/i.test(await win.locator('.statusstrip').innerText());
  check(`frames still come while the export waits (${((Date.now() - t0) / 1000).toFixed(1)} s)`, drew, stillWaiting ? 'export still waiting on the master' : 'master may have finished');
  await win.keyboard.press('Alt+3');
  const done = await win.locator('.rtable .st.done, .rtable .st.fail').first().waitFor({ timeout: 15 * 60000 }).then(() => true, () => false);
  check('then the export finishes', done && /done/i.test(await win.locator('.rtable tbody tr').first().innerText()), await win.locator('.rtable tbody tr').first().innerText().catch(() => ''));
  // Phase 0.4, read-only sources: whatever path the UI sends, the engine refuses to render onto a
  // source (SOURCE_PROTECTED) or onto a file that exists (EXPORT_EXISTS), and touches neither.
  const src = path.join(real, 'gopro-uw-1080p.mp4');
  const made = path.join(exports, fs.readdirSync(exports).find((f) => f.endsWith('.mp4')) ?? 'none.mp4');
  const stamp = (p) => { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; } };
  const before = [stamp(src), stamp(made)];
  const tryRender = (outPath) => win.evaluate(async (o) => {
    try {
      await window.__moshpitEngine.render({ id: `guard-${Math.random()}`, name: 'guard', config: { format: 'mp4-h264', width: 320, height: 180, audio: false }, outPath: o }, () => {}).promise;
      return 'rendered';
    } catch (e) { return e?.code ?? String(e); }
  }, outPath);
  const r1 = await tryRender(src), r2 = await tryRender(made);
  check('the engine refuses a render onto a source and onto an existing export', r1 === 'SOURCE_PROTECTED' && r2 === 'EXPORT_EXISTS', `${r1} · ${r2}`);
  check('…and neither file changed (size + mtime)', stamp(src) === before[0] && stamp(made) === before[1] && before[1] !== 'missing', before.join(' · '));
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `renderwait: ${failed} FAILED` : 'renderwait: all ok');
process.exit(failed ? 1 : 0);
