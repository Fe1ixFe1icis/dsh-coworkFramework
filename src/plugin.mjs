/**
 * DeepSeek Harness 插件：把 cowork 协作能力暴露成 cowork_* 工具。
 *
 * 安装：把本包放进 profile 的 node_modules，在 cordis.patch.yml 里 insert 一条：
 *   - insert:
 *       - id: cowork
 *         name: 'dsh-cowork-framework'
 *         config:
 *           repoPath: 'D:/work/project'
 *           agent: 'A'
 *           notify: true
 *
 * 功能：
 *  - 13 个 cowork_* 工具：状态/同步/提交/发布/评审/合并/任务/消息/自检；
 *  - 系统提示词里注入一段协作规则；
 *  - 每个 agent 步进前，把未读消息/待合并任务作为 <system-reminder> 注入会话（可关）。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { loadGlobalConfig, loadRepoConfig } from './config.mjs'
import { readBoard, summarizeBoard } from './board.mjs'
import * as core from './core.mjs'
import { sha1, truncate } from './util.mjs'

export const name = 'cowork'

/** 插件配置（在 profile 的 cordis.patch.yml 里给 cowork 条目的 config）。 */
export const Config = z.object({
  repoPath: z.string(),
  agent: z.string(),
  notify: z.boolean().default(true),
  fetchOnStatus: z.boolean().default(false),
})

export const inject = ['tools', 'systemPrompt']

const PROTOCOL_TEMPLATE = (agent, repoPath, shareRoot) => `## cowork 局域网协作

你在一个跨机器协作工作区里工作：另一台机器上的 DeepSeek Harness agent 与你共享同一个 git 仓库和任务板。
本机身份：${agent}；本地克隆：${repoPath}；共享仓库：${shareRoot || '（未配置）'}。

规则：
- 开工前先调用 cowork_sync 同步到最新 origin/main。
- 用 cowork_task_claim 认领任务（自动创建 agent/${agent}/<任务号> 分支）；新任务用 cowork_task_create。
- 改动只在本地克隆里做，禁止直接修改共享文件夹里的文件。
- 提交用 cowork_save；交付用 cowork_publish（自动同步 + 推送分支 + 任务置 review）。
- 合并同伴分支：先 cowork_review 看改动，再 cowork_merge 合并进 main。
- 沟通用 cowork_send / cowork_inbox；任务板用 cowork_task_list；环境异常用 cowork_doctor。`

/** 解析运行时上下文（repoPath/agent 来自插件配置、环境变量或全局配置）。 */
async function resolveContext(config) {
  const global = await loadGlobalConfig()
  const repoPath = process.env.COWORK_REPO || config.repoPath || global.repoPath
  if (!repoPath) {
    throw new Error(
      'cowork 插件未配置仓库路径：请在 profile 的 cordis.patch.yml 中为 cowork 条目设置 repoPath，' +
        '或设置环境变量 COWORK_REPO。示例：\n' +
        "  - insert:\n      - id: cowork\n        name: 'dsh-cowork-framework'\n        config:\n          repoPath: 'D:/work/project'\n          agent: 'A'",
    )
  }
  const repo = await loadRepoConfig(repoPath)
  if (!repo) {
    throw new Error(
      `找不到 cowork 仓库配置：${repoPath}\n` +
        '请先运行 cowork init/join 初始化，或用 --repo 指向本地克隆目录。',
    )
  }
  const agent = process.env.COWORK_AGENT || config.agent || repo.agent
  if (!agent) throw new Error('cowork 未配置本机身份 agent（插件配置或仓库 .cowork/config.json）。')
  return { config: repo, agent }
}

/** 简单 TTL 缓存，避免工具/步进钩子频繁读盘。 */
function createCache(ttlMs) {
  let value = null
  let hasValue = false
  let at = 0
  return {
    async get(loader) {
      if (hasValue && Date.now() - at < ttlMs) return value
      value = await loader()
      hasValue = true
      at = Date.now()
      return value
    },
    invalidate() {
      value = null
      hasValue = false
      at = 0
    },
  }
}

export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const contextCache = createCache(3000)
  const resolve = () => contextCache.get(() => resolveContext(config))
  const boardCache = createCache(4000)
  const lastDigestBySession = new Map()
  const registeredTools = []

  const tool = (definition) => {
    registeredTools.push(definition.name)
    return defineTool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters ?? {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
      },
      async execute(args) {
        const { config: repo, agent } = await resolve()
        try {
          const result = await definition.run(args ?? {}, repo, agent)
          if (typeof result === 'string') return result
          return String(result?.text ?? '')
        } catch (error) {
          throw new Error(`[cowork] ${error.message}`)
        } finally {
          boardCache.invalidate()
        }
      },
    })
  }

  ctx.tools.register(
    tool({
      name: 'cowork_status',
      description:
        '查看跨机器协作状态：当前分支/是否有未提交改动/与 origin/main 的领先落后、当前任务、任务板统计、未读消息、协作者在线状态。开始工作或不确定状态时先调用。',
      parameters: {
        refresh: {
          type: 'boolean',
          description: '是否联网 fetch 最新远程状态（默认 false，避免每次卡顿；需要最新数据时传 true）',
        },
      },
      async run(args, repo, agent) {
        const result = await core.status(repo, agent, { fetch: args.refresh ?? config.fetchOnStatus ?? false })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_sync',
      description:
        '把当前分支同步到最新 origin/main（fetch + rebase）。有冲突时会暂停并列出冲突文件；解决冲突后调用 action=continue；要放弃本次同步用 action=abort。',
      parameters: {
        action: {
          type: 'string',
          enum: ['start', 'continue', 'abort'],
          description: 'start=开始同步（默认）；continue=解决冲突后继续 rebase；abort=放弃本次 rebase',
        },
      },
      async run(args, repo, agent) {
        const result = await core.sync(repo, agent, { action: args.action ?? 'start' })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_save',
      description:
        '把本地克隆里的所有改动提交到当前分支（git add -A + commit），不推送。完成一小步就可以提交，减少冲突面。',
      parameters: {
        message: { type: 'string', description: '提交说明，例如 "T-0001: 完成登录页"' },
      },
      async run(args, repo, agent) {
        const result = await core.save(repo, agent, { message: args.message })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_publish',
      description:
        '交付当前分支：自动提交未提交改动 → 同步 origin/main → 推送分支 → 把关联任务置为 review（待合并）。完成一个任务时调用。',
      parameters: {
        message: { type: 'string', description: '可选的提交说明（有未提交改动时使用）' },
      },
      async run(args, repo, agent) {
        const result = await core.publish(repo, agent, { message: args.message })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_review',
      description:
        '查看某个远程分支相对 main 的提交列表、改动统计，以及是否可能与 main 冲突。合并同伴分支前先调用。',
      parameters: {
        target: { type: 'string', required: true, description: '任务号（T-0002）或分支名（agent/B/T-0002）' },
      },
      async run(args, repo, agent) {
        const result = await core.review(repo, agent, args.target)
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_merge',
      description:
        '把指定任务/分支合并进 main 并推送到共享仓库，关联任务标记为 done，默认删除已合并的远程分支。冲突时会自动中止并报告冲突文件。',
      parameters: {
        target: { type: 'string', required: true, description: '任务号或分支名' },
        keepBranch: { type: 'boolean', description: '合并后保留远程分支（默认删除）' },
      },
      async run(args, repo, agent) {
        const result = await core.merge(repo, agent, args.target, { keepBranch: Boolean(args.keepBranch) })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_task_create',
      description:
        '新建协作任务。不指定 assignee 时立即认领并创建 agent/<身份>/<任务号> 分支；指定 assignee 时任务交给同伴（open 状态）并自动发消息通知对方。',
      parameters: {
        title: { type: 'string', required: true, description: '任务标题' },
        description: { type: 'string', description: '任务说明/验收标准' },
        assignee: { type: 'string', description: '指派给哪台机器的身份（不填=自己做）' },
        files: { type: 'array', items: { type: 'string' }, description: '预计涉及的文件列表' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '优先级（默认 normal）',
        },
      },
      async run(args, repo, agent) {
        const result = await core.taskCreate(repo, agent, {
          title: args.title,
          description: args.description,
          assignee: args.assignee,
          files: args.files,
          tags: args.tags,
          priority: args.priority,
        })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_task_claim',
      description: '认领任务：把任务置为 working 并创建/切换到 agent/<身份>/<任务号> 分支。开始做一个任务前调用。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务号，例如 T-0001' },
        force: { type: 'boolean', description: '接管已指派给其他身份的任务时设为 true' },
      },
      async run(args, repo, agent) {
        const result = await core.taskClaim(repo, agent, args.taskId, { force: Boolean(args.force) })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_task_update',
      description: '更新任务状态或添加备注。状态：open/working/review/done/blocked。阻塞时用 blocked 并写备注说明原因。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务号' },
        status: {
          type: 'string',
          enum: ['open', 'working', 'review', 'done', 'blocked'],
          description: '新状态',
        },
        note: { type: 'string', description: '备注（会记录到任务备注里）' },
        assignee: { type: 'string', description: '改派给某个身份（传 none 表示取消指派）' },
        owner: { type: 'string', description: '设置/清除实际认领人（传 none 表示清除）' },
      },
      async run(args, repo, agent) {
        const owner = args.owner === undefined ? undefined : args.owner === 'none' ? null : args.owner
        const assignee = args.assignee === undefined ? undefined : args.assignee === 'none' ? null : args.assignee
        const result = await core.taskUpdate(repo, agent, args.taskId, {
          status: args.status,
          note: args.note,
          assignee,
          owner,
        })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_task_list',
      description: '查看共享任务板：全部任务、待认领、我的任务、待合并任务。了解整体分工时调用。',
      parameters: {
        filter: {
          type: 'string',
          enum: ['all', 'open', 'mine', 'review'],
          description: 'all=全部（默认）；open=待认领；mine=我的；review=待合并',
        },
      },
      async run(args, repo, agent) {
        const filter = args.filter ?? 'all'
        const options =
          filter === 'open'
            ? { status: 'open' }
            : filter === 'mine'
              ? { mine: true }
              : filter === 'review'
                ? { status: 'review' }
                : { all: true }
        const result = await core.taskList(repo, agent, options)
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_send',
      description: '给另一台机器的 agent 发协作消息（也会写入共享任务板，对方 DSH 会在步进前收到提醒）。',
      parameters: {
        to: { type: 'string', description: '收件人身份（例如 B）；不填则广播给所有人' },
        message: { type: 'string', required: true, description: '消息正文' },
        subject: { type: 'string', description: '主题（可选）' },
        taskId: { type: 'string', description: '关联的任务号（可选）' },
      },
      async run(args, repo, agent) {
        const result = await core.sendMessage(repo, agent, {
          to: args.to || 'all',
          body: args.message,
          subject: args.subject,
          taskId: args.taskId,
        })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_inbox',
      description: '查看跨机器收件箱（未读消息/任务通知），可用 markRead=true 标记已读。',
      parameters: {
        markRead: { type: 'boolean', description: '是否把本次看到的消息标记为已读' },
        all: { type: 'boolean', description: '是否包含所有方向的消息（默认只看发给自己的）' },
        limit: { type: 'integer', description: '最多显示多少条（默认 20）' },
      },
      async run(args, repo, agent) {
        const result = await core.inbox(repo, agent, {
          markRead: Boolean(args.markRead),
          all: Boolean(args.all),
          limit: typeof args.limit === 'number' ? args.limit : 20,
        })
        return result.text
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'cowork_doctor',
      description: '环境自检：git/共享目录/裸仓库/任务板/远程地址/锁/身份等检查项，协作出问题时调用。',
      parameters: {},
      async run(_args, repo, agent) {
        const result = await core.doctor(repo, agent)
        return result.text
      },
    }),
  )

  // 系统提示词：静态协议段（不读盘，避免 apply 阶段 I/O）。
  try {
    const agentName = config.agent || process.env.COWORK_AGENT || '<未配置>'
    const repoPath = config.repoPath || process.env.COWORK_REPO || '<未配置>'
    ctx.systemPrompt.section({
      name: 'cowork:protocol',
      order: 9000,
      text: PROTOCOL_TEMPLATE(agentName, repoPath, '见 .cowork/config.json'),
      interpolate: false,
    })
  } catch (error) {
    ctx.logger?.warn?.('cowork: 注册系统提示段失败：%s', error.message)
  }

  // 步进前注入未读消息/待合并任务提醒（只读共享板，4 秒缓存；失败静默）。
  if (config.notify !== false) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next()
      try {
        if (decision.kind === 'reject') return decision
        if (typeof signal?.throwIfAborted === 'function') signal.throwIfAborted()
        const digest = await boardCache.get(async () => {
          let resolved
          try {
            resolved = await resolve()
          } catch {
            return null
          }
          let board
          try {
            board = await readBoard(resolved.config)
          } catch {
            return null
          }
          const summary = summarizeBoard(board, resolved.agent)
          const unread = (board.messages ?? []).filter(
            (message) =>
              (message.to === resolved.agent || message.to === 'all' || !message.to) &&
              !(message.readBy ?? []).includes(resolved.agent),
          )
          const pending = summary.mine.filter((task) => task.status === 'review' || task.status === 'open')
          if (unread.length === 0 && pending.length === 0) return null
          const lines = ['<system-reminder>', '[cowork] 跨机器协作区有新情况：']
          for (const message of unread.slice(-5)) {
            lines.push(`- 未读消息 ${message.id} 来自 ${message.from}：${truncate(message.subject, 60)}`)
          }
          for (const task of pending.slice(0, 5)) {
            lines.push(`- 任务 ${task.id}「${truncate(task.title, 40)}」状态：${task.status}`)
          }
          lines.push('处理建议：cowork_inbox 查看消息；cowork_review / cowork_merge 处理待合并分支；cowork_task_list 查看任务板。')
          lines.push('</system-reminder>')
          const text = lines.join('\n')
          return { text, hash: sha1(text) }
        })
        if (!digest) return decision
        const { createUserMessage } = await getLlmHelpers()
        if (!createUserMessage) return decision
        const sessionId = agent?.session?.id ?? agent?.id ?? 'session'
        if (lastDigestBySession.get(sessionId) === digest.hash) return decision
        const message = createUserMessage({
          content: [{ type: 'text', text: digest.text }],
          source: { kind: 'cowork', form: 'digest' },
        })
        lastDigestBySession.set(sessionId, digest.hash)
        if (lastDigestBySession.size > 100) {
          const oldest = lastDigestBySession.keys().next().value
          lastDigestBySession.delete(oldest)
        }
        return { ...decision, messages: [...decision.messages, message] }
      } catch {
        return decision
      }
    })
  }

  try {
    ctx.logger?.info?.(
      'cowork: 插件已加载（agent=%s, repoPath=%s）',
      config.agent ?? process.env.COWORK_AGENT ?? '?',
      config.repoPath ?? process.env.COWORK_REPO ?? '?',
    )
  } catch {
    // 日志服务缺失时忽略
  }

  // 安装/排障探针：设置环境变量 COWORK_PROBE=1 时，把注册结果写到临时文件，便于验证插件在真实 dsh 里已生效。
  if (process.env.COWORK_PROBE === '1') {
    try {
      writeFileSync(
        joinPath(tmpdir(), 'cowork-plugin-probe.json'),
        JSON.stringify(
          {
            loadedAt: new Date().toISOString(),
            plugin: name,
            agent: config.agent ?? process.env.COWORK_AGENT ?? null,
            repoPath: config.repoPath ?? process.env.COWORK_REPO ?? null,
            tools: registeredTools,
            systemPromptSection: 'cowork:protocol',
            preStepHook: config.notify !== false,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      // 探针失败不影响插件
    }
  }
}

let llmHelpers = null
/** 懒加载 dsh-llm（不同 dsh 版本可能没有该导出；失败则禁用步进提醒而不是让插件加载失败）。 */
async function getLlmHelpers() {
  if (llmHelpers) return llmHelpers
  try {
    llmHelpers = await import('@deepseek-ai/dsh-llm')
  } catch {
    llmHelpers = {}
  }
  return llmHelpers
}
