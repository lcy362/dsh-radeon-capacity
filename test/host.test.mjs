import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../src/host/index.js'

/** 造一个够用的宿主 ctx 桩：services 里放服务，inject 直接回调。 */
function makeCtx(services = {}) {
  const registered = []
  const scope = {
    webServer: {
      register: (route) => {
        registered.push(route)
        return () => {}
      },
    },
    effect: (fn) => fn(),
  }
  const ctx = {
    get: (key) => services[key],
    inject: (names, callback) => callback(scope),
    logger: { warn() {}, error() {} },
    effect: (fn) => fn(),
  }
  return { ctx, registered }
}

/** 极简 req/res。 */
function call(route, method, path, body) {
  const captured = { status: 0, body: null }
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:51226' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    writeHead: (status) => {
      captured.status = status
    },
    end: (payload) => {
      captured.body = JSON.parse(payload)
    },
  }
  return route.handler(req, res).then(() => captured)
}

test('插件导出面正常，并注册了前缀路由', () => {
  assert.equal(name, 'dsh-radeon-capacity')
  const { ctx, registered } = makeCtx()
  apply(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, '/api/radeon-capacity')
})

test('没配任何 provider / 凭据时：state 如实报缺，不抛错', async () => {
  const { ctx, registered } = makeCtx({ settings: { describe: () => [], update: async () => {} } })
  apply(ctx, {})
  // 第一次请求只负责触发后台刷新，返回值可能是「还没数据」；等它落定再看。
  await call(registered[0], 'GET', '/api/radeon-capacity/state')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const result = await call(registered[0], 'GET', '/api/radeon-capacity/state')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.value.provider, null)
  assert.equal(result.body.value.capacity.ok, false)
  assert.equal(result.body.value.capacity.error, 'no-credential')
  assert.equal(result.body.value.credential.configured, false)
})

test('已配置 provider 时：state 能报出它，并按 baseURL 认人', async () => {
  const settings = {
    describe: () => [
      {
        ns: 'llm-pi-ai',
        value: {
          providers: {
            'radeon-cloud': {
              baseURL: 'https://developer.amd.com.cn/radeon/api/v1',
              apiKeyEnv: 'RADEON_CLOUD_API_KEY',
              displayName: 'Radeon Cloud',
              models: [{ id: 'GLM-5.3-Flash' }],
            },
          },
        },
      },
    ],
    update: async () => {},
  }
  const credentials = {
    resolve: async () => ({ value: '' }),
    describe: async (ref) => ({ configured: ref === 'RADEON_CLOUD_API_KEY' }),
  }
  const { ctx, registered } = makeCtx({ settings, credentials })
  apply(ctx, {})
  const result = await call(registered[0], 'GET', '/api/radeon-capacity/state')
  assert.equal(result.body.value.provider.id, 'radeon-cloud')
  assert.equal(result.body.value.provider.apiKeyEnv, 'RADEON_CLOUD_API_KEY')
  assert.equal(result.body.value.credential.configured, true)
})

test('POST /config 校验 provider id 与凭据名', async () => {
  const writes = []
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} } }],
    update: async (ns, patch) => writes.push({ ns, patch }),
  }
  const { ctx, registered } = makeCtx({ settings, credentials: { set: async () => {}, describe: async () => ({ configured: true }) } })
  apply(ctx, {})
  const bad = await call(registered[0], 'POST', '/api/radeon-capacity/config', { providerId: 'Amd_Bad' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /provider id/)

  const badRef = await call(registered[0], 'POST', '/api/radeon-capacity/config', { providerId: 'amd', apiKeyEnv: 'has-dash' })
  assert.equal(badRef.status, 400)
  assert.match(badRef.body.error, /凭据引用名/)

  const ok = await call(registered[0], 'POST', '/api/radeon-capacity/config', {
    providerId: 'amd',
    apiKeyEnv: 'AMD_API_KEY',
    modelIds: ['MiniCPM5-2B'],
  })
  assert.equal(ok.status, 200)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].patch.providers.amd.models.length, 1)
  assert.equal(writes[0].patch.providers.amd.models[0].id, 'MiniCPM5-2B')
})
