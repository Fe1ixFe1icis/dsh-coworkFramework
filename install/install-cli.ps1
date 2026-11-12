# 把 cowork 命令安装到 PATH（在任意目录都能直接敲 cowork）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-cli.ps1
# 默认写入 %APPDATA%\npm\cowork.cmd（该目录通常已在 PATH 上，因为 dsh 就装在那里）；
# 如果该目录不存在，则写到 %USERPROFILE%\cowork\bin 并加入当前用户的 PATH。
param(
  [string]$FrameworkDir = "",
  [string]$ShimDir = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $FrameworkDir -or $FrameworkDir.Trim() -eq "") {
  $FrameworkDir = Split-Path -Parent $scriptDir
}
$cli = Join-Path $FrameworkDir "bin\cowork.mjs"
if (-not (Test-Path $cli)) { throw "找不到 CLI 入口：$cli（用 -FrameworkDir 指定框架目录）" }

# 选择 shim 目录：优先 npm 全局目录（在 PATH 上），否则用户目录 + 持久化 PATH
$addedToPath = $false
if (-not $ShimDir -or $ShimDir.Trim() -eq "") {
  $npmDir = Join-Path $env:APPDATA "npm"
  if (Test-Path $npmDir) {
    $ShimDir = $npmDir
  } else {
    $ShimDir = Join-Path $env:USERPROFILE "cowork\bin"
  }
}
New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null

$shimFile = Join-Path $ShimDir "cowork.cmd"
# 注意：shim 用 ASCII 注释，避免 cmd 在非 UTF-8 代码页下把注释显示成乱码。
$content = "@echo off`r`nrem cowork CLI shim (installed by cowork framework; delete this file to remove the command)`r`nnode `"$cli`" %*`r`n"
[System.IO.File]::WriteAllText($shimFile, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "已安装命令：$shimFile -> $cli"

# 如果 shim 目录不在用户 PATH 里，持久化加入
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathParts = @()
if ($userPath) { $pathParts = $userPath -split ";" | Where-Object { $_.Trim() -ne "" } }
$inPath = $false
foreach ($part in $pathParts) {
  if ($part.TrimEnd('\') -ieq $ShimDir.TrimEnd('\')) { $inPath = $true; break }
}
if (-not $inPath) {
  $newPath = (@($pathParts) + @($ShimDir)) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $addedToPath = $true
  Write-Host "已把 $ShimDir 加入当前用户 PATH（新开的终端生效）。"
}

# 验证（用完整路径调用，不依赖当前进程 PATH 是否已刷新）
$versionOutput = & cmd /c "`"$shimFile`" version" 2>&1
if ($LASTEXITCODE -ne 0) { throw "命令验证失败：$versionOutput" }
Write-Host "验证通过：$versionOutput"

Write-Host ""
Write-Host "现在可以在任意目录使用：cowork status / cowork task new ..." -ForegroundColor Green
if ($addedToPath) {
  Write-Host "注意：当前已打开的终端如果还找不到 cowork，请新开一个终端（或临时执行：`$env:Path += `";$ShimDir`"）。"
}
Write-Host "备选：始终可用  node `"$cli`" status   （不依赖 PATH）"
