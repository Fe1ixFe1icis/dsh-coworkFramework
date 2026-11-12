#!/usr/bin/env node
/**
 * 生成 GitHub Release 源码包：
 *   dist/cowork-framework-<version>.zip
 *   dist/cowork-framework-<version>.zip.sha256
 *
 * 使用 `git archive HEAD`，因此产物只包含已提交内容（可复现）；工作区有未提交改动时会提示。
 * 需要 git >= 2.30（框架本身已依赖 git）。
 *
 * 运行：npm run package
 * 可选：node scripts/package-release.mjs --out <目录> --ref <版本或提交>
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

async function git(args, options = {}) {
  return execFileAsync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...options })
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const version = String(packageJson.version || '').trim()
  if (!version) throw new Error('package.json 缺少 version')
  const ref = option('ref', 'HEAD')
  const outDir = path.resolve(root, option('out', 'dist'))
  const baseName = `cowork-framework-${version}`
  const zipPath = path.join(outDir, `${baseName}.zip`)
  const shaPath = `${zipPath}.sha256`

  const inside = await git(['rev-parse', '--is-inside-work-tree']).then((result) => result.stdout.trim() === 'true', () => false)
  if (!inside) {
    throw new Error('当前目录不是 git 仓库。发布包必须从已提交的内容生成：先 git init 并提交，或在 git clone 里运行。')
  }
  const status = await git(['status', '--porcelain'])
  if (status.stdout.trim() !== '') {
    process.stderr.write('警告：工作区有未提交改动，发布包只包含已提交内容（HEAD）。\n')
  }

  await fs.mkdir(outDir, { recursive: true })
  await fs.rm(zipPath, { force: true })
  await fs.rm(shaPath, { force: true })

  await git([
    'archive',
    '--format=zip',
    `--prefix=${baseName}/`,
    '-o',
    zipPath,
    ref,
  ])

  const buffer = await fs.readFile(zipPath)
  const hash = createHash('sha256').update(buffer).digest('hex')
  await fs.writeFile(shaPath, `${hash}  ${baseName}.zip\n`, 'utf8')

  const sizeKb = (buffer.length / 1024).toFixed(1)
  process.stdout.write(`已生成：${path.relative(root, zipPath)}（${sizeKb} KB，ref=${ref}）\n`)
  process.stdout.write(`SHA-256：${hash}\n`)
  process.stdout.write(`校验文件：${path.relative(root, shaPath)}\n`)
  process.stdout.write('GitHub Release 时把这两个文件一起上传即可。\n')
}

await main()
