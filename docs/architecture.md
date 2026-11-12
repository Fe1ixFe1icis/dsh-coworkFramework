# Architecture

This is the design document for **cowork**, a LAN collaboration framework for DeepSeek Harness (DSH) agents; the Chinese original is [architecture.zh.md](architecture.zh.md).

cowork lets two or more machines work on the same codebase without a server, a database, or a daemon. A bare git repository and a shared task board live in a LAN share; each machine gets its own local clone; a DSH plugin turns the whole thing into tools the model can call, plus a protocol section and a per-step reminder.

## 1. Overall model

```
   machine-a                                    machine-b
 ┌───────────────────────────┐              ┌───────────────────────────┐
 │ DSH (web) + cowork plugin │              │ DSH (web) + cowork plugin │
 │  ├ worker session         │              │  ├ worker session         │
 │  ├ cowork_* tools         │              │  ├ cowork_* tools         │
 │  └ local clone (own copy) │              │  └ local clone (own copy) │
 └─────────────┬─────────────┘              └─────────────┬─────────────┘
               │  git fetch / push (branches)             │
               │  board read / write (cross-machine lock) │
               ▼                                          ▼
      ┌────────────────────────────────────────────────────────────┐
      │  \\fileserver\cowork                                       │
      │    repo.git   bare repo: main + agent/* branches           │
      │    board/     board.json (tasks + messages), members/      │
      └────────────────────────────────────────────────────────────┘
```

The share is plain storage. Nothing runs there: no coordinator process, no message broker, no scheduler.

Three layers, each with one responsibility:

1. **git layer** — the single source of truth for code is `main` in the shared bare repository. Every machine edits only its own local clone, on a task branch named `agent/<agent>/<task-id>`. Work reaches `main` through review (`cowork review`) and an explicit merge, never by editing the share.
2. **board layer** — the memory of the collaboration: who claimed what, how far it got, what has been said. It is ordinary files in the share, serialized by a cross-machine file lock. No database, no service to keep alive.
3. **agent layer** — the DSH plugin wraps the two layers into tools and prompts, so the model follows a fixed workflow and automatically sees unread messages and branches waiting to merge at every step.

Shared directory layout:

```
\\fileserver\cowork\
  cowork.json           framework metadata (version, project name, directory names)
  repo.git/             bare git repository: main + agent/* branches
  board/board.json      tasks and messages
  board/board.json.bak  previous board version, used for recovery
  board/members/*.json  one heartbeat file per machine
  board/events.jsonl    append-only audit log
  board/.board.lock     short-lived write lock
```

A local clone keeps its own `.cowork/config.json` (for example `D:\work\project\.cowork\config.json`), which records its identity, the share path, and the names of the bare repo and board directories.

## 2. Branch model

```
main ──●────────────────●────────────────●──────────►
        \              / \              /
         ●────● (a)   /   ●────● (b)   /
        agent/machine-a/T-0001  agent/machine-b/T-0002
```

- `main` is the integration branch and only accepts reviewed merges. A local `main` is only ever fast-forwarded, never committed to directly.
- `agent/<agent>/<task-id>` is one branch per task, created from `origin/main` and pushed once. The default prefix is `agent` and is configurable per clone.
- Merges use `merge --no-ff`, so the integration point stays visible in history. The remote task branch is deleted after a successful merge (`--keep-branch` / `keepBranch: true` preserves it).
- Both segments of the branch name are sanitized: whitespace, path separators, and characters illegal in git refs (`~ ^ : ? * [ ] \ /`) collapse to `-`, and leading/trailing `-` or `.` are trimmed. An empty result falls back to `agent`.

### 2.1 Sync and conflicts

- `cowork sync` fetches, then rebases the current branch onto `origin/main`. On a conflict the rebase pauses: resolve and run `cowork sync --continue`, or abandon with `cowork sync --abort`. On `main` the same command is a `--ff-only` merge instead of a rebase.
- Because rebase rewrites history, `cowork publish` falls back to `--force-with-lease` for task branches only. It can overwrite the pusher's own branch and nobody else's commits.
- `cowork merge` is a fixed sequence: fetch → `checkout main` → `merge --ff-only origin/main` → `merge --no-ff origin/<branch>` → push `main`. A conflict triggers an automatic `merge --abort`, so `main` is never left dirty and the only output is the list of conflicting files.
- Recommended flow: the branch author syncs and resolves conflicts first, then the reviewer merges. The merge itself re-probes for potential conflicts with `git merge-tree`, so `cowork review` can warn before anyone tries.

## 3. Shared task board

### 3.1 Data structure (`board/board.json`)

```jsonc
{
  "formatVersion": 1,
  "project": "example",
  "seq": 12,                        // one counter shared by task and message ids
  "createdAt": "...", "updatedAt": "...", "updatedBy": "machine-a",
  "tasks": {
    "T-0001": {
      "id": "T-0001", "title": "...", "description": "...",
      "status": "open|working|review|done|blocked",
      "assignee": "machine-b",      // who it was assigned to (may be null)
      "owner": "machine-a",         // who actually claimed it
      "branch": "agent/machine-a/T-0001",
      "files": [], "tags": [], "priority": "normal",
      "createdAt": "...", "createdBy": "machine-a", "updatedAt": "...",
      "notes": [{ "at": "...", "by": "machine-a", "text": "..." }],
      "history": [{ "at": "...", "by": "machine-a", "action": "claim", "detail": "..." }]
    }
  },
  "messages": [
    {
      "id": "M-0002", "from": "machine-a", "to": "machine-b",
      "subject": "...", "body": "...", "taskId": "T-0001",
      "at": "...", "readBy": ["machine-b"]
    }
  ]
}
```

- Task state machine: `open → working → review → done`. Any state can move to `blocked`, normally with a note explaining why.
- Messages may be addressed to one identity or to `all`. `readBy` records read receipts per machine identity.
- `board.json.bak` holds the previous version, copied before each write. When the board fails to parse, the read falls back to this backup and flags the result with `__recoveredFromBackup`, so `status` and `doctor` can warn about it.
- `events.jsonl` is an append-only audit trail (who did what, when). Failing to append never blocks the board write.
- `board/members/<agent>.json` holds a heartbeat — hostname, local IPs, platform, clone path, first and last seen. A member counts as online when its `lastSeen` is under five minutes old.

### 3.2 Concurrency control across machines

A file share has no transactions, so consistency comes from **one file lock plus atomic replacement**:

1. Before writing, create `board/.board.lock` exclusively with `open(lockFile, 'wx')` — O_EXCL semantics, which SMB honors.
2. Under the lock: read `board.json`, apply the mutation, copy the old file to `board.json.bak`, write a temporary file, then `rename` it over the board.
3. Release the lock by deleting the lock file, in a `finally` block.
4. If the lock is held, retry with exponential backoff for at most **20 seconds**. A lock whose mtime has not changed for **45 seconds** is treated as leftover from a crashed machine and removed.

Only writers take the lock. Readers do not: the atomic `rename` guarantees they always see a complete JSON document. Where a particular SMB server rejects `rename` over an existing file, the write falls back to `copyFile` to keep the same reader guarantee.

Heartbeats need no lock, because each machine writes only `<share>/board/members/<its-own-agent>.json`.

### 3.3 Idempotency and error handling

- Running `cowork save` on a clean tree reports "nothing to commit" instead of creating an empty commit.
- `cowork publish` is a pipeline: save (skipped when clean) → sync → push the branch → set the linked task to `review`. It refuses to run on `main`.
- `cowork merge` marks the task `done` and deletes the remote branch unless asked to keep it.
- A missing `board.json` is an error, not an empty board — an unreachable share must never be reported as "0 tasks". Only the write path is allowed to treat a missing file as an empty board.
- Failures are reported with the path that failed and the next action to take; a failed push says whether the local merge already happened.

## 4. DSH plugin

The plugin is a plain ESM package (`@cowork/framework`) whose entry point is `src/plugin.mjs`:

```js
export const name = 'cowork'
export const inject = ['tools', 'systemPrompt']
export const Config = z.object({ repoPath, agent, notify, fetchOnStatus })
export function apply(ctx, config) { ... }
```

`apply` does three things:

1. **Registers 13 tools** through `ctx.tools.register(defineTool({...}))`: `cowork_status`, `cowork_sync`, `cowork_save`, `cowork_publish`, `cowork_review`, `cowork_merge`, `cowork_task_create`, `cowork_task_claim`, `cowork_task_update`, `cowork_task_list`, `cowork_send`, `cowork_inbox`, `cowork_doctor`. Each tool documents the workflow and its constraints in the description, lets DSH validate the model's arguments, and returns a plain-text summary. Tools execute **inside the DSH host process**, not in a sandboxed child, which is why they can read and write the git repository on the share. See [plugin-tools.zh.md](plugin-tools.zh.md) for parameters and return values.
2. **Registers a system prompt section** with `ctx.systemPrompt.section({ name: 'cowork:protocol', order: 9000 })`. It tells the model its identity, the local clone path, the share, and the collaboration rules. The section is static: it does not touch the disk during `apply`, and `interpolate: false` keeps `{{...}}` inside a path from being expanded as a template variable.
3. **Registers an `agent/pre-step` hook.** Before each model step it reads the board once through a **4-second TTL cache**. If there are unread messages or tasks waiting to merge, it builds a `<system-reminder>`-style message with `createUserMessage` and appends it to that step's message list. Digests are de-duplicated per session by a SHA-1 hash kept in a `Map` (bounded at 100 entries), so the same reminder is not injected twice. Every failure is silent: a different DSH version or a temporarily unreachable share must not break the conversation. Setting `notify: false` disables the hook entirely.

Identity and paths are resolved per call, in order: `COWORK_REPO` → plugin `repoPath` → global config; and `COWORK_AGENT` → plugin `agent` → the clone's `.cowork/config.json`. The result is cached for three seconds.

### 4.1 Runtime dependencies and resolution

The plugin bundles no dependencies and reuses the packages DSH already ships:

- `@deepseek-ai/dsh-tools` — `defineTool`
- `@deepseek-ai/schemastery` — the `Config` schema
- `@deepseek-ai/dsh-llm` — `createUserMessage`, loaded lazily; if the export is missing, step reminders switch off instead of failing the plugin load

The plugin is installed at `~/.dsh/profiles/<profile>/node_modules/@cowork/framework`. Node resolves `@deepseek-ai/*` upwards to `~/.dsh/profiles/node_modules`, so no `pnpm install` is needed and the install works offline.

### 4.2 Installation and hot reload

- **Recommended: install as a DSH bundle.** The package ships a `cordis.patch.yml` that inserts one `id: cowork` row. `dsh plugin --profile <p> add <package/path/tarball>` records the package in the profile's `dsh.profile.bundles` and applies that layer automatically. `repoPath` / `agent` are resolved by the plugin from `COWORK_REPO` / `COWORK_AGENT` → `~/.cowork/config.json` → the clone's `.cowork/config.json`:

  ```yaml
  - insert:
      - id: cowork
        name: '@cowork/framework'
        config:
          notify: true
  ```

- **Fallback: the legacy install script.** It copies the package into the profile's `node_modules` and appends an entry with explicit `repoPath` / `agent` to the profile's `cordis.patch.yml`. Use it for older DSH versions or fully offline installs. Do not use both modes at once: they would create two `id: cowork` rows.
- `dsh --profile <p> --dump-config` validates that the configuration tree composes, without touching the network.
- With `patchReload: live` on the profile, saving the patch file triggers a hot reload and **no DSH restart is required**. A failed reload only reports an error; it does not kill the process. Roll back with `dsh plugin remove` for a bundle, or by deleting the whole `# >>> cowork plugin` block and the plugin directory for a manual install.
- The install script backs up `cordis.patch.yml` to a timestamped `.bak` file first.

### 4.3 Host process vs sandbox

| Operation | Default `workspace-write` | Full access |
|---|---|---|
| Plugin tools reading/writing the share (`cowork_*`) | ✅ direct host-process access | ✅ |
| `pwsh`/`bash` child processes reaching a UNC share | ❌ access denied (Windows sandbox) | ✅ |
| Agent `read`/`write`/`edit` against the share directly | ❌ restricted to the workspace | ✅ |
| Agent reads and writes inside the local clone | ✅ | ✅ |

Practical consequence: everyday collaboration works through the plugin tools alone. Switch a session to full access only when you need shell-level git operations against the share.

## 5. Clocks, identity, and security

- Identity is chosen per machine during setup (`cowork init --agent machine-a`, or `cowork join --agent machine-b`). It is stored in the clone's `.cowork/config.json` and mirrored to `~/.cowork/config.json` as the machine default.
- All timestamps are stored as UTC ISO strings and rendered in local time.
- Share permissions are inherited from the Windows SMB ACL. Grant write access only to trusted LAN users, and enable share auditing where available.
- The plugin never executes arbitrary shell commands supplied by the model. Tool arguments are passed to cowork's business functions, and git is invoked with fixed argument arrays — no shell, no interpolation. Git runs with `GIT_TERMINAL_PROMPT=0` and a no-op askpass, so an unavailable share fails fast instead of blocking on a credential prompt.
- `cowork import` copies a directory's contents (excluding `.git` and `.cowork`) into `main`, overwriting same-named files by default. It refuses to run off `main` and refuses the share root as a source. Back up before importing.
- Identities are advisory, not authenticated: anyone with write access to the share could write as another agent. The share ACL is the security boundary.

## 6. Failure modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Share unreachable | `status` shows the share as inaccessible; git operations fail | Check network, credentials, and the share service, then retry |
| Corrupt board JSON | Read error naming `board.json.bak` | Copy `board.json.bak` back to `board.json`, or re-run `cowork init` |
| Stale lock | Writes report waiting for the lock, then time out | Cleared automatically after 45 seconds; delete `.board.lock` if in a hurry |
| Rebase conflict | `sync` returns the conflicting files | Resolve, then `sync --continue`, or `--abort` |
| Merge conflict | Merge aborts itself, `main` stays clean | Have the author sync and rebase, then merge again |
| Push rejected after a local merge | Report says the merge succeeded locally but the push failed | Re-run `cowork merge` to pick up the newer `main` |
| Plugin not loaded | No `cowork_*` tools in the list | `dsh --profile <p> --dump-config` to inspect the entry; read the DSH logs for load errors |
| Plugin reports a missing repository path | Tool calls fail immediately | Add `repoPath` to the profile patch, or set a default in `~/.cowork/config.json` |

`cowork doctor` (and `cowork_doctor`) checks the same ground automatically: Node.js ≥ 20, git on `PATH`, identity, share reachability and writability, the bare repo and its `main`, board readability, the remote URL, lock age, heartbeat records, and local IPs. See [troubleshooting.zh.md](troubleshooting.zh.md) for symptom-driven guidance and [tutorial-two-machines.zh.md](tutorial-two-machines.zh.md) for a step-by-step two-machine setup.

## 7. Scope and current limitations

cowork is deliberately small. The boundaries below are known and intentional:

- **Small teams only.** A file-backed board with a single lock is comfortable for roughly 2–10 machines. Lock contention and read latency grow with machine count; there is no transaction, no query language, and no server to scale out.
- **Windows/SMB first.** UNC paths, ACLs, `core.autocrlf=false`, and the atomic-write fallback are tuned for Windows and SMB. Other network filesystems may work, but are not a supported target.
- **Plugin dependencies come from DSH.** The three `@deepseek-ai/*` packages are not vendored. A DSH release that changes their exports can degrade the plugin; the pre-step hook fails silently by design, so check the logs if reminders stop.
- **No real-time push.** There is no WebSocket, daemon, or notification channel. Freshness depends on polling at each model step with a 4-second cache, so a peer's update is visible only at that peer's next step, and the board is a coordination record rather than a chat transport.
- **No cryptographic identity.** Trust rests on share permissions. cowork does not sign commits, verify authors, or protect against a malicious collaborator with write access.
- **Review is advisory.** `cowork_review` shows commits, diff stats, and likely conflicts, but does not enforce approval. Gating merges is a process convention, not a technical mechanism.
