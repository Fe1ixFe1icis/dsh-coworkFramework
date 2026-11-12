# cowork —— 局域网多 agent 协作框架（git 分支 + 共享任务板 + DSH 插件）

cowork 把一个局域网共享目录变成一个小型 **agent 集群**：

1. **共享裸 git 仓库**（`repo.git`）——一条任务一个分支：`agent/<身份>/<任务号>`；
2. **共享任务板**（`board/board.json`）——认领、进行、待合并、完成、消息，跨机器文件锁保护；
3. **DeepSeek Harness (DSH) 插件**——13 个 `cowork_*` 工具、系统提示段，以及每个模型步进前的
   「未读消息 / 待合并任务」提醒。

每台机器只改自己的本地克隆，共享目录里不再直接改文件。这样分支、历史、归属和评审都保留下来，
多个 agent 可以像一个小团队一样：共享任务池 → 认领 → 交付 → 评审 → 合并。

> **状态：** `0.1.0`，以 Windows/SMB 为主；单元、两机模拟、插件测试通过，真实 SMB 测试套件在
> 提供共享目录时运行。详见 [验证结果](#9-验证结果)。

---

## 1. 它解决什么问题

两台或多台机器直接改 `\\fileserver\share` 里的同一批文件，会遇到：

| 问题 | cowork 的做法 |
|---|---|
| 没有分支、没有提交历史 | 共享目录里放裸仓库；每台机器本地克隆，任务走 `agent/<身份>/<任务号>` 分支 |
| 两边同时改互相覆盖 | 本地克隆 + 发布分支 + 评审 + 合并进 `main` |
| 谁在做什么没人知道 | 共享任务板：`open → working → review → done`，带认领、备注、消息 |
| AI 之间无法交接 | `cowork_send` / `cowork_inbox` + 双方都能认领的任务板 |
| 旧文件已经在共享目录里 | `cowork import` 把旧目录导入 git，之后按分支协作 |

---

## 2. 架构

```
 机器 A                                               机器 B
┌──────────────────────────────┐                    ┌──────────────────────────────┐
│ DSH (web) + cowork 插件       │                    │ DSH (web) + cowork 插件       │
│  ├─ agent 会话               │                    │  ├─ agent 会话               │
│  └─ cowork_* 工具            │                    │  └─ cowork_* 工具            │
│ 本地克隆 D:\work\project      │                    │ 本地克隆 D:\work\project      │
└──────────────┬───────────────┘                    └──────────────┬───────────────┘
               │ git fetch/push（分支）                              │
               │ board 读/写（跨机器锁）                             │
               ▼                                                    ▼
        ┌────────────────────────────────────────────────────────────────┐
        │ \\fileserver\cowork                                            │
        │   repo.git   ← 裸仓库：main + agent/* 分支                      │
        │   board/     ← board.json（任务+消息）、members/、跨机器锁      │
        └────────────────────────────────────────────────────────────────┘
```

代码的唯一真相来源是共享裸仓库的 `main`；每台机器只改自己的克隆。合并进 `main` 前先
`cowork review` 看改动，任务板记录谁认领了什么、做到哪、有什么消息。

设计细节见 [docs/architecture.zh.md](docs/architecture.zh.md)（英文版
[docs/architecture.md](docs/architecture.md)）。

---

## 3. 目录与交付物

```
cowork-framework\
├─ bin\cowork.mjs, bin\cowork.cmd     # cowork 命令行入口
├─ src\
│  ├─ config.mjs                      # 全局/仓库配置与上下文解析
│  ├─ util.mjs                        # 文件锁、原子写、路径与参数工具
│  ├─ git.mjs                         # git 子进程封装（分支/同步/合并/冲突）
│  ├─ board.mjs                       # 共享任务板（任务/消息/成员心跳）
│  ├─ core.mjs                        # 业务逻辑（init/join/task/save/publish/merge/...）
│  ├─ cli.mjs                         # 命令行
│  └─ plugin.mjs                      # DeepSeek Harness 插件（cowork_* 工具）
├─ install\
│  ├─ install-dsh-plugin.ps1          # 把插件装进指定 dsh profile（幂等、备份、校验）
│  ├─ install-cli.ps1                 # 把 cowork 命令装到 PATH
│  ├─ uninstall-dsh-plugin.ps1        # 安全卸载（恢复 [] 哨兵，不会写坏 patch）
│  ├─ package-for-peer.ps1            # 给另一台机器打 zip（不依赖 git 提交）
│  └─ prepare-deps.ps1                # 本地跑插件测试时联接 dsh 的 node_modules
├─ tests\
│  ├─ unit.test.mjs                   # 单元/边界测试
│  ├─ smoke.mjs                       # 两机模拟端到端测试
│  ├─ plugin.test.mjs                 # 插件工具/提示注入测试
│  └─ smb-smoke.mjs                   # 真实共享目录端到端测试
├─ scripts\
│  ├─ check.mjs                       # 语法/版本/链接/隐私/必需文件检查
│  └─ package-release.mjs             # 生成 GitHub Release 源码包
├─ docs\                              # 架构（中/英）/ 两机教程 / 工具参考 / 排障
└─ README.md / README.zh.md
```

共享目录布局（`\\fileserver\cowork`）：

```
cowork\
├─ cowork.json          # 框架元数据（项目名、创建人、版本）
├─ repo.git\            # 共享裸仓库：main + agent/* 分支
├─ board\
│  ├─ board.json        # 任务 + 消息（跨机器文件锁保护，写前有 .bak）
│  ├─ events.jsonl      # 审计事件（可选）
│  ├─ members\          # 每台机器的在线心跳
│  └─ .board.lock       # 写入锁（异常残留会在 45 秒后自动清理）
└─ dist\                # （可选）打包给另一台机器的 zip
```

---

## 4. 快速开始

### 4.1 获取代码

```powershell
git clone <你的仓库地址> D:\tools\cowork-framework
cd D:\tools\cowork-framework
```

或者从 GitHub **Releases** 下载 `cowork-framework-0.1.0.zip` 解压。

### 4.2 机器 A：初始化共享工作区

共享目录可以是 UNC 路径（`\\fileserver\cowork`），也可以是两台机器指向同一物理目录的本地路径
（例如 `D:\shares\cowork`）。不要把共享目录放进项目克隆里面。

```powershell
cd D:\tools\cowork-framework

# 可选：把 cowork 命令装到 PATH（写入 %APPDATA%\npm，通常已在 PATH 上）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-cli.ps1

cowork init `
  --share "\\fileserver\cowork" `
  --agent A `
  --dir "D:\work\project" `
  --project demo
```

这一步会：

1. 在共享目录创建 `cowork.json`、`repo.git`（裸仓库）、`board/`；
2. 生成 `main` 初始提交（`README.md`、`AGENTS.md`、`.gitignore`）；
3. 把仓库克隆到 `D:\work\project`，写入 `.cowork/config.json`（身份 A、共享路径）；
4. 写全局配置 `~/.cowork/config.json`（默认身份/克隆路径）。

验证：

```powershell
cd D:\work\project
cowork status
cowork doctor
```

### 4.3 机器 B：加入

```powershell
cd D:\tools\cowork-framework
cowork join --share "\\fileserver\cowork" --agent B --dir "D:\work\project"
```

两台机器必须指向**同一个物理共享目录**。如果访问 UNC 要求凭据：先在资源管理器里打开一次共享并
记住凭据，或执行 `net use \\fileserver\cowork /user:<用户名> <密码> /persistent:yes`。

### 4.4 安装 DSH 插件

```powershell
cd D:\tools\cowork-framework
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-dsh-plugin.ps1 `
  -Profile web `
  -RepoPath "D:\work\project" `
  -Agent A
```

机器 B 上用 `-Agent B` 和 B 的克隆路径。脚本会：

- 把包复制到 `~/.dsh/profiles/<profile>/node_modules/@cowork/framework`；
- 在 `cordis.patch.yml` 末尾插入插件条目（幂等，自动备份）；
- 校验模块可加载，并执行 `dsh --dump-config`；
- 除非 `-SkipCli`，否则顺带安装 `cowork` 命令。

如果 profile 开了 live patch reload，插件会热加载；否则重启 DSH。验证：`dsh --profile <profile>
--dump-config` 里能看到 `id: cowork`，或新会话工具列表出现 `cowork_status`。

卸载用 `install\uninstall-dsh-plugin.ps1 -Profile <profile>`。不要只手动删补丁块：空 patch 文件必须
保留 YAML 数组（`[]`），否则下次启动 DSH 会失败。

### 4.5 日常工作流

```powershell
cd D:\work\project
cowork status                       # 分支、工作区、任务、未读消息
cowork sync                         # fetch + rebase 当前分支到 origin/main
cowork task new "实现登录页"         # 新建并认领，自动建 agent/A/T-0001
#  ... 改代码 ...
cowork save -m "T-0001: 完成登录页"
cowork publish                      # 同步 + 推送分支 + 任务置 review
```

另一台机器评审合并：

```powershell
cowork task list --review           # 看有哪些待合并
cowork review agent/A/T-0001        # 提交、改动统计、是否可能冲突
cowork merge agent/A/T-0001         # 合并进 main，任务自动 done，删除远程分支
```

沟通与交接：

```powershell
cowork send B "T-0001 已合并，请拉取最新 main" --task T-0001
cowork inbox --mark-read            # 收件箱
cowork task new "做 XX 模块" --assign B   # 直接把任务派给 B（B 会收到通知）
```

**在 DSH 里**：直接对 agent 说「看一下协作状态」「认领 T-0002 然后实现……」「把 B 的分支评审合并」，
它会调用 `cowork_status` / `cowork_task_claim` / `cowork_publish` / `cowork_review` / `cowork_merge`
等工具（参数见 [docs/plugin-tools.zh.md](docs/plugin-tools.zh.md)）。
每个新回合开始前，若有未读消息或待合并任务，插件会自动插入一条 `<system-reminder>`
（`notify: false` 可关闭）。

---

## 5. 冲突处理

- **同步冲突**（`cowork sync`）：rebase 暂停并列出冲突文件 → 手动解决 → `git add` →
  `cowork sync --continue`；不想处理就 `cowork sync --abort` 回到同步前。
- **合并冲突**（`cowork merge`）：工具会**自动中止**合并，`main` 保持干净，并列出冲突文件；
  让分支作者先 `cowork sync` 在分支上解决、再 `cowork publish`，然后重新合并。
- 一条任务一个分支、小步提交，冲突面会小很多。

---

## 6. 从「直接改共享目录」迁移

```powershell
cd D:\work\project
cowork import "\\fileserver\legacy-project"
```

把旧目录的顶层条目复制进 `main`、提交、rebase 并推送。之后：

- 共享目录里只保留 `cowork\` 这份协作仓库；
- 旧文件目录改名成只读归档（例如 `ARCHIVE-2026...`），避免有人继续直接改；
- 所有人只在本地克隆里工作，通过分支合并回 `main`。

---

## 7. CLI 参考

所有命令都支持 `--repo <克隆目录>`（默认从当前目录向上查找）和 `--agent <身份>`（临时覆盖）；
`--json` 输出机器可读数据。

| 命令 | 作用 |
|---|---|
| `cowork init --share <目录> --agent <身份> [--dir <克隆>] [--project <名称>]` | 初始化共享工作区 + 第一个克隆 |
| `cowork join --share <目录> --agent <身份> [--dir <克隆>]` | 加入已有工作区 |
| `cowork status [--no-fetch] [--json]` | 分支、工作区、领先/落后、任务、成员 |
| `cowork sync [--continue\|--abort]` | 同步/rebase；冲突继续或放弃 |
| `cowork save [-m <说明>]` | 提交当前分支的全部改动 |
| `cowork publish [-m <说明>]` | 保存 → 同步 → 推送 → 任务置 review |
| `cowork review <任务号\|分支>` | 提交、改动统计、潜在冲突 |
| `cowork merge <任务号\|分支> [--keep-branch]` | 合并进 main、任务 done、删除远程分支 |
| `cowork import <目录> [-m <说明>] [--no-overwrite]` | 把旧共享目录导入 main |
| `cowork task new <标题> [--desc ...] [--assign ...] [--files ...] [--tags ...] [--priority ...]` | 新建任务（默认立即认领） |
| `cowork task claim <任务号> [--force]` | 认领；`--force` 接管已指派给别人的任务 |
| `cowork task update <任务号> [--status ...] [--note ...] [--assign ...] [--owner ...]` | 更新状态/备注/指派/负责人 |
| `cowork task list [--open\|--my\|--review\|--all] [--status <状态>]` | 任务列表 |
| `cowork task show <任务号>` | 任务详情与历史 |
| `cowork send <身份\|all> <消息> [--task ...] [--subject ...]` | 发跨机器消息 |
| `cowork inbox [--all] [--mark-read] [--limit N]` | 收件箱 |
| `cowork members` | 成员心跳 |
| `cowork doctor` | 环境自检 |
| `cowork remote` | 打印共享裸仓库地址 |
| `cowork version` / `cowork help` | 版本 / 帮助 |

任务状态：`open → working → review → done`；任何状态都可以 `→ blocked`（带备注）。

---

## 8. DSH 插件

### 8.1 提供什么

- **13 个工具**：`cowork_status / sync / save / publish / review / merge / task_create /
  task_claim / task_update / task_list / send / inbox / doctor`
- **系统提示词段** `cowork:protocol`：告诉 agent 本机身份、克隆路径和协作规则
- **步进前提醒**：有未读消息/待合并任务时注入 `<system-reminder>`（4 秒缓存，按内容 hash 去重）

### 8.2 关于 DSH 沙箱

- DSH 默认的 `workspace-write` 权限下，`pwsh` 工具起的子进程访问 UNC 共享路径可能被 Windows 拒绝
  （本机实测 `Access denied`）；这是沙箱限制，不是共享权限问题。
- **插件工具本身不受影响**：插件代码运行在 DSH 宿主进程里，以正常用户权限读写共享目录，
  所以默认沙箱下 agent 也能用 `cowork_*` 工具完成推送/合并。
- 如果想让 agent 用 `pwsh` 直接跑 `cowork` 命令或直接读写共享目录，把会话切到**完全权限**
  （中文界面「完全权限」）。

---

## 9. 验证结果

| 测试 | 命令 | 结果 |
|---|---|---|
| 单元/边界 | `npm run test:unit` | 58 个断言 |
| 两机模拟端到端 | `npm run test:smoke` | 79 个断言（并发任务、冲突、消息、导入、CLI、非工作区/共享不可达回归） |
| 插件工具/提示注入 | `npm run test:plugin` | 49 个断言（13 工具 + 提示段 + 步进注入 + 去重） |
| 真实 SMB 共享目录 | `npm run test:smb -- --share <共享目录>` | 19 个断言（需要真实共享；不传则 SKIP） |

插件测试需要 DSH 自带的 `@deepseek-ai/dsh-tools` / `schemastery` / `dsh-llm`。在装了 DSH 的机器上先
运行 `install\prepare-deps.ps1`；没有依赖时测试打印 `SKIP` 并退出 0。发布前可设置
`COWORK_REQUIRE_PLUGIN_DEPS=1` 强制要求依赖存在。

所有测试通过 `COWORK_HOME` 把全局配置隔离到临时目录，不会污染真实的 `~/.cowork`。

---

## 10. CI 与发布

- `.github/workflows/ci.yml`：Ubuntu/Windows × Node 20/22，运行 `npm run check`、`npm test`、
  `npm run test:plugin`（缺 DSH 依赖时自动 SKIP），并上传源码包。
- `.github/workflows/release.yml`：推送 `v*` 标签时运行，生成
  `dist/cowork-framework-<version>.zip` 和 `.sha256`，自动创建 GitHub Release。
- 本地：`npm run package`。完整步骤见 [RELEASING.md](RELEASING.md)。

---

## 11. 限制与后续方向

- 目前是「同一份共享仓库 + 多台机器」模型；多项目可以建多个共享目录，各自 `cowork init`。
- 任务板是文件型（JSON + 跨机器锁），适合约 **2~10 台机器** 的小团队；更多机器建议换成 HTTP 服务。
- 跨机器「实时」提醒依赖 DSH 每个回合的步进检查；不是 WebSocket 推送（局域网场景足够）。
- 身份是自报字符串，不是密码学身份；review 是流程约束，不是强制门禁（有写权限的机器都能合并）。
- 插件依赖 DSH 自带的三个包；两台机器的 DSH 版本建议一致或都不低于 0.2.2-rc.1。
- 共享目录安全性继承 Windows SMB 权限；只给可信的局域网用户写权限，不要暴露到公网。
- 大仓库首次经 SMB clone 会慢；避免把构建产物/大二进制提交进仓库。

---

## 12. 文档

- [架构（中文）](docs/architecture.zh.md) / [Architecture (English)](docs/architecture.md)
- [两机安装教程](docs/tutorial-two-machines.zh.md)
- [插件工具参考](docs/plugin-tools.zh.md)
- [排障手册](docs/troubleshooting.zh.md)
- [GitHub 仓库文案 / About 参考](docs/github-repo.zh.md)
- [贡献指南](CONTRIBUTING.md) / [安全策略](SECURITY.md) / [更新日志](CHANGELOG.md)

## 13. 许可证

MIT，见 [LICENSE](LICENSE)。
