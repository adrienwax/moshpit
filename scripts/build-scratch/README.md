# Build scratch wrapper

`Run-WithScratch.ps1` runs one executable with a new, exclusive GUID run under:

`%LOCALAPPDATA%/KRAB/scratch/<run-id>`

Set `KRAB_SCRATCH_ROOT` to choose another absolute local directory. Drive roots, relative paths and redirected paths are refused. Build outputs must remain within that directory. The variable is scoped to child processes; it is not saved globally.

The executable must be an absolute executable path (for example `node.exe`, not an npm `.cmd` shim). Arguments are a PowerShell string array, preserved with Windows command-line quoting. The script returns a PowerShell object with `Status`, `Receipt`, `RunDirectory`, `TempDeleted`, `AllProcessesExited`, and `ExitCode`; an outer launcher must treat any status other than `Succeeded` as unsuccessful. It does not terminate the invoking shell.

```powershell
$result = & ./Run-WithScratch.ps1 -FilePath (Get-Command node).Source `
  -ArgumentList @('C:\absolute\project\scripts\package.mjs') `
  -WorkingDirectory 'C:\absolute\project' -RunKind package
```

`RunKind` is `build`, `package` or `portable-test`. `MaxWaitSeconds` defaults to 1800; allowed range 1–86400. Windows PowerShell5.1 may require an invocation-only `-ExecutionPolicy Bypass` to run a local reviewed script. No persistent execution-policy change is needed or performed.

Before launching children, this invocation sets process-scoped values:

| Variable | Value |
|---|---|
| `TEMP`, `TMP`, `EDENA_SCRATCH_TEMP` | `<run>/temp` |
| `EDENA_SCRATCH_RUN` | `<run>` |
| `EDENA_ARTIFACTS_DIR` | `<run>/artifacts` |
| `EDENA_SCRATCH_MANAGED` | `1` |

The caller's exact previous values (including absent variables) are restored on return. Child processes inherit these values. No user/machine environment, registry or shell profile is changed. Package scripts must deliberately write retained artifacts to their chosen output directory or `EDENA_ARTIFACTS_DIR`; this wrapper does not copy project folders or packages.

## Completion and preservation

The child is created suspended, assigned to an unnamed Windows Job Object, then resumed. The job has no breakaway flags and no kill-on-close flag. Detached descendants remain tracked. Cleanup waits for the job's active-process count to reach zero **and** the root process handle to signal exit, with root exit code zero. This checks tree lifetime; it does not independently validate rendered output or every child's exit code. A build entry point remains responsible for propagating build failures.

Only this invocation's new `temp` directory is eligible for deletion. A fixed normalized root, generated run ID, nonce ownership marker/lock and recursive reparse-point inspection guard that operation. Root directories, older runs, artifacts, logs and receipts are never cleanup targets. Descendant or ancestor junctions/symlinks refuse cleanup.

On nonzero exit, timeout, process-tracking errors or cleanup uncertainty, scratch stays in place. The wrapper never kills applications. If initial job assignment fails, its newly created suspended child is resumed to avoid leaving it suspended, but remains untrusted for cleanup. The failure receipt says so. If a portable app remains open beyond the timeout, close it normally later; its retained scratch requires a separately reviewed/manual cleanup. No future-run sweep is performed.

Retained `OWNER.json`, `.owner-lock`, `stdout.log`, `stderr.log`, `artifacts/` and `receipt.json` identify each run. No arguments are copied into receipts, to avoid retaining credentials inadvertently supplied on a command line.

## Bounded tests

`Test-Scratch.ps1` uses tiny Node fixtures only. It checks detached child/grandchild inheritance and root-exits-first behavior, exact space/quote/backslash arguments, log capture, scoped environment restoration, root failure preservation, timeout survival, whitelist/nonce/tree-status guards, and both ancestor and descendant junction rejection. Failure and timeout fixtures are deliberately retained. Tests have been exercised under PowerShell7 and Windows PowerShell5.1; no Moshpit/CT application is launched and no large builds are run by this test.

The Node bootstrap also gives the first PowerShell process a fresh E-drive bootstrap-<guid>/temp before startup. This small launcher-only scratch is retained conservatively; it is outside the managed child job. Main build temp still uses the separate tracked run and is cleaned under the guards above. No blanket sweep is performed. Test reports are written in the successful fixture run's E artifacts directory.
