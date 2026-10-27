// Electron smoke test for the app shell: launches the built app, checks the preload bridge,
// a workspace switch, timeline playback, a layout change reaching disk (L13), and the CT bridge. Run: node app/test/smoke.mjs
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Test windows open off-screen and never take focus (electron/main.ts).
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'out', 'app-smoke');
fs.mkdirSync(outDir, { recursive: true });
// The real engine scans this folder as the library (the engine lane's e2e uses the same fixtures).
// A throwaway profile: the smoke run must never leave recovery files in the user's real one.
const userDataDir = path.join(outDir, 'userdata');
fs.rmSync(userDataDir, { recursive: true, force: true });
const app = await electron.launch({ args: [path.join(root, 'app/dist/main.cjs'), `--user-data-dir=${userDataDir}`], cwd: root, timeout: 30000, env: { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures'), MOSHPIT_NO_CLOSE_PROMPT: '1' } });
// Kill the whole Electron tree (main, renderers, render worker); a bare SIGKILL leaves children.
const killTree = (a) => { try { execFileSync('taskkill', ['/PID', String(a.process().pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
const fail = (m) => {
  console.error('FAIL', m);
  process.exitCode = 1;
};
try {
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.waitForSelector('.topbar', { timeout: 15000 });
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  // The app opens on HOME (Settings → start on); this smoke works in Compose.
  if (!(await win.locator('.stage.ws-home').count())) fail('did not open on HOME');
  await win.keyboard.press('Alt+2');
  await win.locator('.stage.ws-mosh').waitFor({ timeout: 5000 });
  await win.screenshot({ path: path.join(outDir, 'mosh.png') });
  if (!(await win.evaluate(() => !!window.moshpitHost))) fail('preload bridge missing');

  // Compose's Arrange / Process switch is a layout change: it must reach layouts.json (L13).
  await win.locator('.modeseg button', { hasText: 'Process' }).click();
  await win.waitForTimeout(800);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'config', 'layouts.json'), 'utf8'));
  const stackF = (pane) => saved.current.mosh.flatMap((c) => c.stacks).find((s) => s.panes.includes(pane))?.f;
  if (!(stackF('graph') > stackF('edit'))) fail(`Process mode did not reach layouts.json (graph ${stackF('graph')}, arrangement ${stackF('edit')})`);
  await win.locator('.modeseg button', { hasText: 'Arrange' }).click(); // restore

  // Real engine, through the UI: Browse → import a fixture → slice it onto the timeline.
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell').first().click({ timeout: 20000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click(); await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
// First import into an empty project may ask to adopt the clip's frame rate.
{
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
}
  await win.locator('.convbar .hdnote').waitFor({ timeout: 60000 }); // "✓ in project · conformed"
  await win.screenshot({ path: path.join(outDir, 'browse.png') });
  await win.keyboard.press('Alt+2');
  const lane = win.locator('.loupe[data-loupe="A"] .ztrack');
  const box = await lane.boundingBox();
  await lane.click({ position: { x: box.width * 0.2, y: box.height * 0.7 } });
  await win.keyboard.press('i');
  await lane.click({ position: { x: box.width * 0.7, y: box.height * 0.7 } });
  await win.keyboard.press('o');
  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();
  await win.locator('.blk').first().waitFor({ timeout: 10000 });
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(outDir, 'mosh-real.png') });

  // Space plays the timeline: the edit ruler's playhead must move (rAF repaint, L9).
  const ph = () => win.locator('.bpmruler .tph').getAttribute('style');
  const p0 = await ph();
  await win.locator('.topbar .brand').click();
  await win.keyboard.press('Space');
  await win.waitForTimeout(700);
  await win.keyboard.press('Space');
  if ((await ph()) === p0) fail('Space did not advance the playhead');

  // ⌥G opens the graph on the selected block (Node is a mode of Compose now, not a workspace).
  await win.keyboard.press('Alt+g');
  const on = await win.locator('.wsswitch button.on').innerText();
  if (!(await win.locator('.graphbar').count()) || !/mosh/i.test(on)) fail(`Alt+G: graph bar ${await win.locator('.graphbar').count()}, switcher on "${on}"`);
  await win.screenshot({ path: path.join(outDir, 'node.png') });
  // CT Route B through the UI store: the server sees the block we just made, and CT commands
  // land in the UI as ordinary (undoable) actions.
  const { default: WebSocket } = await import('ws');
  const ep = JSON.parse(fs.readFileSync(path.join(userData, 'control-endpoint.json'), 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${ep.port}${ep.path}`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  const ask = async (m, type) => {
    ws.send(JSON.stringify(m));
    for (let i = 0; i < 50 && !msgs.some((x) => x.type === type && x.id === m.id); i++) await win.waitForTimeout(100);
    return msgs.find((x) => x.type === type && x.id === m.id);
  };
  ws.send(JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 1, client: 'smoke', token: ep.token }));
  const t = await ask({ type: 'discover', id: 1 }, 'targets');
  if (!t?.activeBlock) fail('CT discover saw no active block (store not publishing)');
  await ask({ type: 'command', id: 2, command: 'workspace.node' }, 'ack');
  await win.waitForTimeout(300);
  if (!(await win.locator('.graphbar').count())) fail('CT command workspace.node did not open the graph');
  await ask({ type: 'command', id: 3, command: 'workspace.mosh' }, 'ack');
  await ask({ type: 'command', id: 4, command: 'edit.undo' }, 'ack');
  await win.waitForTimeout(400);
  if ((await win.locator('.blk').count()) !== 0) fail('CT edit.undo did not undo the slice');
  ws.close();
  console.log(`CT: discover saw active block ${t?.activeBlock} (generation ${t?.generation}); workspace + undo commands landed`);

  if (errors.length) fail('page errors: ' + errors.join(' | '));
  console.log(process.exitCode ? 'smoke: FAILED' : `smoke: ok (config at ${userData})`);
} finally {
  // The run leaves the project edited; never wait on a close that hangs, never leave the tree behind.
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10000))]).catch(() => {});
  killTree(app);
}
process.exit(process.exitCode ?? 0);
