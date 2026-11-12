# cowork — GitHub 仓库描述与项目摘要

> 用途：创建 GitHub 仓库时填写 **Description（About）**、**Topics**，以及 README 首段。
> 版本：0.1.0 ｜ 许可证：MIT ｜ 运行时：Node.js ≥ 20 ｜ 主要平台：Windows / SMB
>
> 说明：仓库的开源配套（`README.md`、`README.zh.md`、`LICENSE`、`.github/` CI、`CONTRIBUTING.md`、
> `SECURITY.md`、`scripts/check.mjs`）已经就绪；本文只负责「对外一句话」和「仓库描述文案」。

---

## 0. 快速取用（推荐组合）

| 字段 | 建议值 |
|---|---|
| 仓库名 | `cowork`（首选）；`dsh-cowork`（更利于 DSH 生态搜索） |
| About | 下方 **2.2 推荐版（English）** 或 **2.3 推荐版（中文）** |
| Topics | 下方第 3 节 |
| README 首段 | 已有 `README.md` / `README.zh.md`，无需重写；如需替换，用第 4 节摘要 |

---

## 1. 一句话定位

**cowork 是一个无中心调度服务的局域网多机协作框架：把共享目录变成一个「裸 git 仓库 + 任务板」，让每台机器上的 DeepSeek Harness（DSH）lead agent 组成对等 agent 集群。**

它不替代「一个 lead agent 带一群子 agent」的单机模式，而是把同一个思路沿「机器」这一维度横向扩展：每台机器保留自己的 lead、本地克隆、模型/API 与工具环境，机器之间只通过 **git main + 任务板 + 协作协议** 交换状态。

---

## 2. GitHub Description（About）

> GitHub 的 About 最多 350 个字符。以下候选均低于限制，可直接粘贴。

### 2.1 与 package.json 对齐的基线版（English）

> LAN-first multi-agent collaboration framework for DeepSeek Harness: git branch workflow, shared task board, and a DSH plugin.

这是 `package.json` 当前的 `description`，准确但偏「功能清单」，适合 npm 元数据，不一定是 About 的最佳选择。

### 2.2 推荐版（English）

> LAN-first multi-agent collaboration for DeepSeek Harness: a shared bare git repo + locked JSON task board + 13 cowork_* tools. Each machine runs its own lead agent; claim → review → merge, no central server. Built for 2–10 Windows/SMB machines.

### 2.3 推荐版（中文）

> DeepSeek Harness 的局域网多机协作框架：共享裸 git 仓库 + 带锁 JSON 任务板 + 13 个 cowork_* 工具。每台机器运行自己的 lead agent，通过认领 → 评审 → 合并协作；无中心服务器，面向 2–10 台 Windows/SMB 机器。

### 2.4 问题驱动版（中文，适合强调理念）

> 单机 lead + 子 agent 很强；如果每台机器都有一个 lead 呢？cowork 把多台机器的 DSH lead agent 组成对等集群：共享 git main 是事实来源，任务板是共同记忆，认领/评审/合并是协议。无中心调度器，面向 2–10 台 Windows/SMB 机器。

### 2.5 问题驱动版（English）

> A single lead agent with subagents is powerful. What if every machine had its own lead? cowork turns multiple DSH lead agents into a peer cluster: shared git main as source of truth, a task board as shared memory, claim/review/merge as the protocol. No central scheduler. For 2–10 Windows/SMB machines.

### 2.6 极简版

> 中文：把多台机器的 DSH lead agent 变成对等集群：共享 git 仓库 + 任务板 + 13 个协作工具，无中心服务器。
>
> English: Turn multiple DSH lead agents into a peer cluster: shared git repo, task board, 13 collaboration tools, no central server.

### 2.7 仓库名说明

| 名称 | 说明 |
|---|---|
| `cowork` | **首选**。与 README、包名主题一致，简短 |
| `dsh-cowork` | 备选。带生态前缀，GitHub 搜索更容易命中 DSH 用户 |
| `cowork-framework` | 与包名 `@cowork/framework` 完全一致，略长 |
| `cowork-lan` | 强调局域网场景 |

> `RELEASING.md` 目前用 `<owner>/cowork.git` 作为示例；如果最终用 `dsh-cowork`，记得同步改
> `package.json` 的 `repository` / `homepage`。

---

## 3. Topics

建议直接粘贴（GitHub 最多 20 个，全部小写、连字符）：

```text
deepseek-harness
dsh
multi-agent
agent-cluster
agent-collaboration
git-workflow
task-board
lan
smb
windows
nodejs
ai-agents
plugin
```

可选补充：`serverless`、`cordis`、`developer-tools`、`cowork`。

---

## 4. README 摘要

### 4.1 中文摘要（约 230 字）

cowork 是一个面向 DeepSeek Harness 的局域网多机协作框架。它在共享目录里维护一个裸 git 仓库和一份 JSON 任务板，每台机器保留自己的本地克隆和独立 lead agent；一条任务一个分支，经过认领、提交、发布、评审、合并完成交付。DSH 插件把整套流程封装成 13 个 `cowork_*` 工具，并在每个模型步骤自动提醒未读消息与待合并分支。它不依赖中心服务器、数据库或常驻进程，适合 2–10 台 Windows/SMB 机器组成的小型 agent 集群。

### 4.2 English abstract（约 120 words）

cowork turns a shared LAN folder into a small agent cluster for DeepSeek Harness. A bare git repository and a JSON task board live in the share; every machine keeps its own clone and its own lead agent. Work is one task per branch, delivered through claim → commit → publish → review → merge. A DSH plugin exposes the workflow as 13 `cowork_*` tools and injects unread-message / pending-merge reminders at each model step. There is no coordinator process, database, or message broker — just git, a locked JSON board, and a protocol. Built for 2–10 Windows/SMB machines.

### 4.3 README 开头可用的三句话

1. **单机里，一个 lead agent 调度子 agent 已经很强；cowork 问的是：如果每台机器都有一个 lead，会怎样？**
2. **它用共享 git 仓库做事实来源、任务板做共同记忆、认领/评审/合并做协议，把多台机器上的 DSH agent 变成对等集群。**
3. **没有中心调度器、没有数据库、没有常驻服务——只有 git、一个带锁的 JSON 文件，和一套 agent 能直接调用的工作流。**

---

## 5. 项目完整摘要

### 5.1 背景：从「互相改文件」到「协作协议」

最初的协作方式是两台（或多台）Windows 机器通过 SMB 共享目录直接编辑同一批文件。问题很具体：

- 没有分支和提交历史，改坏了无法回退；
- 两边同时改同一文件会互相覆盖；
- 谁在做什么、做到哪一步，没有共享视图；
- AI agent 之间无法交接任务，只能靠人传话。

cowork 把共享目录从「工作区」降级为「协调区」：代码只通过 git 分支流动，共享目录里只保留裸仓库和任务板。

### 5.2 它由三层组成

| 层 | 内容 | 作用 |
|---|---|---|
| git 层 | `<share>/repo.git` 裸仓库 + 每台机器的本地克隆 | 代码的唯一事实来源是 `main`；任务分支 `agent/<身份>/<任务号>` 隔离工作 |
| 任务板层 | `board/board.json`、`members/`、`events.jsonl`、`.board.lock` | 跨机器记忆：任务状态、认领人、消息、心跳、审计 |
| agent 层 | DSH 插件 `@cowork/framework` | 13 个 `cowork_*` 工具 + 系统提示段 + 步进提醒，把协议变成模型可执行的工具 |

### 5.3 一次完整的协作闭环

```text
A: task new "实现登录页"
   └─ 创建 T-0001，从 origin/main 建分支 agent/A/T-0001
A: 改代码 → save → publish
   └─ 提交、rebase 到最新 main、推送分支、任务置 review
B: task list --review → review T-0001 → merge T-0001
   └─ 查看提交/diff/冲突提示 → merge --no-ff 进 main → 任务 done → 删远程分支
A: sync
   └─ 任务分支 rebase 到新 main；下一轮继续
```

消息通过 `cowork_send` / `cowork_inbox` 写入任务板；每个模型步骤开始前，插件检查未读消息和待合并任务，把提醒注入会话（4 秒 TTL 缓存、按内容 hash 去重、可关闭）。

### 5.4 三个关键工程决定

1. **`main` 只接受评审后的合并。** 本地 `main` 只 fast-forward；任务分支 rebase 后允许 `--force-with-lease`，只覆盖自己的分支。合并冲突时自动 `merge --abort`，保证 `main` 永远不会停在脏状态。
2. **任务板用「文件锁 + 原子写」而不是数据库。** 写前 `open(lock, 'wx')` 独占创建锁，读改写后写 `.bak`、临时文件 `rename` 覆盖；锁等待最多 20 秒，45 秒未更新的锁视为崩溃残留自动清理。读不需要锁，因为 `rename` 保证读到完整 JSON。
3. **插件是协议，不是脚本集合。** 工具在 DSH 宿主进程里执行，因此不受 `workspace-write` 沙箱对 UNC 路径的限制；系统提示段告诉 agent 身份、克隆路径和规则；步进钩子负责「异步消息」的送达。插件不执行模型给出的任意 shell 命令，git 参数由固定数组传入、不经 shell 解释。

### 5.5 单 lead 集群 vs 多机 lead 集群

| 维度 | 单机：一个 lead + 子 agent | 多机：每台机器一个 lead（cowork） |
|---|---|---|
| 协调方式 | 进程内任务分解、直接下发 | 共享 `main` + 任务板 + 认领/评审/合并 |
| 上下文 | 共享，汇总快 | 不共享，只能通过代码、任务、消息传递 |
| 扩展维度 | 单机并发、单模型/单 API | 机器数、模型/API 多样性、本地环境 |
| 延迟 | 子 agent 调度延迟低 | 受网络、轮询、评审等待影响 |
| 故障域 | 单点 | 单机故障不影响其他人，但需要处理锁/冲突 |
| 主要成本 | 上下文窗口、单机资源 | 合并冲突、重复劳动、协调开销 |
| 适合 | 紧耦合、需要全局规划的任务 | 可拆分、环境异构、需要真并行的任务 |

cowork 的立场不是「多 lead 一定更快」，而是：**把多 lead 协作的最小协议做出来，让这个问题可以被真实验证。** 目前仓库验证的是协作闭环在工程上可行、可恢复、可重复；还没有做「单 lead vs 多机 lead」的对照性能实验。

如果要回答「效果如何」，建议用固定任务集做 A/B，至少记录：

- 端到端完成时间与并行加速比；
- 合并冲突率、返工率、评审等待时间；
- 每个已合并改动的 token 成本与人工介入次数；
- 缺陷率/回滚率，以及任务分配的公平性。

### 5.6 已验证的事实

- 在两台真实机器上通过 SMB 共享目录跑通完整闭环（主机名与 IP 已从公开文档中脱敏）。
- 测试矩阵（以当前 README 为准）：单元/边界 58 条、两机模拟 79 条、插件工具 49 条、真实 SMB 19 条断言。
- 真实 DSH 实例加载验证：13 个 `cowork_*` 工具、系统提示段、pre-step 钩子全部注册。
- DSH profile 安装支持复制与目录联接两种模式，幂等、自动备份、`dsh --dump-config` 校验；补丁热加载已实测，不需要重启 GUI。
- 仓库已具备开源配套：MIT LICENSE、CI/Release 工作流、贡献/安全文档、`npm run check` 自检、`npm run package` 打包。

> 说明：以上数字来自本仓库当前测试输出（2026-11-12）；插件测试与 SMB 测试在没有 DSH 依赖/共享目录时会 SKIP。

### 5.7 边界与不适用场景

- **规模**：文件型任务板 + 单锁，适合约 2–10 台机器；更多机器应换成 HTTP 服务。
- **平台**：Windows/SMB 优先；UNC、ACL、`core.autocrlf=false`、原子写回退都按 Windows 调优；核心 CLI 是纯 ESM，也可在 Linux/macOS 跑。
- **实时性**：没有 WebSocket/守护进程；消息在每个模型步骤轮询（4 秒缓存），不是聊天传输。
- **身份**：身份是声明式的，不做密码学认证；安全边界是共享目录 ACL。
- **评审**：`cowork_review` 只提供信息，不强制审批；合并门禁是流程约定。
- **依赖**：插件复用 DSH 自带的 `@deepseek-ai/dsh-tools`、`schemastery`、`dsh-llm`；DSH 大版本变化可能影响插件。
- **不是**：不是通用分布式任务队列，不是跨公网方案，也不是多租户平台。

---

## 6. 发布到 GitHub 前的检查清单

已经就绪（截至本次整理）：

- [x] `README.md`（英文，GitHub 首页默认渲染）与 `README.zh.md`
- [x] `LICENSE`（MIT）、`.gitattributes`、`.editorconfig`
- [x] `CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、`RELEASING.md`
- [x] `.github/`：CI、tag 驱动的 Release 工作流、Issue/PR 模板
- [x] `scripts/check.mjs`、`scripts/package-release.mjs`、单元测试
- [x] README/docs 已把内网 IP、主机名、共享名、用户名替换为 `fileserver` / `machine-a` 等占位符

还需要做：

- [ ] **初始化 git 并推送**（如果还没做）：`git init`、提交、`git remote add origin <url>`、`git push -u origin main`。
- [ ] **补 `package.json` 元数据**：按 `RELEASING.md` 的示例加 `repository` 与 `homepage`（如果仓库名不是 `cowork`，注意同步）。
- [ ] **跑完整检查**：`npm run check` → `npm test` → `npm run test:plugin`；真实 SMB 测试用 `npm run test:smb -- --share <share>`。三者不要并行。
- [ ] **`research/` 与 `work/` 不入库**：`.gitignore` 已排除，确认不要 `git add -f`；`research/qa` 含旧版内网信息。
- [ ] **填 About**：Description 用 2.2 或 2.3；Topics 用第 3 节；可选填 homepage。
- [ ] **可选**：把 `docs/architecture.zh.md` 的 ASCII 架构图转成一张 PNG，放在 README 首屏。
- [ ] **可选**：在 README 顶部加一段「单 lead vs 多机 lead」的问题陈述，让仓库定位更鲜明（可直接用 4.3 的三句话）。

---

## 7. 可直接粘贴的发布说明（Release / 项目简介）

> cowork 0.1.0：局域网多机 DSH agent 协作框架。共享目录里一个裸 git 仓库 + 一份 JSON 任务板，每台机器一个本地克隆和一个 lead agent；任务分支、认领、评审、合并、消息全部封装为 13 个 `cowork_*` 工具。无中心服务器、无数据库、无第三方运行时依赖；面向 2–10 台 Windows/SMB 机器。附带单元、两机模拟、插件与真实 SMB 测试套件（SMB 套件在提供共享目录时运行）。
