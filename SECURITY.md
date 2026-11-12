# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

Security fixes are made on `main` and released as patch versions of the supported line.
If you run an older snapshot, upgrade before reporting an issue that may already be fixed.

## Reporting a vulnerability

Report vulnerabilities **privately**:

1. Go to the repository's **Security** tab and choose **Report a vulnerability**
   (GitHub Security Advisory).
2. Do **not** open a public issue, discussion, or pull request that describes the
   vulnerability.
3. Include enough detail to reproduce and assess the issue:
   - cowork version (`cowork version` or `package.json`), DSH version, OS, Node and git
     versions;
   - the affected command or `cowork_*` tool, and the configuration involved;
   - impact and attack preconditions, plus minimal reproduction steps or a proof of concept;
   - relevant logs with secrets removed.

Redact real share paths, hostnames, IP addresses, usernames, tokens, and repository
contents before attaching logs. Maintainers will use the advisory to coordinate a fix,
prepare a release, and agree on disclosure timing with you. Please do not disclose the
issue publicly until a fix or mitigation is available.

## Threat model and security assumptions

cowork is designed for a **trusted local network** and a small group of trusted
collaborators. It is not a multi-tenant service and has no cryptographic identity layer.

- **The SMB share ACL is the security boundary.** Anyone who can write to the share can
  read and rewrite `repo.git`, `board/board.json`, and member heartbeats. There is no
  per-user authentication or request signing inside cowork; Windows/SMB permissions are
  the only access control. Grant write access only to the accounts that collaborate on the
  project, and do not expose SMB (port 445) to the public internet. Prefer a LAN, VPN, or
  firewall-restricted path, disable guest access, and share only the cowork directory
  rather than a whole disk.
- **The task board is a trusted LAN file, not an instruction channel.** Task titles,
  descriptions, notes, and messages are plaintext and are displayed to agents. Treat their
  content as untrusted data: agents must not execute shell commands or follow embedded
  instructions from a board message just because it is stored there. This is a prompt
  injection surface, not an authorization mechanism.
- **The DSH plugin runs inside the DSH host process** with the permissions of the user who
  started DSH. Installing a plugin means granting it code execution in that process. The
  plugin's tools perform cowork operations against the configured clone and share; they do
  not expose an arbitrary shell. Git is invoked through `execFile` using a fixed allowlist
  of framework-controlled subcommands and argument arrays (no shell interpolation), and
  agent/task identifiers are sanitized before being used in branch names. Review the
  configured `repoPath` and install the plugin only in profiles and workspaces you trust.
- **git itself is not sandboxed.** Repository-local hooks, configuration, filters, and
  aliases run with your user privileges. Only clone repositories you trust, and do not run
  cowork against a clone whose `.git/hooks` or config you have not reviewed.
- **The board contains no secrets protection.** Tasks and messages are stored as plaintext
  JSON on the share; do not put credentials or confidential data in them. `cowork doctor`
  reports local paths and local IPv4 addresses — redact those before sharing its output.

## Scope

In scope: vulnerabilities in cowork's own code, such as command or argument injection,
path traversal outside the configured clone/share, unsafe handling of board data, unsafe
file permissions, plugin tool argument handling, and denial of service caused by malformed
input. Out of scope: misconfigured share ACLs, a compromised collaborator machine or SMB
server, vulnerabilities in git or DSH themselves (report those upstream), and social
engineering that relies on a collaborator intentionally misusing their write access.
