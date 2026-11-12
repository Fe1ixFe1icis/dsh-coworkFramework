/**
 * cowork 通用工具：路径展开、JSON 原子读写、跨机器文件锁、时间/字符串处理。
 *
 * 设计约束：
 * - 仅依赖 Node 内置模块，保证在两台只装了 Node（随 dsh 安装）的 Windows 机器上都能跑。
 * - 共享目录是 SMB 网络盘：rename 覆盖、O_EXCL 创建原子性在 SMB 上通常可用，
 *   这里仍然对失败做回退（copy 覆盖），并给锁加过期清理，避免崩溃后永久卡死。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'

/** 当前 UTC 时间（ISO 字符串）。 */
export function nowIso() {
  return new Date().toISOString()
}

/** 睡眠。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把 ~ / 环境变量 / 相对路径展开为绝对路径。 */
export function expandPath(input) {
  if (typeof input !== 'string' || input.trim() === '') return input
  let out = input.trim()
  if (out === '~') out = os.homedir()
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(os.homedir(), out.slice(2))
  out = out.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match)
  out = out.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name) => process.env[name] ?? match)
  return path.resolve(out)
}

/** 路径比较（Windows 大小写不敏感）。 */
export function samePath(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return IS_WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 递归创建目录。 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/** 读取 JSON；缺失且给了 fallback 时返回 fallback（对象会深拷贝）。 */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) {
      return typeof fallback === 'function' ? fallback() : structuredClone(fallback)
    }
    if (error instanceof SyntaxError) throw new Error(`JSON 解析失败：${file}：${error.message}`)
    throw new Error(`读取失败：${file}：${error.message}`)
  }
}

/** 原子写 JSON：先写临时文件再 rename，失败时回退 copy 覆盖（兼容个别 SMB 服务端）。 */
export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file))
  const text = JSON.stringify(value, null, 2) + '\n'
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    // Windows/SMB 上 rename 覆盖可能被拒绝，退化为 copy + 删除。
    try {
      await fs.copyFile(tmp, file)
      await fs.unlink(tmp).catch(() => {})
    } catch (copyError) {
      await fs.unlink(tmp).catch(() => {})
      throw new Error(`写入失败：${file}：${copyError.message}`, { cause: error })
    }
  }
}

/** 备份已有文件（用作共享板损坏后的回退）。 */
export async function backupFile(file) {
  try {
    await fs.copyFile(file, `${file}.bak`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/**
 * 跨机器文件锁。用 O_EXCL 创建锁文件；过期锁（默认 45 秒未更新）会被清除。
 * @param {string} lockFile 锁文件绝对路径（通常位于共享目录）。
 * @param {() => Promise<any>} fn 持有锁期间执行的回调。
 */
export async function withFileLock(lockFile, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000
  const staleMs = options.staleMs ?? 45000
  const label = options.label ?? path.basename(lockFile)
  const started = Date.now()
  const timeoutError = () =>
    new Error(
      `等待共享板锁超时（${label}，${Math.round(timeoutMs / 1000)} 秒）。` +
        `可能有另一台机器正在写入，稍后重试；若确认没有人在操作，可删除：${lockFile}`,
    )
  let delay = 40
  for (;;) {
    // 放在循环顶部：即使清理过期锁失败（只读锁文件/权限问题），也会在超时后退出而不是无限重试。
    if (Date.now() - started > timeoutMs) throw timeoutError()
    let handle
    try {
      await ensureDir(path.dirname(lockFile))
      handle = await fs.open(lockFile, 'wx')
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: os.hostname(), at: nowIso(), label }),
        'utf8',
      )
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      if (error.code !== 'EEXIST') {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          throw new Error(`无法在共享目录创建锁（检查共享写权限）：${lockFile}：${error.message}`)
        }
        throw error
      }
      // 锁被占用：过期就清理，否则退避重试。
      try {
        const stat = await fs.stat(lockFile)
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockFile).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      await sleep(delay + Math.random() * 40)
      delay = Math.min(Math.round(delay * 1.6), 600)
      continue
    }
    try {
      return await fn()
    } finally {
      await handle.close().catch(() => {})
      await fs.unlink(lockFile).catch(() => {})
    }
  }
}

/** 尽力追加一行事件到 JSONL（审计用，失败不影响主流程）。 */
export async function appendJsonl(file, value) {
  try {
    await ensureDir(path.dirname(file))
    await fs.appendFile(file, JSON.stringify(value) + '\n', 'utf8')
  } catch {
    // 审计日志失败不阻断协作流程。
  }
}

/** sha1 短哈希。 */
export function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

/** 截断字符串（用于表格/消息摘要）。 */
export function truncate(text, max = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** 本地时间显示。 */
export function formatLocalTime(iso) {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 把身份/任务名转换成可用的 git 分支片段（同时去掉路径分隔符，避免被当作文件名时穿越目录）。 */
export function sanitizeBranchSegment(input) {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[\u0000-\u001f\u007f\s~^:?*[\]\\/]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'agent'
}

/** 生成四位数序号 id。 */
export function sequenceId(prefix, seq) {
  return `${prefix}-${String(seq).padStart(4, '0')}`
}

/** 取本机局域网 IPv4（展示用，失败返回空数组）。 */
export function localIPv4List() {
  const result = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) result.push(info.address)
    }
  }
  return result
}

/** 判断路径是否是 UNC 网络路径。 */
export function isUncPath(input) {
  return typeof input === 'string' && input.startsWith('\\\\')
}

/** 命令参数里的 `--flag value` / `--flag=value` 解析辅助。 */
export function takeOption(argv, name, { short = null, required = false } = {}) {
  const index = argv.findIndex((item) => item === `--${name}` || (short && item === short) || item.startsWith(`--${name}=`))
  if (index === -1) {
    if (required) throw new Error(`缺少参数 --${name}`)
    return { value: undefined, argv }
  }
  const token = argv[index]
  if (token.includes('=') && token.startsWith(`--${name}=`)) {
    const value = token.slice(token.indexOf('=') + 1)
    const rest = argv.filter((_, i) => i !== index)
    return { value, argv: rest }
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    if (required) throw new Error(`缺少参数 --${name} 的值`)
    const rest = argv.filter((_, i) => i !== index)
    return { value: undefined, argv: rest }
  }
  const rest = argv.filter((_, i) => i !== index && i !== index + 1)
  return { value, argv: rest }
}

/** 取布尔开关（存在即 true）。 */
export function takeFlag(argv, ...names) {
  let found = false
  const rest = []
  for (const token of argv) {
    if (names.includes(token)) found = true
    else rest.push(token)
  }
  return { value: found, argv: rest }
}

/** 检查路径是否存在。 */
export function pathExists(target) {
  return existsSync(target)
}
