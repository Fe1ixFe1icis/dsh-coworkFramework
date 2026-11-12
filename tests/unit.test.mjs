#!/usr/bin/env node
/**
 * 单元/边界测试：工具函数、配置校验、任务板并发语义与损坏恢复。
 *
 * 运行：node tests/unit.test.mjs [--keep]
 * 依赖：Node >= 20、git >= 2.30；不访问任何真实共享目录（全部在临时目录里）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

let passed = 0
function ok(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
}
function step(name) {
  process.stdout.write(`\n== ${name} ==\n`)
}
async function reject(fn, pattern, message) {
  let error = null
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  ok(Boolean(error), message)
  if (pattern) ok(pattern.test(error.message), `${message}（错误信息：${error.message.split('\n')[0]}）`)
}

const keep = process.argv.includes('--keep')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-unit-'))
const coworkHome = path.join(tempRoot, '.cowork-home')
await fs.mkdir(coworkHome, { recursive: true })
process.env.COWORK_HOME = coworkHome

const util = await import('../src/util.mjs')
const configApi = await import('../src/config.mjs')
const boardApi = await import('../src/board.mjs')
const gitApi = await import('../src/git.mjs')
const core = await import('../src/core.mjs')

try {
  process.stdout.write(`测试目录：${tempRoot}\n`)

  step('工具函数：参数解析 / 路径 / 锁')
  {
    let argv = ['--repo', 'D:/work', 'status', '--json']
    const repo = util.takeOption(argv, 'repo')
    ok(repo.value === 'D:/work', 'takeOption 解析 --repo 值')
    argv = repo.argv
    const json = util.takeFlag(argv, '--json')
    ok(json.value && json.argv.length === 1 && json.argv[0] === 'status', 'takeFlag 移除开关并保留位置参数')

    const equals = util.takeOption(['--limit=50', 'inbox'], 'limit')
    ok(equals.value === '50' && equals.argv[0] === 'inbox', 'takeOption 支持 --key=value')

    ok(util.sanitizeBranchSegment('dev x/y') === 'dev-x-y', '分支片段会清理空格和路径分隔符')
    ok(util.sanitizeBranchSegment('..') === 'agent', '分支片段不会留下纯点号')
    ok(util.sequenceId('T', 7) === 'T-0007', '任务号补零到四位')
    ok(util.truncate('abcdef', 4) === 'abc…', 'truncate 保留省略号')

    const envName = util.IS_WINDOWS ? 'TEMP' : 'HOME'
    const envToken = util.IS_WINDOWS ? '%TEMP%' : '$env:HOME'
    const expanded = util.expandPath(envToken)
    ok(expanded === path.resolve(process.env[envName] ?? ''), 'expandPath 展开环境变量')
    ok(util.pathExists(tempRoot), 'pathExists 识别存在的目录')

    const missing = path.join(tempRoot, 'missing.json')
    const fallback = { a: 1 }
    const value = await util.readJson(missing, fallback)
    value.a = 2
    ok(fallback.a === 1, 'readJson 返回 fallback 的深拷贝')

    const badJson = path.join(tempRoot, 'bad.json')
    await fs.writeFile(badJson, '{not json', 'utf8')
    await reject(() => util.readJson(badJson, null), /JSON 解析失败/, '损坏 JSON 给出明确错误')

    const atomicFile = path.join(tempRoot, 'atomic', 'config.json')
    await util.writeJsonAtomic(atomicFile, { hello: 'world' })
    const raw = JSON.parse(await fs.readFile(atomicFile, 'utf8'))
    ok(raw.hello === 'world', 'writeJsonAtomic 写入内容正确')
    const leftovers = (await fs.readdir(path.dirname(atomicFile))).filter((name) => name.endsWith('.tmp'))
    ok(leftovers.length === 0, 'writeJsonAtomic 不残留临时文件')

    const lockFile = path.join(tempRoot, 'locks', 'test.lock')
    const order = []
    await util.withFileLock(lockFile, async () => {
      order.push('first')
    })
    ok(order.length === 1, 'withFileLock 执行回调')
    ok(!(await fs.stat(lockFile).then(() => true, () => false)), 'withFileLock 结束后释放锁')

    await fs.mkdir(path.dirname(lockFile), { recursive: true })
    await fs.writeFile(lockFile, '{"stale":true}', 'utf8')
    const old = new Date(Date.now() - 120000)
    await fs.utimes(lockFile, old, old)
    await util.withFileLock(lockFile, async () => order.push('stale-cleared'))
    ok(order.includes('stale-cleared'), '过期锁会被自动清理并重新获取')
  }

  step('配置：仓库形状识别 / 身份覆盖 / 损坏配置提示')
  {
    ok(configApi.isRepoConfigShape({ shareRoot: '\\\\s\\c', repoDir: 'repo.git', mainBranch: 'main' }), '合法仓库配置通过形状校验')
    ok(!configApi.isRepoConfigShape({ agent: 'A', repoPath: 'D:/x' }), '全局配置不会被当成仓库配置')

    const config = { agent: 'A', branchPrefix: 'agent' }
    ok(configApi.branchNameFor(config, 'B', 'T-0001') === 'agent/B/T-0001', 'branchNameFor 优先使用显式身份')
    ok(configApi.branchNameFor(config, undefined, 'T-0002') === 'agent/A/T-0002', 'branchNameFor 回退到配置身份')

    const corruptDir = path.join(tempRoot, 'corrupt-repo')
    await fs.mkdir(path.join(corruptDir, '.cowork'), { recursive: true })
    await fs.writeFile(path.join(corruptDir, '.cowork', 'config.json'), '{broken', 'utf8')
    await reject(
      () => configApi.resolveRepoContext({ cwd: corruptDir }),
      /仓库配置存在但无法使用/,
      '损坏的仓库配置给出可操作的错误',
    )

    const originalHome = process.env.COWORK_HOME
    process.env.COWORK_HOME = corruptDir
    await fs.mkdir(path.join(corruptDir, '.cowork'), { recursive: true })
    await fs.writeFile(
      path.join(corruptDir, '.cowork', 'config.json'),
      JSON.stringify({ agent: 'A', repoPath: 'D:/x' }),
      'utf8',
    )
    ok(configApi.findRepoConfigFile(corruptDir) === null, 'findRepoConfigFile 跳过全局配置目录')
    process.env.COWORK_HOME = originalHome
  }

  step('初始化 / 加入 / 任务板')
  const share = path.join(tempRoot, 'share', 'cowork')
  const cloneA = path.join(tempRoot, 'machineA', 'project')
  const cloneB = path.join(tempRoot, 'machineB', 'project')
  const init = await core.initWorkspace({ shareRoot: share, agent: 'A', dir: cloneA, project: 'unit-demo' })
  ok(init.ok, `init 成功：${init.text.split('\n')[0]}`)
  const join = await core.joinWorkspace({ shareRoot: share, agent: 'B', dir: cloneB })
  ok(join.ok, `join 成功：${join.text.split('\n')[0]}`)
  const configA = await configApi.loadRepoConfig(cloneA)
  const configB = await configApi.loadRepoConfig(cloneB)
  ok(configA?.agent === 'A' && configB?.agent === 'B', '两个克隆各自保存身份')
  ok(await configApi.loadRepoConfig(path.join(tempRoot, 'nowhere')) === null, '非工作区返回 null')

  await reject(
    () => core.initWorkspace({ shareRoot: path.join(tempRoot, 'bad-share'), agent: 'bad/name', dir: path.join(tempRoot, 'bad-clone') }),
    /非法字符/,
    '非法 agent 身份被拒绝',
  )
  await reject(
    () => core.initWorkspace({ shareRoot: path.join(tempRoot, 'bad-share2'), agent: 'CON', dir: path.join(tempRoot, 'bad-clone2') }),
    /保留名/,
    'Windows 保留名被拒绝',
  )

  const taskA = await core.taskCreate(configA, 'A', { title: '分配给 B 的任务', assignee: 'B', tags: ['unit'], priority: 'high' })
  ok(taskA.ok && taskA.data.task.status === 'open', '指定 assignee 时任务保持 open')
  ok(taskA.data.task.assignee === 'B', '任务记录 assignee')
  const taskAId = taskA.data.task.id
  const assigned = await boardApi.getTask(configA, taskAId)
  ok(assigned.priority === 'high' && assigned.tags.includes('unit'), '任务记录 priority/tags')

  const denied = await core.taskClaim(configA, 'A', taskAId)
  ok(!denied.ok && /已指派给 B/.test(denied.text), '不能直接认领指派给别人的任务')

  const forced = await core.taskClaim(configA, 'A', taskAId, { force: true })
  ok(forced.ok && forced.data.branch === `agent/A/${taskAId}`, '--force 可以接管并创建自己的分支')
  ok((await boardApi.getTask(configA, taskAId)).owner === 'A', '强制认领后 owner 更新为 A')

  const taskB = await core.taskCreate(configB, 'B', { title: 'B 自己的任务' })
  ok(taskB.ok, 'B 创建并认领自己的任务')
  const listed = await core.taskList(configA, 'A', { all: true })
  ok(listed.data.tasks.length >= 2, '任务板包含两个任务')
  ok(listed.data.tasks[0].id.localeCompare(listed.data.tasks[1].id, 'en', { numeric: true }) <= 0, 'taskList 按任务号排序')

  const ownerUpdate = await core.taskUpdate(configA, 'A', taskAId, { owner: 'B', note: '改由 B 负责' })
  ok(ownerUpdate.ok && ownerUpdate.data.task.owner === 'B', 'taskUpdate 可以修改 owner')
  const ownerCleared = await core.taskUpdate(configA, 'A', taskAId, { owner: null })
  ok(ownerCleared.data.task.owner === null, 'taskUpdate 可以清除 owner')

  const message = await core.sendMessage(configA, 'A', { to: 'B', body: '单元测试消息' })
  ok(message.ok, '发送消息')
  const emptyMark = await boardApi.markMessagesRead(configA, 'A', [])
  ok(emptyMark.length === 0, '空 ids 不会误把全部消息标记为已读')
  const inbox = await core.inbox(configB, 'B', { markRead: true })
  ok(inbox.ok && inbox.data.messages.some((item) => item.body === '单元测试消息'), '收件箱收到并标记已读')

  step('共享探测 / 裸仓库边界')
  const brokenConfig = { ...configA, shareRoot: path.join(tempRoot, 'no-such-share') }
  const probe = await boardApi.probeShare(brokenConfig)
  ok(!probe.ok && /不可访问/.test(probe.message), '共享不可达时 probeShare 返回失败')
  ok((await boardApi.probeShare(configA)).ok, '正常共享 probeShare 返回成功')

  const notBare = path.join(tempRoot, 'not-bare')
  await fs.mkdir(notBare, { recursive: true })
  await fs.writeFile(path.join(notBare, 'keep.txt'), 'x', 'utf8')
  await reject(() => gitApi.initBareRepo(notBare), /不是裸 git 仓库/, '非空非裸仓库目录给出明确错误')

  if (util.IS_WINDOWS) {
    ok(gitApi.toGitUrl(String.raw`\\server\share\repo.git`) === '//server/share/repo.git', 'UNC 路径转换成 git URL')
  }

  step('任务板：过期锁 / 损坏恢复')
  const lockFile = path.join(configApi.boardDir(configA), '.board.lock')
  await fs.mkdir(path.dirname(lockFile), { recursive: true })
  await fs.writeFile(lockFile, '{"stale":true}', 'utf8')
  const old = new Date(Date.now() - 120000)
  await fs.utimes(lockFile, old, old)
  await boardApi.mutateBoard(configA, (board) => {
    board.project = 'after-stale-lock'
    return null
  })
  ok((await boardApi.readBoard(configA)).project === 'after-stale-lock', '任务板写入前清理过期锁')

  const boardFile = path.join(configApi.boardDir(configA), 'board.json')
  await fs.writeFile(boardFile, '{broken', 'utf8')
  const recovered = await boardApi.readBoard(configA)
  ok(recovered.__recoveredFromBackup === true, '任务板损坏时从 .bak 恢复')
  ok(Object.keys(recovered.tasks).length >= 2, '恢复后的任务板仍包含任务')

  await boardApi.mutateBoard(configA, (board) => {
    board.project = 'after-recover'
    return null
  })
  const backupRaw = await fs.readFile(`${boardFile}.bak`, 'utf8')
  ok(!backupRaw.includes('{broken'), '从备份恢复后写入不会用损坏文件覆盖 .bak')
  ok((await boardApi.readBoard(configA)).project === 'after-recover', '恢复后可以继续写入任务板')

  step('环境自检')
  const doctor = await core.doctor(configA, 'A')
  ok(doctor.text.includes('cowork 自检'), 'doctor 输出自检标题')
  ok(doctor.data.checks.every((check) => typeof check.ok === 'boolean'), 'doctor 返回结构化检查项')

  process.stdout.write(`\n全部通过：${passed} 个断言\n`)
  if (!keep) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  else process.stdout.write(`保留测试目录：${tempRoot}\n`)
} catch (error) {
  process.stderr.write(`\n测试失败：${error.stack || error.message}\n`)
  process.stderr.write(`测试目录保留用于排查：${tempRoot}\n`)
  process.exitCode = 1
}
