# DSH 插件工具参考

安装插件后，DSH 会话里会出现 13 个 `cowork_*` 工具。它们的描述里已经写了使用场景，
这里给出参数、返回和推荐调用顺序，方便人（或 agent）照着用。

> 配置项（profile 的 `cordis.patch.yml`）：
> `repoPath`（本地克隆路径）、`agent`（本机身份）、`notify`（是否启用步进提醒，默认 true）、
> `fetchOnStatus`（`cowork_status` 是否默认联网 fetch，默认 false）。
> 未在插件配置里写的项会回退到 `~/.cowork/config.json`，再回退到仓库 `.cowork/config.json`。

## 推荐工作流

```
开始工作
  └─ cowork_status                    # 分支干净吗？我是谁？有什么任务/消息？
      └─ cowork_sync                  # 同步 origin/main
          └─ cowork_task_list open    # 有现成任务就 claim，否则 task_create
              └─ cowork_task_claim <T-xxxx>   # 建/切分支
                  └─ (编码，可多次 cowork_save)
                      └─ cowork_publish       # 推送分支 + 任务置 review
                          └─ 通知同伴：cowork_send B "T-xxxx 待评审"
同伴侧
  └─ cowork_task_list review
      └─ cowork_review <T-xxxx或分支>
          └─ cowork_merge <T-xxxx>        # 合并进 main，任务 done，删远程分支
```

## 工具一览

| 工具 | 参数 | 说明 |
|---|---|---|
| `cowork_status` | `refresh?: boolean` | 分支、工作区是否干净、领先/落后 origin/main、当前任务、任务板统计、未读消息、协作者在线状态。`refresh=true` 会 fetch（慢一点） |
| `cowork_sync` | `action?: 'start'\|'continue'\|'abort'` | 同步当前分支到 origin/main；冲突时暂停 rebase，解决后 `continue`，放弃用 `abort` |
| `cowork_save` | `message?: string` | `git add -A` + commit 到当前分支，不推送。工作区干净时返回提示 |
| `cowork_publish` | `message?: string` | 保存未提交改动 → 同步 → 推送分支 → 关联任务置 review |
| `cowork_review` | `target: string` | target 可以是任务号 `T-0002` 或分支名 `agent/B/T-0002`；输出提交列表、改动统计、潜在冲突提示 |
| `cowork_merge` | `target: string, keepBranch?: boolean` | 合并进 main 并推送，任务置 done，默认删远程分支；冲突自动中止 |
| `cowork_task_create` | `title: string, description?, assignee?, files?, tags?, priority?` | 新建任务；不填 assignee 立即认领并建分支；填了则交给同伴并自动发消息 |
| `cowork_task_claim` | `taskId: string, force?: boolean` | 认领任务：状态 working + 建/切分支 `agent/<身份>/<任务号>`；`force=true` 接管已指派给别人的任务 |
| `cowork_task_update` | `taskId, status?, note?, assignee?, owner?` | 改状态（open/working/review/done/blocked）、加备注、改派、设置/清除负责人（传 `none` 取消） |
| `cowork_task_list` | `filter?: 'all'\|'open'\|'mine'\|'review'` | 查看任务板 |
| `cowork_send` | `to?, message, subject?, taskId?` | 给另一台机器发消息（写入共享板，对方步进时会收到提醒）；`to` 省略=广播 |
| `cowork_inbox` | `markRead?, all?, limit?` | 收件箱；`markRead=true` 标记已读 |
| `cowork_doctor` | — | 自检：git/共享读写/裸仓库/main/任务板/远程地址/锁/身份/IP |

## 典型对话示例

**开始一天的工作**

> 你：先看看协作状态，把任务板里能做的接一个，做完发布。
>
> agent（内部）：`cowork_status` → `cowork_sync` → `cowork_task_list open` → `cowork_task_claim T-0003`
> → 改代码 → `cowork_save` → `cowork_publish` → `cowork_send B "T-0003 已推送，请评审"`

**评审合并同伴的工作**

> 你：B 有没有待合并的？审一下然后合了。
>
> agent：`cowork_task_list review` → `cowork_review T-0004` →（看 diff/统计/冲突提示）→ `cowork_merge T-0004`
> → `cowork_send B "T-0004 已合并，leader 上 main 已更新"`

**把任务派给另一台机器**

> 你：把「跑通部署脚本」派给 B。
>
> agent：`cowork_task_create { title: "跑通部署脚本", assignee: "B", description: "..." }`
> → B 的 DSH 在下一回合会收到 `<system-reminder>` 提醒 → B 的 agent `cowork_task_claim` 开始做。

**冲突处理**

> agent：`cowork_sync` 返回冲突文件 `src/app.ts` → 读文件、解决 `<<<<<<<` 标记 → `cowork_sync {action:"continue"}`
> → `cowork_publish`。
> 如果是 `cowork_merge` 冲突：工具会自动中止合并；agent 应 `cowork_send` 通知分支作者先 sync 解决，再重新合并。

## 步进提醒（自动注入的 `<system-reminder>`）

插件在每个模型步骤前检查共享板（4 秒缓存），当出现以下情况时自动注入一条提醒：

- 有发给自己的未读消息；
- 自己的任务处于 `open`（待认领）或 `review`（待合并）。

同一内容只注入一次（按内容 hash 去重），不会刷屏。配置 `notify: false` 可整体关闭。

## 错误信息与含义

| 工具返回 | 含义 / 下一步 |
|---|---|
| `[cowork] 未配置仓库路径…` | 插件配置缺 `repoPath`：改 profile 的 `cordis.patch.yml`，或 `cowork join/init` 后重装 |
| `找不到 cowork 仓库配置` | `repoPath` 指向的目录没有 `.cowork/config.json`；用本地克隆目录而不是源码目录 |
| `当前工作区有未提交改动…` | 先 `cowork_save`（或丢弃改动）再认领新任务 |
| `与 origin/main 产生冲突，已暂停 rebase…` | 解决冲突 → `cowork_sync {action:"continue"}`；不处理就 `abort` |
| `合并 X 时冲突，已自动中止` | main 保持干净；让分支作者先 sync 解决冲突并重新发布，再 merge |
| `任务已被 X 认领` | 换一个任务，或让对方释放（`cowork_task_update` 把 `owner` 设为 `none`） |
| `任务已指派给 X` | 任务创建时指定了 assignee；确认接管时用 `cowork_task_claim` 的 `force=true` |
| `等待共享板锁超时` | 另一台机器正在写；稍后重试，或确认无人操作后删 `board/.board.lock`（45 秒自动过期） |
