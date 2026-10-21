/**
 * Radeon Cloud 的静态知识：端点、模型目录、思考档位表。
 *
 * 为什么要有这张表：Radeon 的模型目录接口（`GET /v1/models`）**不返回**
 * 思考档位（`reasoning_effort`）与上下文窗口的可用性，只返回架构、价格与
 * 是否支持工具。哪几个档位真的被接受，只能逐个实测。这份表就是实测结果，
 * 也是本插件「一键配置 provider」时写进配置的内容。
 *
 * 档位形状有四种，别按厂商归并（同一个 MiniCPM 系里两个模型就不一样）：
 *   1. 全档：off(none) + minimal/low/medium/high/xhigh/max
 *   2. Qwen 系：off(none) + low/medium/xhigh（传 high 会 400）
 *   3. GLM 系与 MiniCPM-V-4.7-1B：只有 low/medium/high，**不能关思考**
 *   4. 不返回分离思考内容：MiniCPM5-2B —— 声明 `false`，不给档位控件
 *
 * 数据来源：社区插件 `@zhz8888/dsh-radeon-cloud-patcher@1.3.0`（MIT）对线上端点的
 * 逐项实测，2026-10 复核；本插件在 `scripts/probe-efforts.mjs` 里保留复测能力。
 */

/** Token Factory 的 OpenAI 兼容端点（中国大陆站点）。 */
export const BASE_URL = 'https://developer.amd.com.cn/radeon/api/v1'

/** 容量/忙闲度端点。它是控制台内部路由，不在公开文档里，因此一切按「可能失效」处理。 */
export const LOAD_URL = 'https://developer.amd.com.cn/radeon/api/tokenfactory/load'

/** 命中 Radeon 的判据：provider 的 baseURL 里出现这个片段即认定为自己人。 */
export const BASE_URL_HINT = 'developer.amd.com.cn'

/** 新建 provider 时的默认值（都可在设置页改）。 */
export const DEFAULT_PROVIDER_ID = 'amd'
export const DEFAULT_API_KEY_ENV = 'AMD_API_KEY'
export const DEFAULT_DISPLAY_NAME = 'Radeon Cloud'

/** 全档接受的档位表（键是 DSH 的档位名，值是线上要发的 `reasoning_effort`）。 */
const ALL_TIERS = {
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** Qwen 系：没有 minimal/high/max，关思考只能走 none。 */
const QWEN_TIERS = { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' }

/** 只有三档、无法关闭思考。 */
const BASIC_TIERS = { low: 'low', medium: 'medium', high: 'high' }

/**
 * 10 个对话模型。`MinerU2.5-Pro` 刻意不收：它走 `/v1/ocr`，目录里
 * `context_length` 为 0、`tools` 为 false，当对话模型用必然失败。
 */
export const MODELS = [
  {
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1048576,
    input: ['text', 'image'],
    reasoningEfforts: ALL_TIERS,
  },
  {
    id: 'DeepSeek-V4-Flash',
    name: 'DeepSeek-V4-Flash',
    contextWindow: 1048576,
    input: ['text'],
    reasoningEfforts: ALL_TIERS,
  },
  {
    id: 'DeepSeek-V4-Flash-Vision-Exp',
    name: 'DeepSeek-V4-Flash-Vision-Exp',
    contextWindow: 1048576,
    input: ['text', 'image'],
    reasoningEfforts: ALL_TIERS,
  },
  {
    id: 'MiMo-V2.6-Flash',
    name: 'MiMo-V2.6-Flash',
    contextWindow: 1048576,
    input: ['text', 'image'],
    reasoningEfforts: ALL_TIERS,
  },
  {
    id: 'MiniCPM-V-4.7-35B-A3B',
    name: 'MiniCPM-V-4.7-35B-A3B',
    contextWindow: 262144,
    input: ['text', 'image'],
    reasoningEfforts: ALL_TIERS,
  },
  {
    id: 'Qwen3.8-27B',
    name: 'Qwen3.8-27B',
    contextWindow: 262144,
    input: ['text', 'image'],
    reasoningEfforts: QWEN_TIERS,
  },
  {
    id: 'Qwen3.8-Flash-Next',
    name: 'Qwen3.8-Flash-Next',
    contextWindow: 262144,
    input: ['text', 'image'],
    reasoningEfforts: QWEN_TIERS,
  },
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 262144,
    input: ['text'],
    reasoningEfforts: BASIC_TIERS,
  },
  {
    id: 'MiniCPM-V-4.7-1B',
    name: 'MiniCPM-V-4.7-1B',
    contextWindow: 262144,
    input: ['text', 'image'],
    reasoningEfforts: BASIC_TIERS,
  },
  {
    id: 'MiniCPM5-2B',
    name: 'MiniCPM5-2B',
    contextWindow: 131072,
    input: ['text'],
    // 接受 low/medium/high，但不返回分离的思考内容（reasoning 恒空、reasoning_tokens 为 0）。
    reasoningEfforts: false,
  },
]

/** 默认勾选的模型 id（设置页「一键配置」时用全部）。 */
export const DEFAULT_MODEL_IDS = MODELS.map((model) => model.id)

/**
 * provider 定义里那些与模型无关、但决定「能不能正常对话」的参数。
 *
 * 每条都对应一个线上实测结论，改之前先读注释：
 * - `supportsDeveloperRole: false`：10 个模型里 6 个直接拒绝 DSH 默认发的
 *   developer 角色（422 unknown role / 400 Unexpected message role）。
 * - `supportsThinkingTokenBudget: false`：网关按白名单转发，thinking_budget
 *   三种写法全被静默丢弃，开了只会让人以为设上了。
 * - `maxTokensField: max_tokens`：网关不认 max_completion_tokens。
 * - `thinkingFormat: openai`：`reasoning_effort` 走 OpenAI 的字段形状。
 * - `defaultMaxTokens: 32768`：思考与回答共用预算，预算太小会把回答挤成空字符串。
 * - `streamIdleTimeoutMs: 600000`：Radeon 的流式超时语义是「分片间隔」。
 * - `retryPolicy.maxDelayMs: 120000`：限流时 Retry-After 是 60 秒，退避上限必须更大。
 */
export const PROVIDER_PARAMS = {
  api: 'openai-completions',
  reasoning: 'medium',
  defaultMaxTokens: 32768,
  streamIdleTimeoutMs: 600000,
  retryPolicy: {
    mode: 'normal',
    maxRetries: 5,
    backoff: { initialDelayMs: 1000, maxDelayMs: 120000, jitterRatio: 0.2 },
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsThinkingTokenBudget: false,
    maxTokensField: 'max_tokens',
    thinkingFormat: 'openai',
  },
}

/**
 * 拼出一份完整的 provider 定义。
 *
 * @param {object} [options]
 * @param {string} [options.providerId] 未使用，仅为调用点可读性保留
 * @param {string} [options.apiKeyEnv] 凭据引用名
 * @param {string} [options.displayName] 模型选择器里显示的供应商名
 * @param {string[]} [options.modelIds] 只写这些模型；缺省写全部
 * @param {Array<{id: string, contextWindow?: number}>} [options.extraModels] 线上有、档位表里没有的模型
 * @param {string} [options.baseURL] 端点，默认中国大陆站点
 * @returns {Record<string, any>} 可直接写入 `llm-pi-ai.providers.<id>` 的对象
 */
export function buildProvider(options = {}) {
  const wanted = Array.isArray(options.modelIds) && options.modelIds.length > 0 ? new Set(options.modelIds) : null
  const measured = MODELS.filter((model) => wanted === null || wanted.has(model.id)).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    input: [...model.input],
    reasoningEfforts:
      model.reasoningEfforts === false ? false : Object.fromEntries(Object.entries(model.reasoningEfforts)),
  }))
  // 未实测的模型：档位一律写 `false`。这不是偷懒 —— 猜错档位会让请求直接 400
  // （Qwen 系传 high 必失败），而关掉档位至少能正常对话，用户之后可自行补测。
  const extra = (Array.isArray(options.extraModels) ? options.extraModels : [])
    .filter((model) => typeof model?.id === 'string' && model.id !== '' && !MODELS.some((known) => known.id === model.id))
    .map((model) => ({
      id: model.id,
      name: model.id,
      contextWindow: Number.isFinite(Number(model.contextWindow)) && Number(model.contextWindow) > 0 ? Number(model.contextWindow) : 262144,
      input: ['text'],
      reasoningEfforts: false,
    }))
  const models = [...measured, ...extra]
  return {
    apiKeyEnv: options.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    api: PROVIDER_PARAMS.api,
    baseURL: options.baseURL ?? BASE_URL,
    displayName: options.displayName ?? DEFAULT_DISPLAY_NAME,
    reasoning: PROVIDER_PARAMS.reasoning,
    defaultMaxTokens: PROVIDER_PARAMS.defaultMaxTokens,
    streamIdleTimeoutMs: PROVIDER_PARAMS.streamIdleTimeoutMs,
    retryPolicy: {
      ...PROVIDER_PARAMS.retryPolicy,
      backoff: { ...PROVIDER_PARAMS.retryPolicy.backoff },
    },
    compat: { ...PROVIDER_PARAMS.compat },
    models,
  }
}

/**
 * 判断一个 baseURL 是否指向 Radeon Cloud。
 *
 * @param {unknown} value 候选 baseURL
 * @returns {boolean} 命中为 true
 */
export function isRadeonBaseURL(value) {
  return typeof value === 'string' && value.toLowerCase().includes(BASE_URL_HINT)
}
