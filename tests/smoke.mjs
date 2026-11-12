#!/usr/bin/env node
/**
 * 端到端冒烟测试：用两个本地克隆模拟两台机器上的两个 agent，
 * 跑通 初始化 → 认领任务 → 提交 → 发布 → 评审 → 合并 → 冲突处理 → 消息 → 导入 的完整流程。
 *
 * 运行：node tests/smoke.mjs [--keep]
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const bin = path.join(repoRoot, 'bin', 'cowork.mjs')

let passed = 0
function ok(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
}
function step(name) {
  process.stdout.write(`\n== ${name} ==\n`)
}
async function readFileOrNull(file) {
  return fs.readFile(file, 'utf8').catch(() => null)
}

async function runCli(args, cwd) {
  const result = await execFileAsync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, COWORK_AGENT: '' },
    timeout: 120000,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

async function runCliAllowFail(args, cwd) {
  try {
    const result = await runCli(args, cwd)
    return { code: 0, ...result }
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

const keep = process.argv.includes('--keep')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-smoke-'))
// 隔离全局配置目录，避免测试互相干扰、也不污染真实 ~/.cowork
await fs.mkdir(path.join(tempRoot, '.cowork-home'), { recursive: true })
process.env.COWORK_HOME = path.join(tempRoot, '.cowork-home')

const core = await import('../src/core.mjs')
const gitModule = await import('../src/git.mjs')
const boardApi = await import('../src/board.mjs')

const share = path.join(tempRoot, 'share', 'cowork')
const cloneA = path.join(tempRoot, 'machineA', 'project')
const cloneB = path.join(tempRoot, 'machineB', 'project')

try {
  process.stdout.write(`测试目录：${tempRoot}\n`)

  step('初始化共享工作区（机器 A）')
  const initResult = await core.initWorkspace({
    shareRoot: share,
    agent: 'A',
    dir: cloneA,
    project: 'smoke-demo',
  })
  ok(initResult.ok, `init 成功：${initResult.text}`)
  ok(await fs.stat(path.join(share, 'repo.git')).then(() => true, () => false), '裸仓库已创建')
  ok(await fs.stat(path.join(share, 'board', 'board.json')).then(() => true, () => false), '任务板已创建')
  ok(await fs.stat(path.join(cloneA, 'AGENTS.md')).then(() => true, () => false), 'AGENTS.md 已生成到克隆')

  step('加入共享工作区（机器 B）')
  const joinResult = await core.joinWorkspace({ shareRoot: share, agent: 'B', dir: cloneB })
  ok(joinResult.ok, `join 成功：${joinResult.text}`)
  const contextA = await loadContext(cloneA, 'A')
  const contextB = await loadContext(cloneB, 'B')

  step('状态与任务板')
  const statusA = await core.status(contextA.config, 'A', { fetch: true })
  ok(statusA.ok, 'status 返回 ok')
  ok(statusA.text.includes('cowork 状态'), 'status 文本包含标题')
  ok(statusA.text.includes('main'), 'status 显示当前分支 main')

  const taskA = await core.taskCreate(contextA.config, 'A', {
    title: '实现功能 X',
    description: '在 feature-x.txt 里写点东西',
  })
  ok(taskA.ok, `任务创建成功：${taskA.text}`)
  const taskAId = taskA.data.task.id
  ok(/^T-\d{4}$/.test(taskAId), '任务号格式 T-0001')
  ok(taskA.data.task.status === 'working', '新建任务并自己认领后状态为 working')
  const branchA = taskA.data.claim.branch
  ok(branchA === `agent/A/${taskAId}`, `分支名符合约定：${branchA}`)

  // 并发创建任务，验证跨机器锁不会丢更新
  const concurrent = await Promise.all([
    core.taskCreate(contextA.config, 'A', { title: '并发任务 1', assignee: 'B' }),
    core.taskCreate(contextA.config, 'A', { title: '并发任务 2', assignee: 'B' }),
  ])
  ok(concurrent.every((item) => item.ok), '并发创建任务都成功')
  const allTasks = await core.taskList(contextA.config, 'A', { all: true })
  ok(allTasks.data.tasks.filter((task) => task.title.startsWith('并发任务')).length === 2, '两个并发任务都在任务板上')

  step('A 改代码 → save → publish')
  await fs.writeFile(path.join(cloneA, 'feature-x.txt'), '功能 X 的第一版\n', 'utf8')
  const saveA = await core.save(contextA.config, 'A', { message: `${taskAId}: 完成功能 X` })
  ok(saveA.ok && saveA.text.includes('已提交'), `save 成功：${saveA.text}`)
  const publishA = await core.publish(contextA.config, 'A', {})
  ok(publishA.ok, `publish 成功：${publishA.text}`)
  ok(publishA.text.includes('已推送分支'), 'publish 推送了分支')
  ok(publishA.text.includes('review'), 'publish 把任务置为 review')

  step('B 评审并合并 A 的分支')
  const reviewA = await core.review(contextB.config, 'B', taskAId)
  ok(reviewA.ok, `review 成功：${reviewA.text}`)
  ok(reviewA.text.includes('feature-x.txt'), 'review 列出改动文件')
  const mergeA = await core.merge(contextB.config, 'B', taskAId)
  ok(mergeA.ok, `merge 成功：${mergeA.text}`)
  const taskAAfterMerge = await boardApi.getTask(contextB.config, taskAId)
  ok(taskAAfterMerge.status === 'done', '合并后任务为 done')
  const clonedMainA = await fs.readFile(path.join(cloneB, 'feature-x.txt'), 'utf8')
  ok(clonedMainA.includes('功能 X'), 'main 上出现 A 的文件内容')

  step('B 做自己的任务并发布，A 合并')
  const taskB = await core.taskCreate(contextB.config, 'B', { title: '实现功能 Y' })
  ok(taskB.ok, 'B 创建任务成功')
  const taskBId = taskB.data.task.id
  await fs.writeFile(path.join(cloneB, 'feature-y.txt'), '功能 Y 已完成\n', 'utf8')
  const publishB = await core.publish(contextB.config, 'B', { message: `${taskBId}: 完成功能 Y` })
  ok(publishB.ok, `B publish 成功：${publishB.text}`)
  const mergeB = await core.merge(contextA.config, 'A', taskBId)
  ok(mergeB.ok, `A 合并 B 分支成功：${mergeB.text}`)
  const taskBAfter = await boardApi.getTask(contextA.config, taskBId)
  ok(taskBAfter.status === 'done', 'B 的任务合并后为 done')

  step('冲突检测与解决')
  // A 基于当前 main 开任务，改 conflict.txt
  const syncA0 = await core.sync(contextA.config, 'A')
  ok(syncA0.ok, `A 同步成功：${syncA0.text}`)
  const taskC = await core.taskCreate(contextA.config, 'A', { title: '冲突任务 A 版' })
  ok(taskC.ok, 'A 创建冲突任务')
  const taskCId = taskC.data.task.id
  await fs.writeFile(path.join(cloneA, 'conflict.txt'), '版本 A\n', 'utf8')
  const publishC = await core.publish(contextA.config, 'A', { message: `${taskCId}: A 版` })
  ok(publishC.ok, `A 冲突分支发布：${publishC.text}`)

  // B 也在旧 main 上改同一个文件（不包含 A 的未合并分支）
  const taskD = await core.taskCreate(contextB.config, 'B', { title: '冲突任务 B 版' })
  ok(taskD.ok, 'B 创建冲突任务')
  const taskDId = taskD.data.task.id
  await fs.writeFile(path.join(cloneB, 'conflict.txt'), '版本 B\n', 'utf8')
  const publishD = await core.publish(contextB.config, 'B', { message: `${taskDId}: B 版` })
  ok(publishD.ok, `B 冲突分支发布：${publishD.text}`)

  // A 先合并 B 的分支 → main 上是“版本 B”
  const mergeD = await core.merge(contextA.config, 'A', taskDId)
  ok(mergeD.ok, `合并 B 冲突分支成功：${mergeD.text}`)
  // A 切回自己的冲突分支并 sync → 应检测到 rebase 冲突
  await gitModule.git(['checkout', `agent/A/${taskCId}`], { cwd: cloneA })
  const syncConflict = await core.sync(contextA.config, 'A')
  ok(!syncConflict.ok, '冲突分支同步应失败')
  ok(syncConflict.text.includes('conflict.txt'), '冲突输出包含冲突文件 conflict.txt')
  // 解决冲突：写合并后的内容并继续 rebase
  await fs.writeFile(path.join(cloneA, 'conflict.txt'), '版本 A + 版本 B\n', 'utf8')
  await gitModule.git(['add', 'conflict.txt'], { cwd: cloneA })
  const syncContinue = await core.sync(contextA.config, 'A', { action: 'continue' })
  ok(syncContinue.ok, `rebase --continue 成功：${syncContinue.text}`)
  const publishC2 = await core.publish(contextA.config, 'A', {})
  ok(publishC2.ok, `解决冲突后发布成功：${publishC2.text}`)
  const mergeC = await core.merge(contextB.config, 'B', taskCId)
  ok(mergeC.ok, `冲突解决后合并成功：${mergeC.text}`)
  const mainCloneB = await fs.readFile(path.join(cloneB, 'conflict.txt'), 'utf8')
  ok(mainCloneB.includes('版本 A + 版本 B'), 'main 上保存了解冲突后的内容')

  step('合并冲突自动中止')
  // 1) 先让 main 上有一个基线文件
  const taskG = await core.taskCreate(contextB.config, 'B', { title: '冲突基线文件' })
  ok(taskG.ok, 'B 创建基线任务')
  const taskGId = taskG.data.task.id
  await fs.writeFile(path.join(cloneB, 'conflict2.txt'), 'baseline\n', 'utf8')
  const publishG = await core.publish(contextB.config, 'B', { message: `${taskGId}: 基线` })
  ok(publishG.ok, `基线分支发布：${publishG.text}`)
  const mergeG = await core.merge(contextA.config, 'A', taskGId)
  ok(mergeG.ok, `基线合并成功：${mergeG.text}`)
  const syncB1 = await core.sync(contextB.config, 'B')
  ok(syncB1.ok, `B 同步成功：${syncB1.text}`)

  // 2) A 和 B 各自基于最新 main 修改同一个文件
  const taskE = await core.taskCreate(contextA.config, 'A', { title: '冲突合并测试 E（A 版）' })
  ok(taskE.ok, 'A 创建任务 E')
  const taskEId = taskE.data.task.id
  await fs.writeFile(path.join(cloneA, 'conflict2.txt'), 'A 版\n', 'utf8')
  const publishE = await core.publish(contextA.config, 'A', { message: `${taskEId}: A 版` })
  ok(publishE.ok, `E 分支发布：${publishE.text}`)

  const taskF = await core.taskCreate(contextB.config, 'B', { title: '冲突合并测试 F（B 版）' })
  ok(taskF.ok, 'B 创建任务 F')
  const taskFId = taskF.data.task.id
  await fs.writeFile(path.join(cloneB, 'conflict2.txt'), 'B 版\n', 'utf8')
  const publishF = await core.publish(contextB.config, 'B', { message: `${taskFId}: B 版` })
  ok(publishF.ok, `F 分支发布：${publishF.text}`)

  // 3) A 先合并 F（干净），再合并 E（应冲突并自动中止）
  const mergeF = await core.merge(contextA.config, 'A', taskFId)
  ok(mergeF.ok, `合并 F 成功：${mergeF.text}`)
  const mergeE = await core.merge(contextA.config, 'A', taskEId)
  ok(!mergeE.ok && mergeE.text.includes('冲突'), `合并 E 检测到冲突并中止：${mergeE.text.slice(0, 200)}`)
  const branchAfterMergeFail = await gitModule.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cloneA })
  ok(branchAfterMergeFail.stdout.trim() === 'main', '合并失败后仍停留在 main 且干净')
  const statusAfter = await gitModule.git(['status', '--porcelain'], { cwd: cloneA })
  ok(statusAfter.stdout.trim() === '', '合并失败后工作区干净')
  const taskEStill = await boardApi.getTask(contextA.config, taskEId)
  ok(taskEStill.status === 'review', '冲突未合并的任务仍保持 review')

  step('消息与收件箱')
  const send = await core.sendMessage(contextA.config, 'A', { to: 'B', body: '我合并了你的分支，请拉取最新 main', taskId: taskAId })
  ok(send.ok, `发消息成功：${send.text}`)
  const inboxB = await core.inbox(contextB.config, 'B', {})
  ok(inboxB.ok && inboxB.text.includes('我合并了你的分支'), 'B 收到消息')
  ok(inboxB.data.messages.some((message) => message.unread), '消息未读标记存在')
  const markRead = await core.inbox(contextB.config, 'B', { markRead: true })
  ok(markRead.ok, 'B 标记已读成功')
  const inboxB2 = await core.inbox(contextB.config, 'B', {})
  ok(!inboxB2.data.messages.some((message) => message.unread), '标记已读后未读消失')

  step('成员心跳')
  const members = await core.members(contextA.config, 'A')
  ok(members.data.members.some((member) => member.agent === 'A'), '成员列表包含 A')
  ok(members.data.members.some((member) => member.agent === 'B'), '成员列表包含 B')

  step('导入旧共享目录文件')
  const legacyDir = path.join(tempRoot, 'legacy-files')
  await fs.mkdir(path.join(legacyDir, 'sub'), { recursive: true })
  await fs.writeFile(path.join(legacyDir, 'legacy.txt'), '旧文件\n', 'utf8')
  await fs.writeFile(path.join(legacyDir, 'sub', 'nested.txt'), '嵌套文件\n', 'utf8')
  await gitModule.git(['checkout', 'main'], { cwd: cloneA })
  const imported = await core.importFiles(contextA.config, 'A', legacyDir, { message: '导入旧文件' })
  ok(imported.ok, `导入成功：${imported.text}`)
  const mainInB = await gitModule.git(['fetch', 'origin'], { cwd: cloneB })
  ok(mainInB.ok, 'B fetch')
  const showFile = await gitModule.git(['show', 'origin/main:legacy.txt'], { cwd: cloneB })
  ok(showFile.stdout.includes('旧文件'), 'main 上存在导入的文件')

  step('CLI 可用性')
  const cliStatus = await runCli(['status', '--no-fetch'], cloneA)
  ok(cliStatus.stdout.includes('cowork 状态'), `CLI status 输出正常：${cliStatus.stdout.slice(0, 120)}`)
  ok(cliStatus.stdout.includes(cloneA), 'CLI 优先使用当前目录的克隆')
  const cliStatusB = await runCli(['status', '--no-fetch'], cloneB)
  ok(cliStatusB.stdout.includes(cloneB), 'CLI 在另一个克隆里使用该克隆（不会被全局配置带偏）')
  const cliTaskList = await runCli(['task', 'list', '--all'], cloneA)
  ok(cliTaskList.stdout.includes('T-'), 'CLI task list 输出任务号')
  const cliHelp = await runCli(['help'], cloneA)
  ok(cliHelp.stdout.includes('cowork init'), 'CLI help 输出用法')

  step('回归：非 cowork 目录不会误把全局配置当仓库')
  const fakeHome = path.join(tempRoot, 'fake-home')
  const fakeHomeCowork = path.join(fakeHome, '.cowork')
  await fs.mkdir(fakeHomeCowork, { recursive: true })
  // 模拟“全局配置”：没有 repoDir/mainBranch，不能当成仓库配置
  await fs.writeFile(
    path.join(fakeHomeCowork, 'config.json'),
    JSON.stringify({ formatVersion: 1, agent: 'X', repoPath: cloneA, shareRoot: share }),
    'utf8',
  )
  const { findRepoRoot, loadRepoConfig } = await import('../src/config.mjs')
  ok(findRepoRoot(fakeHome) === null, '全局配置目录不会被当成仓库根')
  ok((await loadRepoConfig(fakeHome)) === null, '全局配置不会被当成仓库配置')
  const cliOutside = await runCliAllowFail(['task', 'list'], fakeHome)
  ok(cliOutside.code === 1, `非 cowork 目录命令应失败（实际退出码 ${cliOutside.code}）`)
  ok(
    /当前目录不在 cowork 工作区内/.test(cliOutside.stderr + cliOutside.stdout),
    `非 cowork 目录给出友好错误：${(cliOutside.stderr + cliOutside.stdout).slice(0, 120)}`,
  )

  step('回归：共享不可达时明确报错（不静默显示 0 任务）')
  const brokenConfig = { ...contextA.config, shareRoot: path.join(tempRoot, 'no-such-share') }
  const brokenStatus = await core.status(brokenConfig, 'A', { fetch: false })
  ok(!brokenStatus.ok, '共享不可达时 status 返回失败')
  ok(/不可访问|任务板/.test(brokenStatus.text), 'status 文本指出共享/任务板问题')
  let brokenListError = null
  try {
    await core.taskList(brokenConfig, 'A', { all: true })
  } catch (error) {
    brokenListError = error
  }
  ok(Boolean(brokenListError), '共享不可达时 task list 抛错而不是显示空板')
  ok(/任务板不存在|共享目录不可访问|读取任务板失败/.test(brokenListError?.message ?? ''), 'task list 错误信息可指导下一步')

  step('回归：没有 rebase 时 sync --continue 明确提示')
  const noRebase = await core.sync(contextA.config, 'A', { action: 'continue' })
  ok(!noRebase.ok, '无 rebase 时 --continue 返回失败')
  ok(/没有进行中的 rebase/.test(noRebase.text), '无 rebase 时给出中文提示')

  step('环境自检')
  const doctor = await core.doctor(contextA.config, 'A')
  ok(doctor.text.includes('cowork 自检'), 'doctor 输出标题')
  ok(doctor.text.includes('共享读写'), 'doctor 检查共享读写')

  process.stdout.write(`\n全部通过：${passed} 个断言\n`)
  if (!keep) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  else process.stdout.write(`保留测试目录：${tempRoot}\n`)
} catch (error) {
  process.stderr.write(`\n测试失败：${error.stack || error.message}\n`)
  process.stderr.write(`测试目录保留用于排查：${tempRoot}\n`)
  process.exitCode = 1
}

async function loadContext(cloneDir, agent) {
  const { loadRepoConfig } = await import('../src/config.mjs')
  const config = await loadRepoConfig(cloneDir)
  if (!config) throw new Error(`无法加载仓库配置：${cloneDir}`)
  return { config, agent }
}
