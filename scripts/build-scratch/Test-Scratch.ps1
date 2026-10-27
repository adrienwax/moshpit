[CmdletBinding()]
param([string]$NodePath=(Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Scratch-Paths.ps1')
$results=[Collections.Generic.List[object]]::new()
function Require([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function MustRefuse([scriptblock]$Action,[string]$Pattern) {
  $refused=$false
  try { & $Action | Out-Null } catch { if ($_.Exception.Message -notmatch $Pattern) { throw }; $refused=$true }
  Require $refused "Expected refusal: $Pattern"
}
$oldTemp=$env:TEMP; $oldTmp=$env:TMP; $oldManaged=$env:EDENA_SCRATCH_MANAGED
$wrapper=Join-Path $PSScriptRoot 'Run-WithScratch.ps1'
$fixture=Join-Path $PSScriptRoot 'fixture-process.mjs'
$ok=& $wrapper -FilePath $NodePath -ArgumentList @($fixture,'root','normal','space arg','a"b','endslash\') -WorkingDirectory $PSScriptRoot -RunKind portable-test -MaxWaitSeconds 20
Require ($ok.Status -eq 'Succeeded' -and $ok.TempDeleted -and $ok.AllProcessesExited) 'Tree fixture did not finish and clean safely'
$receipt=Get-Content -LiteralPath $ok.Receipt -Raw | ConvertFrom-Json
$records=@('root','child','grandchild' | ForEach-Object {Get-Content -LiteralPath (Join-Path $ok.RunDirectory "artifacts/$_.json") -Raw | ConvertFrom-Json})
foreach($item in $records) { Require ($item.temp -eq $receipt.Temp -and $item.tmp -eq $receipt.Temp -and $item.managed -eq '1' -and $item.run -eq $ok.RunDirectory -and $item.artifacts -eq (Join-Path $ok.RunDirectory 'artifacts')) 'Descendant environment inheritance failed' }
Require ((Get-Content -LiteralPath (Join-Path $ok.RunDirectory 'artifacts/grandchild-done.json') -Raw | ConvertFrom-Json).tempExisted) 'Cleaned while detached grandchild still needed temp'
Require (($records[0].args -join '|') -ceq 'space arg|a"b|endslash\') 'Windows argument quoting failed'
Require ((Get-Content -LiteralPath $receipt.Stdout -Raw) -match 'scratch fixture stdout root') 'Stdout log missing'
Require ((Get-Content -LiteralPath $receipt.Stderr -Raw) -match 'scratch fixture stderr root') 'Stderr log missing'
Require ($env:TEMP -eq $oldTemp -and $env:TMP -eq $oldTmp -and $env:EDENA_SCRATCH_MANAGED -eq $oldManaged) 'Caller environment not restored'
$results.Add(@{Test='Detached child and grandchild inherit scoped env; root exits first; entire job completion; exact argv; caller env restored';Passed=$true;Receipt=$ok.Receipt})
$failed=& $wrapper -FilePath $NodePath -ArgumentList @($fixture,'root','failure') -WorkingDirectory $PSScriptRoot -RunKind build -MaxWaitSeconds 20
Require ($failed.ExitCode -eq 7 -and $failed.AllProcessesExited -and -not $failed.TempDeleted -and (Test-Path -LiteralPath (Join-Path $failed.RunDirectory 'temp/root.tmp'))) 'Nonzero failure scratch was not preserved'
$results.Add(@{Test='Nonzero root exit retains scratch';Passed=$true;Receipt=$failed.Receipt})
$timed=& $wrapper -FilePath $NodePath -ArgumentList @($fixture,'root','timeout') -WorkingDirectory $PSScriptRoot -RunKind portable-test -MaxWaitSeconds 1
Require (-not $timed.AllProcessesExited -and -not $timed.TempDeleted -and (Test-Path -LiteralPath (Join-Path $timed.RunDirectory 'temp'))) 'Timeout deleted scratch or claimed completion'
Start-Sleep -Seconds 3
Require (Test-Path -LiteralPath (Join-Path $timed.RunDirectory 'artifacts/grandchild-done.json')) 'Timeout killed detached grandchild'
$results.Add(@{Test='Timeout preserves temp and does not kill detached child';Passed=$true;Receipt=$timed.Receipt})
MustRefuse { Assert-OwnedScratchTemp -RunDirectory (Get-ScratchRoot) -ExpectedNonce ('a'*32) } 'outside'
MustRefuse { Assert-OwnedScratchTemp -RunDirectory $PSScriptRoot -ExpectedNonce ('a'*32) } 'outside'
MustRefuse { Assert-OwnedScratchTemp -RunDirectory $failed.RunDirectory -ExpectedNonce ('b'*32) } 'mismatch'
$marker=Get-Content -LiteralPath (Join-Path $failed.RunDirectory 'OWNER.json') -Raw | ConvertFrom-Json
MustRefuse { Remove-OwnedScratchTemp -RunDirectory $failed.RunDirectory -ExpectedNonce $marker.Nonce -AllProcessesExited $false -ExitCode 0 } 'entire process tree'
MustRefuse { Remove-OwnedScratchTemp -RunDirectory $failed.RunDirectory -ExpectedNonce $marker.Nonce -AllProcessesExited $true -ExitCode 7 } 'entire process tree'
$results.Add(@{Test='Root, outside, owner nonce, incomplete-tree and failure cleanup guards';Passed=$true})
# Junction is created ONLY inside the failed fixture, points to a newly created
# sibling fixture directory; it is left for explicit later cleanup with the run.
$target=Join-Path $failed.RunDirectory 'reparse-target'
New-Item -ItemType Directory -Path $target | Out-Null
[IO.File]::WriteAllText((Join-Path $target 'keep.txt'),'must remain')
$link=Join-Path $failed.RunDirectory 'temp/redirect'
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
MustRefuse { Assert-OwnedScratchTemp -RunDirectory $failed.RunDirectory -ExpectedNonce $marker.Nonce } 'Redirected descendant'
MustRefuse { Assert-NoScratchReparse (Join-Path $link 'child/other') } 'Redirected path'
Require (Test-Path -LiteralPath (Join-Path $target 'keep.txt')) 'Guard touched redirected contents'
$results.Add(@{Test='Descendant junction and redirected ancestor refuse; preexisting preserved';Passed=$true;Run=$failed.RunDirectory})
$report=[ordered]@{Created=(Get-Date).ToUniversalTime().ToString('o');PowerShell=$PSVersionTable.PSVersion.ToString();Tests=$results;NoOwnerAppsOpened=$true;NoGlobalEnvironmentChanged=$true;FailureAndTimeoutFixturesRetained=$true}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ok.RunDirectory 'artifacts/TEST-RESULTS.json') -Encoding utf8
$report | ConvertTo-Json -Depth 6
