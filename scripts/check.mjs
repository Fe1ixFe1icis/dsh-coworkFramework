#!/usr/bin/env node
/**
 * 仓库自检（无第三方依赖）：
 *  1. 所有 .mjs/.js 文件通过 `node --check` 语法检查；
 *  2. package.json / core.mjs / CHANGELOG.md 版本一致；
 *  3. README/docs 里的相对 Markdown 链接都存在；
 *  4. 必需文件齐全；
 *  5. 源码和文档里没有泄漏内网地址/机器名（research/ 等本地目录不扫描）。
 *
 * 运行：node scripts/check.mjs
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const SKIP_DIRS = new Set(['.git', 'node_modules', 'work', 'work-b', 'dist', 'research', 'coverage', '.cowork'])
const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.ps1', '.cmd', '.txt'])

let failures = 0
function fail(message) {
  failures += 1
  process.stderr.write(`✘ ${message}\n`)
}
function pass(message) {
  process.stdout.write(`✔ ${message}\n`)
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitignore' && entry.name !== '.gitattributes' && entry.name !== '.editorconfig') {
      if (entry.isDirectory()) continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

async function runNodeCheck(file) {
  try {
    await execFileAsync(process.execPath, ['--check', file], { cwd: root, timeout: 60000 })
    return null
  } catch (error) {
    return String(error.stderr || error.message).trim()
  }
}

function extractLinks(markdown) {
  const links = []
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  let match
  while ((match = pattern.exec(markdown))) links.push(match[1])
  return links
}

async function main() {
  const files = await walk(root)
  const textFiles = files.filter((file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()))

  // 1. 语法检查
  const scripts = files.filter((file) => ['.mjs', '.js'].includes(path.extname(file).toLowerCase()))
  for (const file of scripts) {
    const error = await runNodeCheck(file)
    const relative = path.relative(root, file)
    if (error) fail(`语法错误：${relative}\n${error}`)
    else pass(`语法：${relative}`)
  }

  // 2. 版本一致
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const coreSource = await fs.readFile(path.join(root, 'src', 'core.mjs'), 'utf8')
  const coreVersion = coreSource.match(/export const FRAMEWORK_VERSION = '([^']+)'/)?.[1]
  const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8').catch(() => '')
  const changelogVersion = changelog.match(/^##\s*\[([^\]]+)\]/m)?.[1]
  if (!coreVersion) fail('src/core.mjs 里找不到 FRAMEWORK_VERSION')
  if (!changelogVersion) fail('CHANGELOG.md 里找不到 `## [x.y.z]` 版本标题')
  if (coreVersion !== packageJson.version) fail(`版本不一致：package.json=${packageJson.version}，core.mjs=${coreVersion}`)
  if (changelogVersion && changelogVersion !== packageJson.version) {
    fail(`版本不一致：package.json=${packageJson.version}，CHANGELOG.md=${changelogVersion}`)
  }
  if (coreVersion === packageJson.version && changelogVersion === packageJson.version) {
    pass(`版本一致：${packageJson.version}`)
  }

  // 3. 相对链接
  let checkedLinks = 0
  const markdownFiles = files.filter((file) => file.endsWith('.md'))
  for (const file of markdownFiles) {
    const markdown = await fs.readFile(file, 'utf8')
    for (const link of extractLinks(markdown)) {
      if (/^(?:https?:|mailto:|#)/.test(link)) continue
      const target = decodeURI(link.split('#')[0].split('?')[0])
      if (!target) continue
      checkedLinks += 1
      const resolved = path.resolve(path.dirname(file), target)
      const exists = await fs.stat(resolved).then(() => true, () => false)
      if (!exists) fail(`链接失效：${path.relative(root, file)} -> ${link}`)
    }
  }
  pass(`Markdown 相对链接：检查 ${checkedLinks} 个`)

  // 4. 必需文件
  const required = [
    'README.md',
    'README.zh.md',
    'LICENSE',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'AGENTS.md',
    'package.json',
    '.gitignore',
    '.gitattributes',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'src/core.mjs',
    'src/plugin.mjs',
    'bin/cowork.mjs',
    'install/install-dsh-plugin.ps1',
    'scripts/package-release.mjs',
  ]
  for (const relative of required) {
    const exists = await fs.stat(path.join(root, relative)).then(() => true, () => false)
    if (!exists) fail(`缺少必需文件：${relative}`)
  }
  if (!failures) pass(`必需文件：${required.length} 个齐全`)

  // 5. 隐私检查（不扫描 research/、dist/、work/ 等本地目录）
  const privacy = /10\.20\.\d{1,3}\.\d{1,3}|tbcShares|Administrator|D:\\coworkFramework/i
  for (const file of textFiles) {
    // 本文件包含用于检测的规则字面量，跳过自身。
    if (path.relative(root, file) === path.join('scripts', 'check.mjs')) continue
    const content = await fs.readFile(file, 'utf8').catch(() => '')
    if (privacy.test(content)) fail(`可能泄漏内网/机器特定信息：${path.relative(root, file)}`)
  }
  pass('隐私检查：源码与文档无内网地址/主机名')

  process.stdout.write('\n')
  if (failures > 0) {
    process.stderr.write(`检查失败：${failures} 项\n`)
    process.exit(1)
  }
  process.stdout.write(`检查通过：${scripts.length} 个脚本、${markdownFiles.length} 个 Markdown 文件\n`)
}

await main()
