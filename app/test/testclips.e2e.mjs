// The "test clips" favourite: on first run (and once on an existing profile) the HD test footage is
// pinned in Source ▸ Favourites under that name, and it lists its clips (the worker scans the folder).
// Removing it sticks: the seed runs once. Run: node app/test/testclips.e2e.mjs
import { launchApp } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-testclips');
const ud = path.join(out, 'userdata');
const clipsDir = process.env.MOSHPIT_TEST_CLIPS ?? path.join(root, 'test-footage');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const until = async (fn, ms = 5000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 150))) if (await fn()) return true; return false; };

const files = fs.existsSync(clipsDir) ? fs.readdirSync(clipsDir).filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f)).length : 0;
const run = await launchApp({ root, userData: ud, port: 9349, env: { MOSHPIT_LIBRARY: path.join(root, 'fixtures'), MOSHPIT_NO_CLOSE_PROMPT: '1', MOSHPIT_TEST_CLIPS: clipsDir } });
const win = run.win;
try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  check('the test footage is on disk', files > 0, `${files} clips in ${clipsDir}`);
  await win.keyboard.press('Alt+1');
  const fav = win.locator('.places .place', { has: win.locator('.pn', { hasText: /^test clips$/ }) });
  check('a fresh profile has the "test clips" favourite', await until(async () => (await fav.count()) === 1, 10000), (await win.locator('.places .place .pn').allTextContents()).join(' | '));
  await fav.click();
  const cells = win.locator('.gcell');
  check('…and it lists the test clips', await until(async () => (await cells.count()) === files, 60000), `${await cells.count()} of ${files}`);
  await win.screenshot({ path: path.join(out, 'test-clips.png') });
  // Remove it, reload: the seed does not put it back.
  await fav.locator('.px').click();
  await win.waitForTimeout(1200); // settings are written 400 ms after the last change
  await win.reload();
  await win.waitForSelector('.topbar', { timeout: 30000 });
  await win.keyboard.press('Alt+1');
  await win.waitForTimeout(800);
  check('removing it sticks (the seed runs once)', (await win.locator('.places .place .pn', { hasText: /^test clips$/ }).count()) === 0);
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  run.kill();
}
console.log(failed ? `testclips: FAILED (${failed})` : 'testclips: all ok');
process.exitCode = failed ? 1 : 0;
