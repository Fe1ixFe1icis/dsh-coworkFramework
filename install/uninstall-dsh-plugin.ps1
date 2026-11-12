# 从 dsh profile 卸载 cowork 插件（安全版：不会把 cordis.patch.yml 变成非法 YAML）
# 支持两种安装方式：
#   - bundle：profile 的 dsh.profile.bundles 里有 @cowork/framework → 用 dsh plugin remove
#   - 旧版手工安装：profile 的 cordis.patch.yml 里有 # >>> cowork plugin 块 → 删块 + 删包
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install\uninstall-dsh-plugin.ps1 -Profile web
param(
  [string]$Profile = "web",
  [string]$DshHome = "",
  [switch]$KeepPackage
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $DshHome -or $DshHome.Trim() -eq "") {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$pluginDir = Join-Path $profileDir "node_modules\@cowork\framework"
$profilePackage = Join-Path $profileDir "package.json"

Write-Host "== 卸载 cowork 插件 ==" -ForegroundColor Cyan
Write-Host "profile : $profileDir"

# 1) 如果是 bundle 安装，先用 dsh plugin remove（同时清掉 bundles 列表和依赖）
$isBundle = $false
if (Test-Path $profilePackage) {
  try {
    $profileJson = Get-Content $profilePackage -Raw | ConvertFrom-Json
    $bundles = @($profileJson.dsh.profile.bundles)
    if ($bundles -contains "@cowork/framework") { $isBundle = $true }
  } catch {
    Write-Warning "读取 profile package.json 失败（继续按手工安装处理）：$profilePackage"
  }
}
if ($isBundle) {
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if (-not $dsh) {
    throw "检测到 bundle 安装，但 PATH 上没有 dsh。请运行：dsh plugin --profile $Profile remove @cowork/framework"
  }
  Write-Host "检测到 bundle 安装，执行：dsh plugin --profile $Profile remove @cowork/framework"
  & dsh plugin --profile $Profile remove "@cowork/framework"
  if ($LASTEXITCODE -ne 0) {
    throw "dsh plugin remove 失败（退出码 $LASTEXITCODE）。请手动执行：dsh plugin --profile $Profile remove @cowork/framework"
  }
  Write-Host "已从 profile 移除 bundle。"
}

# 2) 清理旧版手工安装的补丁块（如果存在）
if (Test-Path $patchFile) {
  $text = [System.IO.File]::ReadAllText($patchFile, [System.Text.UTF8Encoding]::new($false))
  $backup = "$patchFile.bak-uninstall-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patchFile $backup
  Write-Host "已备份：$backup"

  $pattern = "(?s)# >>> cowork plugin.*?# <<< cowork plugin\r?\n?"
  $text = [regex]::Replace($text, $pattern, "")

  # 删完只剩注释/空行时补 `[]`，保证 patch 层仍是 YAML 数组
  $lines = $text -split "\r?\n"
  $hasEntry = $false
  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
    $hasEntry = $true
    break
  }
  if (-not $hasEntry) {
    $text = ($lines | Where-Object { $_.Trim() -ne "[]" }) -join "`r`n"
    $text = $text.TrimEnd()
    if ($text -ne "") { $text += "`r`n" }
    $text += "[]`r`n"
  }
  [System.IO.File]::WriteAllText($patchFile, $text, [System.Text.UTF8Encoding]::new($false))
  Write-Host "已移除手工安装的插件条目：$patchFile"
} elseif (-not $isBundle) {
  throw "找不到补丁文件：$patchFile"
}

# 3) 删除旧版手工安装的插件包（bundle 的依赖已由 dsh plugin remove 清理）
if (-not $KeepPackage -and (Test-Path $pluginDir)) {
  Remove-Item $pluginDir -Recurse -Force
  Write-Host "已删除插件包：$pluginDir"
}

# 4) 校验：配置树能重新组合、且不再包含 cowork
$dump = & dsh --profile $Profile --dump-config 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Warning "dsh --dump-config 仍失败（退出码 $LASTEXITCODE）：$dump"
  Write-Warning "如仍有手工补丁，可恢复备份：Copy-Item `"$backup`" `"$patchFile`" -Force"
  exit 1
}
if ($dump -match "cowork") { Write-Warning "dump-config 里仍能看到 cowork，请检查 $patchFile" }
else { Write-Host "校验通过：配置树已不再包含 cowork。" }

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
Write-Host "运行中的 dsh 会自动热卸载；不放心可重启 dsh。"
