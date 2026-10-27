// A-1 e2e: the app runs from moshpit://, cross-origin isolated (SharedArrayBuffer live) in the UI and
// the render worker; nothing outside app/dist or the preview folder is served; a preview video plays
// and seeks through range requests; the window cannot navigate away. Run: node app/test/protocol.e2e.mjs
import { launchApp } from './launch.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'out', 'app-protocol');
const userDataDir = path.join(outDir, 'userdata');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const run = await launchApp({ root, userData: userDataDir, port: 9341, env: { MOSHPIT_CACHE_IN_PROFILE: '1', MOSHPIT_LIBRARY: path.join(root, 'fixtures'), MOSHPIT_NO_CLOSE_PROMPT: '1' } });
let failed = 0;
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };
try {
  const win = run.win;
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.waitForSelector('.topbar', { timeout: 20000 });

  check(win.url() === 'moshpit://app/renderer/index.html', 'UI served from moshpit://', win.url());
  const ui = await win.evaluate(() => ({ iso: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function' && new SharedArrayBuffer(16).byteLength === 16 }));
  check(ui.iso && ui.sab, 'UI is cross-origin isolated, SharedArrayBuffer live', JSON.stringify(ui));

  // The worker: on moshpit://, isolated, and doing real work (the library listing comes from it).
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell').first().waitFor({ timeout: 30000 });
  const wp = run.page((u) => u.includes('worker.html'));
  const wk = wp ? { url: wp.url(), ...(await wp.evaluate(() => ({ iso: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function' }))) } : null;
  check(!!wk && wk.url.startsWith('moshpit://app/worker.html?') && wk.iso && wk.sab, 'worker on moshpit://, isolated, serving the library', JSON.stringify(wk)?.slice(0, 160));

  // Path guards: nothing outside the renderer bundle or the preview folder.
  const status = (u, init) => win.evaluate(async ([u, init]) => { try { return (await fetch(u, init)).status; } catch (e) { return 'blocked'; } }, [u, init]);
  check((await status('moshpit://app/renderer/index.html')) === 200, 'the bundle is served');
  for (const u of ['moshpit://app/main.cjs', 'moshpit://app/renderer/..%2Fmain.cjs', 'moshpit://app/renderer/%2E%2E/%2E%2E/package.json', 'moshpit://app/other/x', 'moshpit://app/media/relative.mp4']) { const s = await status(u); check(s === 404 || s === 403, `not served: ${u}`, String(s)); }
  const outside = path.join(root, 'package.json');
  check((await status('moshpit://app/media/' + encodeURIComponent(outside))) === 403, 'media outside the preview folder is refused');
  check((await status('file:///' + outside.replace(/\\/g, '/'))) === 'blocked', 'file:// is not readable from the page');

  // A preview file plays and seeks over range requests.
  const pdir = await win.evaluate(() => window.moshpitHost.files.previewDir());
  const pfile = path.join(pdir, 'preview_protocol test #1.mp4');
  fs.copyFileSync(path.join(root, 'fixtures', 'src-a.mp4'), pfile);
  const url = 'moshpit://app/media/' + encodeURIComponent(pfile);
  const range = await win.evaluate(async (u) => { const r = await fetch(u, { headers: { Range: 'bytes=0-99' } }); return { s: r.status, n: (await r.arrayBuffer()).byteLength, cr: r.headers.get('content-range') }; }, url);
  check(range.s === 206 && range.n === 100 && range.cr?.startsWith('bytes 0-99/'), 'range request answered exactly', JSON.stringify(range));
  const play = await win.evaluate((u) => new Promise((res) => {
    const v = document.createElement('video');
    v.muted = true; v.src = u;
    const t = setTimeout(() => res({ err: 'timeout', rs: v.readyState }), 15000);
    v.onerror = () => (clearTimeout(t), res({ err: v.error?.message ?? 'error' }));
    v.onloadeddata = () => { const d = v.duration; v.onseeked = () => (clearTimeout(t), res({ d, at: v.currentTime })); v.currentTime = d / 2; };
  }), url);
  check(!play.err && play.d > 0 && Math.abs(play.at - play.d / 2) < 0.2, 'a preview video loads and seeks', JSON.stringify(play));

  // The window never navigates off the app.
  await win.evaluate(() => { location.href = 'file:///C:/'; });
  await win.waitForTimeout(800);
  check(win.url() === 'moshpit://app/renderer/index.html', 'navigation away is blocked', win.url());
  check(errors.length === 0, 'no page errors', errors.slice(0, 2).join(' | '));
  fs.rmSync(pfile, { force: true });
} catch (e) {
  check(false, 'run', String(e).split('\n')[0]);
} finally {
  run.kill();
}
console.log(failed ? `protocol: FAILED (${failed})` : 'protocol: all ok');
process.exitCode = failed ? 1 : 0;
