# 打包 cowork 框架给另一台机器（生成 zip，可放进共享目录）
# 用法：.\install\package-for-peer.ps1 [-OutDir <目录>] [-CopyToShare <共享目录>]
param(
  [string]$OutDir = "",
  [string]$CopyToShare = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
if (-not $OutDir -or $OutDir.Trim() -eq "") { $OutDir = Join-Path $root "dist" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$packageFile = Join-Path $root "package.json"
$packageJsonText = [System.IO.File]::ReadAllText($packageFile, [System.Text.UTF8Encoding]::new($false))
$versionMatch = [regex]::Match($packageJsonText, '"version"\s*:\s*"([^"]+)"')
$version = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { "0.0.0" }
$zipPath = Join-Path $OutDir "cowork-framework-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# 用临时目录收集要打包的文件（排除 node_modules / work / tests / research / dist / .git）
$staging = Join-Path $env:TEMP "cowork-pkg-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$excludeDirs = @("node_modules", ".pnpm-store", ".tmp", "work", "work-b", "tests", "research", "dist", ".git", ".github", ".cowork")
$items = Get-ChildItem -Path $root -Force | Where-Object { $excludeDirs -notcontains $_.Name }
foreach ($item in $items) {
  if ($item.PSIsContainer) {
    Copy-Item $item.FullName (Join-Path $staging $item.Name) -Recurse -Force
  } else {
    Copy-Item $item.FullName (Join-Path $staging $item.Name) -Force
  }
}
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
Remove-Item $staging -Recurse -Force

Write-Host "已生成：$zipPath" -ForegroundColor Green
Write-Host "在另一台机器上解压后运行："
Write-Host "  .\install\install-bundle.ps1 -Profile web        # 推荐：作为 DSH bundle 安装"
Write-Host "  # 或旧版兜底：.\install\install-dsh-plugin.ps1 -RepoPath <本机克隆目录> -Agent <身份>"
Write-Host "  然后按 docs\tutorial-two-machines.zh.md 的步骤 join 共享工作区。"
Write-Host "  注意：解压后先运行 cowork join 生成 ~\.cowork\config.json，插件即可零配置解析 repoPath/agent。"

if ($CopyToShare -and $CopyToShare.Trim() -ne "") {
  New-Item -ItemType Directory -Force -Path $CopyToShare | Out-Null
  Copy-Item $zipPath $CopyToShare -Force
  Write-Host "已复制到共享目录：$CopyToShare"
}
