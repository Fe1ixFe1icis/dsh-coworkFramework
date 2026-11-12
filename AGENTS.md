# AGENTS.md — cowork 框架仓库维护说明

本目录是「局域网 cowork 框架」的**源码仓库**（框架本体），不是协作者要编辑的业务仓库。
业务仓库的本地克隆由 `cowork init/join` 创建，带 `.cowork/config.json`，通常放在仓库之外。

## 目录

- `src/`：核心库
  - `core.mjs` 业务逻辑（init/join/task/save/publish/review/merge/import/doctor）
  - `git.mjs` git 子进程封装（分支/同步/合并/冲突）
  - `board.mjs` 共享任务板（任务/消息/成员心跳）
  - `config.mjs` 全局/仓库配置与上下文解析
  - `plugin.mjs` DeepSeek Harness 插件（13 个 `cowork_*` 工具、提示段、步进提醒）
  - `cli.mjs` 命令行
  - `util.mjs` 文件锁、原子写、路径与参数工具
- `bin/`：`cowork` 命令入口（`cowork.mjs` + Windows `cowork.cmd`）
- `install/`：DSH bundle 安装（`install-bundle.ps1`）、旧版插件安装/卸载、CLI 安装、给同伴打包、本地测试依赖准备
- `cordis.patch.yml`：bundle 默认层（`package.json` 的 `dsh.bundle.patch` 指向它）
- `tests/`：`unit.test.mjs` 单元测试、`smoke.mjs` 两机模拟、`plugin.test.mjs` 插件工具、`smb-smoke.mjs` 真实共享目录
- `scripts/`：`check.mjs` 仓库自检、`package-release.mjs` 生成 GitHub Release 源码包
- `docs/`：架构（中/英）、两机教程、工具参考、排障、bundle 发布/安装指南（`publishing.zh.md`）
- `.github/`：CI、Release 工作流、Issue/PR 模板
- `work/`、`research/`、`dist/`：本地工作目录/侦察产物/打包产物，均被 git 忽略

## 常用命令

```powershell
npm run check               # 语法/版本/链接/隐私/必需文件检查
npm test                    # 单元测试 + 两机模拟（默认，不依赖 DSH 包）
npm run test:plugin         # 插件工具/提示注入（需要 DSH 的 node_modules，缺失时打印 SKIP）
npm run test:smb -- --share \\fileserver\cowork   # 真实共享目录测试（不传则 SKIP）
npm run test:all            # check + test + test:plugin
npm run package             # 生成 dist/cowork-framework-<version>.zip + .sha256
npm run pack                # 生成可被 dsh plugin add 安装的 dist/*.tgz bundle
node bin/cowork.mjs help
```

> 测试通过 `COWORK_HOME` 把全局配置隔离到临时目录，不会污染真实的 `~/.cowork`。
> `smoke` 与 `smb` 不要并行跑；真实 SMB 测试会互相抢带宽。
> 插件测试需要 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`：可用 `install\prepare-deps.ps1`
> 联接 DSH 的 `node_modules`；没有依赖时测试会打印 SKIP 并退出 0，CI 依赖这一行为。
> 发布前建议设置 `COWORK_REQUIRE_PLUGIN_DEPS=1`，让缺依赖直接失败。

## 约定

- 全部源码使用 ESM，无第三方运行时依赖（插件运行时依赖 DSH 自带的 `@deepseek-ai/dsh-tools`、
  `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`）。
- 中文注释/文档优先；错误信息要能指导用户下一步操作。
- 修改 `src/` 后必须跑 `npm test` 与 `npm run test:plugin`（没有 DSH 依赖时至少确认 SKIP 原因正确）。
- 不要把内网 IP、主机名、真实用户名、共享路径写进源码/文档/测试；`npm run check` 会检查常见泄漏。
- 发布流程见 `RELEASING.md`；版本号需同时更新 `package.json`、`src/core.mjs` 的 `FRAMEWORK_VERSION`、`CHANGELOG.md`。
