/**
 * git 封装：全部通过子进程调用系统 git（>=2.30 即可），不依赖任何 npm 包。
 *
 * 远程仓库放在共享目录的裸仓库里（repo.git）。Windows 上把本地路径/UNC 路径
 * 转成 git 能稳定识别的 URL 形式（//server/share/... 或 D:/path/...）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ensureDir, nowIso } from './util.mjs'

const execFileAsync = promisify(execFile)

/** git 执行失败。 */
export class GitError extends Error {
  constructor(args, result) {
    const detail = (result.stderr || result.stdout || '').trim()
    super(`git ${args.join(' ')} 失败（退出码 ${result.code}）${detail ? `：${detail}` : ''}`)
    this.name = 'GitError'
    this.args = args
    this.result = result
  }
}

/**
 * 执行 git 命令。
 * @param {string[]} args 参数数组（不经过 shell，避免引号问题）。
 * @param {{cwd?:string, allowFail?:boolean, timeout?:number, env?:object}} options
 */
export async function git(args, options = {}) {
  const { cwd, allowFail = false, timeout = 180000, env = {} } = options
  const mergedEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: 'echo',
    ...env,
  }
  try {
    const completed = await execFileAsync('git', args, {
      cwd,
      timeout,
      env: mergedEnv,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    return {
      ok: true,
      code: 0,
      stdout: String(completed.stdout ?? '').replace(/\r\n/g, '\n').trimEnd(),
      stderr: String(completed.stderr ?? '').replace(/\r\n/g, '\n').trimEnd(),
    }
  } catch (error) {
    const result = {
      ok: false,
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? '').replace(/\r\n/g, '\n').trimEnd(),
      stderr: String(error.stderr ?? error.message ?? '').replace(/\r\n/g, '\n').trimEnd(),
      error,
    }
    if (!allowFail) throw new GitError(args, result)
    return result
  }
}

/** 是否安装了 git 并返回版本。 */
export async function gitVersion() {
  const result = await git(['--version'], { allowFail: true })
  return result.ok ? result.stdout.replace(/^git version\s*/i, '') : null
}

/** 把文件系统路径转换成稳定的 git 远程 URL。 */
export function toGitUrl(target) {
  const absolute = path.resolve(target)
  if (absolute.startsWith('\\\\')) {
    // UNC → //server/share/path
    return absolute.slice(2).replace(/\\/g, '/').replace(/^/, '//')
  }
  return absolute.replace(/\\/g, '/')
}

/** 当前目录所属 git 仓库根；不在仓库内返回 null。 */
export async function repoRoot(cwd) {
  const result = await git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true })
  return result.ok ? path.resolve(result.stdout) : null
}

/** 初始化裸仓库；已存在且是裸仓库时直接返回。 */
export async function initBareRepo(bareDir) {
  const existing = await fs.stat(bareDir).catch(() => null)
  if (existing && !existing.isDirectory()) {
    throw new Error(`共享仓库路径已存在但不是目录：${bareDir}`)
  }
  if (existing) {
    const check = await git(['--git-dir', bareDir, 'rev-parse', '--is-bare-repository'], { allowFail: true })
    if (check.ok && check.stdout.trim() === 'true') return { created: false }
    const entries = await fs.readdir(bareDir).catch(() => [])
    if (entries.length > 0) {
      throw new Error(
        `共享仓库目录已存在，但不是裸 git 仓库：${bareDir}\n` +
          '换一个空的共享目录，或先备份并清空该目录后重跑 cowork init。',
      )
    }
  }
  await ensureDir(bareDir)
  const init = await git(['init', '--bare', '--initial-branch=main', bareDir], { allowFail: true })
  if (!init.ok) throw new GitError(['init', '--bare', bareDir], init)
  // 共享仓库上关闭 fsmonitor/分页等本机特性，避免多机行为不一致。
  await git(['--git-dir', bareDir, 'config', 'core.logallrefupdates', 'true'], { allowFail: true })
  await git(['--git-dir', bareDir, 'config', 'receive.denyDeleteCurrent', 'ignore'], { allowFail: true })
  await git(['--git-dir', bareDir, 'config', 'gc.auto', '0'], { allowFail: true })
  return { created: true }
}

/** 裸仓库里某个引用是否存在。 */
export async function bareRefExists(bareDir, ref) {
  const result = await git(['--git-dir', bareDir, 'rev-parse', '--verify', '--quiet', ref], { allowFail: true })
  return result.ok
}

/**
 * 用初始文件在裸仓库里建立 main 分支（只在 main 不存在时调用）。
 * @param {string} bareDir
 * @param {Record<string,string>} files 相对路径 → 文件内容
 * @param {{authorName?:string, authorEmail?:string, message?:string}} identity
 */
export async function seedBareRepo(bareDir, files, identity = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-seed-'))
  try {
    const authorName = identity.authorName ?? 'cowork'
    const authorEmail = identity.authorEmail ?? 'cowork@local'
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(temp, relative)
      await ensureDir(path.dirname(target))
      await fs.writeFile(target, content, 'utf8')
    }
    await git(['init', '--initial-branch=main'], { cwd: temp })
    await git(['add', '-A'], { cwd: temp })
    await git(
      ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-m', identity.message ?? 'cowork: 初始化共享仓库'],
      { cwd: temp },
    )
    await git(['remote', 'add', 'origin', toGitUrl(bareDir)], { cwd: temp })
    await git(['push', '-u', 'origin', 'main'], { cwd: temp })
    return true
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}

/** 克隆共享裸仓库。 */
export async function cloneRepo(bareDir, targetDir) {
  await ensureDir(path.dirname(path.resolve(targetDir)))
  const result = await git(['clone', toGitUrl(bareDir), targetDir], { allowFail: true })
  if (!result.ok) throw new GitError(['clone', toGitUrl(bareDir), targetDir], result)
  return targetDir
}

/** 为克隆设置提交身份（避免两台机器提交作者混淆）。 */
export async function configureIdentity(cwd, agent) {
  await git(['config', 'user.name', `cowork/${agent}`], { cwd })
  await git(['config', 'user.email', `${agent}@cowork.local`], { cwd })
  await git(['config', 'core.autocrlf', 'false'], { cwd })
  await git(['config', 'core.quotepath', 'false'], { cwd })
  await git(['config', 'core.longpaths', 'true'], { cwd })
  await git(['config', 'pull.rebase', 'true'], { cwd })
  await git(['config', 'fetch.prune', 'true'], { cwd })
}

/** 设置远程地址。 */
export async function setRemote(cwd, name, url) {
  const exists = await git(['remote', 'get-url', name], { cwd, allowFail: true })
  if (exists.ok) return git(['remote', 'set-url', name, url], { cwd })
  return git(['remote', 'add', name, url], { cwd })
}

/** 当前分支；分离 HEAD 时返回 null。 */
export async function currentBranch(cwd) {
  const result = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, allowFail: true })
  return result.ok && result.stdout ? result.stdout.trim() : null
}

/** 是否有未提交改动（含未跟踪文件）。 */
export async function isDirty(cwd) {
  const result = await git(['status', '--porcelain'], { cwd })
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length > 0
}

/** 未提交改动的文件列表。 */
export async function changedFiles(cwd) {
  const result = await git(['status', '--porcelain'], { cwd })
  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ({ state: line.slice(0, 2), file: line.slice(3).trim() }))
}

/** 进行中的 git 操作（rebase/merge 等）；返回描述或 null。 */
export async function operationInProgress(cwd) {
  const gitDirResult = await git(['rev-parse', '--git-dir'], { cwd, allowFail: true })
  if (!gitDirResult.ok) return null
  const gitDir = path.isAbsolute(gitDirResult.stdout) ? gitDirResult.stdout : path.join(cwd, gitDirResult.stdout)
  const probes = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ]
  for (const [file, kind] of probes) {
    try {
      await fs.access(path.join(gitDir, file))
      return kind
    } catch {
      // 继续探测
    }
  }
  return null
}

/** 冲突文件列表。 */
export async function conflictedFiles(cwd) {
  const result = await git(['diff', '--name-only', '--diff-filter=U'], { cwd, allowFail: true })
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** fetch 远程。 */
export async function fetchRemote(cwd, remote) {
  return git(['fetch', '--prune', remote], { cwd, allowFail: true })
}

/** 与上游的领先/落后提交数。 */
export async function aheadBehind(cwd, upstream) {
  const result = await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { cwd, allowFail: true })
  if (!result.ok) return { behind: 0, ahead: 0, ok: false }
  const [behind, ahead] = result.stdout.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0)
  return { behind, ahead, ok: true }
}

/** 提交全部改动（含新增/删除）；没有改动时返回 committed=false。 */
export async function commitAll(cwd, message, identity = {}) {
  await git(['add', '-A'], { cwd })
  const diff = await git(['diff', '--cached', '--quiet'], { cwd, allowFail: true })
  if (diff.ok) return { committed: false, commit: null }
  const commitArgs = [
    '-c',
    `user.name=${identity.name ?? 'cowork'}`,
    '-c',
    `user.email=${identity.email ?? 'cowork@local'}`,
    'commit',
    '-m',
    message,
  ]
  const result = await git(commitArgs, { cwd })
  const head = await git(['rev-parse', '--short', 'HEAD'], { cwd })
  return { committed: true, commit: head.stdout.trim(), summary: result.stdout }
}

/** 列出本地/远程分支。 */
export async function branchList(cwd, { remote = null } = {}) {
  const args = remote ? ['branch', '-r', '--list', `${remote}/*`] : ['branch', '--list']
  const result = await git(args, { cwd, allowFail: true })
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/^\*?\s*/, '').trim())
    .filter((line) => line && !line.includes('->'))
}

/** 创建或切换到任务分支（从 origin/main 出发）。 */
export async function ensureTaskBranch(cwd, branch, baseRef) {
  const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, allowFail: true })
  if (local.ok) {
    await git(['checkout', branch], { cwd })
    return { created: false, branch }
  }
  const base = await git(['rev-parse', '--verify', '--quiet', baseRef], { cwd, allowFail: true })
  if (!base.ok) throw new Error(`基线分支不存在：${baseRef}（先运行 cowork sync 或检查共享仓库）`)
  await git(['checkout', '-b', branch, baseRef], { cwd })
  return { created: true, branch }
}

/** 切换分支（要求工作区干净由调用方保证）。 */
export async function checkout(cwd, branch) {
  await git(['checkout', branch], { cwd })
}

/** 同步：fetch +（main 上 fast-forward / 分支上 rebase 到 origin/main）。 */
export async function syncCurrentBranch(cwd, { remote, mainBranch }) {
  const fetched = await fetchRemote(cwd, remote)
  if (!fetched.ok) {
    return { ok: false, stage: 'fetch', message: `连接共享仓库失败：${fetched.stderr || fetched.stdout}` }
  }
  const branch = await currentBranch(cwd)
  if (branch === null) return { ok: false, stage: 'branch', message: '当前处于分离 HEAD 状态，先 git checkout 一个分支。' }
  const upstream = `${remote}/${mainBranch}`
  if (branch === mainBranch) {
    const pull = await git(['merge', '--ff-only', upstream], { cwd, allowFail: true })
    if (!pull.ok) {
      return { ok: false, stage: 'main', message: `main 分支无法快进到 ${upstream}：${pull.stderr || pull.stdout}` }
    }
    return { ok: true, branch, action: 'fast-forward', output: pull.stdout }
  }
  const rebase = await git(['rebase', upstream], { cwd, allowFail: true })
  if (rebase.ok) {
    return { ok: true, branch, action: 'rebase', output: rebase.stdout, conflicts: [] }
  }
  const conflicts = await conflictedFiles(cwd)
  if (conflicts.length > 0) {
    return {
      ok: false,
      stage: 'conflict',
      branch,
      conflicts,
      message:
        `与 ${upstream} 产生冲突，已暂停 rebase。请解决以下文件后执行 cowork sync --continue，` +
        `或执行 cowork sync --abort 放弃本次同步：\n- ${conflicts.join('\n- ')}`,
    }
  }
  await git(['rebase', '--abort'], { cwd, allowFail: true })
  return { ok: false, stage: 'rebase', message: `rebase 失败并已回滚：${rebase.stderr || rebase.stdout}` }
}

/** rebase 继续 / 放弃。 */
export async function continueSync(cwd, action) {
  if (action === 'abort') {
    const result = await git(['rebase', '--abort'], { cwd, allowFail: true })
    return { ok: result.ok, output: result.stderr || result.stdout }
  }
  // GIT_EDITOR=true 让 rebase --continue 自动接受原提交信息（Git for Windows 自带的 sh 有 true）。
  const result = await git(['rebase', '--continue'], { cwd, allowFail: true, env: { GIT_EDITOR: 'true' } })
  if (result.ok) return { ok: true, output: result.stdout }
  const conflicts = await conflictedFiles(cwd)
  return { ok: false, conflicts, message: result.stderr || result.stdout }
}

/** 推送当前分支；任务分支 rebase 后允许用 --force-with-lease 覆盖自己的远程分支。 */
export async function pushBranch(cwd, remote, branch, options = {}) {
  const first = await git(['push', '-u', remote, branch], { cwd, allowFail: true })
  if (first.ok) return { ok: true, output: first.stderr || first.stdout }
  if (options.autoForce) {
    const forced = await git(['push', '--force-with-lease', remote, branch], { cwd, allowFail: true })
    if (forced.ok) {
      return { ok: true, rewritten: true, output: forced.stderr || forced.stdout }
    }
    return { ok: false, message: `推送失败（已尝试 --force-with-lease）：${forced.stderr || forced.stdout}` }
  }
  return { ok: false, message: `推送失败：${first.stderr || first.stdout}` }
}

/** 删除远程分支。 */
export async function deleteRemoteBranch(cwd, remote, branch) {
  return git(['push', remote, '--delete', branch], { cwd, allowFail: true })
}

/** 远程分支是否存在。 */
export async function remoteBranchExists(cwd, remote, branch) {
  const result = await git(['ls-remote', '--heads', remote, branch], { cwd, allowFail: true })
  return result.ok && result.stdout.trim() !== ''
}

/** 分支相对基线的提交与改动统计。 */
export async function reviewBranch(cwd, { remote, mainBranch, branch }) {
  const upstream = `${remote}/${branch}`
  const base = `${remote}/${mainBranch}`
  const exists = await remoteBranchExists(cwd, remote, branch)
  if (!exists) return { ok: false, message: `远程不存在分支：${branch}` }
  const commits = await git(['log', '--oneline', '--no-decorate', `${base}..${upstream}`], { cwd, allowFail: true })
  const stat = await git(['diff', '--stat', `${base}...${upstream}`], { cwd, allowFail: true })
  const names = await git(['diff', '--name-status', `${base}...${upstream}`], { cwd, allowFail: true })
  const mergeBase = await git(['merge-base', base, upstream], { cwd, allowFail: true })
  const conflictProbe = mergeBase.ok
    ? await git(['merge-tree', mergeBase.stdout.trim(), base, upstream], { cwd, allowFail: true })
    : { ok: false, stdout: '' }
  return {
    ok: true,
    branch,
    commits: commits.stdout.split('\n').filter(Boolean),
    stat: stat.stdout,
    files: names.stdout.split('\n').filter(Boolean),
    potentialConflicts: conflictProbe.ok && /<<<<<<<|CONFLICT/.test(conflictProbe.stdout),
  }
}

/**
 * 把远程分支合并进 main 并推送。
 * 冲突时自动中止合并，保持工作区干净，返回冲突文件。
 */
export async function mergeIntoMain(cwd, { remote, mainBranch, branch }) {
  const upstream = `${remote}/${branch}`
  const base = `${remote}/${mainBranch}`
  const exists = await remoteBranchExists(cwd, remote, branch)
  if (!exists) return { ok: false, message: `远程不存在分支：${branch}` }
  const dirty = await isDirty(cwd)
  if (dirty) {
    return { ok: false, message: '当前工作区有未提交改动，先运行 cowork save 或提交/还原后再合并。' }
  }
  const fetched = await fetchRemote(cwd, remote)
  if (!fetched.ok) return { ok: false, message: `fetch 失败：${fetched.stderr || fetched.stdout}` }
  await git(['checkout', mainBranch], { cwd })
  const pull = await git(['merge', '--ff-only', base], { cwd, allowFail: true })
  if (!pull.ok) {
    return { ok: false, message: `main 无法快进到 ${base}：${pull.stderr || pull.stdout}` }
  }
  const merge = await git(['merge', '--no-ff', '--no-edit', upstream], { cwd, allowFail: true })
  if (!merge.ok) {
    const conflicts = await conflictedFiles(cwd)
    if (conflicts.length > 0) {
      await git(['merge', '--abort'], { cwd, allowFail: true })
      return {
        ok: false,
        stage: 'conflict',
        conflicts,
        message:
          `合并 ${branch} 时冲突，已自动中止（main 保持干净）。\n` +
          `冲突文件：\n- ${conflicts.join('\n- ')}\n` +
          '处理方式：让分支作者 rebase 到最新 main 后再推送，或者在本机手动 merge 解决后提交。',
      }
    }
    return { ok: false, message: `合并失败：${merge.stderr || merge.stdout}` }
  }
  const push = await git(['push', remote, mainBranch], { cwd, allowFail: true })
  if (!push.ok) {
    return {
      ok: false,
      stage: 'push',
      message:
        `合并已在本地完成，但推送 main 失败：${push.stderr || push.stdout}\n` +
        '可能有人同时推送了 main，重新运行 cowork merge 即可。',
    }
  }
  const head = await git(['rev-parse', '--short', 'HEAD'], { cwd })
  return { ok: true, commit: head.stdout.trim(), output: merge.stdout }
}

/** 当前分支相对 origin/main 的状态（需先 fetch）。 */
export async function branchAheadBehind(cwd, { remote, mainBranch, branch }) {
  return aheadBehind(cwd, `${remote}/${mainBranch}`).then((value) => ({ ...value, branch }))
}

/** 最近提交。 */
export async function recentCommits(cwd, limit = 10) {
  const result = await git(['log', `-${limit}`, '--oneline', '--no-decorate', '--date=short'], { cwd, allowFail: true })
  return result.stdout.split('\n').filter(Boolean)
}

/** 当前 HEAD 的提交 id（短）。 */
export async function headCommit(cwd) {
  const result = await git(['rev-parse', '--short', 'HEAD'], { cwd, allowFail: true })
  return result.ok ? result.stdout.trim() : null
}

/** 把某个目录里的文件加入仓库（用于从旧的直接共享目录迁移）。 */
export async function addFilesFrom(cwd, sourceDir, { overwrite = true, skip = [] } = {}) {
  const skipSet = new Set([...skip, '.git', '.cowork'])
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  const copied = []
  for (const entry of entries) {
    if (skipSet.has(entry.name)) continue
    const from = path.join(sourceDir, entry.name)
    const to = path.join(cwd, entry.name)
    if (entry.isDirectory()) {
      await fs.cp(from, to, { recursive: true, force: overwrite, errorOnExist: false })
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
    }
    copied.push(entry.name)
  }
  return copied
}

/** 简单的时间戳提交信息。 */
export function defaultCommitMessage(agent) {
  return `cowork: ${agent} @ ${nowIso()}`
}
