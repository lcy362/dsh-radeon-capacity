/**
 * dsh-radeon-capacity —— 宿主半区。
 *
 * 这个插件只做三件事，全部围绕「把 Radeon Cloud 的实时水位搬进 DSH 界面」：
 *
 *   1. 容量：代理控制台的 `tokenfactory/load`，缓存 + 单飞 + 陈旧兜底，
 *      经同源只读路由交给浏览器半区（见 ./load.js）；
 *   2. 额度：一次 1-token 探针把 `x-ratelimit-*` 头读出来（见 ./quota.js）；
 *   3. 配置：可选地把 provider 写进**用户层**（`ctx.settings.update` 落到 profile
 *      补丁），所以卸载本插件之后 provider 仍然在、仍然能用（见 ./provider.js）。
 *
 * 它不接管任何模型调用：传输、思考字段、用量计量仍由 DSH 自带的 `dsh-llm-pi-ai`
 * 承担。也没有 provider 定义藏在插件自己的 bundle 层 —— 那是「卸载即失联」的
 * 做法，与本插件「配置要能活过卸载」的目标相反。
 *
 * @module dsh-radeon-capacity
 */

import {
  BASE_URL,
  DEFAULT_API_KEY_ENV,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_PROVIDER_ID,
  MODELS,
} from '../shared/catalog.js'
import { createCapacitySource } from './load.js'
import { createQuotaSource } from './quota.js'
import { describeProvider, findRadeonProvider, writeProviderConfig } from './provider.js'
import { createRoutes } from './routes.js'

/** 插件注册名（必须与 package.json 的 name 一致）。 */
export const name = 'dsh-radeon-capacity'

/**
 * 宿主侧不强制任何服务：`webServer` / `settings` / `credentials` 全部按需
 * `ctx.get()` 取，缺了就降级（界面显示「不可用」而不是整个插件加载失败）。
 */
export const inject = []

/** provider 探测结果的缓存时长：describe() 会投影整份配置，没必要每次轮询都算。 */
const DETECT_TTL_MS = 10_000

/**
 * 插件主体。
 *
 * @param {any} ctx 宿主 Cordis 上下文
 * @param {object} [config] 插件配置（见 README「配置」）
 */
export function apply(ctx, config = {}) {
  const options = {
    providerId: typeof config?.providerId === 'string' && config.providerId !== '' ? config.providerId : DEFAULT_PROVIDER_ID,
    apiKeyEnv: typeof config?.apiKeyEnv === 'string' && config.apiKeyEnv !== '' ? config.apiKeyEnv : DEFAULT_API_KEY_ENV,
    displayName: typeof config?.displayName === 'string' && config.displayName !== '' ? config.displayName : DEFAULT_DISPLAY_NAME,
    baseURL: typeof config?.baseURL === 'string' && config.baseURL !== '' ? config.baseURL : BASE_URL,
    quotaProbe: config?.quotaProbe !== false,
  }

  /** provider 探测缓存。 */
  let detected = { at: 0, value: null }

  /**
   * 现在到底有没有 Radeon provider，是哪一个。
   *
   * @returns {{ns: string, id: string, provider: any} | null} 命中项
   */
  function detect() {
    const now = Date.now()
    if (now - detected.at < DETECT_TTL_MS) return detected.value
    const settings = ctx.get('settings')
    let descriptors = []
    if (settings !== undefined && typeof settings.describe === 'function') {
      try {
        descriptors = settings.describe({ redactSecrets: true })
      } catch {
        descriptors = []
      }
    }
    detected = { at: now, value: findRadeonProvider(descriptors) }
    return detected.value
  }

  /**
   * 解析一次调用要用的凭据。
   *
   * 顺序：探测到的 provider 自己的 `apiKeyEnv` → 插件配置的 ref → 社区插件常用的
   * `RADEON_CLOUD_API_KEY`。每次都重新解析，用户在设置页换钥后下一次刷新即生效。
   *
   * @returns {Promise<{key: string, baseURL: string, ref: string} | null>} 凭据；没有则 null
   */
  async function resolveAuth() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.resolve !== 'function') return null
    const found = detect()
    const candidates = []
    if (typeof found?.provider?.apiKeyEnv === 'string' && found.provider.apiKeyEnv !== '') {
      candidates.push({ ref: found.provider.apiKeyEnv, baseURL: found.provider.baseURL })
    }
    candidates.push({ ref: options.apiKeyEnv, baseURL: options.baseURL })
    candidates.push({ ref: 'RADEON_CLOUD_API_KEY', baseURL: options.baseURL })
    for (const candidate of candidates) {
      try {
        const resolved = await credentials.resolve(candidate.ref)
        if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value !== '') {
          return {
            key: resolved.value,
            baseURL: typeof candidate.baseURL === 'string' && candidate.baseURL !== '' ? candidate.baseURL : options.baseURL,
            ref: candidate.ref,
          }
        }
      } catch {
        // 单个 ref 解析失败不影响下一个候选。
      }
    }
    return null
  }

  const capacity = createCapacitySource({
    resolveAuth,
    ttlMs: typeof config?.capacityTtlMs === 'number' ? config.capacityTtlMs : undefined,
  })
  const quota = createQuotaSource({
    resolveAuth,
    enabled: options.quotaProbe,
    ttlMs: typeof config?.quotaTtlMs === 'number' ? config.quotaTtlMs : undefined,
  })

  /**
   * 交给浏览器的完整视图。
   *
   * @returns {Promise<object>} 状态
   */
  async function state() {
    const found = detect()
    const [capacityView, quotaView] = await Promise.all([capacity.read(), quota.read()])
    const credentials = ctx.get('credentials')
    let credentialConfigured = false
    let credentialRef = found?.provider?.apiKeyEnv ?? options.apiKeyEnv
    if (credentials !== undefined && typeof credentials.describe === 'function' && typeof credentialRef === 'string') {
      try {
        const described = await credentials.describe(credentialRef)
        credentialConfigured = described?.configured === true
      } catch {
        credentialConfigured = false
      }
    }
    return {
      provider: found === null ? null : describeProvider(found),
      providerId: found?.id ?? options.providerId,
      suggested: {
        providerId: options.providerId,
        apiKeyEnv: options.apiKeyEnv,
        displayName: options.displayName,
        baseURL: options.baseURL,
      },
      credential: { ref: credentialRef, configured: credentialConfigured },
      capacity: capacityView,
      quota: quotaView,
      now: Date.now(),
    }
  }

  /**
   * 强制刷新容量（界面上的「立即刷新」按钮）。
   *
   * @param {boolean} force 是否连额度探针一起跑
   * @returns {Promise<void>} 完成
   */
  async function refresh(force) {
    await capacity.refresh()
    if (force) await quota.read(true)
  }

  /**
   * 问上游「你现在到底有哪几个模型」。
   *
   * 为什么要这一步：`catalog.js` 里的档位表是实测快照（10 个），而上游的目录
   * 会新增模型（2026-10 实测多了 Gemma-4-31B-IT / Clef / d3）。不发现就会
   * 出现「线上有、DSH 里选不到」。发现到的未实测模型按 `reasoningEfforts: false`
   * 写入 —— 猜档位会 400，关掉档位至少能对话。
   *
   * @returns {Promise<object>} `{ models: [{id, contextWindow, known}], measured: string[] }`
   */
  async function discover() {
    const auth = await resolveAuth()
    if (auth === null) throw new Error('没有可用的 API 密钥：请先在下方填写密钥')
    const response = await fetch(`${auth.baseURL.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${auth.key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`目录接口返回 HTTP ${response.status}`)
    const body = await response.json()
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const models = list
      .filter((model) => typeof model?.id === 'string' && model.id !== '')
      // context_length 为 0 的是非对话模型（如 MinerU2.5-Pro 走 /v1/ocr），别收。
      .filter((model) => Number(model?.context_length ?? model?.context_window ?? 0) > 0)
      .map((model) => ({
        id: model.id,
        contextWindow: Number(model.context_length ?? model.context_window ?? 0),
        known: MODELS.some((known) => known.id === model.id),
      }))
    return { models, measured: MODELS.map((model) => model.id) }
  }

  /**
   * 写入 provider（用户层）+ 可选存密钥。
   *
   * @param {any} input 请求体
   * @returns {Promise<object>} 写入结果
   */
  async function writeConfig(input) {
    const providerId = typeof input?.providerId === 'string' && input.providerId !== '' ? input.providerId : options.providerId
    if (!/^[a-z][a-z0-9-]*$/.test(providerId)) {
      throw new Error('provider id 只能是小写字母开头的字母/数字/连字符（例：amd、radeon-cloud）')
    }
    const apiKeyEnv = typeof input?.apiKeyEnv === 'string' && input.apiKeyEnv !== '' ? input.apiKeyEnv : options.apiKeyEnv
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new Error('凭据引用名必须是 shell 标识符（例：AMD_API_KEY）')
    }
    const modelIds = Array.isArray(input?.modelIds) ? input.modelIds.filter((id) => typeof id === 'string' && id !== '') : undefined
    const extraModels = Array.isArray(input?.extraModels)
      ? input.extraModels.filter((model) => typeof model?.id === 'string' && model.id !== '')
      : undefined
    const written = await writeProviderConfig(
      { settings: ctx.get('settings'), credentials: ctx.get('credentials') },
      {
        providerId,
        apiKeyEnv,
        displayName: typeof input?.displayName === 'string' && input.displayName !== '' ? input.displayName : options.displayName,
        modelIds,
        extraModels,
        baseURL: typeof input?.baseURL === 'string' && input.baseURL !== '' ? input.baseURL : options.baseURL,
        apiKey: typeof input?.apiKey === 'string' ? input.apiKey : '',
        entryId: typeof input?.entryId === 'string' ? input.entryId : undefined,
      },
    )
    // 刚写完，探测缓存立刻作废。
    detected = { at: 0, value: null }
    return written
  }

  ctx.inject(['webServer'], (scope) => {
    const route = createRoutes({
      state,
      refresh,
      writeConfig,
      discover,
      log: (error) => ctx.logger?.warn?.('[dsh-radeon-capacity] %s', error instanceof Error ? error.message : String(error)),
    })
    scope.effect(() => scope.webServer.register(route), 'dsh-radeon-capacity: /api/radeon-capacity routes')

    // 启动时预热一次容量：它要 25 秒，等用户打开选择器再拉就太晚了。
    // 失败无所谓（没配密钥时必然失败），只是省掉第一次的空白。
    capacity.read().catch(() => {})
  })
}
