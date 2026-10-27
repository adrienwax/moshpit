// CT Route B against the PACKAGED exe, driven by waxyct's own adapter (host/moshpit-client.mjs):
//   launch the exe (throwaway profile, debug port) → build a block with a real recipe through the UI →
//   the adapter reads the endpoint file, says hello, discovers the real targets → a knob write on a
//   continuous param lands in the UI store and comes back on re-discover → workspace + undo commands
//   take effect → an undo/redo made in the UI pushes values back to the CT. Then the exe is closed.
//   MOSHPIT_EXE=<exe> [WAXYCT=<waxyct dir>] node app/test/ct.packaged.e2e.mjs
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Test windows open off-screen and never take focus (electron/main.ts).
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.env.MOSHPIT_EXE ?? path.resolve(root, '..', 'moshpit-builds', 'v3.1', 'Moshpit-3.1.0-portable.exe');
const waxyct = process.env.WAXYCT ?? path.resolve(root, '..', 'waxyct');
const out = path.join(root, 'out', 'app-ct-packaged');
const userData = path.join(out, 'userdata');
const endpointFile = path.join(userData, 'control-endpoint.json');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const until = async (fn, ms = 5000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true;
  return false;
};

const child = spawn(exe, [`--user-data-dir=${userData}`, '--remote-debugging-port=9335'], {
  env: { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures') }, stdio: 'ignore',
});
let m;
try {
  let browser;
  for (let i = 0; i < 120 && !browser; i++) browser = await chromium.connectOverCDP('http://127.0.0.1:9335').catch(() => new Promise((r) => setTimeout(r, 1000)));
  let win;
  await until(() => (win = browser?.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith('index.html'))), 30000);
  await win.waitForSelector('.topbar', { timeout: 30000 });

  // 1. The server is on by default and announced itself.
  check('the packaged exe started the control server on launch', await until(() => fs.existsSync(endpointFile), 15000));
  const ep = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  check('endpoint file: moshpit-control v1 on 127.0.0.1, path /control, with a token', ep.protocol === 'moshpit-control' && ep.v === 1 && ep.path === '/control' && ep.token.length >= 32, `port ${ep.port}`);

  // A block with real params: import a fixture, slice it, apply the VHS Decay recipe.
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell').first().click({ timeout: 20000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click(); await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.convbar .hdnote').waitFor({ timeout: 90000 });
  await win.keyboard.press('Alt+2');
  const lane = win.locator('.loupe[data-loupe="A"] .ztrack');
  const box = await lane.boundingBox();
  await lane.click({ position: { x: box.width * 0.2, y: box.height * 0.7 } });
  await win.keyboard.press('i');
  await lane.click({ position: { x: box.width * 0.7, y: box.height * 0.7 } });
  await win.keyboard.press('o');
  await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();
  await win.locator('.blk').first().click();
  await win.locator('.recipe', { hasText: 'VHS Decay' }).click();
  await win.waitForTimeout(500);

  // Telemetry probe (§12.8): the worker's 2 s push reaches the status strip with measured figures.
  const ro = (l) => win.locator('.statusstrip .ro.sys', { has: win.locator('.lbl', { hasText: new RegExp('^' + l + '$') }) }).locator('.val');
  const val = async (l) => (await ro(l).textContent())?.trim() ?? '';
  check('telemetry: GPU load reported as a %', await until(async () => /^\d+%$/.test(await val('GPU')), 10000), await val('GPU'));
  check('telemetry: VRAM used/total in GB, compact', /^\d+(\.\d)?\/\d+(\.\d)?GB$/.test(await val('VRAM')), await val('VRAM'));
  check('telemetry: FRAME cost in ms', await until(async () => /^\d+(\.\d)?ms$/.test(await val('FRAME')), 6000), await val('FRAME'));
  // Non-zero: a clip was just conformed into the cache (a walk that skipped folders read 0 MB here).
  check('telemetry: CACHE counts the conform just written (not 0 MB)', await until(async () => /^([1-9]\d*MB|\d+(\.\d)?GB)$/.test(await val('CACHE')), 20000), await val('CACHE'));
  const ud = path.dirname(endpointFile);
  check("engine cache in userData/engine-cache, not Chromium's Cache", fs.existsSync(path.join(ud, 'engine-cache', 'conform')) && !fs.existsSync(path.join(ud, 'Cache', 'conform')), fs.readdirSync(path.join(ud, 'engine-cache')).join(', '));
  check('telemetry: the status strip is the 34px stacked readout', Math.round((await win.locator('.statusstrip.hud').boundingBox()).height) === 34);

  // 2. waxyct's adapter, exactly as deck-host builds it (endpoint file → port + token).
  const { createMoshpitClient } = await import(pathToFileURL(path.join(waxyct, 'host', 'moshpit-client.mjs')).href);
  const pushes = [];
  m = createMoshpitClient({ endpointFile, clientVersion: 'ct-packaged-test', log: (s) => /connected|error|refused/.test(s) && console.log('   ' + s) });
  m.onChange((why, st) => { if (why === 'value') pushes.push(Date.now()); void st; });
  m.start();
  check('hello → welcome: protocol v1 accepted, adapter connected', await until(() => m.connected(), 10000), m.state().detail);
  const st = m.state();
  const targets = [...st.targets.values()];
  check('discover returns the real namespace: targets keyed by block/node UUIDs', targets.length > 0 && targets.every((t) => /^\/(block\/[0-9a-f-]{36}\/node\/[0-9a-f-]{36}|lfo\/)/.test(t.path) || !t.path.startsWith('/block')), `${targets.length} targets, e.g. ${targets[0]?.path}`);
  // 3.2: a look is placed as one container, so VHS Decay is one slot (its macros are the dials).
  check('active block chain: slots in order with Moshpit names', st.slots.length >= 1 && st.slots.some((s) => s.name === 'VHS Decay'), st.slots.map((s) => s.name).join(' → '));
  check('each target carries a ParamSpec (key, label, type, range, default)', targets.filter((t) => t.param).every((t) => t.param.key && t.param.label && t.param.type && 'default' in t.param), JSON.stringify(targets.find((t) => t.param?.type === 'float')?.param ?? {}));
  check('commands listed', st.commands.length > 0, `${st.commands.length}: ${st.commands.slice(0, 6).map((c) => c.id ?? c).join(', ')}…`);

  // 3a. A knob turn on a continuous param.
  const slotIdx = st.slots.findIndex((s) => s.params.some((p) => st.targets.get(p)?.param?.type === 'float'));
  const s = st.slots[slotIdx];
  const pIdx = s.params.findIndex((p) => st.targets.get(p)?.param?.type === 'float');
  const pth = s.params[pIdx];
  const spec = st.targets.get(pth).param;
  const v0 = st.values.get(pth);
  const dir = Number(v0) >= (spec.max ?? 1) ? -1 : 1;
  const r = await m.act({ verb: 'knob', slot: slotIdx + 1, param: pIdx + 1 }, 5 * dir);
  check(`knob write acked with the committed value (${s.name} · ${spec.label})`, r.type === 'ack' && r.value !== undefined && r.value !== v0, `${v0} → ${r.value}`);
  check('the write came back as a value push', await until(() => pushes.length > 0, 3000));
  await new Promise((res) => setTimeout(res, 400));
  await m.discover();
  check('the write landed in the UI store (re-discover reads it back from the app)', m.state().values.get(pth) === r.value, String(m.state().values.get(pth)));

  // 3b. Discrete commands.
  const ws = await m.act({ verb: 'command', command: 'workspace.node' });
  check('command workspace.node acked', ws.type === 'ack', JSON.stringify(ws));
  check('…and the app opened the graph on the selected block', await until(async () => (await win.locator('.graphbar').count()) > 0));
  await m.act({ verb: 'command', command: 'workspace.mosh' });
  await m.act({ verb: 'command', command: 'edit.undo' });
  check('command edit.undo reverted the knob write, pushed back to the CT', await until(() => m.state().values.get(pth) === v0), `${m.state().values.get(pth)} vs ${v0}`);

  // 3c. A change made in the app (keyboard redo) reaches the CT as feedback.
  await win.locator('.topbar .brand').click();
  await win.keyboard.press('Control+Shift+z');
  check('a redo made in the app pushes the value to the CT', await until(() => m.state().values.get(pth) === r.value), String(m.state().values.get(pth)));

  // Protocol guard: a wrong version is refused.
  const raw = new WebSocket(`ws://127.0.0.1:${ep.port}${ep.path}`);
  const refusal = await new Promise((res) => {
    raw.onopen = () => raw.send(JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 99, client: 'probe', token: ep.token }));
    raw.onmessage = (e) => res(JSON.parse(e.data));
    setTimeout(() => res(null), 3000);
  });
  check('a client speaking v99 is refused with PROTOCOL_VERSION', refusal?.code === 'PROTOCOL_VERSION', JSON.stringify(refusal));
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  m?.stop();
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `ct packaged: ${failed} FAILED` : 'ct packaged: all ok');
process.exit(failed ? 1 : 0);
