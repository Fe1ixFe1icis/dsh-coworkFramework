/**
 * 配置：全局配置（每台机器一份）+ 仓库内配置（每个本地克隆一份）。
 *
 * 全局：~/.cowork/config.json
 *   用于记录本机身份（agent 名）、最近使用的本地克隆、共享目录。
 * 仓库：<本地克隆>/.cowork/config.json
 *   记录该克隆的 agent、共享目录、裸仓库目录名、任务板目录名等。
 *
 * 共享目录布局（shareRoot）：
 *   cowork.json          框架元数据
 *   repo.git/            裸 git 仓库（main + agent/* 分支）
 *   board/board.json     任务与消息板（跨机器锁保护）
 *   board/members/*.json 成员心跳
 */
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, expandPath, readJson, sanitizeBranchSegment, writeJsonAtomic } from './util.mjs'

/** 本机 cowork 全局目录（可用 COWORK_HOME 覆盖，测试/多身份场景用）。 */
export function coworkHomeDir() {
  const override = process.env.COWORK_HOME
  if (override && override.trim() !== '') return path.resolve(override.trim())
  return path.join(os.homedir(), '.cowork')
}

/** 全局配置文件路径。 */
export function globalConfigFile() {
  return path.join(coworkHomeDir(), 'config.json')
}

export const REPO_CONFIG_RELATIVE = path.join('.cowork', 'config.json')

/** 全局配置默认值。 */
export function defaultGlobalConfig() {
  return {
    formatVersion: 1,
    agent: null,
    repoPath: null,
    shareRoot: null,
    updatedAt: null,
  }
}

/** 读取全局配置（不存在时返回默认值，不写盘）。 */
export async function loadGlobalConfig() {
  const raw = await readJson(globalConfigFile(), defaultGlobalConfig)
  return { ...defaultGlobalConfig(), ...raw }
}

/** 写入全局配置。 */
export async function saveGlobalConfig(patch) {
  const current = await loadGlobalConfig()
  const next = { ...current, ...patch, formatVersion: 1, updatedAt: new Date().toISOString() }
  await ensureDir(coworkHomeDir())
  await writeJsonAtomic(globalConfigFile(), next)
  return next
}

/**
 * 判断一段 JSON 是否是「仓库配置」（而不是全局配置）。
 * 全局配置位于 ~/.cowork/config.json，和仓库里的 <clone>/.cowork/config.json 同名，
 * 所以必须用仓库独有字段来区分，否则用户主目录会被误判成仓库根。
 */
export function isRepoConfigShape(raw) {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      typeof raw.shareRoot === 'string' &&
      raw.shareRoot.trim() !== '' &&
      typeof raw.repoDir === 'string' &&
      typeof raw.mainBranch === 'string',
  )
}

/**
 * 从 startDir 向上查找 `.cowork/config.json` 文件路径（不校验内容，跳过全局配置目录）。
 * 用于区分「不在工作区」和「工作区配置损坏」两种情况，给用户更准确的错误。
 */
export function findRepoConfigFile(startDir = process.cwd()) {
  const globalHome = coworkHomeDir()
  let dir = path.resolve(startDir)
  for (;;) {
    if (dir.toLowerCase() !== globalHome.toLowerCase()) {
      const candidate = path.join(dir, REPO_CONFIG_RELATIVE)
      if (existsSync(candidate)) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 从 startDir 向上查找包含「仓库配置」的目录（会跳过全局配置目录，并校验配置形状）。 */
export function findRepoRoot(startDir = process.cwd()) {
  const globalHome = coworkHomeDir()
  let dir = path.resolve(startDir)
  for (;;) {
    const isCoworkHome = dir.toLowerCase() === globalHome.toLowerCase()
    if (!isCoworkHome) {
      const candidate = path.join(dir, REPO_CONFIG_RELATIVE)
      if (existsSync(candidate)) {
        try {
          const raw = JSON.parse(readFileSync(candidate, 'utf8'))
          if (isRepoConfigShape(raw)) return dir
        } catch {
          // 配置损坏：继续向上找，由 loadRepoConfig 的调用方给出错误
        }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 规范化仓库配置（填充默认值、展开路径）。 */
export function normalizeRepoConfig(root, raw) {
  const merged = {
    formatVersion: 1,
    agent: null,
    shareRoot: null,
    repoDir: 'repo.git',
    boardDir: 'board',
    remote: 'origin',
    mainBranch: 'main',
    branchPrefix: 'agent',
    project: null,
    createdAt: null,
    ...raw,
  }
  return {
    ...merged,
    root,
    shareRoot: merged.shareRoot ? expandPath(merged.shareRoot) : null,
  }
}

/** 读取指定目录（或向上查找）的仓库配置；找不到返回 null。 */
export async function loadRepoConfig(startDir = process.cwd()) {
  const root = findRepoRoot(startDir)
  if (!root) return null
  const raw = await readJson(path.join(root, REPO_CONFIG_RELATIVE), null)
  if (!raw || !isRepoConfigShape(raw)) return null
  if (raw.kind !== undefined && raw.kind !== 'repo') return null
  return normalizeRepoConfig(root, raw)
}

/** 写入仓库配置。 */
export async function saveRepoConfig(root, config) {
  const target = path.join(root, REPO_CONFIG_RELATIVE)
  await ensureDir(path.dirname(target))
  await writeJsonAtomic(target, { ...config, kind: 'repo', formatVersion: 1 })
}

/** 共享裸仓库路径。 */
export function shareRepoPath(config) {
  return path.join(config.shareRoot, config.repoDir)
}

/** 共享任务板目录。 */
export function boardDir(config) {
  return path.join(config.shareRoot, config.boardDir)
}

/** 共享任务板文件。 */
export function boardFile(config) {
  return path.join(boardDir(config), 'board.json')
}

/** 成员心跳目录。 */
export function membersDir(config) {
  return path.join(boardDir(config), 'members')
}

/** 共享目录元数据文件。 */
export function shareMetaFile(config) {
  return path.join(config.shareRoot, 'cowork.json')
}

/** 把本地 git 仓库地址变成可展示的字符串。 */
export function describeRemote(config) {
  return shareRepoPath(config)
}

/**
 * 解析命令使用的上下文：显式 --repo > 当前目录向上查找。
 * 不自动回退到全局配置里的默认克隆，避免在任意目录执行命令时误操作另一个仓库。
 * @returns {{root:string, config:object, agent:string}}
 */
export async function resolveRepoContext({ repoPath, agent, cwd = process.cwd() } = {}) {
  const explicit = repoPath ? expandPath(repoPath) : null
  const global = await loadGlobalConfig()
  const config = explicit ? await loadRepoConfig(explicit) : await loadRepoConfig(cwd)
  if (!config) {
    // 文件存在但内容不合法：不要笼统地说「不在工作区」，否则用户会反复 init/join。
    const broken = explicit ? path.join(explicit, REPO_CONFIG_RELATIVE) : findRepoConfigFile(cwd)
    if (broken && existsSync(broken)) {
      let parsed = null
      try {
        parsed = JSON.parse(readFileSync(broken, 'utf8'))
      } catch {
        parsed = null
      }
      // 兼容误放的全局配置（只有 repoPath/agent，没有 repoDir/mainBranch）：忽略它，
      // 继续按「不在工作区」处理，避免把用户主目录当成仓库。
      const looksLikeGlobal = parsed && typeof parsed === 'object' && !isRepoConfigShape(parsed) && typeof parsed.repoPath === 'string'
      if (!looksLikeGlobal) {
        throw new Error(
          `仓库配置存在但无法使用：${broken}\n` +
            '配置文件应是合法 JSON，并至少包含 shareRoot、repoDir、mainBranch 字段。\n' +
            '处理：恢复该文件的备份；或重新运行 cowork join --share <共享目录> --agent <身份> --dir <本克隆目录> 覆盖配置。',
        )
      }
    }
    const hint = []
    hint.push('当前目录不在 cowork 工作区内。')
    hint.push('如果还没有初始化：先运行 cowork init --share <共享目录> --agent <本机身份> --dir <本地克隆目录>')
    hint.push('如果克隆已存在：cd 到克隆目录，或用 --repo <克隆目录> 指定。')
    throw new Error(hint.join('\n'))
  }
  const finalAgent = agent || config.agent || global.agent
  if (!finalAgent) {
    throw new Error('这个克隆还没有配置 agent 身份。重新运行 cowork join/init 时用 --agent <身份> 指定。')
  }
  return { root: config.root, config, agent: finalAgent }
}

/**
 * 计算任务对应的分支名。
 * 显式传入的 agent（例如 CLI 的 --agent 覆盖）优先于仓库配置，避免分支挂到错误身份下。
 */
export function branchNameFor(config, agent, taskId) {
  const prefix = config.branchPrefix || 'agent'
  return `${prefix}/${sanitizeBranchSegment(agent ?? config.agent)}/${sanitizeBranchSegment(taskId)}`
}
