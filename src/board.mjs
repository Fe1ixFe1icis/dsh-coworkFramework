/**
 * 共享任务板：tasks（任务）+ messages（跨机器消息）+ members（成员心跳）。
 *
 * 存储：<share>/board/board.json，所有写操作都在跨机器文件锁内完成；
 * 写前把旧文件复制成 board.json.bak，读到损坏 JSON 时自动回退到 .bak。
 *
 * 任务状态机：
 *   open → working（被认领）→ review（已推送分支待合并）→ done（已合并）
 *   任何状态都可以 → blocked（备注原因）
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendJsonl,
  backupFile,
  ensureDir,
  nowIso,
  readJson,
  sanitizeBranchSegment,
  sequenceId,
  truncate,
  withFileLock,
  writeJsonAtomic,
  localIPv4List,
} from './util.mjs'
import { boardDir, boardFile, membersDir } from './config.mjs'

export const TASK_STATUSES = ['open', 'working', 'review', 'done', 'blocked']
export const TASK_STATUS_LABELS = {
  open: '待认领',
  working: '进行中',
  review: '待合并',
  done: '已完成',
  blocked: '受阻',
}

/** 空任务板。 */
export function emptyBoard(project = '') {
  return {
    formatVersion: 1,
    project,
    seq: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    updatedBy: null,
    tasks: {},
    messages: [],
  }
}

/**
 * 读取任务板。
 * @param {object} config
 * @param {{allowMissing?:boolean}} options allowMissing=true 时文件缺失返回空板（初始化/写入路径用）；
 *   默认严格：文件缺失会抛错，避免「共享不可达」被误显示成「0 个任务」。
 */
export async function readBoard(config, options = {}) {
  const file = boardFile(config)
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (options.allowMissing) return emptyBoard(config.project ?? '')
      throw new Error(
        `任务板不存在：${file}\n` +
          '可能原因：共享目录不可访问，或这个共享目录还不是 cowork 工作区。\n' +
          '确认共享可访问；若是首次使用，请先运行 cowork init（或让另一台机器 init 后 cowork join）。',
      )
    }
    throw new Error(`读取任务板失败：${file}：${error.message}\n检查共享目录是否可访问、是否有读权限。`)
  }
  try {
    const board = JSON.parse(raw)
    if (!board || typeof board !== 'object' || Array.isArray(board)) {
      throw new Error('任务板顶层必须是 JSON 对象')
    }
    if (!board.tasks || typeof board.tasks !== 'object' || Array.isArray(board.tasks)) {
      throw new Error('任务板缺少 tasks 对象')
    }
    return board
  } catch (error) {
    // JSON 损坏：回退到上次写入前保留的 .bak
    try {
      const backup = await readJson(`${file}.bak`, null)
      if (backup) {
        backup.__recoveredFromBackup = true
        return backup
      }
    } catch {
      // 备份也不可用
    }
    throw new Error(
      `任务板文件损坏：${file}\n${error.message}\n` +
        '可尝试：把 board.json.bak 复制为 board.json，或让一台机器重新 cowork init 重建任务板。',
    )
  }
}

/**
 * 在跨机器锁内读-改-写任务板。
 * @param {object} config 仓库配置
 * @param {(board:object)=>Promise<any>|any} mutator 修改 board 并返回结果
 * @param {{audit?:object}} options
 */
export async function mutateBoard(config, mutator, options = {}) {
  const dir = boardDir(config)
  const file = boardFile(config)
  const lockFile = path.join(dir, '.board.lock')
  await ensureDir(dir)
  return withFileLock(
    lockFile,
    async () => {
      const board = await readBoard(config, { allowMissing: true })
      const recovered = Boolean(board.__recoveredFromBackup)
      delete board.__recoveredFromBackup
      const result = await mutator(board)
      board.updatedAt = nowIso()
      board.updatedBy = config.agent ?? null
      // 从 .bak 恢复出来的板子：不要用损坏的当前文件覆盖仍然完好的备份。
      if (!recovered) await backupFile(file)
      await writeJsonAtomic(file, board)
      if (options.audit) {
        await appendJsonl(path.join(dir, 'events.jsonl'), {
          at: board.updatedAt,
          by: config.agent ?? null,
          ...options.audit,
        })
      }
      return result
    },
    { label: 'board' },
  )
}

function nextSeq(board) {
  board.seq = (board.seq ?? 0) + 1
  return board.seq
}

/** 新建任务。返回任务对象。 */
export async function createTask(config, input) {
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('任务标题不能为空。')
  return mutateBoard(
    config,
    (board) => {
      const seq = nextSeq(board)
      const id = sequenceId('T', seq)
      const task = {
        id,
        title,
        description: String(input.description ?? '').trim(),
        status: 'open',
        assignee: input.assignee ?? null,
        owner: null,
        branch: null,
        files: Array.isArray(input.files) ? input.files : [],
        tags: Array.isArray(input.tags) ? input.tags : [],
        priority: input.priority ?? 'normal',
        createdAt: nowIso(),
        createdBy: config.agent,
        updatedAt: nowIso(),
        notes: [],
        history: [{ at: nowIso(), by: config.agent, action: 'create', detail: title }],
      }
      board.tasks[id] = task
      return task
    },
    { audit: { action: 'task/create', task: title } },
  )
}

/** 读取单个任务（返回 undefined 表示不存在）。 */
export async function getTask(config, taskId) {
  const board = await readBoard(config)
  return board.tasks[taskId]
}

/** 认领任务：owner=agent、status=working、branch=传入分支。 */
export async function claimTask(config, taskId, { agent, branch, force = false }) {
  return mutateBoard(
    config,
    (board) => {
      const task = board.tasks[taskId]
      if (!task) throw new Error(`任务不存在：${taskId}`)
      if (task.owner && task.owner !== agent && task.status !== 'open') {
        throw new Error(`任务 ${taskId} 已被 ${task.owner} 认领（状态：${task.status}）。`)
      }
      if (task.assignee && task.assignee !== agent && task.owner !== agent && !force) {
        throw new Error(
          `任务 ${taskId} 已指派给 ${task.assignee}，当前身份 ${agent} 不能直接认领。\n` +
            `如确认要接管，使用 --force（CLI）或 force=true（插件工具）。`,
        )
      }
      if (task.status === 'done') throw new Error(`任务 ${taskId} 已完成，不能重复认领。`)
      task.owner = agent
      task.branch = branch ?? task.branch
      task.status = 'working'
      task.updatedAt = nowIso()
      task.history.push({ at: nowIso(), by: agent, action: 'claim', detail: task.branch })
      return task
    },
    { audit: { action: 'task/claim', task: taskId, force: Boolean(force) } },
  )
}

/** 更新任务（状态 / 备注 / 指派人 / 分支）。 */
export async function updateTask(config, taskId, patch = {}) {
  const agent = patch.by ?? config.agent
  return mutateBoard(
    config,
    (board) => {
      const task = board.tasks[taskId]
      if (!task) throw new Error(`任务不存在：${taskId}`)
      if (patch.status !== undefined) {
        if (!TASK_STATUSES.includes(patch.status)) {
          throw new Error(`无效状态：${patch.status}（可用：${TASK_STATUSES.join(', ')}）`)
        }
        task.status = patch.status
      }
      if (patch.assignee !== undefined) task.assignee = patch.assignee
      if (patch.owner !== undefined) task.owner = patch.owner
      if (patch.branch !== undefined) task.branch = patch.branch
      if (patch.title !== undefined) task.title = String(patch.title).trim()
      if (patch.description !== undefined) task.description = String(patch.description)
      if (patch.priority !== undefined) task.priority = patch.priority
      if (patch.note) {
        task.notes.push({ at: nowIso(), by: agent, text: String(patch.note).trim() })
      }
      task.updatedAt = nowIso()
      task.history.push({
        at: nowIso(),
        by: agent,
        action: 'update',
        detail: patch.status ? `status=${patch.status}` : patch.note ? truncate(patch.note, 80) : 'update',
      })
      return task
    },
    { audit: { action: 'task/update', task: taskId, patch } },
  )
}

/** 任务列表（支持按状态/归属过滤）。 */
export async function listTasks(config, { agent, status = null, mine = false, all = false } = {}) {
  const board = await readBoard(config)
  let tasks = Object.values(board.tasks)
  if (all) return tasks
  if (status) tasks = tasks.filter((task) => task.status === status)
  if (mine) {
    tasks = tasks.filter(
      (task) => task.owner === agent || task.assignee === agent,
    )
  }
  return tasks
}

/** 任务板统计（供 status/board 使用）。 */
export function summarizeBoard(board, agent) {
  const tasks = Object.values(board.tasks ?? {})
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]))
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
  const mine = tasks.filter((task) => task.owner === agent || task.assignee === agent)
  const messages = board.messages ?? []
  const unread = messages.filter((message) => {
    const toMe = message.to === agent || message.to === 'all' || !message.to
    return toMe && !(message.readBy ?? []).includes(agent)
  })
  return {
    total: tasks.length,
    counts,
    mine: mine.map(projectTask),
    unread: unread.length,
    project: board.project ?? '',
    updatedAt: board.updatedAt,
    updatedBy: board.updatedBy,
    recoveredFromBackup: Boolean(board.__recoveredFromBackup),
  }
}

function projectTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner,
    assignee: task.assignee,
    branch: task.branch,
    files: task.files ?? [],
    updatedAt: task.updatedAt,
  }
}

/** 追加一条跨机器消息。 */
export async function addMessage(config, input) {
  const body = String(input.body ?? input.message ?? '').trim()
  if (!body) throw new Error('消息内容不能为空。')
  return mutateBoard(
    config,
    (board) => {
      const seq = nextSeq(board)
      const message = {
        id: sequenceId('M', seq),
        from: config.agent ?? input.from ?? 'unknown',
        to: input.to ?? 'all',
        subject: String(input.subject ?? '').trim() || truncate(body, 60),
        body,
        taskId: input.taskId ?? null,
        at: nowIso(),
        readBy: [],
      }
      board.messages.push(message)
      return message
    },
    { audit: { action: 'message/send', to: input.to ?? 'all' } },
  )
}

/** 收件箱：默认只看发给我的最近消息。 */
export async function readInbox(config, { agent, all = false, limit = 20 } = {}) {
  const board = await readBoard(config)
  const messages = (board.messages ?? []).filter((message) => {
    const toMe = message.to === agent || message.to === 'all' || !message.to
    return all || toMe
  })
  const sorted = [...messages].reverse().slice(0, limit)
  return sorted.map((message) => ({
    ...message,
    unread: !(message.readBy ?? []).includes(agent),
  }))
}

/** 把消息标记为已读。ids 为空时不做任何事（避免误把全部消息标记为已读）。 */
export async function markMessagesRead(config, agent, ids = []) {
  const wanted = new Set(ids)
  if (wanted.size === 0) return []
  return mutateBoard(
    config,
    (board) => {
      const changed = []
      for (const message of board.messages ?? []) {
        if (wanted.size > 0 && !wanted.has(message.id)) continue
        const readBy = new Set(message.readBy ?? [])
        if (!readBy.has(agent)) {
          readBy.add(agent)
          message.readBy = [...readBy]
          changed.push(message.id)
        }
      }
      return changed
    },
    { audit: { action: 'message/read', count: ids.length } },
  )
}

/** 写入本机成员心跳（各机器只写自己的文件，无需加锁）。 */
export async function touchMember(config, extra = {}) {
  const agent = config.agent
  if (!agent) return null
  // 身份来自配置，理论上已清洗；这里再做一次文件名清洗，避免手改配置造成路径穿越。
  const safeAgent = sanitizeBranchSegment(agent)
  const file = path.join(membersDir(config), `${safeAgent}.json`)
  const existing = await readJson(file, null).catch(() => null)
  const member = {
    agent,
    hostname: os.hostname(),
    ips: localIPv4List(),
    platform: process.platform,
    repoPath: config.root,
    lastSeen: nowIso(),
    firstSeen: existing?.firstSeen ?? nowIso(),
    ...extra,
  }
  await ensureDir(membersDir(config))
  await writeJsonAtomic(file, member)
  return member
}

/** 读取所有成员心跳。 */
export async function listMembers(config) {
  const dir = membersDir(config)
  let files = []
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const members = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      members.push(await readJson(path.join(dir, file), null))
    } catch {
      // 忽略损坏的心跳文件
    }
  }
  return members.filter(Boolean).sort((a, b) => String(a.agent).localeCompare(String(b.agent)))
}

/** 检查共享目录是否可读写（用于 status/doctor）。只做真实探测，不创建缺失的目录。 */
export async function probeShare(config) {
  // 探测共享根本身：即使还没 init（board/ 不存在）也能正确判断共享是否可达。
  const probe = path.join(config.shareRoot, `.probe-${os.hostname()}-${process.pid}-${Date.now()}.tmp`)
  try {
    const stat = await fs.stat(config.shareRoot)
    if (!stat.isDirectory()) return { ok: false, message: `共享路径不是目录：${config.shareRoot}` }
    await fs.writeFile(probe, nowIso(), 'utf8')
    await fs.unlink(probe).catch(() => {})
    return { ok: true, message: '共享目录可读写', shareRoot: config.shareRoot }
  } catch (error) {
    return { ok: false, message: `共享目录不可访问：${config.shareRoot}（${error.message}）`, shareRoot: config.shareRoot }
  }
}
