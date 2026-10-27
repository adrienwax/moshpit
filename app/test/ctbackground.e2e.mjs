// CT feedback with Moshpit MINIMISED, as a user runs it (P2 from the CT integration audit). The app is
// started plainly: no Playwright, no debug port, no test-background switch. Each of those keeps a
// minimised page awake (measured: rAF ran at 145/s under Playwright), which is why every other e2e
// missed this. The window is minimised with the OS (ShowWindow on this process's own window only),
// then a CT undo must come back as a value push. Before the fix it never did: the UI's publish loop
// rode requestAnimationFrame, which a minimised window stops. Dev only (the portable exe re-spawns).
// Run: node app/test/ctbackground.e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ud = path.join(root, 'out', 'app-ctbackground', 'userdata');
fs.rmSync(path.dirname(ud), { recursive: true, force: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const until = async (fn, ms) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true; return false; };

const env = { ...process.env, MOSHPIT_NO_CLOSE_PROMPT: '1' };
delete env.MOSHPIT_TEST_BACKGROUND;
const child = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], { env, stdio: 'ignore' });
const win32 = (body) => execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);'; $h = (Get-Process -Id ${child.pid}).MainWindowHandle; ${body}`], { encoding: 'utf8' }).trim();
let ws;
try {
  const epf = path.join(ud, 'control-endpoint.json');
  check('the app started its control server', await until(() => fs.existsSync(epf), 30000));
  await new Promise((r) => setTimeout(r, 4000)); // the UI boots and publishes its first document
  const ep = JSON.parse(fs.readFileSync(epf, 'utf8'));
  ws = new WebSocket(`ws://127.0.0.1:${ep.port}${ep.path}`);
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  await new Promise((r) => (ws.onopen = r));
  let nid = 0;
  const ask = async (m) => { const id = ++nid; ws.send(JSON.stringify({ ...m, id })); await until(() => got.some((x) => x.id === id), 5000); return got.find((x) => x.id === id); };
  ws.send(JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 1, client: 'ctbackground', token: ep.token }));
  await until(() => got.length > 0, 5000);
  const t = await ask({ type: 'discover' });
  const p = t.targets.find((x) => x.path.endsWith('/period'));
  check('a fresh project has an LFO period to drive', !!p, p?.path);
  await ask({ type: 'subscribe', paths: [p.path] });
  const w = await ask({ type: 'write', write: { target: p.path, generation: t.generation, delta: 4, source: 'ct' } });
  check('a CT write is acked', w?.type === 'ack' && w.value !== p.value, `${p.value} → ${w?.value}`);
  await new Promise((r) => setTimeout(r, 800));

  check('the window is minimised (OS)', win32('[W.U]::ShowWindow($h, 6) | Out-Null; Start-Sleep -Milliseconds 1500; [W.U]::IsIconic($h)') === 'True');
  got.length = 0;
  const t0 = Date.now();
  await ask({ type: 'command', command: 'edit.undo' });
  const back = await until(() => got.some((m) => m.type === 'value' && m.path === p.path && m.value === p.value), 5000);
  check('minimised: a CT undo comes back as a value push', back, `${Date.now() - t0} ms`);
  got.length = 0;
  await ask({ type: 'command', command: 'edit.redo' });
  check('…and the redo', await until(() => got.some((m) => m.type === 'value' && m.path === p.path && m.value === w.value), 5000));
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  ws?.close();
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `ctbackground: FAILED (${failed})` : 'ctbackground: all ok');
process.exitCode = failed ? 1 : 0;
