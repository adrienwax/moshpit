// HOME: lands there on launch, reads recent projects without side effects, opens one into Compose.
//   node app/test/home.e2e.mjs                (dev build: node app/build.mjs first)
//   MOSHPIT_EXE=<built .exe> node app/test/home.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-home');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'config'), { recursive: true });
// Copies, so opening one never touches the other suites' files.
const src = ['out/app-fullloop/fullloop.moshpit.json', 'out/app-lifecycle/roundtrip.moshpit.json'].map((p) => path.join(root, p)).filter((p) => fs.existsSync(p));
const projects = src.map((p) => { const d = path.join(out, path.basename(p)); fs.copyFileSync(p, d); return d; });
projects.push(path.join(out, 'broken.moshpit.json'));
fs.writeFileSync(projects.at(-1), '{ not json');
const recentsFile = path.join(ud, 'config', 'recents.json');
fs.writeFileSync(recentsFile, JSON.stringify(projects));

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

async function launch(extraSettings) {
  if (extraSettings) fs.writeFileSync(path.join(ud, 'config', 'settings.json'), JSON.stringify(extraSettings));
  if (process.env.MOSHPIT_EXE) {
    const port = 9400 + Math.floor(Math.random() * 400);
    const child = spawn(process.env.MOSHPIT_EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], { env: { ...process.env }, stdio: 'ignore' });
    let browser;
    for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 300)); } }
    let win;
    for (let i = 0; i < 100 && !win; i++) { win = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().includes('worker')); if (!win) await new Promise((r) => setTimeout(r, 200)); }
    return { win, pid: child.pid };
  }
  const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`] });
  return { win: await app.firstWindow(), pid: app.process().pid };
}
const kill = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };

let s = await launch();
try {
  const win = s.win;
  const errs = []; win.on('pageerror', (e) => errs.push(String(e)));
  await win.waitForSelector('.topbar', { timeout: 30000 });
  check('launches on HOME', await win.locator('.stage.ws-home').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await win.locator('.hcard').first().waitFor({ timeout: 15000 });
  const cards = await win.locator('.hcard').count();
  check(`one card per recent project (${projects.length})`, cards === projects.length, String(cards));
  check('an unreadable project shows as a card with the reason, not an error', (await win.locator('.hcard.bad', { hasText: 'could not read' }).count()) === 1);
  const first = win.locator('.hcard:not(.bad)').first();
  const meta = await first.locator('.hro').innerText();
  check('a card reads blocks, clips, length and BPM from the file', /BLK\s*\d+\s*CLIPS\s*\d+\s*LEN\s*\d+:\d\d\s*BPM\s*\d+/.test(meta.replace(/\n/g, ' ')), meta.replace(/\s+/g, ' '));
  check('a card has a picture of its first clip', await first.locator('.cellthumb canvas:not(.hidden), .cellthumb img').first().waitFor({ timeout: 15000 }).then(() => true, () => false));
  check('reading the cards left recents.json as it was', JSON.stringify(JSON.parse(fs.readFileSync(recentsFile, 'utf8'))) === JSON.stringify(projects));
  check('System shows the GPU and the CT link', /GPU/.test(await win.locator('.hsys').first().innerText()) && /CT LINK/.test(await win.locator('.hsys').first().innerText()));
  const name = (await first.locator('.hcmeta b').innerText()).trim();
  await first.click();
  check('clicking a card opens it in Compose', await win.locator('.stage.ws-mosh').waitFor({ timeout: 15000 }).then(() => true, () => false));
  check('…the project that was clicked', (await win.locator('.projbtn .pname').innerText()).trim() === name, name);
  await win.keyboard.press('Alt+0');
  check('⌥0 goes back to HOME', await win.locator('.stage.ws-home').waitFor({ timeout: 5000 }).then(() => true, () => false));
  check('…where that card is marked OPEN and Continue is offered', await win.locator('.hcard.cur .hcur').waitFor({ timeout: 10000 }).then(() => true, () => false) && (await win.locator('.hact', { hasText: 'Continue' }).count()) === 1);
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally { kill(s.pid); }

// Start on Compose when the setting says so.
s = await launch({ startOn: 'compose' });
try {
  await s.win.waitForSelector('.topbar', { timeout: 30000 });
  check('startOn: compose opens straight into Compose', await s.win.locator('.stage.ws-mosh').waitFor({ timeout: 10000 }).then(() => true, () => false));
} catch (e) {
  check('second launch ran', false, String(e).split('\n')[0]);
} finally { kill(s.pid); }

console.log(failed ? `home: ${failed} FAILED` : 'home: all ok');
process.exit(failed ? 1 : 0);
