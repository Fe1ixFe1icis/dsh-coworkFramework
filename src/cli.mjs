#!/usr/bin/env node
/**
 * cowork 命令行入口。
 *
 * 用法示例：
 *   cowork init --share \\fileserver\cowork --agent A --dir D:\work\project
 *   cowork join --share \\fileserver\cowork --agent B --dir D:\work\project
 *   cowork status
 *   cowork task new "实现登录页"
 *   cowork save -m "T-0001: 完成登录页"
 *   cowork publish
 *   cowork review agent/B/T-0002
 *   cowork merge agent/B/T-0002
 *   cowork send B "我合并了你的分支"
 *   cowork inbox --mark-read
 */
import { resolveRepoContext } from './config.mjs'
import { TASK_STATUSES } from './board.mjs'
import * as core from './core.mjs'
import { takeFlag, takeOption } from './util.mjs'

const HELP = `cowork — 局域网共享工作区的 git 分支 + 任务板协作工具

用法:
  cowork <命令> [参数] [选项]

初始化 / 加入:
  cowork init  --share <共享目录> --agent <身份> [--dir <本地克隆目录>] [--project <名称>]
  cowork join  --share <共享目录> --agent <身份> [--dir <本地克隆目录>]

日常:
  cowork status [--no-fetch] [--json]
  cowork sync [--continue|--abort]
  cowork save [-m <提交说明>]
  cowork publish [-m <提交说明>]
  cowork review <任务号|分支名>
  cowork merge <任务号|分支名> [--keep-branch]
  cowork import <旧共享目录> [-m <提交说明>] [--no-overwrite]  把旧目录文件导入 main（迁移用）

任务:
  cowork task new <标题> [--desc <描述>] [--assign <身份>] [--files a,b] [--tags x,y] [--priority normal]
  cowork task claim <任务号> [--force]              --force 用于接管已指派给别人的任务
  cowork task update <任务号> [--status open|working|review|done|blocked] [--note <备注>] [--assign <身份|none>] [--owner <身份|none>]
  cowork task list [--open|--my|--review|--all] [--status <状态>]
  cowork task show <任务号>

协作:
  cowork send <身份|all> <消息> [--task <任务号>] [--subject <主题>]
  cowork inbox [--all] [--mark-read] [--limit <条数>]
  cowork members
  cowork doctor

其它:
  cowork remote                打印共享仓库地址
  cowork version / help

选项:
  --repo <目录>    指定本地克隆目录（默认从当前目录向上查找）
  --agent <身份>   临时覆盖本机身份
  --json           输出原始 JSON（便于脚本/agent 解析）

说明:
  共享目录布局 = <share>/repo.git（裸仓库）+ <share>/board（任务板）。
  每个协作者有一份本地克隆，在本地改代码，通过分支同步；不要直接改共享目录里的文件。
`

function fail(message) {
  process.stderr.write(`cowork: ${message}\n`)
  process.exitCode = 1
}

function print(result, options) {
  if (options.json) {
    process.stdout.write(JSON.stringify(result.data ?? result, null, 2) + '\n')
  } else if (result.text) {
    process.stdout.write(result.text + '\n')
  }
  if (!result.ok) process.exitCode = 1
}

function parseCommon(argv) {
  const options = { json: false, repo: null, agent: null }
  let rest = argv
  let taken = takeOption(rest, 'repo')
  options.repo = taken.value ?? null
  rest = taken.argv
  taken = takeOption(rest, 'agent')
  options.agent = taken.value ?? null
  rest = taken.argv
  const flag = takeFlag(rest, '--json')
  options.json = flag.value
  rest = flag.argv
  return { options, rest }
}

async function context(options) {
  const envAgent = process.env.COWORK_AGENT || null
  return resolveRepoContext({ repoPath: options.repo, agent: options.agent || envAgent })
}

export async function main(argv) {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP + '\n')
    return 0
  }
  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`cowork ${core.FRAMEWORK_VERSION}（Node ${process.version}）\n`)
    return 0
  }

  const command = argv[0]
  let args = argv.slice(1)
  const parsed = parseCommon(args)
  const options = parsed.options
  let rest = parsed.rest

  try {
    switch (command) {
      case 'init': {
        let opts = rest
        const share = takeOption(opts, 'share', { required: true })
        const agentOpt = takeOption(share.argv, 'agent')
        const dir = takeOption(agentOpt.argv, 'dir')
        const project = takeOption(dir.argv, 'project')
        const agent = options.agent || agentOpt.value
        if (!agent) return fail('缺少参数 --agent <身份>（例如 --agent A）')
        const result = await core.initWorkspace({
          shareRoot: share.value,
          agent,
          dir: dir.value,
          project: project.value,
        })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'join': {
        let opts = rest
        const share = takeOption(opts, 'share', { required: true })
        const agentOpt = takeOption(share.argv, 'agent')
        const dir = takeOption(agentOpt.argv, 'dir')
        const agent = options.agent || agentOpt.value
        if (!agent) return fail('缺少参数 --agent <身份>（例如 --agent B）')
        const result = await core.joinWorkspace({
          shareRoot: share.value,
          agent,
          dir: dir.value,
        })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'status': {
        const noFetch = takeFlag(rest, '--no-fetch')
        rest = noFetch.argv
        const { config, agent } = await context(options)
        const result = await core.status(config, agent, { fetch: !noFetch.value })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'sync': {
        const action = rest.find((item) => item === '--continue' || item === '--abort')
        const syncAction = action === '--continue' ? 'continue' : action === '--abort' ? 'abort' : 'start'
        const { config, agent } = await context(options)
        const result = await core.sync(config, agent, { action: syncAction })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'save': {
        const message = takeOption(rest, 'message', { short: '-m' })
        const { config, agent } = await context(options)
        const result = await core.save(config, agent, { message: message.value })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'publish': {
        const message = takeOption(rest, 'message', { short: '-m' })
        const { config, agent } = await context(options)
        const result = await core.publish(config, agent, { message: message.value })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'review': {
        const target = rest.find((item) => !item.startsWith('-'))
        if (!target) return fail('用法：cowork review <任务号|分支名>')
        const { config, agent } = await context(options)
        const result = await core.review(config, agent, target)
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'merge': {
        const keep = takeFlag(rest, '--keep-branch')
        rest = keep.argv
        const target = rest.find((item) => !item.startsWith('-'))
        if (!target) return fail('用法：cowork merge <任务号|分支名> [--keep-branch]')
        const { config, agent } = await context(options)
        const result = await core.merge(config, agent, target, { keepBranch: keep.value })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'import': {
        const message = takeOption(rest, 'message', { short: '-m' })
        rest = message.argv
        const noOverwrite = takeFlag(rest, '--no-overwrite')
        const source = noOverwrite.argv.find((item) => !item.startsWith('-'))
        if (!source) return fail('用法：cowork import <旧共享目录> [-m 提交说明] [--no-overwrite]')
        const { config, agent } = await context(options)
        const result = await core.importFiles(config, agent, source, {
          message: message.value,
          overwrite: !noOverwrite.value,
        })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'task':
        return await taskCommand(rest, options)
      case 'send': {
        const taskOpt = takeOption(rest, 'task')
        const subjectOpt = takeOption(taskOpt.argv, 'subject')
        const positional = subjectOpt.argv.filter((item) => !item.startsWith('-'))
        const to = positional[0]
        const body = positional.slice(1).join(' ')
        if (!to || !body) return fail('用法：cowork send <身份|all> <消息> [--task <任务号>] [--subject <主题>]')
        const { config, agent } = await context(options)
        const result = await core.sendMessage(config, agent, {
          to,
          body,
          taskId: taskOpt.value ?? null,
          subject: subjectOpt.value ?? '',
        })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'inbox': {
        const all = takeFlag(rest, '--all')
        rest = all.argv
        const markRead = takeFlag(rest, '--mark-read')
        rest = markRead.argv
        const limit = takeOption(rest, 'limit')
        const limitValue = limit.value ? Number.parseInt(limit.value, 10) : 20
        if (!Number.isInteger(limitValue) || limitValue < 1) {
          return fail('--limit 需要一个大于 0 的整数（例如 --limit 50）。')
        }
        const { config, agent } = await context(options)
        const result = await core.inbox(config, agent, {
          all: all.value,
          markRead: markRead.value,
          limit: limitValue,
        })
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'members': {
        const { config, agent } = await context(options)
        const result = await core.members(config, agent)
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'doctor': {
        const { config, agent } = await context(options)
        const result = await core.doctor(config, agent)
        print(result, options)
        return result.ok ? 0 : 1
      }
      case 'remote': {
        const { config } = await context(options)
        process.stdout.write(core.remoteDescription(config) + '\n')
        return 0
      }
      default:
        return fail(`未知命令：${command}\n\n${HELP}`)
    }
  } catch (error) {
    fail(error.message)
    return 1
  }
}

async function taskCommand(argv, options) {
  const sub = argv[0]
  const rest = argv.slice(1)
  if (!sub) return fail('用法：cowork task <new|claim|update|list|show> ...')
  switch (sub) {
    case 'new': {
      const assign = takeOption(rest, 'assign')
      const desc = takeOption(assign.argv, 'desc')
      const filesOpt = takeOption(desc.argv, 'files')
      const tagsOpt = takeOption(filesOpt.argv, 'tags')
      const priorityOpt = takeOption(tagsOpt.argv, 'priority')
      const title = priorityOpt.argv.filter((item) => !item.startsWith('-')).join(' ').trim()
      if (!title) return fail('用法：cowork task new <标题> [--desc 描述] [--assign 身份] [--priority normal]')
      const { config, agent } = await context(options)
      const result = await core.taskCreate(config, agent, {
        title,
        description: desc.value ?? '',
        assignee: assign.value ?? null,
        files: filesOpt.value ? filesOpt.value.split(',').map((item) => item.trim()).filter(Boolean) : [],
        tags: tagsOpt.value ? tagsOpt.value.split(',').map((item) => item.trim()).filter(Boolean) : [],
        priority: priorityOpt.value ?? 'normal',
      })
      print(result, options)
      return result.ok ? 0 : 1
    }
    case 'claim': {
      const force = takeFlag(rest, '--force')
      const taskId = force.argv.find((item) => !item.startsWith('-'))
      if (!taskId) return fail('用法：cowork task claim <任务号> [--force]')
      const { config, agent } = await context(options)
      const result = await core.taskClaim(config, agent, taskId, { force: force.value })
      print(result, options)
      return result.ok ? 0 : 1
    }
    case 'update': {
      const status = takeOption(rest, 'status')
      const note = takeOption(status.argv, 'note')
      const assign = takeOption(note.argv, 'assign')
      const owner = takeOption(assign.argv, 'owner')
      const taskId = owner.argv.find((item) => !item.startsWith('-'))
      if (!taskId) return fail('用法：cowork task update <任务号> [--status ...] [--note ...] [--owner ...]')
      if (status.value && !TASK_STATUSES.includes(status.value)) {
        return fail(`无效状态：${status.value}（可用：${TASK_STATUSES.join(', ')}）`)
      }
      const ownerValue = owner.value === undefined ? undefined : owner.value === 'none' ? null : owner.value
      const assigneeValue = assign.value === undefined ? undefined : assign.value === 'none' ? null : assign.value
      const { config, agent } = await context(options)
      const result = await core.taskUpdate(config, agent, taskId, {
        status: status.value,
        note: note.value,
        assignee: assigneeValue,
        owner: ownerValue,
      })
      print(result, options)
      return result.ok ? 0 : 1
    }
    case 'list': {
      const open = takeFlag(rest, '--open')
      const my = takeFlag(open.argv, '--my')
      const review = takeFlag(my.argv, '--review')
      const all = takeFlag(review.argv, '--all')
      const status = takeOption(all.argv, 'status')
      if (status.value && !TASK_STATUSES.includes(status.value)) {
        return fail(`无效状态：${status.value}（可用：${TASK_STATUSES.join(', ')}）`)
      }
      let filter = null
      if (status.value) filter = { status: status.value }
      else if (open.value) filter = { status: 'open' }
      else if (my.value) filter = { mine: true }
      else if (review.value) filter = { status: 'review' }
      else filter = { all: true }
      const { config, agent } = await context(options)
      const result = await core.taskList(config, agent, filter)
      print(result, options)
      return result.ok ? 0 : 1
    }
    case 'show': {
      const taskId = rest.find((item) => !item.startsWith('-'))
      if (!taskId) return fail('用法：cowork task show <任务号>')
      const { config, agent } = await context(options)
      const result = await core.taskShow(config, agent, taskId)
      print(result, options)
      return result.ok ? 0 : 1
    }
    default:
      return fail(`未知 task 子命令：${sub}`)
  }
}
