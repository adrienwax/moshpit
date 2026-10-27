[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$FilePath,
  [string[]]$ArgumentList=@(),
  [Parameter(Mandatory)][string]$WorkingDirectory,
  [Parameter(Mandatory)][ValidateSet('build','package','portable-test')][string]$RunKind,
  [ValidateRange(1,86400)][int]$MaxWaitSeconds=1800
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Scratch-Paths.ps1')
$scratchRoot=Get-ScratchRoot
$exe=[IO.Path]::GetFullPath($FilePath)
$cwd=[IO.Path]::GetFullPath($WorkingDirectory)
if (-not [IO.Path]::IsPathRooted($FilePath) -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'FilePath must name an existing absolute executable.' }
if (-not [IO.Path]::IsPathRooted($WorkingDirectory) -or -not (Test-Path -LiteralPath $cwd -PathType Container)) { throw 'WorkingDirectory must name an existing absolute directory.' }
Assert-NoScratchReparse $scratchRoot
if (-not (Test-Path -LiteralPath $scratchRoot)) { [IO.Directory]::CreateDirectory($scratchRoot) | Out-Null }
Assert-NoScratchReparse $scratchRoot
$runId=[Guid]::NewGuid().ToString('N')
$run=Join-Path $scratchRoot $runId
# CreateDirectory alone is not exclusive. The per-run lock is CREATE_NEW, and
# an existing run directory is never accepted even if empty.
if (Test-Path -LiteralPath $run) { throw 'Unexpected pre-existing run directory.' }
New-Item -ItemType Directory -Path $run -ErrorAction Stop | Out-Null
$nonce=[Guid]::NewGuid().ToString('N')
$lock=Join-Path $run '.owner-lock'
$lockStream=[IO.File]::Open($lock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try {
  $ownerBytes=[Text.Encoding]::UTF8.GetBytes($nonce)
  $lockStream.Write($ownerBytes,0,$ownerBytes.Length); $lockStream.Flush()
  $temp=Join-Path $run 'temp'
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  $artifacts=Join-Path $run 'artifacts'
  [IO.Directory]::CreateDirectory($artifacts) | Out-Null
  $marker=[ordered]@{Schema=1;RunId=$runId;Nonce=$nonce;Root=$scratchRoot;Temp=$temp;Created=(Get-Date).ToUniversalTime().ToString('o');RunKind=$RunKind}
  $markerFile=Join-Path $run 'OWNER.json'
  [IO.File]::WriteAllText($markerFile,($marker | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $receipt=[ordered]@{Schema=1;RunId=$runId;RunKind=$RunKind;FilePath=$exe;WorkingDirectory=$cwd;Temp=$temp;Started=$marker.Created;AllProcessesExited=$false;TempDeleted=$false;Status='Preparing';ProcessId=$null;ExitCode=$null;Stdout=(Join-Path $run 'stdout.log');Stderr=(Join-Path $run 'stderr.log')}
  $scopedEnvironment=@{KRAB_SCRATCH_ROOT=$scratchRoot;TEMP=$temp;TMP=$temp;EDENA_SCRATCH_RUN=$run;EDENA_SCRATCH_TEMP=$temp;EDENA_ARTIFACTS_DIR=$artifacts;EDENA_SCRATCH_MANAGED='1'}
  $previousEnvironment=@{}
  foreach ($key in $scopedEnvironment.Keys) { $previousEnvironment[$key]=[Environment]::GetEnvironmentVariable($key,'Process') }
  try {
    foreach ($key in $scopedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key,$scopedEnvironment[$key],'Process') }
    # Add-Type may spawn compilation helpers; scope scratch before this too.
    if (-not ('EdenaScratch.JobProcess' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'JobProcess.cs') }
    $result=[EdenaScratch.JobProcess]::Run($exe,$ArgumentList,$cwd,$receipt.Stdout,$receipt.Stderr,$MaxWaitSeconds)
    $receipt.ProcessId=$result.ProcessId
    $receipt.AllProcessesExited=$result.AllExited
    if ($result.AllExited) { $receipt.ExitCode=$result.ExitCode }
    if ($result.Error) { $receipt.Status='Tracking error; scratch retained'; $receipt.Error=$result.Error }
    elseif ($result.TimedOut) { $receipt.Status='Timed out; processes not killed; scratch retained' }
    elseif (-not $result.AllExited) { $receipt.Status='Uncertain process state; scratch retained' }
    elseif ($result.ExitCode -ne 0) { $receipt.Status='Child failed; scratch retained' }
    else {
      Remove-OwnedScratchTemp -RunDirectory $run -ExpectedNonce $nonce -AllProcessesExited $result.AllExited -ExitCode $result.ExitCode
      $receipt.TempDeleted=$true; $receipt.Status='Succeeded'
    }
  } catch { $receipt.Status='Wrapper failed; scratch retained'; $receipt.Error=$_.Exception.Message }
  finally {
    foreach ($key in $previousEnvironment.Keys) {
      if ($null -eq $previousEnvironment[$key]) { Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($key,$previousEnvironment[$key],'Process') }
    }
    $receipt.Finished=(Get-Date).ToUniversalTime().ToString('o')
    $receiptFile=Join-Path $run 'receipt.json'
    [IO.File]::WriteAllText($receiptFile,($receipt | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  }
  [pscustomobject]@{Status=$receipt.Status;Receipt=$receiptFile;RunDirectory=$run;TempDeleted=$receipt.TempDeleted;AllProcessesExited=$receipt.AllProcessesExited;ExitCode=$receipt.ExitCode}
} finally { $lockStream.Dispose() }
