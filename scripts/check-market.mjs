#!/usr/bin/env node
/**
 * 校验 `market/index.json` 是不是合规的 DSH 插件市场 format 1 索引。
 *
 * 为什么要有这个脚本：内核那边用 `@deepseek-ai/dsh-plugin-market-index` 的
 * `parseMarketIndex` 严格校验，索引里任何一处不合规都会让整个来源在「发现」页
 * 直接报错。手写 JSON 很容易踩的几个点：
 *
 *   - `title` / `description` 必须是本地化对象且**含 `en`**（纯字符串也行，但对象必须带 en）
 *   - `publishTimestamp` 是**整数秒**（不是毫秒）
 *   - `git` source 的 `commit` 必须是 **40 位小写 hex**，分支/tag 一律不认
 *   - `versions[].version` 必须是**精确** SemVer，不能写 `^1.0.0`
 *   - `engines.dsh` 必须能被当前内核满足
 *
 * 校验器从内核包里加载；加载不到就退化成内置的等价检查（CI 上没装内核也能跑）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const INDEX_PATH = new URL('../market/index.json', import.meta.url)
const INDEX_URL = 'https://raw.githubusercontent.com/lcy362/dsh-radeon-capacity/main/market/index.json'

const problems = []
const fail = (message) => problems.push(message)

/** 读索引 JSON。 */
function readIndex() {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
  } catch (error) {
    console.error(`读不到 market/index.json：${error.message}`)
    process.exit(1)
  }
}

/** 尝试从内核包里取真正的校验器；拿不到就返回 null。 */
function kernelValidator() {
  const require = createRequire(import.meta.url)
  const candidates = [
    '@deepseek-ai/dsh-plugin-market-index',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js',
  ]
  for (const id of candidates) {
    try {
      return require(id)
    } catch {
      // 换下一个
    }
  }
  return null
}

/** 内置的等价检查：覆盖内核校验器里最容易踩的几条规则。 */
function builtinCheck(doc) {
  if (doc.format !== 1) fail('$.format 必须是 1')

  const localized = (value, path) => {
    if (typeof value === 'string') return
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(`${path} 必须是字符串或本地化对象`)
    }
    if (!Object.hasOwn(value, 'en')) fail(`${path} 必须含 en 键`)
  }
  localized(doc.title, '$.title')
  if (doc.description !== undefined) localized(doc.description, '$.description')

  if (!Array.isArray(doc.plugins) || doc.plugins.length === 0) fail('$.plugins 必须是非空数组')

  const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
  const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
  const COMMIT = /^[0-9a-f]{40}$/

  for (const [position, plugin] of (doc.plugins ?? []).entries()) {
    const at = `$.plugins[${position}]`
    if (typeof plugin.name !== 'string' || !NPM_NAME.test(plugin.name)) fail(`${at}.name 不是合法 npm 包名`)
    if (plugin.title !== undefined) localized(plugin.title, `${at}.title`)
    if (plugin.description !== undefined) localized(plugin.description, `${at}.description`)

    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
      fail(`${at}.versions 必须是非空数组`)
      continue
    }
    const seen = new Set()
    for (const [index, entry] of plugin.versions.entries()) {
      const versionAt = `${at}.versions[${index}]`
      if (typeof entry.version !== 'string' || !SEMVER.test(entry.version)) {
        fail(`${versionAt}.version 必须是精确 SemVer`)
      } else if (seen.has(entry.version)) {
        fail(`${versionAt}.version 重复了 ${entry.version}`)
      } else {
        seen.add(entry.version)
      }

      const stamp = entry.publishTimestamp
      if (!Number.isInteger(stamp) || stamp < 0 || stamp >= 1e11) {
        fail(`${versionAt}.publishTimestamp 必须是整数秒（不是毫秒）`)
      }

      const source = entry.source
      if (source === undefined || typeof source !== 'object') {
        fail(`${versionAt}.source 缺失`)
      } else if (source.type === 'git') {
        if (typeof source.commit !== 'string' || !COMMIT.test(source.commit)) {
          fail(`${versionAt}.source.commit 必须是 40 位小写 hex commit SHA（分支/tag 不认）`)
        }
        if (typeof source.url !== 'string' || !source.url.startsWith('https://')) {
          fail(`${versionAt}.source.url 必须是 https URL`)
        }
      } else if (source.type === 'npm') {
        // npm 源没有额外必填项
      } else {
        fail(`${versionAt}.source.type 必须是 "npm" 或 "git"`)
      }

      if (entry.engines?.dsh !== undefined) {
        if (entry.engines.dsh.startsWith('workspace:')) fail(`${versionAt}.engines.dsh 不能用 workspace: 范围`)
      }
    }
  }
}

const doc = readIndex()
const kernel = kernelValidator()

if (kernel !== null) {
  try {
    kernel.parseMarketIndex(doc, INDEX_URL)
    console.log('✓ 内核校验器通过')
  } catch (error) {
    fail(`内核校验器拒绝：${error.message}`)
  }
} else {
  builtinCheck(doc)
  console.log('· 内核校验器不可用，已用内置检查')
}

/**
 * commit 必须真实存在：索引指向一个不存在的 commit，安装时才会炸，太晚。
 *
 * https 不通的环境（例如本机 `github.com:443` 被墙、只有 ssh 可用）会回退到 ssh
 * 形态的同一仓库再查一次 —— 校验的是「这个 commit 在仓库里存在」，与走哪种协议
 * 取到它无关。两种都失败才算问题。
 */
const sshForm = (httpsUrl) => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(httpsUrl)
  return match === null ? null : `git@github.com:${match[1]}/${match[2]}.git`
}
const commitExists = (url, commit) => {
  const attempts = [url, sshForm(url)].filter((candidate) => candidate !== null)
  let lastError
  for (const candidate of attempts) {
    try {
      execFileSync('git', ['ls-remote', candidate, commit], {
        stdio: 'pipe',
        timeout: 20_000,
        env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
      })
      return true
    } catch (error) {
      lastError = error
    }
  }
  return lastError
}

for (const plugin of doc.plugins ?? []) {
  for (const entry of plugin.versions ?? []) {
    if (entry.source?.type !== 'git' || entry.source.commit === undefined) continue
    const result = commitExists(entry.source.url, entry.source.commit)
    if (result !== true) {
      fail(`${plugin.name}@${entry.version} 的 commit ${entry.source.commit} 在 ${entry.source.url} 上查不到（${result.message.split('\n')[0]}）`)
    }
  }
}

if (problems.length > 0) {
  console.error(`\n✗ market/index.json 有 ${problems.length} 处问题：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const plugins = doc.plugins ?? []
const versions = plugins.reduce((sum, plugin) => sum + (plugin.versions?.length ?? 0), 0)
console.log(`✓ market/index.json 合规：${plugins.length} 个插件、${versions} 个版本`)
