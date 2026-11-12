# cowork - install as a DSH bundle (recommended)
#
# Unlike the legacy install-dsh-plugin.ps1, this script does not copy files or edit the
# profile's cordis.patch.yml by hand. It runs `dsh plugin add`, which installs the package
# and records @cowork/framework in the profile's dsh.profile.bundles. The bundle's own
# cordis.patch.yml is then applied automatically.
#
# Usage (from the framework repository root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-bundle.ps1 -Profile web
#
# Install a published package, tarball, or GitHub repo instead:
#   ... -Spec "@scope/cowork"
#   ... -Spec ".\cowork-framework-0.1.0.tgz"
#   ... -Spec "github:owner/cowork#v0.1.0"
param(
  [string]$Profile = "web",
  [string]$Spec = "",
  [string]$DshHome = "",
  [switch]$SkipVerify,
  [switch]$SkipCli
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$frameworkSource = Split-Path -Parent $scriptDir

if (-not $Spec -or $Spec.Trim() -eq "") {
  $Spec = $frameworkSource
} elseif (Test-Path $Spec) {
  $Spec = (Resolve-Path $Spec).Path
}

if ($DshHome -and $DshHome.Trim() -ne "") {
  $env:DSH_HOME = $DshHome
}

Write-Host "== cowork bundle install ==" -ForegroundColor Cyan
Write-Host "Profile : $Profile"
Write-Host "Spec    : $Spec"
if ($env:DSH_HOME) { Write-Host "DSH_HOME: $env:DSH_HOME" }

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  throw "dsh was not found on PATH. Install DeepSeek Harness first, or run from a source checkout with pnpm dsh."
}
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  throw "dsh plugin installs through pnpm, but pnpm is not on PATH. Run: corepack enable"
}

if (-not (Test-Path (Join-Path $frameworkSource "cordis.patch.yml"))) {
  throw "Framework source is incomplete (cordis.patch.yml is missing): $frameworkSource"
}

# 1) Install. dsh reads dsh.bundle from package.json and appends the bundle to the profile.
& dsh plugin --profile $Profile add $Spec
if ($LASTEXITCODE -ne 0) {
  throw "dsh plugin add failed (exit code $LASTEXITCODE). Check pnpm and network access, or run: dsh plugin --profile $Profile install"
}
Write-Host "Installed bundle: @cowork/framework" -ForegroundColor Green

# 2) Verify the composed config without starting the GUI.
if (-not $SkipVerify) {
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $dumpLines = & dsh --profile $Profile --dump-config 2>&1
    $dumpExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
  }
  $dumpText = ($dumpLines | Out-String)
  if ($dumpExit -ne 0) {
    Write-Warning "dsh --dump-config failed (exit code $dumpExit):`n$dumpText"
  } elseif ($dumpText -match "id: cowork") {
    Write-Host "Composed config contains the cowork row." -ForegroundColor Green
  } else {
    Write-Warning "The cowork row was not found in --dump-config. Check dsh.profile.bundles and cordis.patch.yml."
  }
}

# 3) Show where repoPath/agent will come from.
#    Resolution order: COWORK_REPO/COWORK_AGENT -> ~/.cowork/config.json -> clone .cowork/config.json
$globalConfigFile = Join-Path $env:USERPROFILE ".cowork\config.json"
Write-Host ""
Write-Host "== local configuration =="
if (Test-Path $globalConfigFile) {
  try {
    $global = Get-Content $globalConfigFile -Raw | ConvertFrom-Json
    Write-Host "Found $globalConfigFile"
    if ($global.repoPath) { Write-Host "  repoPath: $($global.repoPath)" }
    if ($global.agent) { Write-Host "  agent   : $($global.agent)" }
  } catch {
    Write-Warning "Could not read the global config (ignored): $globalConfigFile"
  }
} else {
  Write-Warning "No global config at $globalConfigFile"
  Write-Host "  Run cowork init or cowork join on this machine, or set:"
  Write-Host "    `$env:COWORK_REPO = 'D:\work\project'"
  Write-Host "    `$env:COWORK_AGENT = 'A'"
  Write-Host "  You can also override the cowork row in this profile's cordis.patch.yml (see docs/publishing.zh.md)."
}

# 4) Optionally install the cowork CLI.
if (-not $SkipCli) {
  $cliScript = Join-Path $scriptDir "install-cli.ps1"
  if (Test-Path $cliScript) {
    Write-Host ""
    Write-Host "== install the cowork command ==" -ForegroundColor Cyan
    & $cliScript -FrameworkDir $frameworkSource
  }
}

Write-Host ""
Write-Host "Activation:" -ForegroundColor Green
Write-Host "  - With live patch reload the plugin hot-loads; otherwise restart dsh."
Write-Host "  - Verify: dsh --profile $Profile --dump-config should show id: cowork."
Write-Host "  - Uninstall: dsh plugin --profile $Profile remove @cowork/framework"
Write-Host "  - If the legacy installer was used before, run uninstall-dsh-plugin.ps1 first to avoid duplicate id: cowork rows."
