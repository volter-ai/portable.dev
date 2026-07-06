<#
.SYNOPSIS
  Install the `portable` CLI on Windows (PRD: tasks/prd-portable-distribution.md).
  Ensures Bun is present, ensures Bun's global-bin dir is on your PATH (the step a
  WinGet/MSI Bun install skips), then `bun install -g` the CLI — hardened against
  the failure modes a fresh dev machine hits (stalled npm-registry connections, a
  running `portable` holding the global store, a half-written prior install).

.DESCRIPTION
  Run a downloaded copy:
    powershell -ExecutionPolicy Bypass -File scripts\install-portable.ps1 [source]
  Or one-liner (uses $env:PORTABLE_INSTALL_SOURCE for the source):
    irm <hosted-url>/install-portable.ps1 | iex

  `source` is any npm spec / tarball path / git url. With NO source given:
    - Run from inside the repo checkout -> it BUILDS a local artifact and installs
      that (useful for testing local changes before they are published).
    - Run anywhere else (the hosted one-liner) -> installs `@volter-ai/portable.dev`.

  Reliability features (no silent hangs on other people's machines):
   - Resolves the just-installed Bun explicitly (no dependence on a PATH refresh).
   - Refuses to install while `portable` is RUNNING (it holds the global store open
     on Windows, which would otherwise stall the install forever) — with guidance.
   - Runs the install under an INACTIVITY watchdog: a stalled registry connection
     (the classic flaky/IPv6 hang) is detected within seconds and retried, instead
     of hanging indefinitely. Uses `--prefer-offline` so warm-cache reinstalls skip
     the registry-revalidation chatter entirely.
   - Classifies a NON-transient failure (e.g. a 404 not-found) and stops with the
     real error instead of retrying it as if it were a network blip.
   - Verifies the installed shim actually RESOLVES (catches an orphaned shim).
#>
[CmdletBinding()]
param([string]$Source)
$ErrorActionPreference = 'Stop'

# An explicit source (arg or env) is honored as-is; otherwise we decide below (local
# build inside a checkout, else the published package).
$ExplicitSource = if ($Source) { $Source } elseif ($env:PORTABLE_INSTALL_SOURCE) { $env:PORTABLE_INSTALL_SOURCE } else { '' }

# Where this script lives -> the repo root (when run from a checkout). $PSScriptRoot
# is empty under `irm | iex`, so that path simply falls through to the package.
$RepoRoot = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { '' }

$BunBin = Join-Path $env:USERPROFILE '.bun\bin'
$GlobalModules = Join-Path $env:USERPROFILE '.bun\install\global\node_modules'
$PkgDir = Join-Path $GlobalModules '@volter-ai\portable.dev'
$script:InstallLog = $null  # path to the last attempt's captured output (for classification)

# Resolve a usable bun.exe even right after a fresh install (PATH may not be live
# in this session yet): PATH → bun.sh default (~/.bun/bin) → WinGet Links shim.
function Resolve-BunExe {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'),
      (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe')
    )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# PIDs of any `portable` process currently running. Its api child holds the global
# store's files open on Windows, so an in-place reinstall would stall forever.
# Matches the global-mode shim (portable.exe), the global bundle bun children
# (.../@volter-ai/portable.dev/{cli,server}.js), and a source-mode dev run
# (`bun --cwd packages/launcher start` + `packages/api/src/server`). Deliberately
# does NOT match this installer's own `bun install -g @volter-ai/portable.dev`.
function Get-RunningPortable {
  try {
    return Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      ($_.Name -eq 'portable.exe') -or
      ($_.Name -eq 'bun.exe' -and $_.CommandLine -and
        ($_.CommandLine -match 'portable\.dev[\\/](cli|server)\.js|packages[\\/]launcher[\\/].*(start|connect)|packages[\\/]api[\\/]src[\\/]server'))
    } | Select-Object -ExpandProperty ProcessId
  } catch {
    return @()
  }
}

# Build a local install artifact from this checkout and return its tarball path.
# Installing the packed .tgz — not the dist dir — is load-bearing: a global install
# of the dir can't resolve its deps (its real path sits inside the monorepo, whose
# node_modules don't hold the CLI's externals).
function Build-LocalArtifact {
  param([string]$BunExe)
  Write-Host '[portable] No source given; building a local artifact from this checkout (one-time, ~30s)...'
  Push-Location $RepoRoot
  try {
    # Pipe to Out-Host so the build's stdout is SHOWN but does NOT leak into this
    # function's return value (PowerShell folds uncaptured native command output
    # into the return — which would otherwise corrupt $Source with the build log).
    & $BunExe run build:portable | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'build:portable failed' }
    $dist = Join-Path $RepoRoot 'dist-portable'
    Push-Location $dist
    try {
      & $BunExe pm pack | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'bun pm pack failed' }
    } finally { Pop-Location }
    $tgz = Get-ChildItem (Join-Path $dist '*.tgz') -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $tgz) { throw 'no tarball produced in dist-portable' }
    return $tgz.FullName
  } finally { Pop-Location }
}

# A registry/resolution failure that retrying can't fix (the package genuinely isn't
# there, or a path/permission error) — vs a transient network stall worth retrying.
# NB: DependencyLoop is deliberately NOT here — it's recoverable by dropping a stale
# global self-pin (handled in the install loop), so it must not hard-fail.
function Test-NonTransientFailure {
  param([string]$LogPath)
  if (-not $LogPath -or -not (Test-Path $LogPath)) { return $false }
  $txt = Get-Content $LogPath -Raw -ErrorAction SilentlyContinue
  return ($txt -match '(?i)\b404\b|E404|not found|no matching version|EPERM|EACCES|ENOENT')
}

# Is $Source a LOCAL artifact (tarball/path/git) rather than the published npm spec?
# Local installs are the ones that can hit DependencyLoop when a prior install pinned
# a different tarball path, so we proactively clear the self-pin for them.
function Test-LocalSource {
  return ($Source -notmatch '^@volter-ai/portable\.dev(@.*)?$')
}

# Run `bun install -g` under an INACTIVITY watchdog. Returns $true on success.
# Progress is gauged by bun's CPU time advancing OR a new top-level package landing
# in the global store; if NEITHER moves for $StallSec, the attempt is a stalled
# registry connection (the IPv6/Cloudflare hang) and is killed so we can retry.
# Captures output to $script:InstallLog so a failure can be CLASSIFIED + shown.
function Invoke-BunInstallAttempt {
  param([string]$BunExe, [int]$StallSec = 45, [int]$CapSec = 600)
  $argv = @('install', '-g', $Source, '--prefer-offline')
  $outF = [System.IO.Path]::GetTempFileName()
  $errF = [System.IO.Path]::GetTempFileName()
  $script:InstallLog = $errF  # bun writes resolution errors (the 404) to stderr
  $p = Start-Process -FilePath $BunExe -ArgumentList $argv -NoNewWindow -PassThru `
    -RedirectStandardOutput $outF -RedirectStandardError $errF
  $lastCpu = -1.0
  $lastCount = -1
  $lastProgress = Get-Date
  $start = Get-Date
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 5
    if ($p.HasExited) { break }
    $cpu = $null
    try { $cpu = (Get-Process -Id $p.Id -ErrorAction Stop).CPU } catch { break }
    $count = -1
    try { $count = @(Get-ChildItem $GlobalModules -ErrorAction SilentlyContinue).Count } catch { }
    if (($null -ne $cpu -and $cpu -gt $lastCpu + 0.2) -or ($count -ne $lastCount)) {
      $lastProgress = Get-Date
    }
    if ($null -ne $cpu) { $lastCpu = $cpu }
    $lastCount = $count
    $idle = (New-TimeSpan -Start $lastProgress -End (Get-Date)).TotalSeconds
    $elapsed = (New-TimeSpan -Start $start -End (Get-Date)).TotalSeconds
    if ($idle -ge $StallSec) {
      Write-Host "[portable] install stalled (~$([int]$idle)s with no progress) — terminating this attempt..."
      try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch { }
      return $false
    }
    if ($elapsed -ge $CapSec) {
      Write-Host "[portable] install exceeded the ${CapSec}s cap — terminating this attempt..."
      try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch { }
      return $false
    }
  }
  # Process exited on its own (the watchdog above did NOT kill it). `Start-Process
  # -PassThru` reports a flaky/null $p.ExitCode after exit, so gauge success by the
  # reliable OUTCOME instead: the package entry actually materialized in the global
  # store. A network-failed `bun install` exits without creating it → $false.
  try { $p.WaitForExit() } catch { }
  Remove-Item $outF -ErrorAction SilentlyContinue  # stdout not needed; keep $errF for classification
  return (Test-Path (Join-Path $PkgDir 'cli.js'))
}

# 1) Ensure Bun (its own installer also adds ~/.bun/bin to PATH).
if (-not (Resolve-BunExe)) {
  Write-Host '[portable] Bun not found - installing via the official installer...'
  Invoke-RestMethod 'https://bun.sh/install.ps1' | Invoke-Expression
}
$Bun = Resolve-BunExe
if (-not $Bun) {
  throw '[portable] Bun is required but could not be found or installed. Install it from https://bun.sh and re-run.'
}
Write-Host "[portable] Using bun: $Bun ($(& $Bun --version))"

# 2) Ensure Bun's global-bin dir is on the User PATH (idempotent). A WinGet/MSI Bun
#    install often skips this, so the `portable` shim would not be found otherwise.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $BunBin) {
  $newPath = ($userPath.TrimEnd(';') + ';' + $BunBin).TrimStart(';')
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host "[portable] Added $BunBin to your User PATH (persistent)."
}
else {
  Write-Host "[portable] $BunBin already on your User PATH."
}
if (($env:Path -split ';') -notcontains $BunBin) { $env:Path = "$env:Path;$BunBin" }  # this session

# 2b) Decide the install source (needs Bun for the local build):
#       explicit arg/env  ->  honored as-is
#       inside a checkout  ->  build a local artifact from your working tree
#       otherwise          ->  the published package (the hosted one-liner case)
if ($ExplicitSource) {
  $Source = $ExplicitSource
}
elseif ($RepoRoot -and (Test-Path (Join-Path $RepoRoot 'scripts\build-portable.ts'))) {
  try {
    $Source = Build-LocalArtifact -BunExe $Bun
  } catch {
    Write-Host "[portable] Local build failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[portable] Run 'bun install' then 'bun run build:portable' to see why, and re-run." -ForegroundColor Red
    exit 1
  }
}
else {
  $Source = '@volter-ai/portable.dev'
}

# 3) Refuse to install over a RUNNING portable (it holds the global store open on
#    Windows; an in-place reinstall would stall). Abort cleanly with guidance — do
#    NOT hang, and do NOT kill the user's running session for them.
$running = @(Get-RunningPortable)
if ($running.Count -gt 0) {
  Write-Host ''
  Write-Host "[portable] ERROR: 'portable' is currently running (PID(s): $($running -join ', '))." -ForegroundColor Red
  Write-Host '[portable] On Windows the running app holds the global package files open, so an'
  Write-Host '[portable] in-place reinstall would stall. Stop it first (Ctrl-C in its terminal, or'
  Write-Host "[portable]   Stop-Process -Id $($running -join ',') -Force"
  Write-Host '[portable] ), then re-run this installer.'
  exit 1
}

# 4) Install the CLI with retries + the inactivity watchdog.
Write-Host "[portable] Installing from: $Source"
Write-Host '[portable] (first install on a fresh machine fetches dependencies — this can take a minute)'
$maxAttempts = 3
$ok = $false
# Local-tarball installs: a prior install may pin a DIFFERENT tarball path in the
# global store, which makes `bun add` of the new path fail with DependencyLoop.
# Proactively drop any stale self-pin first (a no-op on a fresh machine).
if (Test-LocalSource) {
  try { & $Bun remove -g '@volter-ai/portable.dev' 2>$null | Out-Null } catch { }
}
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  if ($attempt -gt 1) { Write-Host "[portable] retrying install (attempt $attempt/$maxAttempts)..." }
  if (Invoke-BunInstallAttempt -BunExe $Bun) { $ok = $true; break }
  # A stale global self-pin (different tarball path) loops — clear it and retry
  # rather than treating it as a hard failure.
  if ((Get-Content $script:InstallLog -Raw -ErrorAction SilentlyContinue) -match '(?i)DependencyLoop') {
    Write-Host '[portable] clearing a stale global package pin and retrying...'
    try { & $Bun remove -g '@volter-ai/portable.dev' 2>$null | Out-Null } catch { }
    continue
  }
  # A 404 / not-found / perms error won't be fixed by retrying — stop now with the
  # real error instead of three rounds mislabeled as "flaky network".
  if (Test-NonTransientFailure -LogPath $script:InstallLog) {
    Write-Host ''
    Write-Host "[portable] Install failed and retrying won't help. The error from bun was:" -ForegroundColor Red
    Get-Content $script:InstallLog -ErrorAction SilentlyContinue | Select-Object -Last 12 | ForEach-Object { Write-Host "[portable]   $_" }
    if ((Get-Content $script:InstallLog -Raw -ErrorAction SilentlyContinue) -match '(?i)\b404\b|E404|not found') {
      Write-Host ''
      Write-Host "[portable] '$Source' was not found in the npm registry." -ForegroundColor Red
      Write-Host "[portable] npm install failed — install from a checkout instead:"
      Write-Host '[portable]   git clone <repo>; cd mobile-vgit; bun install; scripts\install-portable.ps1'
      Write-Host '[portable] (run with no source, from inside the repo, and it builds + installs a local artifact).'
      Write-Host '[portable] Or point it at a built tarball:  $env:PORTABLE_INSTALL_SOURCE = ".\dist-portable\<pkg>.tgz"; scripts\install-portable.ps1'
    }
    exit 1
  }
}
if (-not $ok) {
  Write-Host ''
  Write-Host '[portable] Install did not complete after several attempts (looks like a stalled connection).' -ForegroundColor Red
  if ($script:InstallLog -and (Test-Path $script:InstallLog)) {
    Write-Host '[portable] Last output from bun:'
    Get-Content $script:InstallLog -ErrorAction SilentlyContinue | Select-Object -Last 12 | ForEach-Object { Write-Host "[portable]   $_" }
  }
  Write-Host '[portable] A stalled IPv6/Cloudflare connection is the usual culprit on Windows.'
  Write-Host '[portable] Try again on a stable connection, or run it manually to see the error:'
  Write-Host "[portable]   `"$Bun`" install -g $Source --prefer-offline"
  exit 1
}

# 5) Verify: the shim exists AND its target module actually resolves (an interrupted
#    prior install can leave an ORPHANED shim pointing at a missing package).
$shim = Join-Path $BunBin 'portable.exe'
$entry = Join-Path $PkgDir 'cli.js'
if ((Test-Path $shim) -and (Test-Path $entry)) {
  Write-Host '[portable] OK - installed. Open a NEW terminal (PATH is already refreshed in this one) and run: portable'
}
elseif (Test-Path $shim) {
  Write-Host "[portable] Install finished but the package entry is missing ($entry)." -ForegroundColor Red
  Write-Host '[portable] The shim is orphaned. Re-run this installer (the retry will materialize it).'
  exit 1
}
else {
  throw "[portable] Install finished but the portable shim was not found in $BunBin"
}
