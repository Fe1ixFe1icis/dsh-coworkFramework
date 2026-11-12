# 从 dsh profile 卸载 cowork 插件（安全版：不会把 cordis.patch.yml 变成非法 YAML）
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

Write-Host "== 卸载 cowork 插件 ==" -ForegroundColor Cyan
Write-Host "profile : $profileDir"
if (-not (Test-Path $patchFile)) { throw "找不到补丁文件：$patchFile" }

$text = [System.IO.File]::ReadAllText($patchFile, [System.Text.UTF8Encoding]::new($false))
$backup = "$patchFile.bak-uninstall-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $patchFile $backup
Write-Host "已备份：$backup"

# 1) 删除 cowork 块
$pattern = "(?s)# >>> cowork plugin.*?# <<< cowork plugin\r?\n?"
$text = [regex]::Replace($text, $pattern, "")

# 2) 如果删完只剩注释/空行，补一个 `[]` 空数组（YAML patch 层必须是数组）
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
Write-Host "已移除插件条目：$patchFile"

# 3) 删除插件包
if (-not $KeepPackage) {
  if (Test-Path $pluginDir) {
    Remove-Item $pluginDir -Recurse -Force
    Write-Host "已删除插件包：$pluginDir"
  }
}

# 4) 校验：配置树能重新组合、且不再包含 cowork
$dump = & dsh --profile $Profile --dump-config 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Warning "dsh --dump-config 仍失败（退出码 $LASTEXITCODE）：$dump"
  Write-Warning "可恢复备份：Copy-Item `"$backup`" `"$patchFile`" -Force"
  exit 1
}
if ($dump -match "cowork") { Write-Warning "dump-config 里仍能看到 cowork，请检查 $patchFile" }
else { Write-Host "校验通过：配置树已不再包含 cowork。" }

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
Write-Host "运行中的 dsh 会自动热卸载；不放心可重启 dsh。"
