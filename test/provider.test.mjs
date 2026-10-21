import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProvider, isRadeonBaseURL } from '../src/shared/catalog.js'
import { describeProvider, findRadeonProvider, writeProviderConfig } from '../src/host/provider.js'

/** 造一条 settings 描述。 */
const row = (ns, providers) => ({ ns, value: { providers } })

test('按 baseURL 认人，不看 id：amd / radeon-cloud / 自定义都能命中', () => {
  for (const id of ['amd', 'radeon-cloud', 'my-radeon']) {
    const found = findRadeonProvider([
      row('llm-pi-ai', {
        opencode: { baseURL: 'https://opencode.test/v1' },
        [id]: { baseURL: 'https://developer.amd.com.cn/radeon/api/v1', apiKeyEnv: 'AMD_API_KEY' },
      }),
    ])
    assert.equal(found.id, id)
    assert.equal(found.ns, 'llm-pi-ai')
  }
})

test('没有 Radeon provider 时返回 null，不误判同域名的其它服务', () => {
  assert.equal(findRadeonProvider([row('llm-pi-ai', { x: { baseURL: 'https://api.deepseek.com' } })]), null)
  assert.equal(findRadeonProvider([]), null)
  assert.equal(findRadeonProvider(undefined), null)
  assert.equal(isRadeonBaseURL('https://developer.amd.com.cn/other'), true)
  assert.equal(isRadeonBaseURL(42), false)
})

test('describeProvider 只出白名单字段', () => {
  const found = findRadeonProvider([
    row('llm-pi-ai', {
      amd: {
        baseURL: 'https://developer.amd.com.cn/radeon/api/v1',
        apiKeyEnv: 'AMD_API_KEY',
        displayName: 'Radeon Cloud',
        headers: { 'x-secret': 'nope' },
        models: [{ id: 'A' }, { id: 'B' }],
        reasoning: 'medium',
      },
    }),
  ])
  const view = describeProvider(found)
  assert.deepEqual(view.modelIds, ['A', 'B'])
  assert.equal(view.modelCount, 2)
  assert.equal(view.apiKeyEnv, 'AMD_API_KEY')
  assert.equal(JSON.stringify(view).includes('x-secret'), false)
})

test('buildProvider：10 个模型、四档形状、compat 开关齐全', () => {
  const definition = buildProvider()
  assert.equal(definition.models.length, 10)
  assert.equal(definition.compat.supportsDeveloperRole, false)
  assert.equal(definition.compat.maxTokensField, 'max_tokens')
  assert.equal(definition.retryPolicy.backoff.maxDelayMs, 120000)
  assert.equal(definition.models.find((model) => model.id === 'MiniCPM5-2B').reasoningEfforts, false)
  assert.deepEqual(Object.keys(definition.models.find((model) => model.id === 'Qwen3.8-27B').reasoningEfforts), [
    'off',
    'low',
    'medium',
    'xhigh',
  ])
  // 只写指定模型
  const subset = buildProvider({ modelIds: ['GLM-5.3-Flash'] })
  assert.deepEqual(subset.models.map((model) => model.id), ['GLM-5.3-Flash'])
})

test('writeProviderConfig：写凭据 + 落用户层，且不动别的 provider', async () => {
  const writes = []
  const settings = {
    describe: () => [row('llm-pi-ai', { opencode: { baseURL: 'https://opencode.test/v1' } })],
    update: async (ns, patch) => writes.push({ ns, patch }),
  }
  const credentialWrites = []
  const credentials = { set: async (ref, value) => credentialWrites.push({ ref, value }) }

  const result = await writeProviderConfig(
    { settings, credentials },
    { providerId: 'amd', apiKeyEnv: 'AMD_API_KEY', apiKey: 'rc-secret', modelIds: ['GLM-5.3-Flash'] },
  )

  assert.equal(result.entryId, 'llm-pi-ai')
  assert.equal(result.providerId, 'amd')
  assert.equal(result.credentialWritten, true)
  assert.deepEqual(credentialWrites, [{ ref: 'AMD_API_KEY', value: 'rc-secret' }])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ns, 'llm-pi-ai')
  assert.deepEqual(Object.keys(writes[0].patch.providers), ['amd'])
  assert.equal(writes[0].patch.providers.amd.models.length, 1)
  assert.equal(writes[0].patch.providers.amd.baseURL, 'https://developer.amd.com.cn/radeon/api/v1')
})

test('writeProviderConfig：没有可用条目时给出可执行的错误', async () => {
  await assert.rejects(
    () => writeProviderConfig({ settings: { describe: () => [], update: async () => {} } }, { providerId: 'amd' }),
    /找不到可配置条目/,
  )
  await assert.rejects(() => writeProviderConfig({}, { providerId: 'amd' }), /settings 服务不可用/)
})

test('buildProvider：未实测的新模型也能写入，档位一律关掉', () => {
  const definition = buildProvider({
    extraModels: [{ id: 'Gemma-4-31B-IT', contextWindow: 131072 }, { id: 'DeepSeek-V4.1-Flash' }, { id: '' }],
  })
  const extra = definition.models.filter((model) => model.id === 'Gemma-4-31B-IT')
  assert.equal(extra.length, 1)
  assert.equal(extra[0].reasoningEfforts, false)
  assert.equal(extra[0].contextWindow, 131072)
  // 已在实测表里的 id 不会被重复写入
  assert.equal(definition.models.filter((model) => model.id === 'DeepSeek-V4.1-Flash').length, 1)
  assert.equal(definition.models.length, 11)
})
