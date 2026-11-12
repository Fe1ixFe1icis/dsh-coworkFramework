# cowork — LAN multi-agent collaboration for DeepSeek Harness

**cowork turns a shared LAN folder into a small agent cluster.** It combines three pieces:

1. a **bare git repository** in the shared folder (`repo.git`) — one branch per task, `agent/<agent>/<task>`;
2. a **file-backed task board** (`board/board.json`) — claim, work, review, merge, message, with a
   cross-machine file lock;
3. a **DeepSeek Harness (DSH) plugin** — 13 `cowork_*` tools, a system-prompt section, and a
   per-step reminder that surfaces unread messages and tasks waiting for review.

Each machine works in its own local clone. Nobody edits the shared folder directly, so history,
ownership, and review survive. The result is the smallest useful **cross-machine agent cluster**:
a shared task pool, claim, deliver, review, merge.

> **Status:** `0.1.0` — Windows/SMB first. Unit, two-machine simulation, and plugin suites
> pass; the real SMB suite is included and runs when a share is provided. See [Testing](#testing).

---

## Why

Directly editing files in `\\fileserver\share` from two machines has familiar failure modes:

| Problem | cowork's answer |
|---|---|
| No branches or history | Bare git repo in the share; every task gets `agent/<agent>/<task>` |
| Two people overwrite each other | Local clones + publish + review + merge into `main` |
| Nobody knows who is doing what | Shared task board: `open → working → review → done` |
| Agents cannot hand off work | `cowork_send` / `cowork_inbox` + a task board both agents can claim |
| Existing files are already in the share | `cowork import` brings them into git, then work on branches |

---

## Architecture

```
 machine A                                             machine B
┌──────────────────────────────┐                     ┌──────────────────────────────┐
│ DSH (web) + cowork plugin    │                     │ DSH (web) + cowork plugin    │
│  ├─ agent sessions           │                     │  ├─ agent sessions           │
│  └─ cowork_* tools           │                     │  └─ cowork_* tools           │
│ local clone: D:\work\project │                     │ local clone: D:\work\project │
└──────────────┬───────────────┘                     └──────────────┬───────────────┘
               │ git fetch/push (branches)                          │
               │ board reads/writes (cross-machine lock)            │
               ▼                                                    ▼
        ┌──────────────────────────────────────────────────────────────┐
        │ \\fileserver\cowork                                          │
        │   repo.git   ← bare repo: main + agent/* branches            │
        │   board/     ← board.json (tasks + messages), members/, lock │
        └──────────────────────────────────────────────────────────────┘
```

The only source of truth for code is `main` in the shared bare repo. Each machine only edits its
own clone. A merge into `main` goes through review (`cowork review`), and the task board records
who claimed what, what state it is in, and what messages were exchanged.

Read [docs/architecture.md](docs/architecture.md) for the design details
(Chinese: [docs/architecture.zh.md](docs/architecture.zh.md)).

---

## Requirements

- **Node.js >= 20** (DSH ships its own Node; use that if in doubt).
- **git >= 2.30** in `PATH`.
- **Windows 10/11** is the primary target (SMB/UNC shares, PowerShell installers). The CLI and core
  logic are plain ESM and also run on Linux/macOS; the SMB-oriented installers are Windows-only.
- **DeepSeek Harness >= 0.2.2-rc.1** for the plugin. The plugin does not bundle DSH packages; it
  reuses the host's `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, and
  `@deepseek-ai/dsh-llm`.

---

## Quick start

### 1. Get the code

```powershell
git clone <your-repo-url> D:\tools\cowork-framework
cd D:\tools\cowork-framework
```

Or download `cowork-framework-<version>.zip` from the GitHub **Releases** page and extract it.

### 2. Machine A: create the shared workspace

The share can be a UNC path (`\\fileserver\cowork`) or a local path that points at the same
physical directory on both machines (for example `D:\shares\cowork`). Keep it out of the project
clone itself.

```powershell
cd D:\tools\cowork-framework

# Optional: install the `cowork` shim into %APPDATA%\npm (already on PATH)
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-cli.ps1

cowork init `
  --share "\\fileserver\cowork" `
  --agent A `
  --dir "D:\work\project" `
  --project demo
```

This creates `cowork.json`, `repo.git`, and `board/` in the share, seeds `main` with a README and
`AGENTS.md`, and clones the repo to `D:\work\project` with `.cowork/config.json` (your identity and
the share path).

### 3. Machine B: join

```powershell
cd D:\tools\cowork-framework
cowork join --share "\\fileserver\cowork" --agent B --dir "D:\work\project"
```

Both machines must point at the **same physical share**. If credentials are requested, open the
share once in Explorer and save them, or use `net use`.

### 4. Install the DSH plugin

cowork is packaged as a DSH **bundle**: `package.json` declares `dsh.bundle.patch`, so
`dsh plugin add` installs the package and activates its `cordis.patch.yml` automatically.

#### Option A — bundle (recommended)

```powershell
dsh plugin --profile web add D:\tools\cowork-framework
dsh --profile web --dump-config        # should contain "- id: cowork"
```

Or use the helper, which also installs the `cowork` command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-bundle.ps1 -Profile web
```

`dsh plugin add` also accepts an npm package, a GitHub repo, or a tarball:

```powershell
dsh plugin --profile web add @cowork/framework
dsh plugin --profile web add github:Fe1ixFe1icis/dsh-coworkFramework#v0.2.0
dsh plugin --profile web add .\cowork-framework-<version>.tgz
```

The plugin resolves `repoPath` / `agent` from `COWORK_REPO` / `COWORK_AGENT`, then
`~/.cowork/config.json` (written by `cowork init` / `cowork join`), then the clone's
`.cowork/config.json`. To pin values for one profile, override the row by id in the profile's
`cordis.patch.yml`:

```yaml
- id: cowork
  config:
    repoPath: 'D:/work/project'
    agent: 'A'
    notify: true
```

A later layer replaces the whole `config` object, so restate every key you need. Uninstall with
`dsh plugin --profile web remove @cowork/framework`.

#### Option B — offline/manual install

The older script copies the package into the profile and edits `cordis.patch.yml` directly:

```powershell
cd D:\tools\cowork-framework
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-dsh-plugin.ps1 `
  -Profile web `
  -RepoPath "D:\work\project" `
  -Agent A
```

Use `-Agent B` and B's clone path on machine B. The script copies the package into
`~/.dsh/profiles/<profile>/node_modules/@cowork/framework`, appends an idempotent entry to
`cordis.patch.yml` (with a timestamped backup), validates the module import and
`dsh --dump-config`, and installs the CLI shim. Uninstall with
`install\uninstall-dsh-plugin.ps1 -Profile <profile>`.

> Do not use both options at once: they would create two `id: cowork` rows. Migrate by running
> the uninstall script first. Do not hand-delete a partial patch block, because an empty patch
> file must remain a YAML array (`[]`).

If the profile has live patch reload, the plugin hot-loads; otherwise restart DSH. Verify with
`dsh --profile <profile> --dump-config` or by checking that `cowork_status` appears in a new
session. Full publishing and installation guide: [docs/publishing.zh.md](docs/publishing.zh.md).

### 5. Daily workflow

```powershell
cd D:\work\project
cowork status                       # branch, dirty state, tasks, unread messages
cowork sync                         # fetch + rebase current branch onto origin/main
cowork task new "Implement login"   # create + claim, creates agent/A/T-0001
# ... edit files ...
cowork save -m "T-0001: implement login"
cowork publish                      # sync + push branch + task → review
```

On the other machine:

```powershell
cowork task list --review           # what is waiting for merge
cowork review agent/A/T-0001        # commits, diffstat, possible conflicts
cowork merge agent/A/T-0001         # merge into main, task → done, delete remote branch
```

Communication and handoff:

```powershell
cowork send B "T-0001 merged, please pull main" --task T-0001
cowork inbox --mark-read
cowork task new "Run deployment script" --assign B
```

In DSH, just ask the agent: “check the collaboration status”, “claim T-0002 and implement it”,
“review and merge B's branch”. It will call `cowork_status`, `cowork_task_claim`,
`cowork_publish`, `cowork_review`, `cowork_merge`, and friends. Before each model step, the plugin
injects a `<system-reminder>` when there are unread messages or tasks waiting for review
(disable with `notify: false`).

---

## CLI reference

All commands accept `--repo <clone>` (default: walk up from the current directory) and
`--agent <id>` (temporary identity override). `--json` prints machine-readable data.

| Command | Purpose |
|---|---|
| `cowork init --share <dir> --agent <id> [--dir <clone>] [--project <name>]` | Create the shared workspace and the first clone |
| `cowork join --share <dir> --agent <id> [--dir <clone>]` | Join an existing workspace |
| `cowork status [--no-fetch] [--json]` | Branch, dirty state, ahead/behind, tasks, members |
| `cowork sync [--continue\|--abort]` | Fetch + rebase onto `origin/main`; resolve or abort conflicts |
| `cowork save [-m <message>]` | Commit all local changes on the current branch |
| `cowork publish [-m <message>]` | Save → sync → push → mark the task `review` |
| `cowork review <task-id\|branch>` | Commits, diffstat, potential conflicts |
| `cowork merge <task-id\|branch> [--keep-branch]` | Merge into `main`, mark `done`, delete the remote branch |
| `cowork import <dir> [-m <message>] [--no-overwrite]` | Import an old shared directory into `main` |
| `cowork task new <title> [--desc ...] [--assign ...] [--files ...] [--tags ...] [--priority ...]` | Create a task (claim it unless assigned) |
| `cowork task claim <task-id> [--force]` | Claim a task; `--force` takes over an assigned task |
| `cowork task update <task-id> [--status ...] [--note ...] [--assign ...] [--owner ...]` | Update state/notes/assignment |
| `cowork task list [--open\|--my\|--review\|--all] [--status <state>]` | List tasks |
| `cowork task show <task-id>` | Task details and history |
| `cowork send <agent\|all> <message> [--task ...] [--subject ...]` | Send a cross-machine message |
| `cowork inbox [--all] [--mark-read] [--limit N]` | Read the inbox |
| `cowork members` | Member heartbeats |
| `cowork doctor` | Environment self-check |
| `cowork remote` | Print the shared bare-repo URL |
| `cowork version`, `cowork help` | Version / help |

Task states: `open → working → review → done`; any state can become `blocked` with a note.

---

## DSH plugin tools

| Tool | What it does |
|---|---|
| `cowork_status` | Branch, dirty state, ahead/behind, tasks, unread messages, members |
| `cowork_sync` | Sync/rebase; `action=continue\|abort` for conflicts |
| `cowork_save` | Commit local changes |
| `cowork_publish` | Save + sync + push + task → review |
| `cowork_review` | Review a task/branch before merging |
| `cowork_merge` | Merge into `main`, mark done, delete remote branch |
| `cowork_task_create` | Create a task (optionally assign it) |
| `cowork_task_claim` | Claim a task and create/switch its branch |
| `cowork_task_update` | Change status, notes, assignee, owner |
| `cowork_task_list` | List tasks (`all\|open\|mine\|review`) |
| `cowork_send` | Send a message to another machine |
| `cowork_inbox` | Read messages; optionally mark read |
| `cowork_doctor` | Environment self-check |

Full parameter reference: [docs/plugin-tools.zh.md](docs/plugin-tools.zh.md) (Chinese).

---

## Conflicts

- **Sync conflict:** `cowork sync` pauses the rebase and lists conflicted files. Resolve the
  markers, `git add` the files, then `cowork sync --continue`. To bail out, `cowork sync --abort`.
- **Merge conflict:** `cowork merge` aborts the merge automatically; `main` stays clean and the
  conflicted files are listed. The branch author should `cowork sync` on the task branch, resolve,
  `cowork publish`, and the reviewer merges again.
- One task per branch and small commits keep the conflict surface small.

---

## Migrating from a shared folder

```powershell
cd D:\work\project
cowork import "\\fileserver\legacy-project"
```

This copies the top-level entries into `main`, commits, rebases, and pushes. Afterwards, keep only
the `cowork\` workspace in the share and move the old directory to a read-only archive. Everyone
works in local clones from then on.

---

## Testing

```powershell
npm run check          # syntax, version consistency, doc links, required files, privacy
npm test               # unit tests + two-machine simulation (no DSH packages needed)
npm run test:plugin    # plugin tools/prompt injection (SKIPs if DSH packages are absent)
npm run test:smb -- --share \\fileserver\cowork   # real SMB end-to-end (SKIPs without --share)
npm run test:all       # check + test + plugin
```

Current coverage:

| Suite | Command | Assertions |
|---|---|---|
| Unit / edge cases | `npm run test:unit` | 58 |
| Two-machine simulation | `npm run test:smoke` | 79 |
| DSH plugin tools | `npm run test:plugin` | 49 (needs DSH packages) |
| Real SMB / UNC share | `npm run test:smb` | 19 (needs a share) |

The plugin test needs the DSH-provided packages. On a machine with DSH installed, run
`install\prepare-deps.ps1` first; otherwise the test prints `SKIP` and exits 0. Set
`COWORK_REQUIRE_PLUGIN_DEPS=1` to make missing dependencies fail (recommended before a release).

Tests isolate global state through `COWORK_HOME` and never touch your real `~/.cowork`.

---

## Release and CI

- `.github/workflows/ci.yml` runs `npm run check`, `npm test`, and `npm run test:plugin` on
  Ubuntu and Windows with Node 20/22, and uploads a source package.
- `.github/workflows/release.yml` runs on `v*` tags, builds
  `dist/cowork-framework-<version>.zip` + `.sha256` and the installable
  `dist/cowork-framework-<version>.tgz` bundle, and creates a GitHub Release.
- Locally: `npm run package` and `npm run pack`. See
  [RELEASING.md](RELEASING.md) and the bundle publishing guide
  [docs/publishing.zh.md](docs/publishing.zh.md).

---

## Security and limitations

- The share inherits Windows SMB permissions. Only give write access to trusted LAN users; do not
  expose the share to the internet.
- The plugin runs in the DSH host process and therefore can read/write the share even when the
  agent's shell is sandboxed. Its tools only call cowork business functions (no arbitrary shell).
- The task board is a file with a cross-machine lock, designed for roughly **2–10 machines**. It is
  not a database or a real-time message bus; reminders are checked at each model step.
- Identity is a self-declared string, not a cryptographic identity. The review gate is advisory:
  any machine with write access can merge.
- Large repositories clone slowly over SMB; avoid committing build artifacts and large binaries.

---

## Documentation

- [Architecture (English)](docs/architecture.md) · [架构（中文）](docs/architecture.zh.md)
- [Two-machine tutorial (中文)](docs/tutorial-two-machines.zh.md)
- [Plugin tool reference (中文)](docs/plugin-tools.zh.md)
- [Troubleshooting (中文)](docs/troubleshooting.zh.md)
- [GitHub repository copywriting / About (中文)](docs/github-repo.zh.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
