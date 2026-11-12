# 发布与安装 cowork（DSH bundle）

cowork 现在既是一个命令行工具，也是一个可被 DSH 直接安装的 **bundle**。
本文说明两件事：

1. 怎样把它装进一个 DSH profile（本地路径 / GitHub / npm / tarball）；
2. 怎样把它发布出去，让别人用一条 `dsh plugin add` 安装。

> 适用版本：cowork 0.1.0、DSH 0.2.x（`engines.dsh` 声明为 `>=0.2.2-rc.1 <0.3.0`）。
> 平台：Windows / PowerShell 为主；命令本身是跨平台的。

---

## 1. bundle 是什么

DSH 的安装单位是 **bundle**：一个 npm 包，`package.json` 里声明 `dsh.bundle.patch`，
指向一个 `cordis.patch.yml`；profile 的 `dsh.profile.bundles` 列出这个包后，
启动时会把 patch 层叠加进配置树。

cowork 的 `package.json` 已经声明：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` 只插入一行插件：

```yaml
- insert:
    - id: cowork
      name: 'dsh-cowork-framework'
      config:
        notify: true
```

`repoPath` / `agent` 故意不写死：插件会按
`COWORK_REPO` / `COWORK_AGENT` → `~/.cowork/config.json` → 仓库 `.cowork/config.json` 的顺序解析。
`cowork init` / `cowork join` 会写全局配置，所以正常流程下不需要再填路径。

---

## 2. 本地验证 bundle（不碰真实 profile）

用临时 `DSH_HOME` 建一个一次性 profile，安装、dump、跑测试，最后整个目录删掉：

```powershell
# 在 cowork 仓库根目录
$tmp = Join-Path $PWD ".tmp\bundle-smoke"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:DSH_HOME = Join-Path $tmp "dsh-home"

dsh plugin --profile bundle-test add $PWD
dsh --profile bundle-test --dump-config | Select-String cowork
```

应看到：

```text
# == dsh-cowork-framework
- id: cowork
  name: 'dsh-cowork-framework'
  config:
    notify: true
```

可选的插件导入/配置 schema 检查：

```powershell
dsh --profile bundle-test --dump-config-schema
```

> `--dump-config-schema` 会真实 import 插件模块。web 系 profile 可能因为
> `@deepseek-ai/dsh-agent-preset` 的既有诊断而返回非 0；以输出里
> `"id": "cowork", "status": "schema"` 为准，不要只看退出码。

可选的真实加载探针（13 个工具 + 提示段 + pre-step 钩子）：

```powershell
$env:COWORK_PROBE = "1"
dsh --profile bundle-test --port 3086 --no-open
# 另开终端：
Get-Content "$env:TEMP\cowork-plugin-probe.json"
```

清理：

```powershell
Remove-Item $tmp -Recurse -Force
Remove-Item Env:DSH_HOME
Remove-Item Env:COWORK_PROBE
```

---

## 3. 用户怎么装

### 方式 A：本地路径（开发/内网分发，最稳）

```powershell
dsh plugin --profile web add D:\tools\cowork-framework
dsh --profile web --dump-config
```

pnpm 会把这个目录以 `link:` 装进 profile；改源码后 HMR 能感知。
安装时可能看到 peerDependencies 警告（`@deepseek-ai/dsh-*`），这是正常的：
DSH 运行时会从安装目录解析这些包，不需要 profile 里再装一份。

也可以用仓库里的脚本（会顺带装 `cowork` 命令）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install-bundle.ps1 -Profile web
```

### 方式 B：GitHub 仓库

```powershell
dsh plugin --profile web add github:Fe1ixFe1icis/dsh-coworkFramework
# 建议锁 tag/commit，避免上游后续提交改变安装内容（发布 v0.2.0 后）：
dsh plugin --profile web add github:Fe1ixFe1icis/dsh-coworkFramework#v0.2.0
```

cowork 是纯 ESM JavaScript（`src/*.mjs`），没有构建步骤，所以从 GitHub 安装不需要
`prepare` 脚本，也不需要 `allowBuilds`。如果以后改成 TypeScript 构建，就要补 `prepare`，
并让用户允许构建脚本。

### 方式 C：npm

```powershell
npm login
npm publish --access public
```

用户安装：

```powershell
dsh plugin --profile web add dsh-cowork-framework
```

**关于包名**：仓库使用 unscoped 的 `dsh-cowork-framework`。如果你想换成自己的名字：

- 先确认新名字可用：`npm view <new-name> version`（返回 404 通常表示可用）；
- 同步修改 `package.json` 的 `name` 和 `cordis.patch.yml` 里的 `name:`；
- 再跑 `npm run check`，确保两处一致。

`dsh-cowork` 这个名称已经被别人占用，不要使用。

### 方式 D：tarball / GitHub Release

```powershell
npm run pack
# 生成 dist\dsh-cowork-framework-0.2.0.tgz（按发布版本）
```

把 `.tgz` 上传到 GitHub Release，用户：

```powershell
dsh plugin --profile web add .\dsh-cowork-framework-0.2.0.tgz
```

tarball 安装的是预构建内容，不需要构建权限，也不依赖 GitHub 可达性；适合内网/离线分发。

### 方式 E：旧的手工安装（兜底）

`install\install-dsh-plugin.ps1` 仍然保留：它把包复制到 profile 的 `node_modules`，
再往 profile 的 `cordis.patch.yml` 追加一行。适合：

- DSH 版本较老、`dsh plugin` 不可用；
- 不想让 pnpm 管理 profile 依赖；
- 需要完全离线、只复制文件。

> 不要同时用 bundle 和手工安装：两个 `id: cowork` 行会冲突。
> 从手工安装迁移到 bundle 时，先运行 `install\uninstall-dsh-plugin.ps1 -Profile <profile>`。

---

## 4. 安装后的配置

### 4.1 零配置（推荐）

在每台机器上先运行过：

```powershell
cowork init --share "\\fileserver\cowork" --agent A --dir "D:\work\project"
# 或
cowork join --share "\\fileserver\cowork" --agent B --dir "D:\work\project"
```

`cowork init/join` 会写 `~/.cowork/config.json`，其中包含 `repoPath`、`agent`、`shareRoot`。
bundle 里的插件启动后按这个全局配置解析，不需要改 profile。

### 4.2 环境变量

```powershell
$env:COWORK_REPO = "D:\work\project"
$env:COWORK_AGENT = "A"
```

适合 CI、临时会话、或一台机器有多个克隆的情况。

### 4.3 在 profile 里覆盖

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: cowork
  config:
    repoPath: 'D:/work/project'
    agent: 'A'
    notify: true
```

注意：后叠加的层会**整体替换** `config`，不是深合并。覆盖时把需要的键都写全
（尤其是 `notify`，否则会回退到默认值 true）。

### 4.4 验证

```powershell
dsh --profile web --dump-config | Select-String cowork
```

启动 DSH 后，新会话里应有 13 个 `cowork_*` 工具；让 agent 调一次 `cowork_doctor`，
或在终端运行 `cowork doctor`。

---

## 5. 发布步骤（维护者）

### 5.1 发布前

> **版本提示**：`v0.1.0` 已经作为初始版本打过 tag。bundle 改变了安装面，建议 bump 到
> `0.2.0` 后再打 `v0.2.0`；不要移动或复用已经发布的 `v0.1.0`。

1. 版本号三处同步：`package.json`、`src/core.mjs` 的 `FRAMEWORK_VERSION`、`CHANGELOG.md`。
2. 跑检查：

   ```powershell
   npm run check
   npm test
   npm run test:plugin
   ```

3. 确认 npm 包内容包含 bundle patch：

   ```powershell
   npm pack --dry-run
   ```

   输出里必须有 `cordis.patch.yml`。

4. 用临时 profile 做一次真实安装（见第 2 节），确认 `id: cowork` 和 13 个工具。

### 5.2 GitHub Release（必做）

```powershell
git switch main
git pull --ff-only
npm run package          # dist/cowork-framework-<version>.zip + .sha256
npm run pack                       # dist/dsh-cowork-framework-<version>.tgz

git tag -a v0.2.0 -m "cowork v0.2.0"
git push origin main --tags
```

tag 会触发 `.github/workflows/release.yml`，自动生成 GitHub Release 并上传
`dist/*.zip`、`dist/*.sha256`、`dist/*.tgz`。手动发布也可以：

```powershell
gh release create v0.2.0 `
  "dist/cowork-framework-0.2.0.zip" `
  "dist/cowork-framework-0.2.0.zip.sha256" `
  "dist/dsh-cowork-framework-0.2.0.tgz" `
  --title "cowork v0.2.0" --generate-notes
```

### 5.3 npm（可选）

```powershell
npm pack --dry-run       # 最后确认 files
npm publish --access public
```

如果提示 scope 无权限，按第 3 节的方式 C 改名；不要为了发布把包塞进别人的 scope。

### 5.4 让生态发现它

1. 给 GitHub 仓库加 topic：`dsh-plugin`（官方 README 明确这是发现信号）。
2. 在 [DSH Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 发一个介绍：
   解决什么问题、安装命令、30 秒 demo、已知限制。
3. 提交社区目录（它们是社区 PR，不是官方核心）：
   - <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
   - <https://github.com/0xsline/awesome-deepseek-harness>
4. 写一篇博客/教程，链接到 Release 和 `dsh-plugin` topic。

> 官方核心仓库目前不接受外部 PR，也不开 Issues；不要往 `deepseek-ai/deepseek-harness`
> 提 PR。生态贡献走插件 + topic + Discussions。

---

## 6. 卸载与回滚

```powershell
dsh plugin --profile web remove dsh-cowork-framework
dsh --profile web --dump-config | Select-String cowork
```

- 也可以直接运行 `install\uninstall-dsh-plugin.ps1 -Profile web`：它会检测 bundle 安装并调用
  `dsh plugin remove`，再清理旧版手工安装留下的补丁块。
- 如果 `dump-config` 里还有 `id: cowork`，检查 profile 的 `cordis.patch.yml` 是否有残留块。
- npm 发布后 72 小时内可以 `npm unpublish`，但更推荐发一个新的 patch 版本。

---

## 7. 检查清单

- [ ] `package.json` 有 `dsh.bundle.patch`，且 `files` 包含 `cordis.patch.yml`
- [ ] `cordis.patch.yml` 的 `id` / `name` 与包名一致
- [ ] `engines.dsh` 覆盖目标 DSH 版本
- [ ] `npm pack --dry-run` 包含 `cordis.patch.yml`
- [ ] 临时 profile：`dsh plugin add` → `--dump-config` 出现 cowork
- [ ] 真实加载：13 个 `cowork_*` 工具 + `cowork:protocol` + pre-step
- [ ] `cowork init/join` 后零配置可用，或文档写明 env/override
- [ ] README 的安装章节同时给出 bundle 和手工两条路
- [ ] GitHub topic `dsh-plugin`
- [ ] Release 附带 `.zip`、`.sha256`、`.tgz`
- [ ] Discussions / awesome list 已发布
