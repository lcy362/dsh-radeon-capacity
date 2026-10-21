#!/usr/bin/env node
/**
 * 真机冒烟：直接打 Radeon 的两个端点，确认表里的假设还成立。
 *
 * 它只读本机已存的凭据（`~/.dsh/.credentials.yaml` 的 `refs:` 段），
 * **不会打印密钥**，只打印读到的容量与额度。
 *
 *   node scripts/smoke.mjs
 *
 * 期望：容量端点 ~25 秒返回 13～16 个模型的 state/utilization；额度探针
 * 1 秒内返回，并带回 `x-ratelimit-*` 头。
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createCapacitySource } from '../src/host/load.js'
import { createQuotaSource } from '../src/host/quota.js'

/** 凭据文件名。 */
const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')

/**
 * 从 credentials.yaml 里抠出 refs 段的一个值。
 *
 * 故意不引 yaml 依赖：这个脚本要在任何环境的裸 node 里跑得起来。
 *
 * @param {string} text 文件内容
 * @param {string[]} refs 候选引用名
 * @returns {string|null} 第一个命中的密钥
 */
function findKey(text, refs) {
  for (const ref of refs) {
    // 两种写法都认：块式 `  REF: value` 与流式 `{ REF: value, ... }`。
    const match = new RegExp(`(?:^|[{,\\s])${ref}:\\s*([^,}\\s]+)`, 'm').exec(text)
    if (match !== null) return match[1].replace(/^['"]|['"]$/g, '')
  }
  return null
}

const text = await readFile(CREDENTIALS, 'utf8').catch(() => '')
const key = findKey(text, ['AMD_API_KEY', 'RADEON_CLOUD_API_KEY'])
if (key === null) {
  console.error('没在 ~/.dsh/.credentials.yaml 里找到 AMD_API_KEY / RADEON_CLOUD_API_KEY')
  process.exit(1)
}

const resolveAuth = async () => ({ key })

const capacity = createCapacitySource({ resolveAuth })
const quota = createQuotaSource({ resolveAuth })

console.log('容量端点（同步等待，实测 ~25 秒）…')
const started = Date.now()
const capacityView = await capacity.refresh()
console.log(`  耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，ok=${capacityView.ok}`)
if (capacityView.ok) {
  const entries = Object.entries(capacityView.models)
  console.log(`  模型数 ${entries.length}`)
  for (const [id, entry] of entries.slice(0, 6)) {
    console.log(`  - ${id}: ${entry.state} ${Math.round(entry.utilization)}% (${entry.label})`)
  }
} else {
  console.log(`  错误：${capacityView.error}`)
}

console.log('额度探针（1-token）…')
const quotaView = await quota.read(true)
if (quotaView.ok && quotaView.quota !== null) {
  const daily = quotaView.quota.dailyUsd
  const rpm = quotaView.quota.rpm
  console.log(`  当日额度 $${daily.remaining} / $${daily.limit}，本分钟剩余 ${rpm.remaining} / ${rpm.limit}`)
  if (daily.resetAt !== null) console.log(`  重置时间 ${new Date(daily.resetAt).toISOString()}`)
} else {
  console.log(`  错误：${quotaView.error}`)
}
