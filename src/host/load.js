/**
 * 模型忙闲度（AI Capacity）数据源。
 *
 * 端点：`GET /radeon/api/tokenfactory/load` —— 与 Radeon Cloud 控制台
 * 「Token Factory 模型目录」页用的是同一个接口，返回每个模型的并发配额占用。
 *
 * 三个必须按它设计的实测事实：
 * 1. **慢**：服务端 TTFB 稳定在 ~25 秒（连发三次 24.4/25.0/25.1s），
 *    `cache-control: no-store`，`?model=` 之类的过滤参数无效。所以这里必须
 *    缓存 + 单飞；谁都不能每次打开选择器就直连上游。
 * 2. **集合会浮动**：不同时刻返回 13～16 个模型（只看当前有流量的），
 *    因此「查不到」是正常状态，界面按未知处理，不猜「空闲」。
 * 3. **未文档化**：它是控制台内部路由，随时可能消失，一切失败都要静默降级。
 *
 * @module dsh-radeon-capacity/host/load
 */

import { LOAD_URL } from '../shared/catalog.js'

/** 默认缓存时长：比上游 25 秒的延迟长一点，避免排队等自己的请求。 */
const DEFAULT_TTL_MS = 30_000
/** 单次请求超时：上游要 25 秒，留出余量。 */
const DEFAULT_TIMEOUT_MS = 45_000
/** 失败后的最小重试间隔，避免上游坏掉时被轮询打成雪崩。 */
const DEFAULT_RETRY_MS = 15_000
/** 超过这个年龄的缓存不再当作「当前」值，但仍会返回（界面自己标灰）。 */
const DEFAULT_STALE_MS = 900_000

/**
 * 归一化上游响应。
 *
 * 只保留界面要用的三个字段，并把可疑值挡在外面：上游可能多给字段，
 * 也可能给 `null` 的 utilization；我们不把任何原始 body 透传给浏览器。
 *
 * @param {unknown} body 上游 JSON
 * @returns {Record<string, {state: string, label: string, utilization: number}>} 模型 id → 读数
 */
export function normalizeLoad(body) {
  const models = body?.models
  if (models === null || typeof models !== 'object') return {}
  const out = {}
  for (const [id, value] of Object.entries(models)) {
    if (typeof id !== 'string' || id === '') continue
    if (value === null || typeof value !== 'object') continue
    const utilization = Number(value.utilization)
    const state = typeof value.state === 'string' ? value.state : 'unknown'
    const label = typeof value.label === 'string' ? value.label : state
    out[id] = {
      state,
      label,
      utilization: Number.isFinite(utilization) ? Math.max(0, Math.min(100, utilization)) : 0,
    }
  }
  return out
}

/**
 * 建一个容量数据源。
 *
 * @param {object} options
 * @param {() => Promise<{key: string, baseURL?: string} | null>} options.resolveAuth 每次刷新时重新解析凭据（支持中途换钥）
 * @param {typeof fetch} [options.fetchImpl] 便于测试注入
 * @param {() => number} [options.now] 便于测试注入
 * @param {string} [options.url] 上游地址
 * @param {number} [options.ttlMs] 缓存时长
 * @param {number} [options.timeoutMs] 单次超时
 * @param {number} [options.retryMs] 失败后的最短重试间隔
 * @param {number} [options.staleMs] 超过多久算「陈旧」
 * @returns {{read: () => Promise<object>, refresh: () => Promise<object>, peek: () => object|null}}
 */
export function createCapacitySource(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const url = options.url ?? LOAD_URL
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS

  /** 最近一次成功结果。 */
  let cache = null
  /** 最近一次尝试的结论（成功或失败），用于失败退避。 */
  let attempt = { at: 0, ok: false, error: null }
  /** 正在飞行的请求（单飞）。 */
  let inflight = null

  /**
   * 把缓存整理成交给界面的视图。
   *
   * @param {boolean} refreshing 是否正在后台刷新
   * @returns {object} 视图
   */
  function view(refreshing) {
    if (cache === null) {
      return {
        ok: false,
        models: {},
        fetchedAt: null,
        ageMs: null,
        stale: true,
        refreshing,
        error: attempt.error ?? 'no data yet',
      }
    }
    const ageMs = Math.max(0, now() - cache.at)
    return {
      ok: true,
      models: cache.models,
      fetchedAt: cache.at,
      ageMs,
      stale: ageMs > staleMs,
      refreshing,
      error: attempt.ok ? null : attempt.error,
    }
  }

  /**
   * 真正打一次上游。
   *
   * @returns {Promise<object>} 视图
   */
  async function refresh() {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const startedAt = now()
      try {
        const auth = await options.resolveAuth()
        if (auth === null || typeof auth.key !== 'string' || auth.key === '') {
          attempt = { at: startedAt, ok: false, error: 'no-credential' }
          return view(false)
        }
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${auth.key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
          attempt = { at: startedAt, ok: false, error: `HTTP ${response.status}` }
          return view(false)
        }
        const body = await response.json()
        cache = { at: now(), models: normalizeLoad(body) }
        attempt = { at: cache.at, ok: true, error: null }
        return view(false)
      } catch (error) {
        attempt = { at: startedAt, ok: false, error: error instanceof Error ? error.message : String(error) }
        return view(false)
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * 读一次。新鲜就给缓存，过期就**先回旧值再后台刷**（stale-while-revalidate）：
   * 界面永远不会挂在一次 25 秒的请求上。
   *
   * @returns {Promise<object>} 视图
   */
  async function read() {
    const ageMs = cache === null ? Number.POSITIVE_INFINITY : now() - cache.at
    if (ageMs < ttlMs && attempt.ok) return view(false)
    const sinceAttempt = now() - attempt.at
    if (sinceAttempt < retryMs) return view(false)
    // 不 await：调用方拿的是此刻能给出的最好答案，刷新在后台进行。
    refresh().catch(() => {})
    return view(cache !== null && ageMs >= ttlMs)
  }

  return { read, refresh, peek: () => (cache === null ? null : view(inflight !== null)) }
}
