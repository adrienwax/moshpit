// Project lifecycle end to end, on the real engine, in a throwaway user-data dir:
//   import → slice → Save → edit → (kill the app) → relaunch → recover the edit as a new copy →
//   Save As (the original untouched) → New → Open → Save again = byte-identical file → edit →
//   close → "Don't save" discards. Phase 0.3: one instance per profile, a crashed UI window
//   reloads and offers its edits, a lost GPU context restarts the worker.
// Needs a build first (node app/build.mjs). Run: node app/test/lifecycle.e2e.mjs
import { _electron as electron } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Test windows open off-screen and never take focus (electron/main.ts).
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-lifecycle');
const userData = path.join(out, 'userdata');
const projectFile = path.join(out, 'roundtrip.moshpit.json');
const recoveredFile = path.join(out, 'roundtrip-recovered.moshpit.json');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Kill the whole Electron tree (main, renderers, render worker); a bare SIGKILL leaves children.
const killTree = (a) => { try { execFileSync('taskkill', ['/PID', String(a.process().pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failed++;
};

const appEnv = (dialogPath) => ({ ...process.env, MOSHPIT_TEST: '1', MOSHPIT_DIALOG_PATH: dialogPath, MOSHPIT_LIBRARY: path.join(root, 'fixtures') });
async function launch(dialogPath = projectFile) {
  const app = await electron.launch({
    args: [path.join(root, 'app/dist/main.cjs'), `--user-data-dir=${userData}`],
    cwd: root,
    timeout: 30000,
    env: appEnv(dialogPath),
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.topbar', { timeout: 20000 });
  return { app, win };
}
const title = (win) => win.title();
const bpm = (win) => win.locator('.tl .bpm .pval').innerText();
let cur = projectFile; // the file the session is working on
const read = (f = cur) => fs.readFileSync(f, 'utf8');

// ---------- session 1: build something, save it, edit, crash ----------
let { app, win } = await launch();
check('fresh profile boots with no recovery prompt', !(await win.locator('[role=alertdialog]').count()));
await win.keyboard.press('Alt+1');
await win.locator('.gcell').first().click({ timeout: 20000 });
await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click(); await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
// First import into an empty project may ask to adopt the clip's frame rate.
{
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
}
await win.locator('.convbar .hdnote').waitFor({ timeout: 60000 });
await win.keyboard.press('Alt+2');
const lane = win.locator('.loupe[data-loupe="A"] .ztrack');
const box = await lane.boundingBox();
await lane.click({ position: { x: box.width * 0.2, y: box.height * 0.7 } });
await win.keyboard.press('i');
await lane.click({ position: { x: box.width * 0.7, y: box.height * 0.7 } });
await win.keyboard.press('o');
await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();
await win.locator('.blk').first().waitFor();
check('editing marks the project dirty (title •)', (await title(win)).startsWith('•'), await title(win));

await win.keyboard.press('Control+s');
await win.waitForFunction(() => !document.title.startsWith('•'), null, { timeout: 10000 });
const saved1 = read();
const doc1 = JSON.parse(saved1);
check('Ctrl+S writes a moshpit.project file with section versions', doc1.format === 'moshpit.project' && !!doc1.versions?.graph && doc1.timeline.blocks.length === 1);
check('the file is named after the project', /roundtrip/.test(await title(win)), await title(win));

// An edit after the save: nudge the BPM up three steps, let the journal flush, then kill the app.
const bpm0 = await bpm(win);
await win.locator('.tl .bpm [role=slider]').focus();
for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight');
const bpmEdited = await bpm(win);
check('the edit changed the BPM', bpmEdited !== bpm0, `${bpm0} → ${bpmEdited}`);
await win.waitForTimeout(1200); // journal debounce
check('the autosave journal holds the edit', fs.existsSync(projectFile + '.journal') && fs.readFileSync(projectFile + '.journal', 'utf8').split('\n').filter(Boolean).length >= 2);
killTree(app);
await new Promise((r) => setTimeout(r, 800));

// ---------- session 2: recover (as a new copy: Phase 0.3) ----------
({ app, win } = await launch(recoveredFile));
const prompt = win.locator('[role=alertdialog]');
await prompt.waitFor({ timeout: 15000 });
check('relaunch offers recovery', /closed without saving/i.test(await prompt.innerText()), await prompt.innerText());
await prompt.getByRole('button', { name: 'Recover' }).click();
await win.keyboard.press('Alt+2');
await win.locator('.tl .bpm .pval').waitFor();
check('recovered project has the unsaved BPM edit', (await bpm(win)) === bpmEdited, `${await bpm(win)} vs ${bpmEdited}`);
check('it opens as a new unsaved copy: "(recovered)", title •', /^•.*\(recovered\)/.test(await title(win)), await title(win));
check('the original file is untouched, and its journal moved into the new session', read(projectFile) === saved1 && !fs.existsSync(projectFile + '.journal'));
await win.keyboard.press('Control+s'); // no file yet: Save As (the test dialog answers recoveredFile)
await win.waitForFunction(() => !document.title.startsWith('•'), null, { timeout: 10000 });
cur = recoveredFile;
const saved2 = read();
check('saving the recovered copy writes the edit to the new file; the original keeps the old BPM', JSON.parse(saved2).settings.bpm !== doc1.settings.bpm && JSON.parse(read(projectFile)).settings.bpm === doc1.settings.bpm);

// ---------- round trip: New → Open → Save = byte-identical (the recovered copy's file) ----------
await win.keyboard.press('Control+n');
await win.waitForFunction(() => document.title.startsWith('Untitled'), null, { timeout: 10000 });
check('New starts an empty Untitled project', (await win.locator('.blk').count()) === 0);
await win.keyboard.press('Control+o');
await win.waitForFunction(() => document.title.includes('roundtrip'), null, { timeout: 15000 });
await win.keyboard.press('Alt+2');
await win.locator('.blk').first().waitFor();
check('reopened project has its block and the recovered BPM', (await bpm(win)) === bpmEdited);
await win.keyboard.press('Control+s');
await win.waitForTimeout(800);
check('save → reopen → save is byte-identical', read() === saved2, 'file changed after a plain reopen + save');
// Re-check conformed clips from the menu (D7): the fixture conform must still match its pin.
await win.locator('.projbtn').click();
await win.getByRole('menuitem', { name: /Re-check conformed clips/ }).click();
const verdict = win.locator('.toasts .toast', { hasText: /match their pinned conforms|conform differently/ });
await verdict.first().waitFor({ timeout: 120000 });
const vtext = await verdict.first().innerText();
check('D7 re-check: the reopened clip still matches its pinned conform', /match their pinned conforms/.test(vtext), vtext);

// ---------- close with unsaved edits → Don't save ----------
await win.locator('.tl .bpm [role=slider]').focus();
await win.keyboard.press('ArrowLeft');
await win.waitForTimeout(800);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.close());
const ask = win.locator('[role=alertdialog]');
await ask.waitFor({ timeout: 5000 });
check('closing with unsaved edits asks first', /Save changes/.test(await ask.innerText()));
const closed = app.waitForEvent('close').catch(() => null);
// The click's own result is the window closing, which can beat Playwright's click acknowledgement:
// "target closed" here is the expected outcome, anything else is a real failure.
await ask.getByRole('button', { name: "Don't save" }).click().catch((e) => { if (!/has been closed/.test(String(e))) throw e; });
await Promise.race([closed, new Promise((r) => setTimeout(r, 8000))]);
check("Don't save discards the journal", !fs.existsSync(cur + '.journal'));
check('the file keeps the last saved state', read() === saved2);

// ---------- session 3: nothing to recover; one instance per profile ----------
({ app, win } = await launch(recoveredFile));
await win.waitForTimeout(1500);
check('after a clean close, the next launch has no recovery prompt', !(await win.locator('[role=alertdialog]').count()));
{
  // A second launch on the same profile hands over to the first and exits (Phase 0.3).
  const electronExe = (await import('electron')).default;
  const second = spawn(electronExe, [path.join(root, 'app/dist/main.cjs'), `--user-data-dir=${userData}`], { cwd: root, env: appEnv(recoveredFile), stdio: 'ignore' });
  const exited = await new Promise((r) => { second.on('exit', () => r(true)); setTimeout(() => r(false), 10000); });
  if (!exited) try { execFileSync('taskkill', ['/PID', String(second.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  check('a second instance on the same profile exits at once; the first keeps running', exited && !win.isClosed() && (await win.locator('.topbar').count()) === 1);
}

// ---------- the UI window crashes: reload, recover (Phase 0.3) ----------
await win.keyboard.press('Control+o');
await win.waitForFunction(() => document.title.includes('roundtrip'), null, { timeout: 15000 });
await win.keyboard.press('Alt+2');
await win.locator('.tl .bpm [role=slider]').focus();
await win.keyboard.press('ArrowRight');
const bpmCrash = await bpm(win);
await win.waitForTimeout(600); // the journal's 150 ms debounce, with room
// Playwright treats a crashed page as gone for good, though Electron reloads the same window: the
// reloaded page is driven from main (executeJavaScript), which is also what proves it came back.
const ui = (js) => app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'))?.executeJavaScript(code), js);
await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'))?.forcefullyCrashRenderer());
let crashText = '';
for (let i = 0; i < 60 && !crashText; i++) {
  await new Promise((r) => setTimeout(r, 500));
  crashText = (await ui("document.querySelector('[role=alertdialog]')?.innerText ?? ''").catch(() => '')) ?? '';
}
check('a crashed UI window reloads and says so, offering its edits', /window crashed/i.test(crashText), crashText.slice(0, 120) || '(no prompt)');
await ui("[...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent.trim() === 'Recover')?.click()");
let bpmAfter = '';
for (let i = 0; i < 40 && !bpmAfter; i++) {
  await new Promise((r) => setTimeout(r, 250));
  bpmAfter = (await ui("(window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true })), document.querySelector('.tl .bpm .pval')?.innerText ?? '')").catch(() => '')) ?? '';
}
const recTitle = await ui('document.title').catch(() => '');
check('…and the recovered copy has the edit made just before the crash', bpmAfter === bpmCrash && /\(recovered\)/.test(recTitle), `${bpmAfter} vs ${bpmCrash} · ${recTitle}`);

// ---------- the worker loses its GPU context: restart, frames come back (Phase 0.3) ----------
await new Promise((r) => setTimeout(r, 1500));
// Blank the Program canvas first (1 px wide): only a frame drawn after the restart can pass the check.
await ui("(() => { const c = document.querySelector('section[aria-label=\"Program\"] .frameview canvas'); if (c) c.width = 1; return !!c; })()");
const lost = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes('worker.html'))?.executeJavaScript('window.__moshpitLoseGpu ? window.__moshpitLoseGpu() : -1'));
let restarted = false;
for (let i = 0; i < 40 && !restarted; i++) {
  await new Promise((r) => setTimeout(r, 500));
  restarted = !!(await ui("[...document.querySelectorAll('.toasts .toast')].some((t) => /render engine stopped unexpectedly and was restarted/.test(t.textContent))").catch(() => false));
}
// An edit after the restart (BPM down one step): Program must render it on the new worker.
await ui("(document.querySelector('.tl .bpm [role=slider]')?.focus(), document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))").catch(() => {});
let drew = false;
for (let i = 0; i < 60 && !drew; i++) {
  await new Promise((r) => setTimeout(r, 500));
  drew = !!(await ui("(() => { const v = document.querySelector('section[aria-label=\"Program\"] .frameview'); const c = v?.querySelector('canvas'); return !!c && !v.querySelector('.frameerr') && c.width > 16; })()").catch(() => false));
}
check('a lost WebGL context restarts the worker (toast), and Program draws again', lost > 0 && restarted && drew, `backends ${lost}, toast ${restarted}, drew ${drew}`);

// Never leave a process holding the throwaway profile.
killTree(app);

console.log(failed ? `lifecycle e2e: ${failed} FAILED` : 'lifecycle e2e: all ok');
// Exit outright: the Playwright connection to the killed app keeps the event loop alive.
process.exit(failed ? 1 : 0);
