# 两机安装教程（机器 A ↔ 机器 B）

本教程用两台 Windows 机器演示最小可用集群。实际使用时把示例值替换成你的环境：

| 占位符 | 示例 | 说明 |
|---|---|---|
| `<share-host>` | `fileserver` | 提供 SMB 共享的机器名或 IP |
| `<share-name>` | `cowork` | 共享目录名 |
| `\\<share-host>\<share-name>` | `\\fileserver\cowork` | 两台机器指向的同一物理目录 |
| `D:\tools\cowork-framework` | 框架源码目录 | `git clone` 或解压 Release 包的位置 |
| `D:\work\project` | 本地克隆 | 由 `cowork init/join` 创建，每台机器一份 |
| `A` / `B` | 身份 | 建议用短英文名或机器名；同一台机器不要用两个身份操作同一克隆 |

前置条件：

- 两台机器都安装了 **git >= 2.30** 和 **Node.js >= 20**（DSH 自带 Node，可直接用 DSH 的运行时）。
- 两台机器都安装了 **DeepSeek Harness**，并能启动 Web GUI。
- 共享目录对两台机器的 Windows 账号可读写；如果访问 UNC 需要凭据，先在资源管理器里打开一次并保存。

> 本教程不会把共享目录当作工作区。共享目录只放 `repo.git`（裸仓库）和 `board/`（任务板），
> 实际代码在每台机器的本地克隆里改。

---

## 第 1 步：机器 A 初始化共享工作区

```powershell
cd D:\tools\cowork-framework

# 可选：安装 cowork 命令到 PATH（写入 %APPDATA%\npm）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-cli.ps1

cowork init `
  --share "\\fileserver\cowork" `
  --agent A `
  --dir "D:\work\project" `
  --project demo
```

如果不想安装命令，把 `cowork` 换成 `node D:\tools\cowork-framework\bin\cowork.mjs` 即可。

这一步会：

1. 在 `\\fileserver\cowork\` 创建 `cowork.json`、`repo.git`（裸仓库）、`board\`；
2. 生成 `main` 初始提交（`README.md`、`AGENTS.md`、`.gitignore`）；
3. 把仓库克隆到 `D:\work\project`，写入 `.cowork/config.json`（身份 A、共享路径）；
4. 写全局配置 `%USERPROFILE%\.cowork\config.json`（默认身份/克隆路径）。

验证：

```powershell
cd D:\work\project
cowork status
cowork doctor
```

`status` 应显示：身份 A、共享目录 `[可访问]`、分支 `main`、工作区干净、任务板 0 个任务。
`doctor` 应全部 ✔（首次 init 后协作者可能只有 A，这是正常的）。

---

## 第 2 步：机器 B 加入

### 2.1 把框架文件传到 B

任选一种：

- 在 B 上 `git clone <仓库地址> D:\tools\cowork-framework`；
- 从 GitHub Releases 下载 `cowork-framework-0.1.0.zip` 解压；
- 在 A 上打包后复制到共享目录：

  ```powershell
  cd D:\tools\cowork-framework
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install\package-for-peer.ps1 `
    -CopyToShare "\\fileserver\cowork\dist"
  ```

  然后在 B 上把 zip 复制出来解压。

### 2.2 在 B 上 join

```powershell
cd D:\tools\cowork-framework
cowork join `
  --share "\\fileserver\cowork" `
  --agent B `
  --dir "D:\work\project"
```

成功输出「已克隆共享仓库到本地 / 身份 B / 加入完成」。

> 如果 B 是共享宿主，也可以把 `--share` 换成本机磁盘路径（例如 `D:\shares\cowork`）——
> 两台机器只要指向**同一个物理目录**就行。
>
> **共享路径必须一致地指向同一目录**：A 用 UNC、B 用本地盘符是可以的，但不要一台指向
> `D:\shares\cowork`、另一台指向 `\\fileserver\cowork` 下另一个目录。

### 2.3 在 B 上验证

```powershell
cd D:\work\project
cowork status
cowork doctor
```

- `协作者` 里应同时出现 A 和 B（心跳文件在共享目录 `board\members\`）；
- 在 A 上再跑一次 `cowork status`，也能看到 B。

---

## 第 3 步：在 B 上安装 DSH 插件

```powershell
cd D:\tools\cowork-framework
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-dsh-plugin.ps1 `
  -Profile web `
  -RepoPath "D:\work\project" `
  -Agent B
```

脚本会：

- 把插件复制到 `%USERPROFILE%\.dsh\profiles\web\node_modules\@cowork\framework`；
- 在 `cordis.patch.yml` 插入插件条目（自动备份原文件）；
- 用 `dsh --profile web --dump-config` 校验配置树；
- 安装 `cowork` 命令（除非 `-SkipCli`）。

生效方式：

- 如果 B 的 DSH 正在运行且 profile 开了 `patchReload: live`，保存补丁会热加载，无需重启；
- 否则重启 DSH（关掉当前窗口，重新运行 `dsh web`）。

验证插件是否生效（不影响正在用的 GUI，另起临时实例）：

```powershell
# 另起一个只用一次的测试 profile（可选）
dsh --profile cowork-e2e --from-default-profile web --dump-config
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-dsh-plugin.ps1 `
  -Profile cowork-e2e -RepoPath "D:\work\project" -Agent B
$env:COWORK_PROBE='1'; dsh --profile cowork-e2e --port 3083 --no-open
# 看到端口打开后另开终端：
Get-Content "$env:TEMP\cowork-plugin-probe.json"
# 应包含 13 个 cowork_* 工具、systemPromptSection=cowork:protocol、preStepHook=true
# 验证完关闭该测试窗口，并删除临时 profile：
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\cowork-e2e"
```

（在 A 上同样的安装命令为 `-Profile web -RepoPath "D:\work\project" -Agent A`。）

> 看到 `skipping profile bundle ...` 是 profile 里既有的可选 bundle 缺失警告，与 cowork 无关，
> 安装脚本会单独提示并继续。卸载请使用 `install\uninstall-dsh-plugin.ps1`，不要只手动删补丁块：
> 空 patch 必须保留 `[]` 哨兵。

---

## 第 4 步：第一次协作（两台机器各跑一遍）

在 A（`D:\work\project`）上：

```powershell
cowork task new "写一个 hello.txt 作为联调"
# 输出：已创建任务 T-0001 / 已认领 / 已创建分支 agent/A/T-0001

"hello from A" | Out-File hello.txt -Encoding utf8
cowork save -m "T-0001: 添加 hello.txt"
cowork publish
# 输出：已推送分支 ... 任务 T-0001 已置为「待合并」
```

在 B（`D:\work\project`）上：

```powershell
cowork task list --review   # 看到 T-0001 待合并
cowork review T-0001        # 看提交和改动统计
cowork merge T-0001         # 合并进 main + 推送 + 任务 done
```

再在 A 上：

```powershell
cowork sync                 # 在 A 当前的任务分支上 rebase 到最新 main
# 如果要更新本地 main（例如准备做新任务）：
#   git checkout main
#   cowork sync
cowork status               # T-0001 已完成
```

至此两台机器已经跑通「认领 → 提交 → 交付 → 评审 → 合并」的协作闭环。
下一步就可以在 DSH 里直接说：

> 「先 cowork_status 看一下；如果有待合并的分支，review 后合并；然后认领下一个任务。」

### 并发与认领规则

- 一条任务一个分支，分支名 `agent/<身份>/<任务号>`；不要两个人同时认领同一个任务。
- 任务被指派给别人（`--assign B`）时，A 直接 `cowork task claim` 会被拒绝；
  确认要接管时用 `cowork task claim <任务号> --force`。
- 同一个本地克隆上不要同时跑多个会写 git 的命令（会争抢 `.git/index.lock`）。
- 任务卡住时用 `cowork task update <任务号> --status blocked --note "原因"` 记录，别让它悄悄消失。

---

## 第 5 步：把现有共享文件迁进 git（可选，建议尽早）

```powershell
# 在 A 上，先把旧文件导入 main（导入前建议先复制一份备份）
cd D:\work\project
cowork import "\\fileserver\legacy-project"
# 输出：已导入 N 个顶层条目并提交 ... 已推送到 origin/main

# 在 B 上拉取
cd D:\work\project
cowork sync
```

之后：

- 共享目录里只保留 `cowork\` 这份协作仓库；
- 旧文件目录改名成 `ARCHIVE-2026...` 作为只读备份，避免有人继续直接改；
- 所有人只在本地克隆里工作。

---

## 第 6 步：验证共享目录（可选）

在任意一台有真实共享写权限的机器上：

```powershell
cd D:\tools\cowork-framework
npm run test:smb -- --share "\\fileserver\cowork"
```

测试会在共享目录下创建临时子目录，跑完整两机闭环，结束后清理。没有共享时会打印 `SKIP`
并退出 0；指定了共享但不可访问会作为真实失败处理。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 安装脚本被系统拦住 | 用 `powershell -NoProfile -ExecutionPolicy Bypass -File ...` 调用 |
| `cowork` 不是命令 | 没加 PATH；用 `node <框架目录>\bin\cowork.mjs`，或把 `bin` 加入 PATH / 重跑 `install-cli.ps1` |
| 工具里看不到 cowork_* | 插件没加载：`dsh --profile web --dump-config` 确认有 cowork 条目；重启 DSH；看日志 |
| 工具报「未配置仓库路径」 | profile 补丁里 `repoPath` 写错，或全局 `~/.cowork/config.json` 没有默认值 |
| `pwsh` 里访问共享目录 Access denied | 会话是 workspace-write 沙箱；切「完全权限」，或改用 cowork_* 插件工具 |
| git 报 dubious ownership | 共享仓库属主不同；执行 `git config --global --add safe.directory "<共享仓库路径>"` |
| 每次 status 都显示有改动 | 全局 `core.autocrlf` 影响；cowork 已把克隆设为 `core.autocrlf=false`，重跑 `cowork join` 或 `git reset --hard` |
| 任务板锁等待超时 | 另一台机器正在写；等 45 秒自动清理，或确认无人操作后删 `board\.board.lock` |
| 任务被拒绝认领 | 已指派给其他身份；确认接管用 `cowork task claim <任务号> --force` |

更多排障：[docs/troubleshooting.zh.md](troubleshooting.zh.md)。
