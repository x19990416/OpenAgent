param(
  [ValidateSet('x64', 'arm64')]
  [string]$Arch = $(if ($env:OPENAGENT_WIN_ARCH) { $env:OPENAGENT_WIN_ARCH } else { 'x64' }),

  [switch]$SkipBuild,
  [switch]$Clean,
  [switch]$UseLocalProxy,
  [switch]$KillRunningApp
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir '..')
Set-Location $rootDir

if ($UseLocalProxy) {
  $env:HTTP_PROXY = 'http://127.0.0.1:7890'
  $env:HTTPS_PROXY = 'http://127.0.0.1:7890'
  $env:ALL_PROXY = 'socks5://127.0.0.1:7890'
}

function Test-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE"
  }
}

function Get-RunningOpenAgent {
  return @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -eq 'OpenAgent' })
}

function Stop-PackagedOpenAgentIfRequested {
  $runningApps = Get-RunningOpenAgent
  if (-not $runningApps) {
    return
  }

  if (-not $KillRunningApp) {
    $processList = ($runningApps | ForEach-Object {
      $path = if ($_.Path) { $_.Path } else { '<path unavailable>' }
      "PID $($_.Id): $path"
    }) -join [Environment]::NewLine
    throw @"
OpenAgent is still running and may lock release\win-unpacked\resources\app.asar:
$processList

Close it and rerun the command, or rerun with:
pnpm package:windows:installer -- -Clean -KillRunningApp
"@
  }

  foreach ($process in $runningApps) {
    Write-Host "Stopping running OpenAgent process PID $($process.Id)..."
    Stop-Process -Id $process.Id -Force
  }
  Start-Sleep -Milliseconds 500
}

function Assert-FileIsNotLocked {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $stream.Close()
  } catch {
    throw "File is locked by another process: $Path. Close the process that holds it, then retry. Common causes: OpenAgent, Clash for Windows, Explorer preview, antivirus, or file indexers. Original error: $($_.Exception.Message)"
  }
}

if (-not (Test-CommandExists 'pnpm')) {
  throw 'pnpm is required but was not found in PATH.'
}

if (-not (Test-Path (Join-Path $rootDir 'node_modules'))) {
  Write-Host 'node_modules not found; installing dependencies with pnpm install --frozen-lockfile...'
  Invoke-Native pnpm install --frozen-lockfile
}

if ($Clean) {
  $releaseDir = Join-Path $rootDir 'release'
  if (Test-Path $releaseDir) {
    Stop-PackagedOpenAgentIfRequested
    $resolvedReleaseDir = Resolve-Path $releaseDir
    if (-not $resolvedReleaseDir.Path.StartsWith($rootDir.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove release directory outside workspace: $resolvedReleaseDir"
    }
    try {
      Remove-Item -Recurse -Force -LiteralPath $resolvedReleaseDir
    } catch {
      throw "Failed to remove $resolvedReleaseDir. Close any running OpenAgent from release\win-unpacked and retry, or use -KillRunningApp. Original error: $($_.Exception.Message)"
    }
  }
}

if (-not $SkipBuild) {
  Invoke-Native pnpm build
}

$mainEntry = Join-Path $rootDir 'dist\main\main.js'
$rendererEntry = Join-Path $rootDir 'dist\renderer\index.html'
if (-not (Test-Path $mainEntry)) {
  throw "Missing Electron main entry: $mainEntry. Run pnpm build or omit -SkipBuild."
}
if (-not (Test-Path $rendererEntry)) {
  throw "Missing renderer entry: $rendererEntry. Run pnpm build or omit -SkipBuild."
}

$existingAsar = Join-Path $rootDir 'release\win-unpacked\resources\app.asar'
Assert-FileIsNotLocked $existingAsar

$archFlag = "--$Arch"
Write-Host "Packaging Windows NSIS installer for $Arch..."
Invoke-Native pnpm exec electron-builder --config electron-builder.config.cjs --win nsis $archFlag --publish never

$installers = Get-ChildItem -Path (Join-Path $rootDir 'release') -Recurse -File -Filter '*Installer*.exe' |
  Sort-Object FullName

if (-not $installers) {
  throw 'Windows installer was not found under release/. Expected release/*Installer*.exe'
}

Write-Host ''
Write-Host 'Windows installer artifact(s):'
foreach ($artifact in $installers) {
  $sizeMb = [Math]::Round($artifact.Length / 1MB, 2)
  Write-Host ("{0} MB`t{1}" -f $sizeMb, $artifact.FullName)
}

$unpacked = Get-ChildItem -Path (Join-Path $rootDir 'release') -Recurse -Directory -Filter 'win*-unpacked' |
  Sort-Object FullName

if ($unpacked) {
  Write-Host ''
  Write-Host 'Windows unpacked artifact(s):'
  foreach ($artifact in $unpacked) {
    Write-Host $artifact.FullName
  }
}
