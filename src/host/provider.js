/**
 * 找出「已经存在的」Radeon provider。
 *
 * 用户的 Radeon provider 可能来自三个地方，本插件都不能假设自己配的那一份才算：
 *   - 用户自己在设置页加的（条目 id 可能是 `amd`）；
 *   - 用户手写进 profile 补丁的（id 可能是 `radeon-cloud`）；
 *   - 别的插件在自己的 bundle 层声明的（id 又可能不同）。
 *
 * 所以判据只能是 **baseURL**，不能是 id、也不能是凭据名。
 * 数据来自 `ctx.settings.describe()`：它返回每个插件条目的**实时生效配置**
 * （各层合并后的值），正是我们要的「现在到底在跑什么」。
 *
 * @module dsh-radeon-capacity/host/provider
 */

import { PROVIDER_PARAMS, buildProvider, isRadeonBaseURL } from '../shared/catalog.js'

/**
 * 在 settings 描述里找 Radeon provider。
 *
 * @param {Array<{ns: string, value?: any}>} descriptors `ctx.settings.describe()` 的返回
 * @returns {{ns: string, id: string, provider: any} | null} 命中项；没有则 null
 */
export function findRadeonProvider(descriptors) {
  if (!Array.isArray(descriptors)) return null
  for (const descriptor of descriptors) {
    const providers = descriptor?.value?.providers
    if (providers === null || typeof providers !== 'object') continue
    for (const [id, provider] of Object.entries(providers)) {
      if (provider === null || typeof provider !== 'object') continue
      if (!isRadeonBaseURL(provider.baseURL)) continue
      return { ns: descriptor.ns, id, provider }
    }
  }
  return null
}

/**
 * 把一个 provider 定义压成界面要的形状。
 *
 * 只出白名单字段：配置里可能存在用户自己的 headers 之类东西，没必要送到浏览器。
 *
 * @param {{ns: string, id: string, provider: any}} found 命中项
 * @returns {object} 前端视图
 */
export function describeProvider(found) {
  const provider = found.provider ?? {}
  const models = Array.isArray(provider.models) ? provider.models : []
  return {
    entryId: found.ns,
    id: found.id,
    displayName: typeof provider.displayName === 'string' ? provider.displayName : found.id,
    baseURL: typeof provider.baseURL === 'string' ? provider.baseURL : '',
    apiKeyEnv: typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : '',
    modelCount: models.length,
    modelIds: models.map((model) => (typeof model?.id === 'string' ? model.id : '')).filter((id) => id !== ''),
    /** 该 provider 是否声明了推理档位（决定界面上要不要提「档位」这回事）。 */
    reasoning: provider.reasoning === undefined ? null : provider.reasoning,
  }
}

/**
 * 生成「写进配置」的那一份 provider 定义。
 *
 * 关键设计：**写进用户层**（`ctx.settings.update` 会落到 profile 补丁），
 * 而不是插件自己的 bundle 层。这样卸载插件之后 provider 仍然在、仍然能用，
 * 用户不会因为卸一个 UI 插件而丢掉模型。
 *
 * @param {object} options
 * @param {string} options.providerId 要写入的 provider 路由名
 * @param {string} [options.apiKeyEnv] 凭据引用名
 * @param {string} [options.displayName] 供应商显示名
 * @param {string[]} [options.modelIds] 只写这些模型
 * @param {Array<{id: string, contextWindow?: number}>} [options.extraModels] 线上有、档位表里没有的模型
 * @param {string} [options.baseURL] 端点
 * @returns {Record<string, any>} provider 定义
 */
export function providerDefinition(options) {
  return buildProvider({
    apiKeyEnv: options.apiKeyEnv,
    displayName: options.displayName,
    modelIds: options.modelIds,
    extraModels: options.extraModels,
    baseURL: options.baseURL,
  })
}

/**
 * 把 provider 写进配置（用户层），可选同时存凭据。
 *
 * @param {object} deps 依赖
 * @param {{describe: Function, update: Function}} deps.settings settings 服务
 * @param {{set: Function} | undefined} deps.credentials credentials 服务
 * @param {object} options 见 {@link providerDefinition}
 * @param {Array<{id: string, contextWindow?: number}>} [options.extraModels] 线上有、档位表里没有的模型
 * @param {string} [options.apiKey] 非空时写入凭据（只在宿主内存里过一手，不进浏览器）
 * @param {string} [options.entryId] 目标条目 id，默认 `llm-pi-ai`
 * @returns {Promise<{entryId: string, providerId: string, definition: any, credentialWritten: boolean}>} 写入结果
 */
export async function writeProviderConfig(deps, options) {
  const settings = deps.settings
  if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.update !== 'function') {
    throw new Error('settings 服务不可用：当前 DSH 版本无法从插件写入 provider 配置')
  }
  const descriptors = settings.describe({ redactSecrets: true })
  const entryId =
    typeof options.entryId === 'string' && options.entryId !== ''
      ? options.entryId
      : (descriptors.find((row) => typeof row?.value?.providers === 'object')?.ns ?? 'llm-pi-ai')
  if (!descriptors.some((row) => row.ns === entryId)) {
    throw new Error(`找不到可配置条目 "${entryId}"：请在 DSH 设置 → 模型中手动添加 provider`)
  }

  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  const definition = providerDefinition(options)
  let credentialWritten = false
  if (apiKey !== '') {
    if (deps.credentials === undefined || typeof deps.credentials.set !== 'function') {
      throw new Error('credentials 服务不可用：无法保存 API 密钥，请到设置 → 模型中手动填写')
    }
    await deps.credentials.set(definition.apiKeyEnv, apiKey)
    credentialWritten = true
  }

  await settings.update(entryId, { providers: { [options.providerId]: definition } })
  return { entryId, providerId: options.providerId, definition, credentialWritten }
}

export { PROVIDER_PARAMS }
