# cowork 框架 —— DSH 插件安装脚本
# 用法（在任意 PowerShell 里，建议以当前用户身份运行，不要用管理员提权）：
#   .\install\install-dsh-plugin.ps1 -RepoPath "D:\work\project" -Agent "A"
# 可选：-Profile web（默认）、-Dev（用目录联接代替复制，改动源码立即生效）
param(
  [string]$Profile = "web",
  [string]$RepoPath = "",
  [string]$Agent = "",
  [string]$DshHome = "",
  [switch]$Dev,
  [switch]$SkipVerify,
  [switch]$SkipCli
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$frameworkSource = Split-Path -Parent $scriptDir

if (-not $DshHome -or $DshHome.Trim() -eq "") {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
$targetDir = Join-Path $profileDir "node_modules\dsh-cowork-framework"
$patchFile = Join-Path $profileDir "cordis.patch.yml"

Write-Host "== cowork 插件安装 ==" -ForegroundColor Cyan
Write-Host "框架源码: $frameworkSource"
Write-Host "profile : $profileDir"

if (-not (Test-Path $profileDir)) {
  throw "找不到 profile 目录：$profileDir。请先启动一次 dsh（例如 dsh web），或检查 -Profile/-DshHome。"
}
if (-not (Test-Path (Join-Path $frameworkSource "src\plugin.mjs"))) {
  throw "框架源码不完整（缺少 src\plugin.mjs）：$frameworkSource"
}

# 1) 读取全局 cowork 配置，补默认 repoPath / agent
$globalConfigFile = Join-Path $env:USERPROFILE ".cowork\config.json"
if (Test-Path $globalConfigFile) {
  try {
    $globalText = [System.IO.File]::ReadAllText($globalConfigFile, [System.Text.UTF8Encoding]::new($false))
    $globalConfig = $globalText | ConvertFrom-Json
    if ((-not $RepoPath) -and $globalConfig.repoPath) { $RepoPath = $globalConfig.repoPath }
    if ((-not $Agent) -and $globalConfig.agent) { $Agent = $globalConfig.agent }
  } catch { Write-Warning "读取全局配置失败（忽略）：$globalConfigFile" }
}
if ((-not $RepoPath) -and (Test-Path (Join-Path (Get-Location) ".cowork\config.json"))) {
  $RepoPath = (Get-Location).Path
}
if (-not $RepoPath) {
  Write-Warning "没有拿到本地克隆路径。插件会先装上，但调用工具前需要在 cordis.patch.yml 里补 repoPath（或用 -RepoPath 重跑本脚本）。"
}
if (-not $Agent) {
  Write-Warning "没有拿到 agent 身份；插件会回退到仓库 .cowork/config.json 里的身份。"
}

# 2) 安装插件包到 profile 的 node_modules
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetDir) | Out-Null
if (Test-Path $targetDir) {
  # 删除旧安装（如果是联接，只删除联接本身）
  $existing = Get-Item $targetDir -Force
  if ($existing.LinkType) { cmd /c rmdir "$targetDir" } else { Remove-Item $targetDir -Recurse -Force }
}
if ($Dev) {
  New-Item -ItemType Junction -Path $targetDir -Target $frameworkSource | Out-Null
  Write-Host "已创建目录联接（开发模式）：$targetDir -> $frameworkSource"
} else {
  $excludeDirs = @("node_modules", "work", "work-b", "tests", "research", "dist", ".git", ".github", ".tmp")
  $robocopyArgs = @($frameworkSource, $targetDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:2", "/W:2")
  foreach ($dir in $excludeDirs) { $robocopyArgs += @("/XD", (Join-Path $frameworkSource $dir)) }
  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 复制失败，退出码 $LASTEXITCODE" }
  Write-Host "已复制插件包到：$targetDir"
}

# 3) 修改 profile 的 cordis.patch.yml（幂等：先移除旧块再追加）
$patchText = ""
if (Test-Path $patchFile) {
  $patchText = [System.IO.File]::ReadAllText($patchFile, [System.Text.UTF8Encoding]::new($false))
  $backup = "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patchFile $backup
  Write-Host "已备份原补丁文件：$backup"
  $pattern = "(?s)# >>> cowork plugin.*?# <<< cowork plugin\r?\n?"
  $patchText = [regex]::Replace($patchText, $pattern, "")
}
# 空数组标记 `[]` 会让追加的条目变成非法 YAML：模板 profile 的 patch 文件就是 `[]`。
$patchLines = $patchText -split "\r?\n" | Where-Object { $_.Trim() -ne "[]" }
$patchText = ($patchLines -join "`r`n").TrimEnd()
if ($patchText -ne "") { $patchText += "`r`n" }
$yamlPath = if ($RepoPath) { $RepoPath.Replace("\", "/") } else { "" }
$yamlAgent = $Agent
function Escape-Yaml([string]$value) { return $value.Replace("'", "''") }
$block = @()
$block += "# >>> cowork plugin（由 install-dsh-plugin.ps1 生成；删除本块并重启 dsh 即可卸载）"
$block += "- insert:"
$block += "    - id: cowork"
$block += "      name: 'dsh-cowork-framework'"
$block += "      config:"
if ($yamlPath) { $block += "        repoPath: '$(Escape-Yaml $yamlPath)'" }
if ($yamlAgent) { $block += "        agent: '$(Escape-Yaml $yamlAgent)'" }
$block += "        notify: true"
$block += "# <<< cowork plugin"
$newPatch = $patchText + ($block -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($patchFile, $newPatch, [System.Text.UTF8Encoding]::new($false))
Write-Host "已写入插件条目：$patchFile"

# 4) 校验：模块可解析 + 配置树能组合
$nodeCheck = @"
try {
  const p = await import('dsh-cowork-framework')
  if (typeof p.apply !== 'function') throw new Error('插件缺少 apply 导出')
  console.log('PLUGIN_IMPORT_OK')
} catch (e) { console.error('PLUGIN_IMPORT_FAIL: ' + e.message); process.exit(1) }
"@
Push-Location $profileDir
try {
  $importOutput = & node --input-type=module -e $nodeCheck 2>&1
  if ($LASTEXITCODE -ne 0) { throw "插件模块加载失败：$importOutput" }
  Write-Host "插件模块加载检查：$importOutput"
} finally {
  Pop-Location
}

if (-not $SkipVerify) {
  # 抓取 stdout/stderr：PowerShell 5.1 在 $ErrorActionPreference=Stop 时会把 dsh 的 stderr 警告
  # 当成终止错误抛出（例如 profile 里缺失的可选 bundle 警告），这里显式降级为 Continue 并自己判定。
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
    throw "dsh --dump-config 失败（退出码 $dumpExit）：`n$dumpText"
  }
  if ($dumpText -match "id: cowork") {
    Write-Host "配置树已包含 cowork 条目。"
  } else {
    Write-Warning "dump-config 输出里没找到 cowork，请检查 $patchFile"
  }
  if ($dumpText -match "skipping profile bundle") {
    Write-Warning "检测到既有的 profile bundle 警告（与本插件无关：profile 里声明了未安装的可选 bundle，dsh 会自动跳过）："
    $missing = $dumpText -split "`r?`n" | Where-Object { $_ -match "skipping profile bundle" } | Select-Object -Unique
    foreach ($line in $missing) { Write-Warning "  $line" }
    Write-Warning "如需彻底消除：在联网环境执行  dsh plugin --profile $Profile install  （或从 profile 的 dsh.profile.bundles 移除缺失项）。"
  }
}

Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green

# 顺带把 cowork 命令装到 PATH（可用 -SkipCli 跳过）
if (-not $SkipCli) {
  $cliScript = Join-Path $scriptDir "install-cli.ps1"
  if (Test-Path $cliScript) {
    Write-Host ""
    Write-Host "== 安装 cowork 命令 ==" -ForegroundColor Cyan
    & $cliScript -FrameworkDir $frameworkSource
  }
}

Write-Host "生效方式："
Write-Host "  - 如果 dsh 正在运行且 profile 开启 patchReload: live，保存后会自动重载（可在 dsh 日志确认 cowork 插件加载）。"
Write-Host "  - 否则重启：先关闭当前 dsh 窗口，再运行  dsh $Profile"
Write-Host "验证：在 DSH 里新建/继续会话，工具列表应出现 cowork_status 等工具；或运行  cowork doctor。"
Write-Host "卸载：运行  powershell -NoProfile -ExecutionPolicy Bypass -File .\install\uninstall-dsh-plugin.ps1 -Profile $Profile"
Write-Host "      （会自动删补丁块、恢复空 patch 的 [] 哨兵、删插件包，并做 dump-config 校验；不要手动只删一半）"
