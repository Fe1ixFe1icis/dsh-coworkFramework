#!/usr/bin/env node
/**
 * 真实共享目录（SMB/UNC）上的端到端测试：
 * 在 <共享根目录>/<临时目录> 上跑两机协作的最小闭环，结束后清理。
 *
 * 运行：node tests/smb-smoke.mjs --share \\fileserver\cowork [--keep]
 * 或：  COWORK_SMB_SHARE=\\fileserver\cowork node tests/smb-smoke.mjs
 *
 * 不传共享目录时打印 SKIP 并退出 0，方便在 CI/没有共享环境的机器上跑完整测试链。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const core = await import('../src/core.mjs')
const boardApi = await import('../src/board.mjs')
const { git } = await import('../src/git.mjs')

const argv = process.argv.slice(2)
const shareIndex = argv.indexOf('--share')
const keep = argv.includes('--keep')
const cliShare = shareIndex >= 0 ? argv[shareIndex + 1] : null
const baseShare = cliShare || process.env.COWORK_SMB_SHARE || null

if (shareIndex >= 0 && (!cliShare || cliShare.startsWith('--'))) {
  process.stderr.write('用法：node tests/smb-smoke.mjs --share \\\\fileserver\\cowork [--keep]\n')
  process.exit(1)
}
if (!baseShare) {
  process.stdout.write(
    'SKIP：未指定真实共享目录。\n' +
      '这个测试会写入真实 SMB/UNC 共享，默认不跑；需要时用 --share <共享目录> 或 COWORK_SMB_SHARE 环境变量指定。\n' +
      '示例：node tests/smb-smoke.mjs --share \\\\fileserver\\cowork\n',
  )
  process.exit(0)
}

const tag = `smoke-${Date.now().toString(36)}`
const share = path.join(baseShare, tag)
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-smb-'))
await fs.mkdir(path.join(tempRoot, '.cowork-home'), { recursive: true })
process.env.COWORK_HOME = path.join(tempRoot, '.cowork-home')
const cloneA = path.join(tempRoot, 'machineA', 'project')
const cloneB = path.join(tempRoot, 'machineB', 'project')

let passed = 0
function ok(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
}
function step(name) {
  process.stdout.write(`\n== ${name} ==\n`)
}

try {
  process.stdout.write(`共享路径：${share}\n本地临时目录：${tempRoot}\n`)

  step('在真实共享目录上初始化')
  const initResult = await core.initWorkspace({ shareRoot: share, agent: 'A', dir: cloneA, project: 'smb-smoke' })
  ok(initResult.ok, `init 成功：${initResult.text}`)
  const repoGit = path.join(share, 'repo.git')
  const stat = await fs.stat(repoGit)
  ok(stat.isDirectory(), '共享目录上存在裸仓库 repo.git')

  step('第二台机器 join')
  const joinResult = await core.joinWorkspace({ shareRoot: share, agent: 'B', dir: cloneB })
  ok(joinResult.ok, `join 成功：${joinResult.text}`)

  const { loadRepoConfig } = await import('../src/config.mjs')
  const configA = await loadRepoConfig(cloneA)
  const configB = await loadRepoConfig(cloneB)
  ok(configA.shareRoot === share, 'A 的共享路径正确')
  ok(configB.shareRoot === share, 'B 的共享路径正确')

  step('A 建任务 / 改文件 / 发布')
  const taskA = await core.taskCreate(configA, 'A', { title: 'SMB 测试任务 A' })
  ok(taskA.ok, `A 任务创建成功：${taskA.text}`)
  const taskAId = taskA.data.task.id
  await fs.writeFile(path.join(cloneA, 'smb-a.txt'), 'SMB 上 A 写的文件\n', 'utf8')
  const publishA = await core.publish(configA, 'A', {})
  ok(publishA.ok, `A 发布成功：${publishA.text}`)

  step('B 评审 / 合并 / 自己发布')
  const reviewA = await core.review(configB, 'B', taskAId)
  ok(reviewA.ok, `B 评审成功：${reviewA.text}`)
  const mergeA = await core.merge(configB, 'B', taskAId)
  ok(mergeA.ok, `B 合并成功：${mergeA.text}`)
  const taskB = await core.taskCreate(configB, 'B', { title: 'SMB 测试任务 B' })
  ok(taskB.ok, 'B 创建任务成功')
  await fs.writeFile(path.join(cloneB, 'smb-b.txt'), 'SMB 上 B 写的文件\n', 'utf8')
  const publishB = await core.publish(configB, 'B', {})
  ok(publishB.ok, `B 发布成功：${publishB.text}`)

  step('A 同步并合并 B 的分支')
  const syncA = await core.sync(configA, 'A')
  ok(syncA.ok, `A 同步成功：${syncA.text}`)
  const mergeB = await core.merge(configA, 'A', taskB.data.task.id)
  ok(mergeB.ok, `A 合并 B 成功：${mergeB.text}`)
  const showA = await git(['show', 'origin/main:smb-b.txt'], { cwd: cloneA })
  ok(showA.stdout.includes('SMB 上 B 写的文件'), 'main 上能看到 B 的文件')

  step('消息 / 任务板落盘检查')
  const send = await core.sendMessage(configA, 'A', { to: 'B', body: 'SMB 测试消息' })
  ok(send.ok, '消息发送成功')
  const boardRaw = await fs.stat(path.join(share, 'board', 'board.json'))
  ok(boardRaw.size > 0, '共享任务板 board.json 已写入')
  const board = await boardApi.readBoard(configA)
  ok(Object.keys(board.tasks).length >= 2, '任务板上有两个任务')
  ok(board.messages.some((message) => message.body.includes('SMB 测试消息')), '任务板上有消息')

  step('自检')
  const doctor = await core.doctor(configA, 'A')
  ok(doctor.text.includes('全部检查通过'), `A 自检通过：${doctor.text.split('\n').slice(-3).join(' / ')}`)

  process.stdout.write(`\nSMB 端到端测试全部通过：${passed} 个断言\n`)
} catch (error) {
  process.stderr.write(`\nSMB 测试失败：${error.stack || error.message}\n`)
  process.stderr.write(`保留路径：${share} / ${tempRoot}\n`)
  process.exitCode = 1
} finally {
  if (process.exitCode !== 1) {
    if (!keep) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
      if (!keep) await fs.rm(share, { recursive: true, force: true }).catch(() => {})
    } else {
      process.stdout.write(`保留路径：${share} / ${tempRoot}\n`)
    }
  }
}
