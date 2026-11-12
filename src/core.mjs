/**
 * cowork 核心业务逻辑。
 *
 * 供两处复用：
 *  - CLI（src/cli.mjs）：人直接在终端/脚本里用；
 *  - DSH 插件（src/plugin.mjs）：把同样的能力暴露成 cowork_* 工具给 agent 用。
 *
 * 所有函数都返回 { ok, text, data }，text 是给人和模型看的中文摘要。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  branchNameFor,
  boardDir,
  loadGlobalConfig,
  saveGlobalConfig,
  saveRepoConfig,
  shareMetaFile,
  shareRepoPath,
} from './config.mjs'
import {
  addFilesFrom,
  aheadBehind,
  bareRefExists,
  changedFiles,
  cloneRepo,
  commitAll,
  configureIdentity,
  continueSync,
  conflictedFiles,
  currentBranch,
  defaultCommitMessage,
  deleteRemoteBranch,
  ensureTaskBranch,
  fetchRemote,
  git,
  gitVersion,
  headCommit,
  initBareRepo,
  isDirty,
  mergeIntoMain,
  operationInProgress,
  pushBranch,
  recentCommits,
  repoRoot,
  reviewBranch,
  seedBareRepo,
  setRemote,
  syncCurrentBranch,
  toGitUrl,
} from './git.mjs'
import * as boardApi from './board.mjs'
import {
  ensureDir,
  expandPath,
  formatLocalTime,
  localIPv4List,
  nowIso,
  pathExists,
  readJson,
  truncate,
  writeJsonAtomic,
} from './util.mjs'

export const FRAMEWORK_VERSION = '0.2.0'
export const AGENT_RECENT_MS = 5 * 60 * 1000

/** 统一结果包装。 */
function report(ok, text, data = {}) {
  return { ok: Boolean(ok), text, data }
}

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 清洗 agent 身份。身份会进入分支名、成员心跳文件名和插件提示，必须限制字符集。
 * 允许中文等 Unicode 字母，但不允许路径分隔符、Windows 保留名和首尾点/横线。
 */
function sanitizeAgentName(value) {
  const cleaned = String(value ?? '').trim().replace(/\s+/g, '-')
  if (!cleaned) throw new Error('agent 身份不能为空。建议用短英文名，例如 A / B / dev-x。')
  if (/[\\/:*?"<>|]/.test(cleaned)) throw new Error(`agent 身份包含非法字符：${value}`)
  if (cleaned.length > 64) throw new Error('agent 身份过长（最多 64 个字符）。')
  if (/^[.-]|[.-]$/.test(cleaned)) throw new Error('agent 身份不能以点或横线开头/结尾。')
  if (RESERVED_WINDOWS_NAMES.test(cleaned)) throw new Error(`agent 身份不能使用 Windows 保留名：${cleaned}`)
  if (!/^[\p{L}\p{N}._-]+$/u.test(cleaned)) {
    throw new Error(`agent 身份只能包含字母、数字、点、横线和下划线：${value}`)
  }
  return cleaned
}

function normalizeShareRoot(shareRoot) {
  if (!shareRoot || !String(shareRoot).trim()) throw new Error('缺少 --share <共享目录>。例如 \\\\server\\share\\cowork')
  return path.resolve(expandPath(String(shareRoot).trim()))
}

/** 默认本地克隆目录。 */
export function defaultCloneDir(project) {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd()
  return path.join(home, 'cowork', project || 'workspace')
}

/** 生成共享仓库的初始文件。 */
function defaultSeedFiles(project, agent) {
  const agentsMd = `# AGENTS.md — 跨机器协作规则（cowork 框架）

本仓库由多台机器上的 DeepSeek Harness agent 共同维护。共享裸仓库位于局域网共享目录，
每个 agent 在本地克隆里工作，通过分支与共享任务板协作。

## 工作流（必须遵守）

1. 开始工作前：调用 \`cowork_sync\`（或终端 \`cowork sync\`）把本地分支同步到最新 \`origin/main\`。
2. 认领任务：调用 \`cowork_task_claim\`（或 \`cowork task claim <T-0001>\`），它会创建 \`agent/<身份>/<任务号>\` 分支。
3. 修改代码（在本地克隆里，不要直接改共享目录里的文件）。
4. 提交：\`cowork_save\`；推送并交付：\`cowork_publish\`（自动同步 + 推送分支 + 任务置为 review）。
5. 合并同伴的分支：先 \`cowork_review <分支或任务号>\` 看改动，再 \`cowork_merge <分支或任务号>\` 合并进 main。
6. 沟通：\`cowork_send\` 发消息，\`cowork_inbox\` 查收件箱；任务板：\`cowork_task_list\`。

## 约定

- 不要直接修改共享文件夹里的工作文件，只通过 git 分支同步。
- 一条任务一个分支；分支名 \`agent/<身份>/<任务号>\`。
- 冲突时不要强行 merge：先 \`cowork sync\`，按提示解决冲突后 \`cowork sync --continue\`，再 \`cowork_publish\`。
- 提交信息用中文或英文均可，建议格式：\`<任务号>: 做了什么\`。
`
  const readme = `# ${project || 'cowork workspace'}

本仓库由 cowork 框架管理（局域网共享 + git 分支 + 共享任务板）。

- 共享裸仓库：\`<share>/repo.git\`
- 共享任务板：\`<share>/board/board.json\`
- 本地克隆：每个协作者一份，不要在共享目录里直接编辑文件
- 初始化人：${agent}

## 常用命令

\`\`\`powershell
cowork status                 # 当前分支、任务、任务板摘要
cowork task new "标题"         # 新建并认领任务（自动建分支）
cowork save -m "说明"          # 提交本地改动
cowork publish                 # 同步 + 推送分支 + 任务置 review
cowork review agent/B/T-0001   # 查看同伴分支改动
cowork merge agent/B/T-0001    # 合并进 main
cowork send B "消息"           # 给同伴发消息
cowork inbox                   # 收件箱
\`\`\`
`
  return {
    'README.md': readme,
    'AGENTS.md': agentsMd,
    '.gitignore': 'node_modules/\n.cowork/\n*.tmp\n*.log\n',
  }
}

/** 确保本地克隆的 .gitignore 忽略 .cowork/（旧仓库自动补上）。 */
async function ensureLocalIgnore(cloneDir) {
  const file = path.join(cloneDir, '.gitignore')
  let content = ''
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    content = ''
  }
  const lines = content.split(/\r?\n/).map((line) => line.trim())
  if (lines.includes('.cowork/') || lines.includes('.cowork')) return
  const next = `${content}${content && !content.endsWith('\n') ? '\n' : ''}.cowork/\n`
  await fs.writeFile(file, next, 'utf8')
}

/** 读取共享目录元数据；不存在时返回 null。 */
export async function readShareMeta(shareRoot) {
  const fake = { shareRoot, repoDir: 'repo.git', boardDir: 'board' }
  return readJson(shareMetaFile(fake), null)
}

/** 确保本地克隆存在并与共享裸仓库连通。 */
async function ensureCloneReady(config, agent) {
  const root = await repoRoot(config.root)
  if (!root) {
    throw new Error(
      `本地克隆不是 git 仓库：${config.root}\n` +
        '这个目录可能被删除/移动过，或 .git 被清理。重新运行 cowork join --share <共享目录> --agent <身份> --dir <克隆目录>。',
    )
  }
  await setRemote(config.root, config.remote, toGitUrl(shareRepoPath(config)))
  await configureIdentity(config.root, agent)
  await fetchRemote(config.root, config.remote)
  return true
}

/**
 * 初始化共享工作区 + 本地克隆（只在第一台机器执行一次）。
 * @param {{shareRoot:string, agent:string, dir?:string, project?:string, seed?:string[]}} options
 */
export async function initWorkspace(options) {
  const shareRoot = normalizeShareRoot(options.shareRoot)
  const agent = sanitizeAgentName(options.agent)
  const project = String(options.project || path.basename(shareRoot) || 'workspace').trim()
  const cloneDir = path.resolve(options.dir || defaultCloneDir(project))
  const lines = []

  const shareStat = await fs.stat(shareRoot).catch(() => null)
  if (shareStat && !shareStat.isDirectory()) {
    throw new Error(`共享路径已存在但不是目录：${shareRoot}\n请指定一个文件夹（例如 \\\\server\\share\\cowork）。`)
  }
  await ensureDir(shareRoot)
  // 1. 共享目录元数据
  const metaFile = shareMetaFile({ shareRoot })
  let meta = await readJson(metaFile, null)
  if (!meta) {
    meta = {
      formatVersion: 1,
      framework: 'dsh-cowork-framework',
      frameworkVersion: FRAMEWORK_VERSION,
      project,
      repoDir: 'repo.git',
      boardDir: 'board',
      createdAt: nowIso(),
      createdBy: agent,
    }
    await writeJsonAtomic(metaFile, meta)
    lines.push(`已创建共享目录元数据：${metaFile}`)
  } else {
    lines.push(`共享目录已存在（创建人 ${meta.createdBy ?? '?'}，项目 ${meta.project ?? project}）`)
  }

  // 2. 裸仓库
  const bareDir = path.join(shareRoot, meta.repoDir ?? 'repo.git')
  const bareResult = await initBareRepo(bareDir)
  lines.push(bareResult.created ? `已创建裸仓库：${bareDir}` : `复用已有裸仓库：${bareDir}`)

  // 3. main 分支初始提交
  if (!(await bareRefExists(bareDir, 'refs/heads/main'))) {
    await seedBareRepo(bareDir, defaultSeedFiles(project, agent), {
      authorName: `cowork/${agent}`,
      authorEmail: `${agent}@cowork.local`,
      message: 'cowork: 初始化仓库（含 AGENTS.md 协作规则）',
    })
    lines.push('已创建 main 分支初始提交（README.md / AGENTS.md）')
  } else {
    lines.push('main 分支已存在，跳过初始提交')
  }

  // 4. 本地克隆
  let cloned = false
  if (!pathExists(cloneDir)) {
    await cloneRepo(bareDir, cloneDir)
    cloned = true
    lines.push(`已克隆到本地：${cloneDir}`)
  } else {
    const stat = await fs.stat(cloneDir)
    if (!stat.isDirectory()) throw new Error(`本地克隆路径已存在但不是目录：${cloneDir}`)
    const entries = await fs.readdir(cloneDir)
    const hasGit = await pathExists(path.join(cloneDir, '.git'))
    if (!hasGit && entries.length > 0) {
      throw new Error(`目录已存在且非空、又不是 git 克隆：${cloneDir}\n换一个 --dir，或先把该目录清空。`)
    }
    if (!hasGit) {
      await cloneRepo(bareDir, cloneDir)
      cloned = true
      lines.push(`已克隆到本地：${cloneDir}`)
    } else {
      lines.push(`复用已有本地克隆：${cloneDir}`)
    }
  }

  // 5. 写仓库配置 + git 身份
  const config = {
    formatVersion: 1,
    agent,
    shareRoot,
    repoDir: meta.repoDir ?? 'repo.git',
    boardDir: meta.boardDir ?? 'board',
    remote: 'origin',
    mainBranch: 'main',
    branchPrefix: 'agent',
    project,
    createdAt: nowIso(),
    root: cloneDir,
  }
  await saveRepoConfig(cloneDir, config)
  await configureIdentity(cloneDir, agent)
  await ensureLocalIgnore(cloneDir)
  // 刚克隆时按本仓库规范（autocrlf=false）重建一次工作区，避免全局 CRLF 设置导致的“假脏”。
  if (cloned) await git(['reset', '--hard'], { cwd: cloneDir, allowFail: true })
  lines.push(`已写入仓库配置：${path.join(cloneDir, '.cowork', 'config.json')}`)

  // 6. 任务板 + 成员心跳
  await boardApi.mutateBoard(config, (board) => {
    if (!board.project) board.project = project
    return null
  })
  await boardApi.touchMember(config, { branch: await currentBranch(cloneDir), role: 'init' })

  // 7. 全局配置
  await saveGlobalConfig({ agent, repoPath: cloneDir, shareRoot })

  lines.push('')
  lines.push('初始化完成。下一步：')
  lines.push(`  cd "${cloneDir}"`)
  lines.push('  cowork status          # 检查环境')
  lines.push('  cowork task new "第一个任务"   # 立刻开始干活')
  lines.push('')
  lines.push('另一台机器上执行（把 <共享目录> 换成本机可见的同一路径）：')
  lines.push(`  cowork join --share "${shareRoot}" --agent <对方身份> --dir <对方本地克隆目录>`)
  return report(true, lines.join('\n'), { shareRoot, cloneDir, project, agent, cloned })
}

/**
 * 加入已有共享工作区（第二台及以后的机器）。
 */
export async function joinWorkspace(options) {
  const shareRoot = normalizeShareRoot(options.shareRoot)
  const agent = sanitizeAgentName(options.agent)
  const meta = await readShareMeta(shareRoot)
  if (!meta) {
    throw new Error(`共享目录不是 cowork 工作区（缺少 cowork.json）：${shareRoot}\n请先在另一台机器上运行 cowork init。`)
  }
  const project = meta.project || path.basename(shareRoot) || 'workspace'
  const cloneDir = path.resolve(options.dir || defaultCloneDir(project))
  const bareDir = path.join(shareRoot, meta.repoDir ?? 'repo.git')
  const lines = []
  let cloned = false

  if (!(await bareRefExists(bareDir, 'refs/heads/main'))) {
    throw new Error(`共享裸仓库里没有 main 分支：${bareDir}`)
  }
  if (!pathExists(cloneDir)) {
    await cloneRepo(bareDir, cloneDir)
    cloned = true
    lines.push(`已克隆共享仓库到本地：${cloneDir}`)
  } else {
    const entries = await fs.readdir(cloneDir)
    const hasGit = await pathExists(path.join(cloneDir, '.git'))
    if (!hasGit && entries.length > 0) {
      throw new Error(`目录已存在且非空、又不是 git 克隆：${cloneDir}\n换一个 --dir。`)
    }
    if (!hasGit) {
      await cloneRepo(bareDir, cloneDir)
      cloned = true
      lines.push(`已克隆共享仓库到本地：${cloneDir}`)
    } else {
      lines.push(`复用已有本地克隆：${cloneDir}`)
    }
  }

  const config = {
    formatVersion: 1,
    agent,
    shareRoot,
    repoDir: meta.repoDir ?? 'repo.git',
    boardDir: meta.boardDir ?? 'board',
    remote: 'origin',
    mainBranch: 'main',
    branchPrefix: 'agent',
    project,
    createdAt: nowIso(),
    root: cloneDir,
    joinedAt: nowIso(),
  }
  await saveRepoConfig(cloneDir, config)
  await configureIdentity(cloneDir, agent)
  await ensureLocalIgnore(cloneDir)
  if (cloned) await git(['reset', '--hard'], { cwd: cloneDir, allowFail: true })
  await ensureCloneReady(config, agent)
  // 共享目录里可能只保留了 cowork.json/repo.git（board 被误删）：join 时补建任务板。
  await boardApi.mutateBoard(config, (board) => {
    if (!board.project) board.project = project
    return null
  })
  await boardApi.touchMember(config, { branch: await currentBranch(cloneDir), role: 'join' })
  await saveGlobalConfig({ agent, repoPath: cloneDir, shareRoot })

  lines.push(`身份: ${agent}`, `共享: ${shareRoot}`, `本地: ${cloneDir}`)
  lines.push('')
  lines.push('加入完成。下一步：')
  lines.push(`  cd "${cloneDir}"`)
  lines.push('  cowork status')
  lines.push('  cowork task list --open     # 看有没有待认领任务')
  return report(true, lines.join('\n'), { shareRoot, cloneDir, project, agent })
}

/** 读取当前分支状态（供 status/doctor 复用）。 */
async function collectGitState(config, { fetch = true } = {}) {
  const root = await repoRoot(config.root)
  if (!root) {
    throw new Error(
      `本地克隆不是 git 仓库：${config.root}\n` +
        '这个目录可能被删除/移动过，或 .git 被清理。重新运行 cowork join --share <共享目录> --agent <身份> --dir <克隆目录>。',
    )
  }
  const result = {
    branch: null,
    clean: true,
    changed: [],
    operation: null,
    conflicts: [],
    ahead: 0,
    behind: 0,
    head: null,
    recent: [],
    fetchOk: null,
    gitVersion: null,
  }
  result.gitVersion = await gitVersion()
  if (fetch) {
    const fetched = await fetchRemote(config.root, config.remote)
    result.fetchOk = fetched.ok
  }
  result.branch = await currentBranch(config.root)
  result.clean = !(await isDirty(config.root))
  result.operation = await operationInProgress(config.root)
  result.conflicts = await conflictedFiles(config.root)
  result.changed = await changedFiles(config.root)
  result.head = await headCommit(config.root)
  result.recent = await recentCommits(config.root, 5)
  const upstream = `${config.remote}/${config.mainBranch}`
  const ab = await aheadBehind(config.root, upstream)
  result.ahead = ab.ahead
  result.behind = ab.behind
  return result
}

/** 状态总览。 */
export async function status(config, agent, options = {}) {
  const gitState = await collectGitState(config, { fetch: options.fetch !== false })
  const lines = []
  const shareAccess = await boardApi.probeShare(config).catch((error) => ({
    ok: false,
    message: error.message,
  }))
  let summary = null
  let boardError = null
  try {
    const board = await boardApi.readBoard(config)
    summary = boardApi.summarizeBoard(board, agent)
  } catch (error) {
    boardError = error.message
  }

  lines.push('cowork 状态')
  lines.push(`  身份      ${agent}`)
  lines.push(`  共享目录  ${config.shareRoot}${shareAccess.ok ? '  [可访问]' : '  [不可访问]'}`)
  lines.push(`  本地克隆  ${config.root}`)
  lines.push(`  当前分支  ${gitState.branch ?? '(分离 HEAD)'}${gitState.head ? ` @ ${gitState.head}` : ''}`)
  let workState = '干净'
  if (gitState.operation === 'rebase') workState = 'rebase 进行中（解决冲突后 cowork sync --continue）'
  else if (gitState.operation === 'merge') workState = 'merge 进行中'
  else if (!gitState.clean) workState = `有 ${gitState.changed.length} 个未提交改动`
  if (gitState.conflicts.length > 0) workState += `，冲突 ${gitState.conflicts.length} 个文件`
  lines.push(`  工作区    ${workState}`)
  lines.push(`  相对 ${config.remote}/${config.mainBranch}  领先 ${gitState.ahead}，落后 ${gitState.behind}${gitState.fetchOk === false ? '（fetch 失败，数据可能过期）' : ''}`)

  let currentTask = null
  if (summary) {
    currentTask = summary.mine.find((task) => task.branch && task.branch === gitState.branch) ?? null
    lines.push('')
    lines.push('任务板')
    lines.push(
      `  共 ${summary.total} 个任务：待认领 ${summary.counts.open} / 进行中 ${summary.counts.working} / 待合并 ${summary.counts.review} / 已完成 ${summary.counts.done} / 受阻 ${summary.counts.blocked}`,
    )
    lines.push(`  未读消息：${summary.unread}`)
    if (currentTask) {
      lines.push(`  当前分支任务：${currentTask.id} ${currentTask.title}（${boardApi.TASK_STATUS_LABELS[currentTask.status] ?? currentTask.status}）`)
    }
    const mine = summary.mine.filter((task) => task.id !== currentTask?.id)
    if (mine.length > 0) {
      lines.push('  我的其他任务：')
      for (const task of mine.slice(0, 5)) {
        lines.push(`    ${task.id}  ${truncate(task.title, 50)}  [${boardApi.TASK_STATUS_LABELS[task.status] ?? task.status}]${task.branch ? `  ${task.branch}` : ''}`)
      }
    }
  } else {
    lines.push('')
    lines.push(`任务板不可读：${boardError}`)
    lines.push('  → 这是错误状态，不是“没有任务”。按上面的原因处理（共享/初始化）后重试。')
  }

  const members = await boardApi.listMembers(config).catch(() => [])
  if (members.length > 0) {
    lines.push('')
    lines.push('协作者')
    for (const member of members) {
      const online = Date.now() - new Date(member.lastSeen).getTime() < AGENT_RECENT_MS
      const self = member.agent === agent ? '（本机）' : ''
      lines.push(`  ${member.agent}${self}  ${online ? '在线' : formatLocalTime(member.lastSeen)}  ${member.branch ?? ''}`)
    }
  }
  if (gitState.recent.length > 0) {
    lines.push('')
    lines.push('最近提交')
    for (const commit of gitState.recent) lines.push(`  ${commit}`)
  }
  const ok = !boardError && shareAccess.ok
  return report(ok, lines.join('\n'), {
    agent,
    root: config.root,
    shareRoot: config.shareRoot,
    remote: config.remote,
    mainBranch: config.mainBranch,
    git: gitState,
    board: summary,
    members,
    shareAccess,
  })
}

/** 同步当前分支（fetch + rebase 到 origin/main）。 */
export async function sync(config, agent, options = {}) {
  const action = options.action ?? 'start'
  if (action === 'continue' || action === 'abort') {
    const operation = await operationInProgress(config.root)
    if (operation !== 'rebase') {
      return report(
        false,
        `当前没有进行中的 rebase（${operation ? `实际进行中：${operation}` : '工作区干净'}），不需要 --${action}。\n` +
          '用 cowork sync（不带参数）开始一次同步。',
      )
    }
    const result = await continueSync(config.root, action)
    if (action === 'abort') {
      return report(result.ok, result.ok ? '已放弃本次 rebase，工作区恢复到同步前状态。' : `放弃失败：${result.output}`, result)
    }
    if (result.ok) {
      const head = await headCommit(config.root)
      return report(true, `rebase 已继续并完成当前提交（HEAD ${head}）。如还有后续冲突，重复 cowork sync --continue。`, result)
    }
    const lines = ['仍存在冲突，继续解决后再次 cowork sync --continue：']
    for (const file of result.conflicts ?? []) lines.push(`  - ${file}`)
    return report(false, lines.join('\n'), result)
  }

  const result = await syncCurrentBranch(config.root, { remote: config.remote, mainBranch: config.mainBranch })
  await boardApi.touchMember(config, { branch: await currentBranch(config.root) }).catch(() => {})
  if (!result.ok) {
    if (result.stage === 'conflict') {
      const lines = [
        `同步失败：与 ${config.remote}/${config.mainBranch} 冲突，rebase 已暂停。`,
        '冲突文件：',
        ...result.conflicts.map((file) => `  - ${file}`),
        '',
        '处理方式：',
        '  1) 打开冲突文件，解决冲突标记（<<<<<<< ======= >>>>>>>）',
        '  2) git add <文件>（或直接 cowork save 之前先 git add）',
        '  3) cowork sync --continue',
        '  4) 放弃本次同步：cowork sync --abort',
      ]
      return report(false, lines.join('\n'), result)
    }
    return report(false, `同步失败：${result.message}`, result)
  }
  const branch = result.branch
  const ab = await aheadBehind(config.root, `${config.remote}/${config.mainBranch}`)
  return report(
    true,
    `同步完成：${branch} 已${result.action === 'rebase' ? ' rebase 到' : '快进到'}最新 ${config.remote}/${config.mainBranch}（领先 ${ab.ahead}，落后 ${ab.behind}）。`,
    { ...result, ...ab },
  )
}

/** 提交本地改动。 */
export async function save(config, agent, options = {}) {
  const operation = await operationInProgress(config.root)
  if (operation) {
    return report(
      false,
      `当前有 ${operation} 进行中，不能直接提交。\n` +
        (operation === 'rebase' ? '先解决冲突并 cowork sync --continue，或 cowork sync --abort。' : '先完成或中止当前操作。'),
    )
  }
  const message = String(options.message || '').trim() || defaultCommitMessage(agent)
  const result = await commitAll(config.root, message, { name: `cowork/${agent}`, email: `${agent}@cowork.local` })
  await boardApi.touchMember(config, { branch: await currentBranch(config.root) }).catch(() => {})
  if (!result.committed) return report(true, '没有需要提交的改动（工作区干净）。', result)
  return report(true, `已提交 ${result.commit}：${truncate(message, 80)}`, result)
}

/** 发布：保存改动 + 同步 + 推送分支 + 任务置 review。 */
export async function publish(config, agent, options = {}) {
  const lines = []
  const branch = await currentBranch(config.root)
  if (!branch) return report(false, '当前处于分离 HEAD 状态，先 checkout 一个分支。')
  if (branch === config.mainBranch) {
    return report(
      false,
      `当前在 ${config.mainBranch} 分支上。请先 cowork task new/claim 创建任务分支再发布；` +
        '如果要直接更新 main（例如初始化导入），用 cowork sync 后 git push，或使用 cowork import。',
    )
  }
  const dirty = await isDirty(config.root)
  if (dirty) {
    const saveResult = await save(config, agent, { message: options.message })
    lines.push(saveResult.text)
    if (!saveResult.ok) return report(false, lines.join('\n'))
  }
  const syncResult = await sync(config, agent)
  if (!syncResult.ok) {
    return report(false, `发布前同步失败，已停止推送。\n${syncResult.text}`)
  }
  lines.push(syncResult.text)
  const isTaskBranch = branch.startsWith(`${config.branchPrefix ?? 'agent'}/`)
  const push = await pushBranch(config.root, config.remote, branch, { autoForce: isTaskBranch })
  if (!push.ok) return report(false, push.message, push)
  lines.push(
    push.rewritten
      ? `已推送分支（rebase 重写过历史，使用 --force-with-lease 更新）：${branch} → ${config.remote}/${branch}`
      : `已推送分支：${branch} → ${config.remote}/${branch}`,
  )

  const task = await findTaskByBranch(config, branch).catch(() => null)
  if (task) {
    try {
      const updated = await boardApi.updateTask(config, task.id, {
        status: 'review',
        branch,
        note: `已推送分支 ${branch}`,
        by: agent,
      })
      lines.push(`任务 ${updated.id} 已置为「待合并」（review）。`)
    } catch (error) {
      lines.push(`任务状态更新失败（分支已推送）：${error.message}`)
    }
  } else {
    lines.push('提示：当前分支没有关联任务，建议用 cowork task new 创建任务后再发布。')
  }
  const head = await headCommit(config.root)
  return report(true, lines.join('\n'), { branch, head, task })
}

/** 找出与分支关联的任务。 */
async function findTaskByBranch(config, branch) {
  const tasks = await boardApi.listTasks(config, { all: true })
  return tasks.find((task) => task.branch === branch) ?? null
}

/** 把 target（任务号或分支名）解析为分支名。 */
async function resolveTargetBranch(config, agent, target) {
  const value = String(target ?? '').trim()
  if (!value) {
    const branch = await currentBranch(config.root)
    if (!branch) throw new Error('没有指定目标分支，且当前处于分离 HEAD。')
    return { branch, task: await findTaskByBranch(config, branch) }
  }
  if (/^T-\d+$/i.test(value)) {
    const task = await boardApi.getTask(config, value.toUpperCase())
    if (!task) throw new Error(`任务不存在：${value}`)
    if (!task.branch) throw new Error(`任务 ${value} 还没有关联分支（尚未认领/推送）。`)
    return { branch: task.branch, task }
  }
  return { branch: value, task: await findTaskByBranch(config, value) }
}

/** 查看同伴分支（提交、改动统计、潜在冲突）。 */
export async function review(config, agent, target) {
  const resolved = await resolveTargetBranch(config, agent, target)
  await ensureCloneReady(config, agent)
  const result = await reviewBranch(config.root, {
    remote: config.remote,
    mainBranch: config.mainBranch,
    branch: resolved.branch,
  })
  if (!result.ok) return report(false, result.message, result)
  const lines = [`分支 ${result.branch}（相对 ${config.remote}/${config.mainBranch}）`]
  lines.push('')
  lines.push(`提交（${result.commits.length}）：`)
  if (result.commits.length === 0) lines.push('  （没有新提交）')
  else for (const commit of result.commits) lines.push(`  ${commit}`)
  lines.push('')
  lines.push('改动统计：')
  lines.push(result.stat ? result.stat.split('\n').map((line) => `  ${line}`).join('\n') : '  （无改动）')
  if (result.potentialConflicts) {
    lines.push('')
    lines.push('⚠ 该分支与当前 main 可能存在合并冲突，合并前建议让作者先 cowork sync 并 rebase。')
  }
  if (resolved.task) {
    lines.push('')
    lines.push(`关联任务：${resolved.task.id} ${resolved.task.title}（${boardApi.TASK_STATUS_LABELS[resolved.task.status] ?? resolved.task.status}，负责人 ${resolved.task.owner ?? '-'}）`)
  }
  return report(true, lines.join('\n'), result)
}

/** 合并分支进 main 并推送，任务置 done。 */
export async function merge(config, agent, target, options = {}) {
  const resolved = await resolveTargetBranch(config, agent, target)
  if (resolved.branch === config.mainBranch) return report(false, '不能把 main 合并到 main。')
  await ensureCloneReady(config, agent)
  const result = await mergeIntoMain(config.root, {
    remote: config.remote,
    mainBranch: config.mainBranch,
    branch: resolved.branch,
  })
  if (!result.ok) {
    return report(false, `合并失败：\n${result.message}`, result)
  }
  const lines = [`已合并 ${resolved.branch} → ${config.mainBranch}（${result.commit}）并推送共享仓库。`]
  if (resolved.task) {
    try {
      await boardApi.updateTask(config, resolved.task.id, {
        status: 'done',
        note: `已合并到 ${config.mainBranch}（${result.commit}）`,
        by: agent,
      })
      lines.push(`任务 ${resolved.task.id} 已标记为完成。`)
    } catch (error) {
      lines.push(`任务状态更新失败：${error.message}`)
    }
  }
  if (!options.keepBranch) {
    const deletion = await deleteRemoteBranch(config.root, config.remote, resolved.branch)
    lines.push(deletion.ok ? `已删除远程分支 ${resolved.branch}。` : `远程分支删除失败（可手动删除）：${deletion.stderr || deletion.stdout}`)
  }
  const ab = await aheadBehind(config.root, `${config.remote}/${config.mainBranch}`)
  lines.push(`当前 main 与远程一致（领先 ${ab.ahead}，落后 ${ab.behind}）。`)
  return report(true, lines.join('\n'), { ...result, branch: resolved.branch, task: resolved.task })
}

/** 新建任务；默认立即认领并创建分支。assignee 指定给别人时只创建任务并通知对方。 */
export async function taskCreate(config, agent, input) {
  const assignee = input.assignee ? sanitizeAgentName(input.assignee) : null
  const task = await boardApi.createTask(config, {
    title: input.title,
    description: input.description ?? '',
    files: input.files ?? [],
    tags: input.tags ?? [],
    priority: input.priority ?? 'normal',
    assignee,
  })
  const lines = [`已创建任务 ${task.id}：${task.title}`]
  if (assignee && assignee !== agent) {
    await boardApi.addMessage(config, {
      from: agent,
      to: assignee,
      subject: `新任务 ${task.id}：${truncate(task.title, 60)}`,
      body: `请认领任务 ${task.id}。\n${task.description || ''}\n认领：cowork task claim ${task.id}（或让 agent 调用 cowork_task_claim）。`,
      taskId: task.id,
    })
    lines.push(`已指派给 ${assignee} 并发送通知消息。`)
    await boardApi.touchMember(config, {}).catch(() => {})
    return report(true, lines.join('\n'), { task })
  }
  // 自己认领 + 建分支
  const claimResult = await taskClaim(config, agent, task.id, { silent: true })
  lines.push(claimResult.text)
  if (claimResult.ok) {
    task.status = 'working'
    task.owner = agent
    task.branch = claimResult.data.branch
  } else {
    // 建分支失败（例如同一克隆上有并发 git 操作）时把任务留在 open，并标注原因，方便稍后重试或交给同伴。
    try {
      await boardApi.updateTask(config, task.id, {
        status: 'open',
        note: `自动认领失败：${truncate(claimResult.text, 120)}`,
        by: agent,
      })
    } catch {
      // 标注失败不影响任务本身
    }
    lines.push(`任务已创建但自动认领失败，稍后处理掉阻碍后重试：cowork task claim ${task.id}`)
    lines.push('（提示：同一个本地克隆上不要同时跑多个会写 git 的命令，会争抢 .git/index.lock）')
  }
  return report(claimResult.ok, lines.join('\n'), { task, claim: claimResult.data })
}

/** 认领任务：fetch、建/切分支、更新任务板。 */
export async function taskClaim(config, agent, taskId, options = {}) {
  const task = await boardApi.getTask(config, taskId)
  if (!task) return report(false, `任务不存在：${taskId}`)
  if (task.owner && task.owner !== agent && task.status !== 'open') {
    return report(false, `任务 ${taskId} 已被 ${task.owner} 认领（状态 ${task.status}）。`)
  }
  if (task.assignee && task.assignee !== agent && task.owner !== agent && !options.force) {
    return report(
      false,
      `任务 ${taskId} 已指派给 ${task.assignee}。\n` +
        `如确认要接管，使用 cowork task claim ${taskId} --force（插件工具传 force=true）。`,
    )
  }
  const branch = task.branch ?? branchNameFor(config, agent, task.id)
  const fetched = await fetchRemote(config.root, config.remote)
  if (!fetched.ok) return report(false, `连接共享仓库失败：${fetched.stderr || fetched.stdout}`)
  if (await isDirty(config.root)) {
    return report(false, '当前工作区有未提交改动，先 cowork save 或处理掉再认领新任务。')
  }
  const result = await ensureTaskBranch(config.root, branch, `${config.remote}/${config.mainBranch}`).catch((error) => {
    throw new Error(
      `创建/切换任务分支失败：${error.message}\n` +
        '常见原因：同一个本地克隆上同时跑了多个 git 操作（.git/index.lock 冲突），或共享目录/磁盘异常。\n' +
        '处理：稍后重试；如果分支已存在会直接切换。任务不会被认领，可再次 cowork task claim ' +
        taskId,
    )
  })
  try {
    await boardApi.claimTask(config, task.id, { agent, branch, force: Boolean(options.force) })
  } catch (error) {
    // 分支已经切过去了但任务被别人抢走：保留分支（可能已有改动），给出明确恢复动作。
    throw new Error(
      `任务认领失败：${error.message}\n` +
        `本地已切换到分支 ${branch}；如果这个任务确实不该由你做，执行 git checkout ${config.mainBranch} 回到 main。`,
    )
  }
  await boardApi.touchMember(config, { branch, taskId: task.id }).catch(() => {})
  const lines = [`已认领任务 ${task.id}：${task.title}${options.force ? '（强制接管）' : ''}`]
  lines.push(result.created ? `已从 ${config.remote}/${config.mainBranch} 创建分支：${branch}` : `已切换到已有分支：${branch}`)
  lines.push(`下一步：改代码 → cowork save -m "..." → cowork publish`)
  return report(true, lines.join('\n'), { task: { ...task, branch }, branch })
}

/** 更新任务（状态/备注/指派）。 */
export async function taskUpdate(config, agent, taskId, patch = {}) {
  const task = await boardApi.updateTask(config, taskId, { ...patch, by: agent })
  const lines = [`任务 ${task.id} 已更新：${boardApi.TASK_STATUS_LABELS[task.status] ?? task.status}`]
  if (patch.note) lines.push(`备注：${patch.note}`)
  return report(true, lines.join('\n'), { task })
}

/** 任务列表。 */
export async function taskList(config, agent, options = {}) {
  const tasks = await boardApi.listTasks(config, {
    agent,
    status: options.status ?? null,
    mine: Boolean(options.mine),
    all: Boolean(options.all ?? (!options.status && !options.mine)),
  })
  tasks.sort((left, right) => String(left.id).localeCompare(String(right.id), 'en', { numeric: true }))
  const lines = []
  const label = options.status
    ? `状态 ${options.status}`
    : options.mine
      ? `我的任务（${agent}）`
      : '全部'
  lines.push(`任务（${label}）：共 ${tasks.length} 个`)
  for (const task of tasks) {
    const owner = task.owner ? `@${task.owner}` : task.assignee ? `指派:${task.assignee}` : '未认领'
    lines.push(
      `  ${task.id}  [${boardApi.TASK_STATUS_LABELS[task.status] ?? task.status}]  ${truncate(task.title, 56)}  ${owner}${task.branch ? `  ${task.branch}` : ''}`,
    )
  }
  if (tasks.length === 0) lines.push('  （空）')
  return report(true, lines.join('\n'), { tasks })
}

/** 任务详情。 */
export async function taskShow(config, agent, taskId) {
  const task = await boardApi.getTask(config, taskId)
  if (!task) return report(false, `任务不存在：${taskId}`)
  const lines = [
    `任务 ${task.id}：${task.title}`,
    `状态：${boardApi.TASK_STATUS_LABELS[task.status] ?? task.status}    负责人：${task.owner ?? '-'}    指派：${task.assignee ?? '-'}`,
    `分支：${task.branch ?? '-'}`,
    `创建：${formatLocalTime(task.createdAt)} by ${task.createdBy}`,
  ]
  if (task.description) lines.push('', '描述：', task.description)
  if (task.files?.length) lines.push(`涉及文件：${task.files.join(', ')}`)
  if (task.notes?.length) {
    lines.push('', '备注：')
    for (const note of task.notes) lines.push(`  ${formatLocalTime(note.at)} ${note.by}：${note.text}`)
  }
  return report(true, lines.join('\n'), { task })
}

/** 发消息给同伴（或 all）。 */
export async function sendMessage(config, agent, input) {
  const message = await boardApi.addMessage(config, {
    from: agent,
    to: input.to || 'all',
    subject: input.subject ?? '',
    body: input.body ?? input.message ?? '',
    taskId: input.taskId ?? null,
  })
  await boardApi.touchMember(config, {}).catch(() => {})
  return report(
    true,
    `已发送消息 ${message.id} → ${message.to}：${message.subject}`,
    { message },
  )
}

/** 收件箱。 */
export async function inbox(config, agent, options = {}) {
  const messages = await boardApi.readInbox(config, {
    agent,
    all: Boolean(options.all),
    limit: options.limit ?? 20,
  })
  if (options.markRead && messages.length > 0) {
    await boardApi.markMessagesRead(config, agent, messages.filter((message) => message.unread).map((message) => message.id))
    for (const message of messages) message.unread = false
  }
  const lines = []
  if (messages.length === 0) {
    lines.push('收件箱为空。')
  } else {
    lines.push(`收件箱（${messages.length} 条${options.all ? '，含全部方向' : ''}）：`)
    for (const message of messages) {
      lines.push(
        `  ${message.unread ? '●' : ' '} ${message.id}  ${formatLocalTime(message.at)}  ${message.from} → ${message.to}${message.taskId ? `  [${message.taskId}]` : ''}`,
      )
      lines.push(`      ${truncate(message.subject, 80)}`)
      if (message.body) {
        const bodyLines = String(message.body).split('\n').slice(0, 5)
        for (const line of bodyLines) lines.push(`      ${line}`)
        if (String(message.body).split('\n').length > 5) lines.push('      …')
      }
    }
    if (!options.markRead && messages.some((message) => message.unread)) {
      lines.push('')
      lines.push('（用 cowork inbox --mark-read 或 cowork_inbox markRead=true 标记已读）')
    }
  }
  return report(true, lines.join('\n'), { messages })
}

/** 成员列表。 */
export async function members(config, agent) {
  const list = await boardApi.listMembers(config)
  const lines = [`协作者（${list.length}）：`]
  for (const member of list) {
    const online = Date.now() - new Date(member.lastSeen).getTime() < AGENT_RECENT_MS
    lines.push(
      `  ${member.agent}${member.agent === agent ? '（本机）' : ''}  ${online ? '在线' : '离线'}  最后活动 ${formatLocalTime(member.lastSeen)}  分支 ${member.branch ?? '-'}  ${(member.ips ?? []).join(', ')}`,
    )
  }
  if (list.length === 0) lines.push('  （暂无心跳记录）')
  return report(true, lines.join('\n'), { members: list })
}

/** 把旧共享目录里的项目文件导入到 main（从直接共享迁移用）。 */
export async function importFiles(config, agent, sourceDir, options = {}) {
  const source = path.resolve(sourceDir)
  const stat = await fs.stat(source).catch(() => null)
  if (!stat?.isDirectory()) return report(false, `源目录不存在或不是目录：${source}`)
  if (source === config.root) return report(false, '源目录不能是本地克隆本身。')
  if (source === path.resolve(config.shareRoot)) {
    return report(false, '源目录是 cowork 共享根目录，拒绝导入（会把仓库自身复制进来）。请指定具体的项目目录。')
  }
  const branch = await currentBranch(config.root)
  if (branch !== config.mainBranch) {
    return report(false, `导入只能在 ${config.mainBranch} 分支上做（当前 ${branch}）。先 git checkout ${config.mainBranch}。`)
  }
  const dirty = await isDirty(config.root)
  if (dirty) return report(false, '工作区有未提交改动，先 cowork save 或处理掉再导入。')
  const copied = await addFilesFrom(config.root, source, {
    overwrite: options.overwrite !== false,
    skip: ['.git', '.cowork', 'repo.git', 'board', 'cowork.json', 'dist'],
  })
  const message = String(options.message || '').trim() || `cowork: 从 ${source} 导入初始文件`
  const result = await commitAll(config.root, message, { name: `cowork/${agent}`, email: `${agent}@cowork.local` })
  if (!result.committed) return report(true, '没有检测到新文件（内容与仓库一致）。', { copied })
  const fetch = await fetchRemote(config.root, config.remote)
  if (!fetch.ok) return report(false, `已提交但 fetch 失败：${fetch.stderr || fetch.stdout}`)
  const rebase = await git(['rebase', `${config.remote}/${config.mainBranch}`], {
    cwd: config.root,
    allowFail: true,
  })
  if (!rebase.ok) {
    await git(['rebase', '--abort'], { cwd: config.root, allowFail: true })
    return report(false, 'main 已有新提交且导入冲突，已回滚。先 cowork sync 再重试。')
  }
  const push = await pushBranch(config.root, config.remote, config.mainBranch)
  if (!push.ok) return report(false, `推送失败：${push.message}`)
  return report(
    true,
    `已导入 ${copied.length} 个顶层条目并提交（${result.commit}），已推送到 ${config.remote}/${config.mainBranch}。`,
    { copied, commit: result.commit },
  )
}

/** 环境自检。 */
export async function doctor(config, agent) {
  const checks = []
  const add = (name, ok, detail, hint = '') => checks.push({ name, ok, detail, hint })
  const nodeVersion = process.version
  add('Node.js', Number(process.versions.node.split('.')[0]) >= 20, `版本 ${nodeVersion}`)
  const gitVer = await gitVersion()
  add('git', Boolean(gitVer), gitVer ? `版本 ${gitVer}` : '未找到 git，请安装 Git for Windows 并加入 PATH', 'winget install Git.Git')
  add('身份 agent', Boolean(agent), agent ? `本机身份 ${agent}` : '未配置身份', 'cowork join/init 时用 --agent 指定')
  add('仓库配置', true, config.root)
  add('共享目录', pathExists(config.shareRoot), config.shareRoot, '确认共享路径可访问、凭据可用')
  const shareProbe = await boardApi.probeShare(config)
  add('共享读写', shareProbe.ok, shareProbe.message)
  const bareDir = shareRepoPath(config)
  add('共享裸仓库', pathExists(bareDir), bareDir)
  add('main 分支', await bareRefExists(bareDir, 'refs/heads/main'), `${config.remote}/${config.mainBranch}`)
  let boardOk = false
  try {
    const board = await boardApi.readBoard(config)
    boardOk = true
    add('任务板', true, `共 ${Object.keys(board.tasks ?? {}).length} 个任务、${(board.messages ?? []).length} 条消息${board.__recoveredFromBackup ? '（已从备份恢复，建议检查）' : ''}`)
  } catch (error) {
    add('任务板', false, error.message)
  }
  const root = await repoRoot(config.root)
  add('本地 git 仓库', Boolean(root), root ?? '不是 git 仓库')
  const branch = await currentBranch(config.root)
  add('当前分支', Boolean(branch), branch ?? '分离 HEAD')
  const operation = await operationInProgress(config.root)
  add('进行中的 git 操作', operation === null, operation ?? '无')
  const dirty = await isDirty(config.root)
  add('工作区干净', !dirty, dirty ? '有未提交改动' : '干净', 'cowork save 提交改动，或 git stash')
  const remoteResult = await git(['remote', 'get-url', config.remote], {
    cwd: config.root,
    allowFail: true,
  })
  const expected = toGitUrl(shareRepoPath(config))
  add(
    '远程地址',
    remoteResult.ok && remoteResult.stdout.trim() === expected,
    remoteResult.ok ? remoteResult.stdout.trim() : '未配置远程',
    `cowork 会自动修复；可运行 git remote set-url ${config.remote} "${expected}"`,
  )
  const lockFile = path.join(boardDir(config), '.board.lock')
  if (pathExists(lockFile)) {
    const lockStat = await fs.stat(lockFile).catch(() => null)
    const age = lockStat ? Date.now() - lockStat.mtimeMs : 0
    add('任务板锁', age > 45000, age > 45000 ? `锁已过期 ${Math.round(age / 1000)} 秒，下次写入会自动清理` : `锁被占用 ${Math.round(age / 1000)} 秒（另一台机器正在写入？）`)
  }
  const members = await boardApi.listMembers(config).catch(() => [])
  add('协作者心跳', members.length > 0, members.map((member) => member.agent).join(', ') || '无')
  const localIps = localIPv4List()
  add('本机 IP', localIps.length > 0, localIps.join(', ') || '未检测到')

  const lines = ['cowork 自检：']
  for (const check of checks) {
    lines.push(`  ${check.ok ? '✔' : '✘'} ${check.name}：${check.detail}${!check.ok && check.hint ? `（${check.hint}）` : ''}`)
  }
  const failed = checks.filter((check) => !check.ok)
  lines.push('')
  lines.push(failed.length === 0 ? '全部检查通过。' : `${failed.length} 项需要处理，见上面 ✘ 项。`)
  return report(failed.length === 0, lines.join('\n'), { checks })
}

/** 共享目录里的裸仓库地址（给 CLI 打印用）。 */
export function remoteDescription(config) {
  return `${config.remote} = ${toGitUrl(shareRepoPath(config))}`
}

export { shareMetaFile }
