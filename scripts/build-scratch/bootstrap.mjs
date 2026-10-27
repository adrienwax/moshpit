// Shared Windows build launcher. No process/user/global environment changes outside
// the isolated child; never deletes files. Run-WithScratch owns lifecycle/cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function resolveScratchRoot(env = process.env) {
  const value = env.KRAB_SCRATCH_ROOT ?? (env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'KRAB', 'scratch') : '');
  if (!/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f]/.test(value) || value.slice(2).includes(':')) throw new Error('KRAB_SCRATCH_ROOT must be an absolute local directory; otherwise LOCALAPPDATA is required.');
  const root = path.win32.normalize(value).replace(/[\\/]+$/, '');
  if (root.length <= 2) throw new Error('A drive root cannot be a scratch directory.');
  return root;
}
export const SCRATCH_ROOT = resolveScratchRoot();
const same = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

export function inspectManaged(env = process.env, io = fs) {
  const run = env.EDENA_SCRATCH_RUN;
  if (!run || !same(path.win32.dirname(run), SCRATCH_ROOT) || !/^[a-f0-9]{32}$/.test(path.win32.basename(run))) throw new Error('Invalid managed scratch run. Use Run-WithScratch.ps1.');
  const temp = path.win32.join(run, 'temp');
  const artifacts = path.win32.join(run, 'artifacts');
  if (env.EDENA_SCRATCH_MANAGED !== '1' || ![env.TEMP, env.TMP, env.EDENA_SCRATCH_TEMP].every(v => v && same(v, temp)) || !env.EDENA_ARTIFACTS_DIR || !same(env.EDENA_ARTIFACTS_DIR, artifacts)) throw new Error('Scratch environment mismatch.');
  for (const leaf of [temp, artifacts]) {
    let current = leaf;
    while (true) {
      const stat = io.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(io.realpathSync(current), current)) throw new Error(`Redirected scratch path refused: ${current}`);
      const parent = path.win32.dirname(current);
      if (same(parent, current)) break;
      current = parent;
    }
  }
  const owner = JSON.parse(io.readFileSync(path.win32.join(run, 'OWNER.json'), 'utf8'));
  if (owner.Schema !== 1 || owner.RunId !== path.win32.basename(run) || !same(owner.Root, SCRATCH_ROOT) || !same(owner.Temp, temp) || !/^[a-f0-9]{32}$/.test(owner.Nonce) || io.readFileSync(path.win32.join(run, '.owner-lock'), 'utf8') !== owner.Nonce) throw new Error('Scratch ownership mismatch.');
  return { run, temp, artifacts };
}

export function encodedInvocation({ wrapper, executable, args, cwd, kind }) {
  const data = Buffer.from(JSON.stringify({ wrapper, executable, args, cwd, kind }), 'utf8').toString('base64');
  // Only base64 data is interpolated. Quoted paths, dollar signs and backticks
  // remain data; arrays go directly to the native launcher without cmd.exe.
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json; $r=& $d.wrapper -FilePath $d.executable -ArgumentList @($d.args) -WorkingDirectory $d.cwd -RunKind $d.kind; $r | ConvertTo-Json -Compress; if ($r.Status -ne 'Succeeded') { if ($null -ne $r.ExitCode -and $r.ExitCode -ne 0 -and $r.ExitCode -le 2147483647) { exit [int]$r.ExitCode }; exit 1 }`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function ensureScratch(kind = 'build') {
  if (!['build', 'package', 'portable-test'].includes(kind)) throw new Error('Unknown scratch run kind.');
  if (process.platform !== 'win32') throw new Error('This build lane requires Windows.');
  if (process.env.EDENA_SCRATCH_MANAGED) return inspectManaged();
  const wrapper = fileURLToPath(new URL('./Run-WithScratch.ps1', import.meta.url));
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  console.log(`Starting isolated ${kind}; logs and outputs will be under ${SCRATCH_ROOT}.`);
  const encoded = encodedInvocation({ wrapper, executable: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), kind });
  // PowerShell itself must inherit isolated temp before its first module/assembly load.
  // This tiny launcher-only scratch is deliberately retained: it is outside the
  // managed child job, so root-process exit is not sufficient cleanup evidence.
  requireScratchOutput(SCRATCH_ROOT);
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const launcher = path.join(SCRATCH_ROOT, `bootstrap-${randomUUID().replaceAll('-', '')}`);
  fs.mkdirSync(launcher);
  const launcherTemp = path.join(launcher, 'temp');
  fs.mkdirSync(launcherTemp);
  fs.writeFileSync(path.join(launcher, 'launcher.json'), JSON.stringify({ schema: 1, created: new Date().toISOString(), kind, temp: launcherTemp, retained: true }), { flag: 'wx' });
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: 'inherit', windowsHide: true, env: { ...process.env, KRAB_SCRATCH_ROOT: SCRATCH_ROOT, TEMP: launcherTemp, TMP: launcherTemp } });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Supported by the installed electron/install.js and builder-util/app-builder-lib.
// Package-local download/cache state is transient; the wrapper owns its removal.
export function configureToolCaches(scratch) {
  process.env.electron_config_cache = path.join(scratch.temp, 'electron-cache');
  process.env.ELECTRON_BUILDER_CACHE = path.join(scratch.temp, 'electron-builder-cache');
}

export function requireScratchOutput(value) {
  if (!/^[a-z]:[\\/]/i.test(value)) throw new Error(`Build outputs must use an absolute local path: ${value}`);
  const resolved = path.win32.resolve(value);
  if (!same(resolved, SCRATCH_ROOT) && !resolved.toLowerCase().startsWith(SCRATCH_ROOT.toLowerCase() + '\\')) throw new Error(`Build output must stay inside KRAB_SCRATCH_ROOT: ${value}`);
  for (let current = resolved; ; current = path.win32.dirname(current)) {
    if (fs.existsSync(current) && (!same(fs.realpathSync(current), current) || fs.lstatSync(current).isSymbolicLink())) throw new Error(`Redirected output path refused: ${current}`);
    if (current === path.win32.dirname(current)) break;
  }
  return resolved;
}
