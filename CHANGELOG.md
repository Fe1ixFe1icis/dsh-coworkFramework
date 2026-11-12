# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-12

### Added

- Shared workspace bootstrap: `cowork init` creates a bare `repo.git`, the task-board
  directory, seed files, and a local clone; `cowork join` connects additional machines to
  the same share. Work happens on `agent/<agent>/<task-id>` branches in local clones.
- Shared task board at `board/board.json` with tasks (`open`, `working`, `review`, `done`,
  `blocked`), assignment, notes, messages, member heartbeats, atomic writes, a `.bak`
  copy, and a cross-machine write lock that clears stale locks automatically.
- Full CLI: `init`, `join`, `status`, `sync`, `save`, `publish`, `review`, `merge`,
  `import`, `task` (`new`/`claim`/`update`/`list`/`show`), `send`, `inbox`, `members`,
  `doctor`, `remote`, `version`, and `help`, with `--json` output for scripts and agents.
- DSH plugin exposing 13 tools: `cowork_status`, `cowork_sync`, `cowork_save`,
  `cowork_publish`, `cowork_review`, `cowork_merge`, `cowork_task_create`,
  `cowork_task_claim`, `cowork_task_update`, `cowork_task_list`, `cowork_send`,
  `cowork_inbox`, and `cowork_doctor`.
- Task ownership controls: `--assign` / `--owner` (with `none` to clear), plus
  `cowork task claim --force` for taking over a task that was assigned to another
  identity. The plugin exposes the same options (`assignee`, `owner`, `force`).
- Task metadata: `tags` and `priority` are accepted by both `cowork task new` and the
  `cowork_task_create` plugin tool.
- Step reminders: before an agent step, the plugin injects unread messages and
  review-ready tasks as a `<system-reminder>`, suppresses duplicate reminders for the same
  summary, and can be disabled with `notify: false`.
- Installable DSH bundle: `package.json` declares `dsh.bundle.patch`, `cordis.patch.yml`
  inserts the `cowork` row, and `dsh plugin --profile <profile> add <package>` installs and
  activates it without hand-editing the profile. `install/install-bundle.ps1` wraps the
  command and verifies the composed config; `install/uninstall-dsh-plugin.ps1` now detects
  bundle installs and removes them through `dsh plugin remove`; releases also ship an npm
  `.tgz`.
- Install and lifecycle scripts under `install/`: install/uninstall the DSH plugin with a
  `cordis.patch.yml` backup and config validation, install the `cowork` command on `PATH`,
  package the framework for another machine, and prepare local DSH test dependencies.
- `cowork import` for migrating a directory that was previously edited directly on the
  share into git on `main`.
- `COWORK_HOME` isolation for the global configuration directory, used by the tests and by
  setups that need more than one identity on one machine.
- Test suites for the unit layer, the two-machine simulation, a real SMB/UNC share, and
  the DSH plugin (fake DSH context). Suites print `SKIP` and exit successfully when the DSH
  modules are not linked or no SMB share is configured, so a clean checkout and CI stay
  green.
- `scripts/check.mjs` (syntax, version, documentation-link, required-file, and privacy
  checks) and `scripts/package-release.mjs` (reproducible `git archive` release zip plus
  SHA-256), wired to `npm run check` and `npm run package`.
- GitHub project infrastructure: CI and tag-driven release workflows, pull-request and
  issue templates, contributor/security/release documentation, and the MIT license.

### Changed

- Error messages now state the failed operation, the likely cause, and an actionable next
  step (recovery command or path), including broken repository configuration and
  unreachable shares.
- Repository resolution uses the current directory or an explicit `--repo` path and no
  longer silently falls back to a default clone from the global configuration.
- Git remote URLs are normalized for both drive-letter paths and UNC paths, so the same
  share produces a stable remote across Windows machines.
- Tests isolate global state with `COWORK_HOME` and clean up their temporary clones after
  a successful run, so they do not touch a real `~/.cowork` or business repository.
- `cowork version` reports the framework version from `src/core.mjs` together with the
  running Node.js version.

### Fixed

- Sync conflicts leave the clone in a recoverable state: conflicting files are reported
  and the operation can be continued or aborted, instead of leaving an unexplained
  in-progress rebase.
- Merge conflicts abort the merge and leave `main` clean, so the author can resolve the
  conflict on the task branch and publish again.
- A damaged `board.json` can be recovered from the `.bak` copy, and an abandoned board lock
  is cleaned up after the timeout instead of blocking all writers indefinitely. A mutation
  performed after recovery no longer overwrites the still-good `.bak` with the damaged
  file, and `cowork join` recreates a missing task board instead of leaving the clone in a
  state where every board command fails.
- Marking messages read with an empty id list is now a no-op instead of marking every
  message in the board as read.
- The plugin's board cache now also caches an empty result, so a quiet board does not force
  a fresh share read on every model step.
- Duplicate step reminders are no longer injected when the summary has not changed.

### Security

- Git commands are executed through `execFile` with fixed, framework-controlled argument
  arrays and no shell interpolation; agent and task identifiers are sanitized before they
  are used in branch names or member heartbeat filenames.
- Explicit `--agent` overrides now also determine the task branch name, so a temporary
  identity cannot accidentally publish under the clone's configured identity.
- Added `SECURITY.md` with the supported version, private reporting process, and threat
  model covering the shared-folder ACL, the plugin's host-process privileges, the task
  board as untrusted text, and the requirement not to expose SMB to the internet.
- Documented that the task board is plaintext and must not contain credentials, and that
  `cowork doctor` output contains local paths/IP addresses that must be redacted before
  sharing.
