# 排障手册

按「现象 → 原因 → 处理」组织。命令默认在本地克隆目录里执行（例如 `D:\work\project`）。

---

## 1. 共享目录 / 凭据

### 现象：`Access denied`、`共享目录不可访问`

1. 先在资源管理器里打开 `\\fileserver\cowork`，确认能进、能新建文件。
2. 如果要求输入凭据：勾选「记住我的凭据」，或命令行：

   ```powershell
   net use \\fileserver\cowork /user:<用户名> <密码> /persistent:yes
   net use        # 应显示 OK
   ```

3. 共享所在机器要开启「文件和打印机共享」，防火墙放行 445 端口；
   两台机器上 `Test-NetConnection fileserver -Port 445` 应为 True。
4. 如果共享只允许某个 Windows 账号写：两台机器用同一账号，或在共享 ACL 里给两个账号都加写权限。
5. 共享目录使用了「仅允许已列出的用户」之类的高级共享设置时，注意 SMB 会话是**按登录会话**建立的，
   在另一个用户会话里映射的盘符/连接不一定可见。

### 现象：`status` 里共享可访问，但 git 报 `dubious ownership`

共享仓库/文件属主与当前用户不同时 git 会拒绝：

```powershell
git config --global --add safe.directory "//fileserver/cowork/repo.git"
```

cowork 用到的本地克隆一般不会触发；触发时按报错里的路径加即可。

### 现象：`pwsh`/`bash` 里访问共享目录一律 `Access denied`，但资源管理器能进

这是 **DSH 会话沙箱**（workspace-write）限制：子进程 token 受限，无法访问 UNC 共享。

- 日常协作请用 `cowork_*` 插件工具（它们在 dsh 宿主进程执行，不受限）；
- 需要在 shell 里直接跑 `cowork` 命令时，把会话切到 **完全权限**（中文界面「完全权限」）。

---

## 2. 命令 / 环境

### 现象：`cowork : 无法将“cowork”项识别为…`

`cowork` 命令还没装到 PATH。任选其一：

```powershell
# 1) 一键安装命令（推荐：写入 %APPDATA%\npm\cowork.cmd，该目录通常已在 PATH 上）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\tools\cowork-framework\install\install-cli.ps1
# 装完新开一个终端（或在当前终端里执行  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')）

# 2) 不想装命令：始终用完整路径
node "D:\tools\cowork-framework\bin\cowork.mjs" status
# 或在克隆目录里：
node ..\bin\cowork.mjs status
```

说明：`cowork.cmd` 是只含 `node <框架目录>\bin\cowork.mjs %*` 的 shim；删除它即可卸载命令，
框架目录移动后重跑 `install-cli.ps1` 修正指向。

> 不要用 `setx PATH "%PATH%;..."` 手工加 PATH：`setx` 在 PATH 超过 1024 字符时会截断，风险很大。

### 现象：`未找到 git` / `git --version` 失败

安装 Git for Windows（>= 2.30），安装时选择把 git 加入 PATH，然后重开终端。
`cowork doctor` 会显示 git 版本；git 是唯一的外部依赖（Node 随 dsh 自带）。

### 现象：PowerShell 执行安装脚本报「不是数字签名」或语法错误

- 用绕过执行策略的方式调用：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-dsh-plugin.ps1 ...
  ```
- 脚本文件带 UTF-8 BOM，Windows PowerShell 5.1 与 PowerShell 7 都能正确解析中文；
  如果你用编辑器改过脚本，注意保存为 UTF-8 with BOM，否则可能报奇怪的语法错误。

### 现象：命令行里中文乱码

PowerShell 5.1 默认不是 UTF-8。临时设置：

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
```

cowork 的 CLI 输出已经是 UTF-8；乱码通常只是终端编码问题，不影响功能。

### 现象：`cowork status` 每次都说「有 N 个未提交改动」，但没改过文件

全局 `core.autocrlf=true` 导致工作区被转成 CRLF、index 是 LF，看起来「假脏」。
cowork 的 init/join 会把克隆设为 `core.autocrlf=false` 并重置工作区；手动修复：

```powershell
git config core.autocrlf false
git reset --hard
```

### 现象：中文文件名显示为 `\344\270\255...`

git 默认转义非 ASCII 文件名。可设置：

```powershell
git config --global core.quotepath false
```

### 现象：想在同一台机器上模拟两台机器 / 跑测试互相干扰

cowork 的全局配置默认在 `%USERPROFILE%\.cowork\config.json`；可以用环境变量 `COWORK_HOME`
指向另一个目录，隔离全局配置（测试脚本 `tests/*` 已经这样做了）：

```powershell
$env:COWORK_HOME = "$env:TEMP\cowork-home-b"
node bin\cowork.mjs status
```

---

## 3. 任务板 / 锁

### 现象：`等待共享板锁超时`

- 另一台机器正在写任务板：等几秒重试。
- 锁文件超过 45 秒未更新会被自动清理；急用可确认无人操作后手动删：
  `Remove-Item "\\fileserver\cowork\board\.board.lock"`。
- 反复出现：检查两台机器**系统时间**是否准确（锁过期判断依赖 mtime）、共享目录是否只读。

### 现象：任务板 JSON 损坏（`任务板文件损坏`）

board 写入是「临时文件 + rename」且每次写前备份，正常断电不会坏；如果坏了：

```powershell
Copy-Item "\\...\cowork\board\board.json.bak" "\\...\cowork\board\board.json" -Force
```

### 现象：两个任务同时创建丢了其中一个

正常不会（写板走跨机器锁 + 读-改-写）。若真的发生：
先看 `board/events.jsonl` 审计记录，确认哪些操作成功；再从两台机器的 `.cowork/config.json` 确认 agent 名不重复
（**同一台机器不要同时用两个不同 agent 身份操作同一个克隆**）。

---

## 4. git 分支 / 冲突

### 现象：`cowork sync` 冲突

```
同步失败：与 origin/main 冲突，rebase 已暂停。
冲突文件：
  - src/app.ts
```

1. 打开冲突文件，解决 `<<<<<<<` / `=======` / `>>>>>>>` 标记；
2. `git add <文件>`（或直接 `cowork save` 前先 add）；
3. `cowork sync --continue`；
4. 想放弃：`cowork sync --abort`。

### 现象：`cowork publish` 推送被拒（non-fast-forward）

rebase 改写了历史。`cowork publish` 对任务分支会自动用 `--force-with-lease` 重推；
如果仍失败，说明远程分支被其他人改过（不应该发生），先 `cowork sync` 再 `publish`。

### 现象：`cowork merge` 冲突（工具自动中止）

这是预期行为：main 保持干净，返回冲突文件列表。处理方式：

- 让分支作者：`cowork sync` 解决冲突 → `cowork publish`（重新推送）；
- 评审方再 `cowork merge`。
- 或者评审方临时在本地手动 merge 解决冲突后推送 main（不推荐，容易两边不一致）。

### 现象：任务一直停在 review，没人合并

`cowork task list --review` 查看；`cowork send <对方> "..." --task <任务号>` 催一下；
也可以自己 `cowork review` 后 `cowork merge`（两台机器权限相同）。

### 现象：合并后本地分支/文件没更新

合并发生在评审方机器，作者机器需要：

```powershell
cowork sync          # 在作者的任务分支上 rebase 到最新 main
```

如果作者已经切到 main：`git checkout main; cowork sync`。

---

## 5. DSH 插件

### 现象：DSH 工具列表里没有 `cowork_*`

按顺序检查：

1. 安装脚本是否成功：`dsh --profile web --dump-config | Select-String cowork` 应能看到 `- id: cowork`；
2. `dsh --profile web --dump-config` 失败 → `cordis.patch.yml` YAML 非法（常见：空 profile 的 `[]` 直接追加）。
   恢复备份 `profiles\web\cordis.patch.yml.bak-*`，用新版安装脚本重装；
3. 插件目录存在：`%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-cowork-framework\src\plugin.mjs`；
4. 重启 dsh（关掉运行的 dsh 窗口后重新 `dsh web`）。profile 的 HMR 会热加载补丁改动，
   但**如果插件文件本身是复制进去的，首次最好重启一次**；
5. 看 dsh 启动日志/控制台是否有 `cowork: 插件已加载` 或加载错误。

### 现象：工具报 `[cowork] 未配置仓库路径`

profile 补丁里 `repoPath` 缺失或写错：

```yaml
- insert:
    - id: cowork
      name: 'dsh-cowork-framework'
      config:
        repoPath: 'D:/work/project'
        agent: 'A'
        notify: true
```

改完保存即热加载（HMR），或重启 dsh。也可以 `cowork join` 后重跑安装脚本。

### 现象：工具报 `找不到 cowork 仓库配置`

`repoPath` 指向了**源码目录**（没有 `.cowork/config.json`）而不是**本地克隆**。
用 `cowork init/join` 生成的克隆目录，例如 `D:\work\project`。

### 现象：插件条目被自动禁用（`dsh: disabling profile plugin ...`）

cowork 声明了 `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`。当前 dsh 版本超出这个范围时，安装或启动会禁用该行。

- 首选：把 dsh 升级到 0.2.x；两台机器版本差异大时，统一到同一版本最稳。
- 确认插件仍兼容、只是版本号不匹配时，可以按 dsh 的精确版本豁免流程处理：

  ```powershell
  dsh plugin --profile web allow-version dsh-cowork-framework@0.2.0 --dsh-version <当前版本> --accept-risk
  ```

  这是有风险的操作，只在明确知道兼容性时使用；`revoke-version` 可撤销。

### 现象：安装/启动 dsh 时看到 `skipping profile bundle "@deepseek-ai/dsh-experimental-agent-team-web-profile"`

这是 profile 的 `dsh.profile.bundles` 里声明了**未安装的可选实验性 bundle**，dsh 自动跳过它，
不影响 Web GUI 和 cowork 插件（与 cowork 无关，是 profile 既有状态）。

- 想彻底消除：在联网环境执行 `dsh plugin --profile web install`（补装依赖）；
  或者从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里删除该项后重启（会失去对应实验功能）。
- 安装脚本现已把这类警告单独列出、继续完成安装，不会再让它看起来像安装失败。

### 现象：安装脚本校验时报 `PLUGIN_IMPORT_FAIL: Cannot find package 'dsh-cowork-framework'`

说明插件包没复制到位，或脚本在错误的目录做检查。重跑安装脚本（幂等）；
仍失败时检查 `profiles\<profile>\node_modules\dsh-cowork-framework\package.json` 是否存在。

### 现象：改了插件源码想立刻生效

- 用 `install-dsh-plugin.ps1 -Dev`：profile 里是指向源码目录的联接，改 `src/` 后
  保存一次 `cordis.patch.yml`（触发 HMR 重组）即可重挂载；
- 复制安装模式：重新跑安装脚本 → 保存 `cordis.patch.yml` 触发重载，或重启 dsh。

### 现象：想临时验证插件但不影响正在用的 GUI

用一次性 profile（不要用 `web`，也不要占 3080）：

```powershell
dsh --profile cowork-qa --from-default-profile web --dump-config
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-dsh-plugin.ps1 -Profile cowork-qa -RepoPath "D:\work\project" -Agent A
$env:COWORK_PROBE='1'
dsh --profile cowork-qa --port 3085 --no-open
# 端口打开后检查：
Get-Content "$env:TEMP\cowork-plugin-probe.json"
# 验证完关掉该窗口，删除临时 profile：
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\cowork-qa"
```

### 现象：安装后想彻底卸载

用卸载脚本（推荐，自动处理空 patch 的 `[]` 哨兵并校验）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\uninstall-dsh-plugin.ps1 -Profile web
```

手工步骤（如果想自己删）：
1. 删除 `profiles\<profile>\cordis.patch.yml` 中 `# >>> cowork plugin` 到 `# <<< cowork plugin` 的整块；
2. 删除 `profiles\<profile>\node_modules\dsh-cowork-framework`；
3. **如果文件删完只剩注释，必须补一行 `[]`**（patch 层必须是 YAML 数组），否则下次启动 dsh 会报
   `overlay ... must be a top-level YAML array of loader patch entries`；
4. 运行中的 dsh 会自动热卸载；不放心就重启。
   校验：`dsh --profile web --dump-config` 退出码 0 且 `| Select-String cowork` 无输出。

---

## 6. 测试与验证

### 现象：`npm run test:plugin` 输出 `SKIP`

这是预期行为：插件测试需要 DSH 自带的 `@deepseek-ai/dsh-tools` / `schemastery` / `dsh-llm`，
干净 checkout 或普通 CI 机器上没有这些包。要真正跑插件测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\prepare-deps.ps1
npm run test:plugin
```

发布前可设置 `$env:COWORK_REQUIRE_PLUGIN_DEPS='1'`，让缺依赖直接失败。

### 现象：`npm run test:smb` 输出 `SKIP`

真实 SMB 测试默认不跑（避免在普通机器上误写共享）。指定共享目录才会执行：

```powershell
npm run test:smb -- --share "\\fileserver\cowork"
```

指定了共享但不可访问会作为真实失败处理；测试会在共享根下创建临时子目录并在成功后清理。

### 现象：`cowork task claim` 提示「已指派给 X」

任务创建时用了 `--assign X`。这不影响任务存在，只限制认领身份：

- 让 X 执行 `cowork task claim <任务号>`；
- 或由 X 用 `cowork task update <任务号> --assign none` 取消指派；
- 确认要接管时用 `cowork task claim <任务号> --force`（会写入历史记录）。

### 现象：任务板损坏后修复了，但 `.bak` 也不可信

`board.json.bak` 只保留上一版。正常写入是「临时文件 + rename」，损坏概率很低；如果 `.bak` 也坏：

1. 从另一台机器/冷备份恢复（任务板不在 git 里，每台机器的本地克隆也没有它）；
2. 或让一台机器重新 `cowork init` 重建任务板（会丢任务和消息，先备份整个 `cowork\board\`）；
3. 重要节点建议定期冷备份共享目录里的 `cowork\`。

---

## 7. 数据安全与回滚

- **误合并了分支**：main 上撤销一次合并：

  ```powershell
  git checkout main
  git revert -m 1 <合并提交的sha>    # 生成一个反向提交，安全、可再合并
  git push origin main
  ```

- **误删了远程分支**：只要合并过，提交在 main 历史里；未合并的被删分支可从其他机器的本地分支
  `git push origin <分支>` 恢复。删分支前先 `cowork review` 确认。
- **误 import 覆盖了文件**：`git log` 找到 import 提交，`git show <sha>^:<文件> > 文件` 恢复旧内容。
- **备份**：`board.json.bak` 只保留上一版；重要节点可手动复制 `cowork\` 目录做冷备份，
  或 `git --git-dir=repo.git bundle create backup.bundle --all`。

---

## 8. 性能

- `cowork status` 默认会 fetch + 读共享板，SMB 慢时约 0.5~2 秒；插件工具默认 `refresh=false` 更快。
- 大仓库（几 GB）在 SMB 上首次 clone 会慢，之后只传增量；避免把构建产物/大二进制提交进仓库
  （`.gitignore` 里已忽略常见项，按需补充）。
- 任务板文件很小，2~10 台机器规模足够；更多机器建议把任务板换成一个局域网 HTTP 服务（可后续扩展）。
