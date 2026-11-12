## Summary

<!-- What problem does this PR solve, and why is the change needed? Link related issues. -->

## Changes

<!-- Bullet the main changes. Call out CLI/plugin behavior changes or breaking changes. -->

-

## Testing

<!-- Describe what you ran and on which platform. Redact internal paths, hosts, and IPs. -->

- [ ] `npm run check`
- [ ] `npm test` (unit + two-machine smoke)
- [ ] `npm run test:plugin` (or skipped because DSH dependencies are unavailable — explain below)
- [ ] `npm run test:smb` (or skipped because no SMB share is configured — explain below)

Test environment and notes:

<!-- OS, Node, git, DSH version; commands run; any manual verification. -->

## Checklist

- [ ] Documentation updated (`README.zh.md`, `docs/`, or CLI help) for user-visible changes
- [ ] `CHANGELOG.md` updated for user-visible changes
- [ ] No internal IP addresses, hostnames, usernames, share paths, tokens, or customer data
- [ ] No hard-coded machine-specific or sensitive paths; examples use placeholders such as `<share-host>`
- [ ] Change is focused, commits are readable, and the PR title describes the change
- [ ] I agree to follow the Code of Conduct (`CODE_OF_CONDUCT.md`)
