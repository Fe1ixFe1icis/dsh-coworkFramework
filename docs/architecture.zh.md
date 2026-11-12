# 架构设计（cowork）

## 1. 总体模型

```
 机器 A (machine-a)                              机器 B (machine-b)
 ┌──────────────────────────┐                  ┌──────────────────────────┐
 │ DSH (web) + cowork 插件   │                  │ DSH (web) + cowork 插件   │
 │  ├ worker 会话            │                  │  ├ worker 会话            │
 │  └ cowork_* 工具          │                  │  └ cowork_* 工具          │
 │ 本地克隆 D:\...\work       │                  │ 本地克隆 D:\...\work       │
 └───────────┬──────────────┘                  └───────────┬──────────────┘
             │ git fetch/push（分支）                        │
             │ board 读/写（跨机器锁）                       │
             ▼                                              ▼
        ┌───────────────────────────────────────────────────────┐
        │ \\fileserver\cowork                                  │
        │   repo.git   ← 裸仓库：main + agent/* 分支            │
        │   board/     ← board.json（任务+消息）、members/、锁   │
        └───────────────────────────────────────────────────────┘
```

三层职责：

1. **git 层**：唯一的代码真相来源是共享裸仓库的 `main`。每台机器只改自己的本地克隆，
   任务分支 `agent/<身份>/<任务号>`；合并进 `main` 必须经过评审（`cowork review`）。
2. **任务板层**：跨机器协作的「记忆」——谁认领了什么、做到哪、有什么消息。
   放在共享目录的普通文件里，用跨机器文件锁串行化写入，不依赖数据库或服务器。
3. **agent 层**：DSH 插件把前两层包装成工具和提示，让模型按固定工作流协作，并在每个回合
   自动看到「未读消息 / 待合并任务」。

## 2. 分支模型

```
main ──●──────────────●───────────────●──────────►
        \            / \             /
         ●──●  (A)  /   ●──● (B)    /
          agent/A/T-0001   agent/B/T-0002
```

- `main`：集成分支，只接受通过评审的合并；每台机器本地 `main` 只做 fast-forward。
- `agent/<身份>/<任务号>`：一条任务一个分支，从 `origin/main` 创建，推送一次即固定。
- 合并使用 `merge --no-ff`（保留合并记录），合并后默认删除远程任务分支。
- 分支名中的身份和任务号都经过清洗（空格、路径分隔符、特殊字符 → `-`），避免非法 ref；
  身份还会拒绝 Windows 保留名和首尾点/横线，因为它同时用作成员心跳文件名。

### 同步与冲突

- `cowork sync`：`fetch` 后把当前分支 `rebase` 到 `origin/main`。冲突时 rebase 暂停：
  解决 → `cowork sync --continue`；放弃 → `cowork sync --abort`。
- rebase 会重写提交历史，所以 `cowork publish` 对任务分支允许 `--force-with-lease`
  （只覆盖自己的分支，不会覆盖别人的提交）。
- `cowork merge`：本地 `checkout main` → `merge --ff-only origin/main` → `merge --no-ff origin/<branch>`
  → 推送。**冲突时自动 `merge --abort`**，main 保持干净，只返回冲突文件列表。
- 建议流程：分支作者自己先把 `sync` 冲突解决掉，再让评审方 merge。

## 3. 共享任务板

### 3.1 数据结构（`board/board.json`）

```jsonc
{
  "formatVersion": 1,
  "project": "tbc",
  "seq": 12,                       // 任务/消息共用自增序号
  "createdAt": "...", "updatedAt": "...", "updatedBy": "A",
  "tasks": {
    "T-0001": {
      "id": "T-0001", "title": "...", "description": "...",
      "status": "open|working|review|done|blocked",
      "assignee": "B",             // 创建时指派给谁（可空）
      "owner": "A",                // 实际认领人
      "branch": "agent/A/T-0001",
      "files": [], "tags": [], "priority": "normal",
      "createdAt": "...", "createdBy": "A", "updatedAt": "...",
      "notes": [{ "at": "...", "by": "A", "text": "..." }],
      "history": [{ "at": "...", "by": "A", "action": "claim", "detail": "..." }]
    }
  },
  "messages": [
    {
      "id": "M-0002", "from": "A", "to": "B",
      "subject": "...", "body": "...", "taskId": "T-0001",
      "at": "...", "readBy": ["B"]
    }
  ]
}
```

- 任务状态机：`open → working → review → done`，任何状态可 `→ blocked`（带备注）。
- 消息 `to` 可以是具体身份或 `all`；`readBy` 按机器身份记录已读。
- `board.json.bak`：每次写入前保留上一版；读到损坏 JSON 时自动回退（并标记 `__recoveredFromBackup`）。
- `events.jsonl`：追加式审计日志（谁在什么时候做了什么），失败不影响主流程。

### 3.2 跨机器并发控制

共享目录没有事务，所以用**文件锁 + 原子写**：

1. 写任务板前先 `open(lockFile, 'wx')` 独占创建 `board/.board.lock`（O_EXCL 语义在 SMB 上可用）；
2. 拿到锁后读 `board.json` → 修改 → 写 `.bak` → 临时文件 + `rename` 原子替换；
3. 释放锁（删除锁文件）。
4. 拿不到锁时退避重试（最长 20 秒）；锁超过 45 秒未更新视为崩溃残留，自动清理。

只有「写」需要锁；读不需要锁（rename 原子性保证读到的总是完整 JSON）。
成员心跳（`members/<身份>.json`）每个身份只写自己的文件，不需要锁。

### 3.3 幂等与错误处理

- 同一台机器重复执行 `cowork save` → 没有改动就返回「工作区干净」。
- `cowork publish` 先 save（无改动则跳过）→ sync → push → 更新任务状态为 review。
- `cowork merge` 成功后把任务置 done、删除远程分支（`--keep-branch` 可保留）。
- 网络中断/共享不可达时：git 操作返回明确错误；任务板读取失败会提示路径与备份位置。

## 4. DSH 插件

插件是一个普通 ESM 包（`dsh-cowork-framework`），入口 `src/plugin.mjs`，导出：

```js
export const name = 'cowork'
export const inject = ['tools', 'systemPrompt']
export const Config = z.object({ repoPath, agent, notify, fetchOnStatus })
export function apply(ctx, config) { ... }
```

`apply` 内做三件事：

1. **注册 13 个工具**（`ctx.tools.register(defineTool({...}))`）。
   工具描述里写清了工作流和约束；模型参数由 dsh 校验；返回纯文本摘要。
   工具执行在 **dsh 宿主进程**里（不在沙箱子进程），因此可以直接读写共享目录里的 git 仓库。
2. **注册系统提示段**（`ctx.systemPrompt.section({ name: 'cowork:protocol', order: 9000 })`）：
   告诉模型本机身份、本地克隆路径、协作规则；不读盘（避免 apply 阶段 I/O），
   `interpolate: false` 防止路径里的 `{{}}` 被当成变量。
3. **注册 `agent/pre-step` 钩子**：每个模型步骤前读一次共享板（4 秒 TTL 缓存），
   若有未读消息/待合并任务，用 `createUserMessage` 构造一条 `<system-reminder>` 语气消息，
   追加到本步的消息列表里；同摘要去重（Map 记录每个 session 上次注入的 hash），避免刷屏。
   失败静默（`dsh` 版本差异、共享暂时不可达都不影响正常对话）。

### 4.1 运行时依赖与解析

插件不捆绑依赖，直接复用 dsh 自带的包：

- `@deepseek-ai/dsh-tools`（`defineTool`）
- `@deepseek-ai/schemastery`（`Config` schema）
- `@deepseek-ai/dsh-llm`（`createUserMessage`，懒加载，缺失则关闭步进提醒）

安装位置在 `~/.dsh/profiles/<profile>/node_modules/dsh-cowork-framework`，
Node 解析会向上找到 `~/.dsh/profiles/node_modules` 里的 `@deepseek-ai/*`，因此不需要 pnpm 安装、离线可用。

### 4.2 安装与热加载

- **推荐：以 DSH bundle 安装。** 包内 `cordis.patch.yml` 声明一行 `id: cowork`；
  `dsh plugin --profile <p> add <包名/路径/tarball>` 会把包加入 profile 的
  `dsh.profile.bundles`，启动时自动应用该层。`repoPath` / `agent` 由插件按
  `COWORK_REPO` / `COWORK_AGENT` → `~/.cowork/config.json` → 仓库 `.cowork/config.json` 解析：

  ```yaml
  - insert:
      - id: cowork
        name: 'dsh-cowork-framework'
        config:
          notify: true
  ```

- **兜底：旧安装脚本。** 把插件复制到 profile 的 `node_modules`，再在 profile 的
  `cordis.patch.yml` 末尾追加带 `repoPath` / `agent` 的条目。适合老版本 DSH 或完全离线。
  两种方式不要同时用，否则会出现两个 `id: cowork` 行。
- `dsh --profile <p> --dump-config` 可以离线验证配置树组合是否成功。
- profile 的 `patchReload: live` 开启时，保存补丁文件会触发热加载，**不需要重启 dsh**；
  热加载失败只报告错误，不会杀掉进程。回滚：bundle 用 `dsh plugin remove`；
  手工安装删除 `# >>> cowork plugin` 整块 + 插件目录。
- 安装脚本会先备份 `cordis.patch.yml`（`.bak-时间戳`）。

### 4.3 宿主进程 vs 沙箱

| 操作 | 默认 `workspace-write` | 完全权限 |
|---|---|---|
| 插件工具读写共享目录（`cowork_*`） | ✅ 宿主进程直接访问 | ✅ |
| `pwsh`/`bash` 子进程访问 UNC 共享 | ❌ Access denied（Windows 沙箱限制） | ✅ |
| agent 的 read/write/edit 直接操作共享目录 | ❌ 工作区限定 | ✅ |
| agent 在本地克隆里读写 | ✅ | ✅ |

结论：日常协作走插件工具即可；需要 shell 级 git 操作时把会话切到完全权限。

## 5. 时钟、身份与安全

- 身份由每台机器安装时指定（`--agent A/B`），存在本地克隆的 `.cowork/config.json`，
  同时写入全局 `~/.cowork/config.json` 作为默认值。
- 所有时间戳用 UTC ISO 存储，界面显示本地时间。
- 共享目录权限继承 Windows SMB ACL：只给可信局域网用户写权限；建议开启共享审计。
- 插件不会执行模型提供的任意 shell 命令：工具参数只交给 cowork 的业务函数（git 参数为固定白名单）。
- `cowork import` 会复制源目录内容（排除 `.git`、`.cowork`），默认覆盖同名文件；导入前建议先备份。

## 6. 失败模式与恢复

| 失败 | 表现 | 恢复 |
|---|---|---|
| 共享目录不可达 | `status` 显示「不可访问」，git 操作报错 | 检查网络/凭据/共享服务；恢复后重试 |
| 任务板 JSON 损坏 | 读取报错并提示 `.bak` | 把 `board.json.bak` 复制回 `board.json` |
| 锁残留 | 写入提示等待锁超时 | 45 秒后自动清理；急用可删除 `.board.lock` |
| rebase 冲突 | `sync` 返回冲突文件 | 解决 → `sync --continue`，或 `--abort` |
| merge 冲突 | 自动中止，main 干净 | 让作者同步解决后重新合并 |
| 插件没加载 | 工具列表没有 cowork_* | `dsh --profile <p> --dump-config` 检查条目；看 dsh 日志的加载错误 |
| 插件报「未配置仓库路径」 | 工具调用报错 | profile 补丁里补 `repoPath`，或在 `~/.cowork/config.json` 配默认 |
