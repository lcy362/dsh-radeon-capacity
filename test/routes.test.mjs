import assert from 'node:assert/strict'
import test from 'node:test'

import { catalogView, createRoutes, ROUTE_PREFIX, sameOrigin } from '../src/host/routes.js'

/** 极简 res 桩，收集状态码与响应体。 */
function makeRes() {
  const captured = { status: 0, body: null, headers: null }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(payload) {
      captured.body = JSON.parse(payload)
    },
  }
}

/** 极简 req 桩。 */
function makeReq(method, path, { body, origin } = {}) {
  const req = {
    method,
    url: path,
    headers: origin === undefined ? { host: '127.0.0.1:51226' } : { host: '127.0.0.1:51226', origin },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  return req
}

test('sameOrigin：无 Origin 放行，跨源拒绝', () => {
  assert.equal(sameOrigin({ headers: {} }), true)
  assert.equal(sameOrigin(makeReq('GET', '/')), true)
  assert.equal(sameOrigin(makeReq('GET', '/', { origin: 'http://127.0.0.1:51226' })), true)
  assert.equal(sameOrigin(makeReq('GET', '/', { origin: 'https://evil.example' })), false)
})

test('GET /state 返回状态；跨源直接 403', async () => {
  const routes = createRoutes({
    state: async () => ({ provider: null, capacity: { ok: false } }),
    refresh: async () => {},
    writeConfig: async () => ({}),
  })
  const res = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/state`), res)
  assert.equal(res.captured.status, 200)
  assert.deepEqual(res.captured.body.value, { provider: null, capacity: { ok: false } })

  const denied = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/state`, { origin: 'https://evil.example' }), denied)
  assert.equal(denied.captured.status, 403)
})

test('GET /catalog 出静态模型表（供设置页渲染）', async () => {
  const routes = createRoutes({ state: async () => ({}), refresh: async () => {}, writeConfig: async () => ({}) })
  const res = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/catalog`), res)
  assert.equal(res.captured.status, 200)
  const models = res.captured.body.value.models
  assert.equal(models.length, 10)
  assert.deepEqual(models.find((model) => model.id === 'MiniCPM5-2B').tiers, [])
  assert.equal(models.find((model) => model.id === 'DeepSeek-V4.1-Flash').input.includes('image'), true)
})

test('POST /config 走写入并回状态；写入报错回 400', async () => {
  const seen = []
  let fail = false
  const routes = createRoutes({
    state: async () => ({ provider: { id: 'amd' } }),
    refresh: async () => {},
    writeConfig: async (body) => {
      seen.push(body)
      if (fail) throw new Error('provider id 非法')
      return { entryId: 'llm-pi-ai', providerId: body.providerId }
    },
  })

  const res = makeRes()
  await routes.handler(makeReq('POST', `${ROUTE_PREFIX}/config`, { body: { providerId: 'amd' } }), res)
  assert.equal(res.captured.status, 200)
  assert.equal(res.captured.body.value.written.providerId, 'amd')
  assert.deepEqual(seen, [{ providerId: 'amd' }])

  fail = true
  const bad = makeRes()
  await routes.handler(makeReq('POST', `${ROUTE_PREFIX}/config`, { body: { providerId: 'BAD' } }), bad)
  assert.equal(bad.captured.status, 400)
  assert.match(bad.captured.body.error, /非法/)
})

test('方法不对回 405，未知路径回 404', async () => {
  const routes = createRoutes({ state: async () => ({}), refresh: async () => {}, writeConfig: async () => ({}) })
  const wrongMethod = makeRes()
  await routes.handler(makeReq('POST', `${ROUTE_PREFIX}/state`), wrongMethod)
  assert.equal(wrongMethod.captured.status, 405)

  const missing = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/nope`), missing)
  assert.equal(missing.captured.status, 404)
})

test('catalogView 不带任何密钥字段', () => {
  const text = JSON.stringify(catalogView())
  assert.equal(text.includes('key'), false)
  assert.equal(text.includes('AMD_API_KEY'), false)
})

test('GET /discover 把上游目录转成可渲染的列表；失败回 400', async () => {
  let fail = false
  const routes = createRoutes({
    state: async () => ({}),
    refresh: async () => {},
    writeConfig: async () => ({}),
    discover: async () => {
      if (fail) throw new Error('没有可用的 API 密钥')
      return { models: [{ id: 'Gemma-4-31B-IT', contextWindow: 131072, known: false }], measured: ['GLM-5.3-Flash'] }
    },
  })
  const res = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/discover`), res)
  assert.equal(res.captured.status, 200)
  assert.equal(res.captured.body.value.models[0].known, false)

  fail = true
  const bad = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/discover`), bad)
  assert.equal(bad.captured.status, 400)
  assert.match(bad.captured.body.error, /密钥/)
})
