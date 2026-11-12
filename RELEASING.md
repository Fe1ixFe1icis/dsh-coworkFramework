# Releasing cowork

cowork is distributed as a GitHub Release archive (`dist/cowork-framework-X.Y.Z.zip` plus
its `dist/cowork-framework-X.Y.Z.zip.sha256` checksum). `dist/` is git-ignored and is not
committed. Releases are built from a tag on `main`; the GitHub Actions workflow does this
automatically, but the manual path is documented below as a fallback.

## One-time repository setup

Before the first release, connect the local repository to GitHub:

```powershell
git remote add origin <your-repository-url>
git push -u origin main
```

`package.json` already points `repository` and `homepage` at
`https://github.com/Fe1ixFe1icis/dsh-coworkFramework`; update both if the repository is renamed:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/Fe1ixFe1icis/dsh-coworkFramework.git"
},
"homepage": "https://github.com/Fe1ixFe1icis/dsh-coworkFramework#readme"
```

The release workflow publishes GitHub release assets only; it does not publish to npm. If
you decide to publish the package to npm as well, treat that as a separate, explicit step
after the GitHub release. Make sure Actions are enabled for the repository. The release
workflow declares `permissions: contents: write` for its `GITHUB_TOKEN`; if an organization
policy restricts token permissions, allow that permission for this workflow before tagging.

## Versioning

Use Semantic Versioning. For `0.x` releases, a minor bump may include breaking changes —
call them out in the changelog. `v0.1.0` was the initial public release; the DSH bundle
changes the install surface, so publish it as `0.2.0` / `v0.2.0` rather than moving the
existing tag. The version must be updated in **both** places and must
match:

1. `version` in `package.json` (also drives the archive name).
2. `FRAMEWORK_VERSION` in `src/core.mjs` (reported by `cowork version` and stored in the
   share metadata).

Then update `CHANGELOG.md`: add a new section at the top with the version and release date,
and list the user-visible changes under `Added`, `Changed`, `Fixed`, and `Security` as
appropriate.

## Release checklist

1. **Start from a clean, up-to-date `main`:**

   ```powershell
   git switch main
   git pull --ff-only
   git status --short
   ```

   The working tree must be clean. Do not release from a feature branch or a dirty clone.

2. **Bump the version** in `package.json` and `src/core.mjs`, and update `CHANGELOG.md` with
   the new version and date.

3. **Run the test suites:**

   ```powershell
   npm run check
   npm test
   npm run test:plugin
   npm run test:smb
   ```

   `test:plugin` may print `SKIP` when the DSH modules are not linked, and `test:smb` skips
   when no share is configured. Both skips exit successfully, but they are not sufficient
   evidence for a release: link the DSH modules with `install/prepare-deps.ps1`, set
   `$env:COWORK_REQUIRE_PLUGIN_DEPS = "1"`, and run the SMB suite against a real share at
   least once before tagging.

4. **Commit the release metadata:**

   ```powershell
   git add package.json src/core.mjs CHANGELOG.md
   git commit -m "chore(release): vX.Y.Z"
   ```

5. **Create an annotated tag:**

   ```powershell
   git tag -a vX.Y.Z -m "cowork vX.Y.Z"
   ```

6. **Push the commit and the tag:**

   ```powershell
   git push origin main --tags
   ```

7. **Wait for the release workflow.** Pushing a `v*` tag triggers
   `.github/workflows/release.yml` on `ubuntu-latest`. The workflow checks out the full
   history, sets up Node 20, runs `npm run check` and `npm test`, builds the source archive
   and the installable bundle tarball, and creates the GitHub Release with generated release
   notes. It uploads `dist/*.zip`, `dist/*.sha256`, and `dist/*.tgz` with
   `softprops/action-gh-release@v2`.

8. **Verify the published release** (see below).

### Publishing the DSH bundle

The same tag produces an installable bundle tarball (`npm pack`), so users can install with:

```powershell
dsh plugin --profile web add https://github.com/Fe1ixFe1icis/dsh-coworkFramework/releases/download/vX.Y.Z/cowork-framework-X.Y.Z.tgz
```

or, if published to npm, with `dsh plugin --profile web add @cowork/framework`.
The full matrix (local path, GitHub, npm, tarball), the npm scope caveat, and the
`dsh-plugin` discovery checklist are in [docs/publishing.zh.md](docs/publishing.zh.md).

## Manual release without Actions

If Actions are unavailable, build and publish from a machine with the tag checked out and
the GitHub CLI authenticated (`gh auth status`):

```powershell
npm run check
npm test
npm run package
npm run pack
Get-ChildItem .\dist
gh release create vX.Y.Z `
  "dist/cowork-framework-X.Y.Z.zip" `
  "dist/cowork-framework-X.Y.Z.zip.sha256" `
  "dist/cowork-framework-X.Y.Z.tgz" `
  --title "cowork vX.Y.Z" `
  --generate-notes
```

Push the tag first if it only exists locally (`git push origin vX.Y.Z`). `npm run package`
uses `git archive HEAD` and writes the zip plus its `.sha256` file into `dist/`; commit
everything you want in the archive, and confirm both file names match the version in
`package.json` before publishing.

## Verify the release

- The GitHub Release page lists the source zip, its `.sha256`, and the installable `.tgz` bundle.
- The checksum matches the downloaded archive:

  ```powershell
  Get-FileHash .\dist\cowork-framework-X.Y.Z.zip -Algorithm SHA256
  Get-Content .\dist\cowork-framework-X.Y.Z.zip.sha256
  ```

- Download the archive from the release page, extract it to a clean directory such as
  `D:\tools\cowork-framework`, and run:

  ```powershell
  node bin\cowork.mjs version
  node bin\cowork.mjs help
  ```

  The version should match the tag, and the archive should contain `bin/`, `src/`,
  `install/`, `docs/`, `README.zh.md`, and the license/contributor files.

- If the release is wrong, prefer fixing forward with a new patch version. Do not move or
  reuse a tag that has already been published.
