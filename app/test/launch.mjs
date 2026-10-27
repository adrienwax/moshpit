// One launch for the e2e files that must also prove the PACKAGED exe (moshpit:// out of the asar, the
// job process forked from it): dev = Playwright's Electron launch of app/dist; MOSHPIT_EXE=<exe> =
// spawn the exe and drive it over CDP, as picker / fullloop do. Pages are Playwright Pages either way.
import { _electron as electron, chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

/** Launch with a throwaway profile. `port` is the CDP port (packaged only; pick one per test file). */
export async function launchApp({ root, userData, env = {}, port }) {
  const exe = process.env.MOSHPIT_EXE;
  const fullEnv = { ...process.env, ...env };
  if (exe) {
    const pid = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { stdio: 'ignore', env: fullEnv }).pid;
    let browser;
    for (let i = 0; i < 120 && !browser; i++) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => new Promise((r) => setTimeout(r, 1000)));
    const pages = () => browser.contexts().flatMap((c) => c.pages());
    let win;
    for (let i = 0; i < 60 && !win; i++) { win = pages().find((p) => p.url().endsWith('/renderer/index.html')); if (!win) await new Promise((r) => setTimeout(r, 500)); }
    console.log(`packaged: ${exe}`);
    return { packaged: true, pid, win, page: (pred) => pages().find((p) => pred(p.url())), kill: () => killTree(pid) };
  }
  const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${userData}`], cwd: root, timeout: 30000, env: fullEnv });
  const win = await app.firstWindow();
  const pid = app.process().pid;
  return { packaged: false, pid, win, page: (pred) => app.windows().find((p) => pred(p.url())), kill: () => killTree(pid) };
}

export function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}

/** PIDs of the "Moshpit jobs" utility process(es) under `rootPid` (a Node-service utility child). */
export function jobsPids(rootPid) {
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine
$kids = @{}; foreach ($p in $all) { $kids[[int]$p.ParentProcessId] += ,$p }
$q = New-Object System.Collections.Queue; $q.Enqueue(${Number(rootPid)}); $out = @()
while ($q.Count) { $id = $q.Dequeue(); foreach ($c in $kids[[int]$id]) { $q.Enqueue([int]$c.ProcessId); if ($c.CommandLine -match 'node\\.mojom\\.NodeService') { $out += $c.ProcessId } } }
$out -join ','`;
  const r = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  return r ? r.split(',').map(Number) : [];
}

/** Working set of `rootPid` and every descendant, MB (what getAppMetrics sums, without main access). */
export function treeMemMB(rootPid) {
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize
$kids = @{}; foreach ($p in $all) { $kids[[int]$p.ParentProcessId] += ,$p }
$sum = ($all | Where-Object { $_.ProcessId -eq ${Number(rootPid)} }).WorkingSetSize
$q = New-Object System.Collections.Queue; $q.Enqueue(${Number(rootPid)})
while ($q.Count) { $id = $q.Dequeue(); foreach ($c in $kids[[int]$id]) { $q.Enqueue([int]$c.ProcessId); $sum += $c.WorkingSetSize } }
[math]::Round($sum / 1MB)`;
  return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim());
}
