#!/usr/bin/env node
/**
 * 插件单元/集成测试：用假 ctx 验证 cowork 插件注册的 13 个工具、系统提示段和步进提醒，
 * 并真实调用工具执行（在临时共享目录 + 本地克隆上跑 git 操作）。
 *
 * 运行：node tests/plugin.test.mjs
 * 前提：仓库根存在 node_modules 联接（install 前可用 tests/prepare-deps.ps1 或手工 junction）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const pluginUrl = new URL('../src/plugin.mjs', import.meta.url).href

let passed = 0
function ok(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
}

// 插件依赖 DSH 自带的三个包。普通贡献者/CI 没有这些包时跳过，而不是让 CI 红；
// 需要强制校验时设置 COWORK_REQUIRE_PLUGIN_DEPS=1（例如发版前的完整验证机）。
async function hasPluginDeps() {
  try {
    await import('@deepseek-ai/dsh-tools')
    await import('@deepseek-ai/schemastery')
    return true
  } catch {
    return false
  }
}

if (!(await hasPluginDeps())) {
  process.stdout.write(
    'SKIP：未找到 @deepseek-ai/dsh-tools / @deepseek-ai/schemastery。\n' +
      '插件测试需要 DSH 自带的依赖；先运行 install\\prepare-deps.ps1，或把本仓库 node_modules 联接到 DSH 的 node_modules。\n' +
      '设置 COWORK_REQUIRE_PLUGIN_DEPS=1 可让本测试在缺依赖时失败（CI 默认跳过）。\n',
  )
  if (process.env.COWORK_REQUIRE_PLUGIN_DEPS === '1') process.exitCode = 1
  process.exit()
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-plugin-'))
await fs.mkdir(path.join(tempRoot, '.cowork-home'), { recursive: true })
process.env.COWORK_HOME = path.join(tempRoot, '.cowork-home')
const share = path.join(tempRoot, 'share')
const clone = path.join(tempRoot, 'machineA', 'project')

try {
  process.stdout.write(`测试目录：${tempRoot}\n`)
  // 先按真实流程初始化共享工作区
  const core = await import('../src/core.mjs')
  const initResult = await core.initWorkspace({ shareRoot: share, agent: 'A', dir: clone, project: 'plugin-demo' })
  ok(initResult.ok, `初始化：${initResult.text}`)
  process.env.COWORK_REPO = clone
  process.env.COWORK_AGENT = 'A'

  const tools = new Map()
  const sections = []
  const listeners = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    logger: { warn() {} },
  }

  const plugin = await import(pluginUrl)
  ok(plugin.name === 'cowork', '插件导出 name=cowork')
  ok(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), '插件 inject 包含 tools')
  ok(typeof plugin.apply === 'function', '插件导出 apply')

  plugin.apply(ctx, { repoPath: clone, agent: 'A', notify: true })

  const expectedTools = [
    'cowork_status',
    'cowork_sync',
    'cowork_save',
    'cowork_publish',
    'cowork_review',
    'cowork_merge',
    'cowork_task_create',
    'cowork_task_claim',
    'cowork_task_update',
    'cowork_task_list',
    'cowork_send',
    'cowork_inbox',
    'cowork_doctor',
  ]
  ok(tools.size === expectedTools.length, `注册了 ${expectedTools.length} 个工具（实际 ${tools.size}：${[...tools.keys()].join(',')}）`)
  for (const name of expectedTools) ok(tools.has(name), `工具存在：${name}`)

  ok(sections.length === 1, '注册了 1 个系统提示段')
  ok(sections[0].name === 'cowork:protocol', '系统提示段名 cowork:protocol')
  ok(sections[0].text.includes('cowork'), '系统提示段包含 cowork 说明')
  ok(sections[0].text.includes('cowork_sync'), '系统提示段指导使用 cowork_sync')

  ok(listeners.has('agent/pre-step'), '注册了 agent/pre-step 监听器')

  async function callTool(name, args = {}) {
    const definition = tools.get(name)
    ok(definition && typeof definition.execute === 'function', `工具可执行：${name}`)
    return definition.execute(args, { agent: null, signal: { aborted: false } })
  }

  const statusText = await callTool('cowork_status', {})
  ok(typeof statusText === 'string', 'cowork_status 返回字符串')
  ok(statusText.includes('cowork 状态'), `cowork_status 输出：${statusText.slice(0, 80)}`)

  const createText = await callTool('cowork_task_create', {
    title: '插件任务 1',
    tags: ['plugin', 'ui'],
    priority: 'high',
  })
  ok(createText.includes('T-0001'), `cowork_task_create 输出任务号：${createText.slice(0, 120)}`)
  ok(createText.includes('agent/A/T-0001'), 'cowork_task_create 创建了任务分支')

  const boardApi = await import('../src/board.mjs')
  const { loadRepoConfig } = await import('../src/config.mjs')
  const repoConfig = await loadRepoConfig(clone)
  const createdTask = await boardApi.getTask(repoConfig, 'T-0001')
  ok(createdTask.priority === 'high', 'cowork_task_create 写入 priority')
  ok(createdTask.tags.includes('plugin'), 'cowork_task_create 写入 tags')

  const listText = await callTool('cowork_task_list', { filter: 'all' })
  ok(listText.includes('插件任务 1'), 'cowork_task_list 能看到任务')

  const saveText = await callTool('cowork_save', { message: 'T-0001: 插件测试提交' })
  ok(typeof saveText === 'string', 'cowork_save 返回字符串')

  const sendText = await callTool('cowork_send', { to: 'B', message: '请检查插件', subject: '插件通知' })
  ok(sendText.includes('已发送消息'), `cowork_send 输出：${sendText}`)

  const inboxText = await callTool('cowork_inbox', {})
  ok(typeof inboxText === 'string', 'cowork_inbox 返回字符串')

  const doctorText = await callTool('cowork_doctor', {})
  ok(doctorText.includes('cowork 自检'), 'cowork_doctor 输出自检')

  // 推送任务分支，让任务进入 review（这样步进提醒会有内容可注入）
  const publishText = await callTool('cowork_publish', {})
  ok(publishText.includes('已推送分支'), `cowork_publish 输出：${publishText.slice(0, 160)}`)

  // 模拟 agent 步进：应注入一条包含 system-reminder 的用户消息
  const preStep = listeners.get('agent/pre-step')
  const fakeAgent = { session: { id: 'test-session' } }
  const decision = { kind: 'accept', messages: [{ role: 'user', id: 'm1' }] }
  const next = async () => decision
  const result = await preStep({ agent: fakeAgent, messages: [], step: 1, signal: { throwIfAborted() {} } }, next)
  ok(Array.isArray(result.messages) && result.messages.length === 2, '步进提醒追加了一条消息')
  const injected = result.messages[result.messages.length - 1]
  ok(injected.role === 'user', '注入消息是 user 角色')
  const injectedText = JSON.stringify(injected.content)
  ok(injectedText.includes('system-reminder'), '注入内容包含 system-reminder')
  ok(injectedText.includes('cowork'), '注入内容包含 cowork 提示')
  ok(injected.source?.kind === 'cowork', '注入消息 source.kind=cowork')

  // 相同内容不应重复注入
  const second = await preStep({ agent: fakeAgent, messages: [], step: 2, signal: { throwIfAborted() {} } }, next)
  ok(second.messages.length === 1, '同一摘要不重复注入')

  process.stdout.write(`\n全部通过：${passed} 个断言\n`)
} catch (error) {
  process.stderr.write(`\n测试失败：${error.stack || error.message}\n`)
  process.stderr.write(`测试目录保留用于排查：${tempRoot}\n`)
  process.exitCode = 1
} finally {
  if (process.exitCode !== 1) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}
