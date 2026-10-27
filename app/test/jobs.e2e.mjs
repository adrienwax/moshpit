// Background jobs survive navigation (audit B1/B6): start an import, leave Source at once, see it
// on the status strip, come back to live progress (not a fresh Import button), and it completes.
// Then the same for Detect cuts. Real engine, throwaway profile, off-screen window.
//   node app/test/jobs.e2e.mjs              (dev build: node app/build.mjs first)
//   MOSHPIT_EXE=<built .exe> node app/test/jobs.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Test windows open off-screen and never take focus (electron/main.ts).
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const real = process.env.MOSHPIT_REAL_FOOTAGE ?? path.join(root, '..', 'moshpit-v3-spike', 'fixtures-real');
const out = path.join(root, 'out', 'app-jobs');
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
  pid = spawn(exe, [`--user-data-dir=${userData}`, '--remote-debugging-port=9337'], { env, stdio: 'ignore' }).pid;
  let browser;
  for (let i = 0; i < 120 && !browser; i++) browser = await chromium.connectOverCDP('http://127.0.0.1:9337').catch(() => new Promise((r) => setTimeout(r, 1000)));
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

const folder = async (name) => {
  await win.keyboard.press('Alt+1');
  await win.locator('.tnode', { hasText: new RegExp(String.raw`^\W?${name.replace(/-/g, '\\-')}\d+$`) }).first().click({ timeout: 30000 });
};
const strip = () => win.locator('.statusstrip .job');

// A long clip with nothing marked asks before conforming all of it; these tests want it all.
const answerWhole = async () => {
  const w = win.locator('[role=alertdialog]', { hasText: /Conform .* of / });
  if (await w.waitFor({ timeout: 2500 }).then(() => true, () => false)) await w.getByRole('button', { name: 'Conform it all' }).click();
};

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });

  // ---------- import, then leave at once ----------
  await folder('fixtures-real');
  await win.locator('.gcell', { hasText: 'ocean-20min-1080p.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click(); await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
  await answerWhole();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.keyboard.press('Alt+2');
  await strip().waitFor({ timeout: 10000 }).catch(() => {});
  check('away from Source, the status strip shows the import running', /IMPORT/i.test(await strip().innerText().catch(() => '')) && /Import · ocean-20min/.test((await strip().getAttribute('title').catch(() => '')) ?? ''), (await strip().innerText().catch(() => '(none)')).replace(/\s+/g, ' '));
  await win.keyboard.press('Alt+3');
  await win.waitForTimeout(1500);
  check('…and keeps showing it in Render', (await strip().count()) === 1);

  // ---------- come back: live progress, no fresh Import button ----------
  await win.keyboard.press('Alt+1');
  await win.waitForTimeout(800);
  const back = await win.locator('.convbar').innerText();
  check('back in Source, the pane shows the running import (progress + Cancel)', (await win.locator('.convbar .importprog').count()) === 1 && /Cancel/.test(back), back.replace(/\s+/g, ' ').slice(-90));
  check('…and offers no second Import button (no double start)', (await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).count()) === 0);

  // ---------- it completes while elsewhere ----------
  await win.keyboard.press('Alt+2');
  const t0 = Date.now();
  await win.locator('.clip', { hasText: 'ocean-20min-1080p.mp4' }).waitFor({ timeout: 10 * 60000 });
  check(`the import completed while Compose was open (${((Date.now() - t0) / 1000).toFixed(1)}s after leaving)`, true);
  check('the status strip no longer lists it', (await strip().count()) === 0);

  // ---------- re-entering Source re-reads nothing (audit B2/B5) ----------
  await folder('fixtures-real');
  await win.locator('.gcell').first().waitFor({ timeout: 60000 });
  await win.waitForTimeout(1500);
  await win.evaluate(() => {
    const e = window.__moshpitEngine;
    window.__calls = { libraryFolders: 0, libraryClips: 0, sourceFrames: 0 };
    for (const m of ['libraryFolders', 'libraryClips']) {
      const f = e[m].bind(e);
      e[m] = (...a) => (window.__calls[m]++, f(...a));
    }
    const fr = e.frame.bind(e);
    e.frame = (t, s) => (t.kind === 'source' && window.__calls.sourceFrames++, fr(t, s));
  });
  const treeBefore = await win.locator('[role=tree]').innerText();
  await win.keyboard.press('Alt+2');
  await win.waitForTimeout(800);
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell').first().waitFor({ timeout: 5000 });
  await win.waitForTimeout(1500);
  const calls = await win.evaluate(() => window.__calls);
  check('re-entering Source re-reads no folder tree, no folder listing, no source frames', calls.libraryFolders === 0 && calls.libraryClips === 0 && calls.sourceFrames === 0, JSON.stringify(calls));
  check('…and the tree keeps its open folders', (await win.locator('[role=tree]').innerText()) === treeBefore);

  // ---------- a half-typed filter survives a workspace switch (audit B7) ----------
  const filter = win.getByPlaceholder(/^filter \d+ clips/);
  await filter.fill('gopro');
  await win.keyboard.press('Alt+2');
  await win.waitForTimeout(500);
  await win.keyboard.press('Alt+1');
  check('the Source grid filter survives a workspace switch', (await filter.inputValue()) === 'gopro', await filter.inputValue());
  await filter.fill('');

  // ---------- Cancel is quiet: the real worker reports it as INTERNAL, the app knows it asked ----------
  await folder('fixtures-real');
  await win.locator('.gcell', { hasText: 'gopro-uw-1080p-refs1.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click(); await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
  await answerWhole();
  await win.locator('.convbar .importprog').waitFor({ timeout: 10000 });
  const errToasts = await win.locator('.toasts .toast.err, .toasts .toast.error').count();
  await win.locator('.convbar').getByRole('button', { name: 'Cancel' }).click();
  await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).waitFor({ timeout: 20000 });
  await win.waitForTimeout(800);
  check('Cancel stops the import quietly (Import button back, no error banner, no error toast)', (await win.locator('.convbar .banner, .convbar [role=alert]').count()) === 0 && (await win.locator('.toasts .toast.err, .toasts .toast.error').count()) === errToasts);

  // ---------- Detect cuts survives too ----------
  await folder('fixtures');
  await win.locator('.gcell', { hasText: 'src-cuts.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click(); await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
  await win.locator('.convbar .hdnote').waitFor({ timeout: 5 * 60000 });
  await win.getByRole('button', { name: /Detect cuts/ }).click();
  await win.keyboard.press('Alt+2');
  await win.waitForTimeout(300);
  const detecting = await strip().innerText().catch(() => '');
  await win.keyboard.press('Alt+1');
  await win.getByRole('tab', { name: 'Chapters' }).click(); // tabbed with Metadata since the restructure
  await win.waitForFunction(() => !/No chapters yet/.test(document.querySelector('section[aria-label="Chapters"]')?.textContent ?? 'No chapters yet'), null, { timeout: 3 * 60000 }).catch(() => {});
  const chapCount = await win.locator('section[aria-label="Chapters"]').innerText();
  check('Detect cuts ran through a workspace switch and stored its chapters', !/No chapters yet/.test(chapCount), `${detecting ? `strip showed "${detecting.replace(/\s+/g, ' ')}" · ` : ''}${chapCount.replace(/\s+/g, ' ').slice(0, 80)}`);
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `jobs: ${failed} FAILED` : 'jobs: all ok');
process.exit(failed ? 1 : 0);
