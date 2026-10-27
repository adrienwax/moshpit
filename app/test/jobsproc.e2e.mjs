// A-3 e2e: imports run in the "Moshpit jobs" utilityProcess; killing it mid-import fails that import
// with JOB_PROCESS_CRASHED, main starts a new job process, and the next import works and conforms to
// the same bytes. Only this test's own process tree is killed. Run: node app/test/jobsproc.e2e.mjs
import { jobsPids as jobsOf, killTree, launchApp } from './launch.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'out', 'app-jobsproc');
const userDataDir = path.join(outDir, 'userdata');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const run = await launchApp({ root, userData: userDataDir, port: 9342, env: { MOSHPIT_CACHE_IN_PROFILE: '1', MOSHPIT_LIBRARY: path.join(root, 'fixtures'), MOSHPIT_NO_CLOSE_PROMPT: '1' } });
let failed = 0;
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };
const jobsPids = async () => jobsOf(run.pid);
const importClip = (file, opts) => win.evaluate(async ([file, opts]) => {
  try { const r = await window.__moshpitEngine.importClip(file, () => {}, opts).promise; return { ok: true, hash: r.conform.conformedHash, frames: r.conform.frames }; } catch (e) { return { ok: false, code: e?.code ?? String(e) }; }
}, [file, opts]);
let win;
try {
  win = run.win;
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.waitForSelector('.topbar', { timeout: 20000 });
  await win.waitForFunction(() => !!window.__moshpitEngine, null, { timeout: 20000 });

  const first = await jobsPids();
  check(first.length === 1, 'one job process running', JSON.stringify(first));
  const a = await importClip(path.join(root, 'fixtures', 'src-a.mp4'), { proxyFirst: false });
  check(a.ok && a.hash.length > 0, 'an import runs through it', JSON.stringify(a));

  // Crash it mid-import: a full (master) conform of the biggest fixture, killed after it starts.
  const pending = importClip(path.join(root, 'fixtures', 'src-c.mp4'), { proxyFirst: false, quality: 'smooth' });
  await win.waitForTimeout(700);
  killTree(first[0]);
  const crashed = await pending;
  check(!crashed.ok && crashed.code === 'JOB_PROCESS_CRASHED', 'the in-flight import fails with JOB_PROCESS_CRASHED', JSON.stringify(crashed));

  let next = [];
  for (let i = 0; i < 40 && !(next.length === 1 && next[0] !== first[0]); i++) { await win.waitForTimeout(250); next = await jobsPids(); }
  check(next.length === 1 && next[0] !== first[0], 'main started a new job process', `${first[0]} → ${next[0]}`);

  // The next import works; the same file on a fresh key conforms to the same bytes as before.
  const b = await importClip(path.join(root, 'fixtures', 'src-b.mp4'), { proxyFirst: false });
  check(b.ok, 'the next import works', JSON.stringify(b));
  const again = await importClip(path.join(root, 'fixtures', 'src-a.mp4'), { proxyFirst: false });
  check(again.ok && again.hash === a.hash, 'same file, same conform hash after the restart', `${a.hash?.slice(0, 12)} / ${again.hash?.slice(0, 12)}`);
  // And the UI never noticed beyond the one failed call.
  check(errors.length === 0, 'no page errors', errors.slice(0, 2).join(' | '));
} catch (e) {
  check(false, 'run', String(e).split('\n')[0]);
} finally {
  run.kill();
}
console.log(failed ? `jobsproc: FAILED (${failed})` : 'jobsproc: all ok');
process.exitCode = failed ? 1 : 0;
