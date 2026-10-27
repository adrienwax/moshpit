$ErrorActionPreference='Stop'
function Get-ScratchRoot {
  $value=$env:KRAB_SCRATCH_ROOT
  if ($null -eq $value) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA or KRAB_SCRATCH_ROOT is required.' }
    $value=Join-Path $env:LOCALAPPDATA 'KRAB\scratch'
  }
  if ($value -notmatch '^[a-zA-Z]:[\\/]' -or $value -match '[\x00-\x1f]' -or $value.Substring(2).Contains(':')) { throw 'Scratch root must be an absolute local directory.' }
  $root=[IO.Path]::GetFullPath($value).TrimEnd('\')
  if ($root.Length -le 2) { throw 'A drive root cannot be a scratch directory.' }
  return $root
}
function Assert-NoScratchReparse([string]$Path) {
  $part=[IO.Path]::GetFullPath($Path)
  while ($part) {
    if (Test-Path -LiteralPath $part) {
      $item=Get-Item -LiteralPath $part -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected path refused: $part" }
    }
    $next=Split-Path $part -Parent
    if ($next -eq $part) { break }; $part=$next
  }
}
function Assert-OwnedScratchTemp([string]$RunDirectory,[string]$ExpectedNonce) {
  $root=Get-ScratchRoot
  $run=[IO.Path]::GetFullPath($RunDirectory).TrimEnd('\')
  if ((Split-Path $run -Parent) -cne $root -or (Split-Path $run -Leaf) -notmatch '^[a-f0-9]{32}$') { throw 'Run is outside the exact scratch whitelist or not a generated run.' }
  Assert-NoScratchReparse $run
  $marker=Get-Content -LiteralPath (Join-Path $run 'OWNER.json') -Raw | ConvertFrom-Json
  $temp=Join-Path $run 'temp'
  $ownerStream=[IO.File]::Open((Join-Path $run '.owner-lock'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $ownerReader=[IO.StreamReader]::new($ownerStream)
  try { $owner=$ownerReader.ReadToEnd() } finally { $ownerReader.Dispose() }
  if ($ExpectedNonce -notmatch '^[a-f0-9]{32}$' -or $owner -cne $ExpectedNonce -or $marker.Nonce -cne $ExpectedNonce -or $marker.Schema -ne 1 -or $marker.RunId -cne (Split-Path $run -Leaf) -or $marker.Root -cne $root -or $marker.Temp -cne $temp) { throw 'Scratch ownership marker mismatch.' }
  Assert-NoScratchReparse $temp
  if (-not (Test-Path -LiteralPath $temp -PathType Container)) { throw 'Owned temp directory missing.' }
  $pending=[Collections.Generic.Stack[string]]::new(); $pending.Push($temp)
  while ($pending.Count) {
    $dir=$pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $dir -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected descendant refused: $($item.FullName)" }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
  return $temp
}
function Remove-OwnedScratchTemp([string]$RunDirectory,[string]$ExpectedNonce,[bool]$AllProcessesExited,[uint32]$ExitCode) {
  if (-not $AllProcessesExited -or $ExitCode -ne 0) { throw 'Cleanup requires verified entire process tree exit and successful root exit.' }
  $temp=Assert-OwnedScratchTemp -RunDirectory $RunDirectory -ExpectedNonce $ExpectedNonce
  # Exactly this freshly-created temp, never run/artifacts/logs/root or older runs.
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop
}
