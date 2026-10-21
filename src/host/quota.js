/**
 * 额度读数（Quota）。
 *
 * Radeon Cloud 的网关在每个正常响应上回一组 `x-ratelimit-*` 头，服务端才知道
 * 真实的剩余额度：
 *
 *   x-ratelimit-limit-user-daily-usd: 1          x-ratelimit-remaining-user-daily-usd: 0.9999
 *   x-ratelimit-limit-user-rpm: 20               x-ratelimit-remaining-user-rpm: 19
 *   x-ratelimit-reset-user-daily-usd: 1792598400
 *
 * 这些头**只出现在真实请求的响应里**，没有独立的「查额度」端点，所以我们发一次
 * 1-token 的最小请求把额度读出来。成本可以忽略（`max_tokens: 1`），代价是会占用
 * 每分钟 20 次的配额 —— 因此这里有独立的 TTL（默认 60 秒）与单飞，绝不跟容量一起
 * 高频轮询。
 *
 * @module dsh-radeon-capacity/host/quota
 */

import { BASE_URL } from '../shared/catalog.js'

/** 默认缓存时长：额度变化慢，一分钟一次足够。 */
const DEFAULT_TTL_MS = 60_000
/** 探针请求超时。 */
const DEFAULT_TIMEOUT_MS = 30_000
/** 失败后的最短重试间隔。 */
const DEFAULT_RETRY_MS = 20_000

/**
 * 从响应头里读出额度。
 *
 * @param {Headers | Record<string, string> | undefined} headers 响应头
 * @returns {{dailyUsd: {limit: number, remaining: number, used: number, resetAt: number|null}, rpm: {limit: number, remaining: number}} | null} 读数；缺头时 null
 */
export function parseQuota(headers) {
  /**
   * 读一个头，兼容 Headers 与普通对象（测试里给的是后者）。
   *
   * @param {string} name 头名（小写）
   * @returns {string|null} 值
   */
  const get = (name) => {
    if (headers === undefined || headers === null) return null
    if (typeof headers.get === 'function') return headers.get(name)
    const hit = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
    return hit === undefined ? null : hit[1]
  }
  /**
   * 读成数字。
   *
   * @param {string} name 头名
   * @returns {number|null} 数字或 null
   */
  const num = (name) => {
    const raw = get(name)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  const dailyLimit = num('x-ratelimit-limit-user-daily-usd')
  const dailyRemaining = num('x-ratelimit-remaining-user-daily-usd')
  const rpmLimit = num('x-ratelimit-limit-user-rpm')
  const rpmRemaining = num('x-ratelimit-remaining-user-rpm')
  if (dailyLimit === null && rpmLimit === null) return null

  const dailyUsed = num('x-ratelimit-used-user-daily-usd')
  const resetSeconds = num('x-ratelimit-reset-user-daily-usd')
  return {
    dailyUsd: {
      limit: dailyLimit,
      remaining: dailyRemaining,
      used: dailyUsed ?? (dailyLimit !== null && dailyRemaining !== null ? Math.max(0, dailyLimit - dailyRemaining) : null),
      resetAt: resetSeconds === null ? null : resetSeconds * 1000,
    },
    rpm: { limit: rpmLimit, remaining: rpmRemaining },
  }
}

/**
 * 建一个额度数据源。
 *
 * @param {object} options
 * @param {() => Promise<{key: string, baseURL?: string} | null>} options.resolveAuth 每次探针前重新解析凭据
 * @param {() => string} [options.pickModel] 探针用哪个模型（默认用最便宜的 MiniCPM5-2B）
 * @param {typeof fetch} [options.fetchImpl] 便于测试注入
 * @param {() => number} [options.now] 便于测试注入
 * @param {string} [options.baseURL] 端点
 * @param {number} [options.ttlMs] 缓存时长
 * @param {number} [options.timeoutMs] 探针超时
 * @param {number} [options.retryMs] 失败重试间隔
 * @param {boolean} [options.enabled] 关掉探针（配置里可关）
 * @returns {{read: (force?: boolean) => Promise<object>, peek: () => object|null}}
 */
export function createQuotaSource(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const baseURL = options.baseURL ?? BASE_URL
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const enabled = options.enabled !== false
  const pickModel = options.pickModel ?? (() => 'MiniCPM5-2B')

  let cache = null
  let attempt = { at: 0, ok: false, error: null }
  let inflight = null

  /**
   * 视图。
   *
   * @returns {object} 视图
   */
  function view() {
    if (cache === null) {
      return {
        ok: false,
        quota: null,
        fetchedAt: null,
        ageMs: null,
        error: enabled ? (attempt.error ?? 'no data yet') : 'disabled',
      }
    }
    return {
      ok: true,
      quota: cache.quota,
      fetchedAt: cache.at,
      ageMs: Math.max(0, now() - cache.at),
      error: attempt.ok ? null : attempt.error,
    }
  }

  /**
   * 发一次 1-token 探针，把头读出来。
   *
   * @returns {Promise<object>} 视图
   */
  async function probe() {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const startedAt = now()
      try {
        const auth = await options.resolveAuth()
        if (auth === null || typeof auth.key !== 'string' || auth.key === '') {
          attempt = { at: startedAt, ok: false, error: 'no-credential' }
          return view()
        }
        const body = JSON.stringify({
          model: pickModel(),
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        })
        const response = await fetchImpl(`${(auth.baseURL ?? baseURL).replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${auth.key}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
        const quota = parseQuota(response.headers)
        // 429 也是有效读数：头里写着 remaining 是多少，只是这次没拿到内容。
        if (!response.ok && quota === null) {
          attempt = { at: startedAt, ok: false, error: `HTTP ${response.status}` }
          return view()
        }
        // 把响应体读完再丢弃，避免 keep-alive 连接挂着不回收。
        await response.arrayBuffer().catch(() => {})
        cache = { at: now(), quota }
        attempt = { at: cache.at, ok: true, error: null }
        return view()
      } catch (error) {
        attempt = { at: startedAt, ok: false, error: error instanceof Error ? error.message : String(error) }
        return view()
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * 读一次额度。
   *
   * @param {boolean} [force] 忽略 TTL 强制探一次（设置页「测试额度」用）
   * @returns {Promise<object>} 视图
   */
  async function read(force = false) {
    if (!enabled) return view()
    if (force) return probe()
    const ageMs = cache === null ? Number.POSITIVE_INFINITY : now() - cache.at
    if (ageMs < ttlMs && attempt.ok) return view()
    if (now() - attempt.at < retryMs) return view()
    probe().catch(() => {})
    return view()
  }

  return { read, peek: () => (cache === null ? null : view()) }
}
