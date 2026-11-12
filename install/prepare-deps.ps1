# 为本地开发测试准备依赖：把 dsh 自带的 node_modules 联接到本仓库根，
# 让 `node tests/plugin.test.mjs` 能 import 到 @deepseek-ai/dsh-tools / schemastery / dsh-llm。
# 说明：正式安装插件时不需要它（插件会装进 dsh profile 的 node_modules）。
param(
  [string]$DshNodeModules = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$target = Join-Path $root "node_modules"

# 已经手工准备过依赖（例如逐个联接 @deepseek-ai 包）时直接跳过，避免误删。
if (Test-Path $target) {
  $dshTools = Join-Path $target "@deepseek-ai\dsh-tools\package.json"
  if (Test-Path $dshTools) {
    Write-Host "已存在可用的 node_modules（含 @deepseek-ai/dsh-tools），无需处理。"
    exit 0
  }
  $item = Get-Item $target -Force
  if ($item.LinkType) {
    Write-Host "已存在联接：$target -> $($item.Target)"
    exit 0
  }
  Write-Host "已存在 node_modules 目录但缺少 dsh 依赖，未做改动：$target"
  Write-Host "如需自动联接，先移走/删除该目录再重跑本脚本。"
  exit 0
}

if (-not $DshNodeModules -or $DshNodeModules.Trim() -eq "") {
  $DshNodeModules = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh\node_modules"
}
if (-not (Test-Path $DshNodeModules)) {
  throw @"
找不到 dsh 的 node_modules：$DshNodeModules
用 -DshNodeModules 指定，例如：
  .\install\prepare-deps.ps1 -DshNodeModules "C:\Users\<你>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules"
如果 dsh 是从源码/pnpm 工作区运行，请把 @deepseek-ai/dsh-tools、schemastery、dsh-llm 分别联接到本仓库的 node_modules\@deepseek-ai\ 下（或只跑不需要插件的 npm test）。
"@
}
New-Item -ItemType Junction -Path $target -Target $DshNodeModules | Out-Null
Write-Host "已创建联接：$target -> $DshNodeModules"
