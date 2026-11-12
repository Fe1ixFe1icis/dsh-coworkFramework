# Contributing to cowork

Thanks for your interest in cowork — a LAN multi-agent collaboration framework for
DeepSeek Harness (DSH), built around a shared git repository, a shared task board, and a
DSH plugin.

> 中文说明：本文档面向贡献者，说明本地开发、测试与提交 PR 的要求；面向使用者的安装与日常操作见
> `README.zh.md` 和 `docs/`。

## Before you start

- **Node.js >= 20** (the code targets current LTS; CI covers Node 20 and 22).
- **git >= 2.30** on `PATH`. cowork shells out to the system git instead of bundling one.
- **Windows 10/11 is the primary platform** (Windows PowerShell 5.1 or PowerShell 7).
  The core library is plain Node.js and also runs on Linux; the real SMB test is only
  meaningful on Windows with access to an SMB/UNC share.
- No `npm install` is required to run the framework: there are no third-party runtime
  dependencies. The plugin test needs modules that ship with DSH (see below).

Quick sanity check:

```powershell
node --version
git --version
```

Fork the repository on GitHub, then clone your fork (this repository is the framework
source; do **not** run `git init` in it):

```powershell
git clone <your-fork-url> cowork-framework
cd cowork-framework
```

## Repository layout

```text
.
├─ bin/                  # cowork CLI entry points (cowork.mjs, cowork.cmd)
├─ src/                  # ESM core library, no build step
│  ├─ core.mjs           # business logic: init/join/sync/save/publish/review/merge/...
│  ├─ git.mjs            # git subprocess wrapper and path/URL normalization
│  ├─ board.mjs          # shared task board (tasks, messages, heartbeats, locking)
│  ├─ config.mjs         # global (~/.cowork) and per-clone (.cowork) configuration
│  ├─ plugin.mjs         # DeepSeek Harness plugin: cowork_* tools and step reminders
│  ├─ cli.mjs            # command-line parsing and output
│  └─ util.mjs           # filesystem, atomic-write, and formatting helpers
├─ install/              # PowerShell install/uninstall/package/dev-dependency scripts
├─ tests/                # unit tests, two-machine simulation, SMB, and plugin tests
├─ scripts/              # repository check and release packaging (Node, no third-party deps)
├─ docs/                 # architecture, two-machine tutorial, tool reference, troubleshooting
├─ .github/              # CI, release workflow, issue and PR templates
├─ work/                 # local business clone (git-ignored; created by cowork init/join)
└─ dist/                 # release archives (git-ignored; created by npm run package)
```

## Development setup

The framework itself runs directly from the working tree:

```powershell
node bin\cowork.mjs help
node bin\cowork.mjs doctor
```

### DSH modules for the plugin test

`src/plugin.mjs` imports modules that ship with DSH:
`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, and `@deepseek-ai/dsh-llm`.
The plugin test needs to resolve them from this repository. The helper script creates a
`node_modules` junction to the DSH installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\prepare-deps.ps1
```

By default the script looks for DSH under
`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules`. If DSH lives elsewhere, pass
the directory explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\prepare-deps.ps1 `
  -DshNodeModules "D:\tools\dsh\node_modules"
```

`node_modules/` is git-ignored; never commit it or a copy of the DSH modules. Formal
plugin installation into a DSH profile does not use this helper.

## Coding conventions

- **ESM only.** Use `import`/`export`; the package is `"type": "module"` and has no build or
  transpile step. Keep imports of Node built-ins prefixed with `node:`.
- **No third-party runtime dependencies.** The CLI and core use Node built-ins and the
  system `git`. The plugin may import only the DSH-provided packages listed above.
- **Formatting:** UTF-8, LF line endings, two-space indentation. Match the existing style
  (single quotes, no semicolons). Run `npm run check` before committing.
- **Errors must be actionable.** User-facing messages are written in Chinese and should
  say what failed, the likely cause, and the exact next step — including a command or a
  path the user can copy. Do not swallow git stderr; include the relevant detail.
- **Paths:** support both drive-letter paths and UNC paths
  (`\\<share-host>\<share-name>\...`). Normalize paths before comparing or persisting
  them; never hard-code a machine-specific path, hostname, IP address, or username.
- **Shared state:** never edit the shared folder directly during development. Tests must
  use temporary clones/directories and set `COWORK_HOME` to a temporary global config, so
  a developer's real `~/.cowork` and business repository are untouched.
- **Behavior changes:** keep the CLI contract stable. `--json` output is consumed by
  scripts and agents; when you change a result shape, update the docs and tests too.

## Testing

Run the suites from the repository root. They are designed to run **sequentially** — do
not run them in parallel, because the SMB suite is bandwidth-sensitive and the suites
create/clean temporary working copies.

| Command | What it covers | Prerequisites |
| --- | --- | --- |
| `npm run check` | Fast static and syntax checks used by CI. | Node >= 20 |
| `npm test` | Unit and two-machine simulation: init/join, branches, task board, messages, conflict handling, doctor. | Node >= 20, git |
| `npm run test:plugin` | The DSH plugin: 13 `cowork_*` tools, system-prompt section, and step reminders, using a fake DSH context. | DSH modules (see above) |
| `npm run test:smb` | End-to-end flow on a real SMB/UNC share. | Windows and a writable SMB share (skips when none is configured) |

### Plugin test without DSH

`npm run test:plugin` prints `SKIP` and exits with status 0 when the DSH modules are not
available. That is expected on a clean checkout or a CI runner without DSH, and it keeps
CI green. To actually exercise the plugin, prepare the junction with
`install/prepare-deps.ps1` first and confirm the test runs instead of skipping. On a
release or fully provisioned verification machine, set
`$env:COWORK_REQUIRE_PLUGIN_DEPS = "1"` before running the suite so a missing dependency
fails instead of skipping.

### SMB test

The SMB suite creates a temporary directory under the share, runs the two-machine flow,
and removes its artifacts afterwards. If no share is specified, the test prints `SKIP` and
exits 0; a share that is specified but unreachable is treated as a real failure. To point
it at a share explicitly:

```powershell
npm run test:smb -- --share "\\<share-host>\<share-name>\cowork"
```

Use a disposable/test share path and credentials with write access. Never put a real
share path, internal IP, or username into tracked files, test output pasted into an issue,
or a pull request.

### Before opening a pull request

1. `npm run check`
2. `npm test`
3. `npm run test:plugin` (or note that it printed `SKIP` and why)
4. `npm run test:smb` if you touched path, git, board, or locking behavior (or note that it
   skipped because no share was configured)
5. Manually verify the affected CLI command and, for plugin changes, the tool output in a
   DSH session when possible.

## Pull requests

- Branch from `main`, keep the change focused, and keep commits readable. Avoid mixing
  unrelated formatting or refactoring into a behavioral change.
- Fill in the pull request template: summary, changes, and the testing you actually ran.
  If a suite was skipped, say so and why.
- Add or update tests for behavior changes, and update the relevant docs
  (`README.zh.md`, `docs/`, CLI help) for user-visible changes.
- Add a `CHANGELOG.md` entry for user-visible changes.
- Remove secrets and internal details: no internal IP addresses, hostnames, usernames,
  UNC paths, tokens, customer data, or screenshots containing them. Use placeholders such
  as `<share-host>` and `D:\tools\cowork-framework`.
- Link related issues and describe the motivation, not just the diff.
- By contributing, you agree that your contribution is licensed under the MIT License and
  that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).

CI runs the check, unit/smoke, and plugin suites on Windows and Linux with Node 20 and 22.
A maintainer will review the change and may ask for a smaller diff, tests, or a docs
update before merging.

## Reporting security issues

**Do not open a public issue for a vulnerability.** Follow [SECURITY.md](SECURITY.md) and
report it privately through GitHub Security Advisories.
