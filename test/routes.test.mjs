import assert from 'node:assert/strict'
import test from 'node:test'

import {
  catalogView, createRoutes, hostNameOf, isJsonRequest, isLocalRequest, isLoopbackHost, ROUTE_PREFIX, sameOrigin,
} from '../src/host/routes.js'

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

/** 极简 req 桩：默认回环 Host；POST 默认声明 application/json（客户端就是这么发的）。 */
function makeReq(method, path, { body, origin, host = '127.0.0.1:51226', contentType, secFetchSite } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  const type = contentType === undefined ? (method === 'POST' ? 'application/json' : undefined) : contentType
  if (type !== undefined) headers['content-type'] = type
  const req = {
    method,
    url: path,
    headers,
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

test('DNS rebinding：Origin 与 Host 一起变成外部域名时必须拒绝', () => {
  // 这是维护者指出的那个漏洞。evil.com 的页面把域名重绑定到 127.0.0.1 之后，
  // 它发出的请求里 Origin 与 Host 都是 evil.com —— 只比较这两者会通过。
  const rebound = makeReq('GET', '/', { host: 'evil.example', origin: 'http://evil.example' })
  assert.equal(sameOrigin(rebound), true, '旧判据确实会被绕过（这就是当初的问题）')
  assert.equal(isLocalRequest(rebound), false, '新判据必须拒绝')
})

test('isLocalRequest：回环 Host + 无 Origin 放行；非回环 Host 一律拒绝', () => {
  assert.equal(isLocalRequest(makeReq('GET', '/')), true)
  assert.equal(isLocalRequest(makeReq('GET', '/', { host: 'localhost:3000' })), true)
  assert.equal(isLocalRequest(makeReq('GET', '/', { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' })), true)
  assert.equal(isLocalRequest(makeReq('GET', '/', { host: '10.0.0.5:3000' })), false)
  assert.equal(isLocalRequest(makeReq('GET', '/', { host: 'evil.example' })), false)
})

test('isLocalRequest：sec-fetch-site: cross-site 一律拒绝', () => {
  assert.equal(isLocalRequest(makeReq('GET', '/', { secFetchSite: 'cross-site' })), false)
  assert.equal(isLocalRequest(makeReq('GET', '/', { secFetchSite: 'same-origin' })), true)
})

test('hostNameOf / isLoopbackHost 基本形态', () => {
  assert.equal(hostNameOf({ headers: { host: '127.0.0.1:51226' } }), '127.0.0.1')
  assert.equal(hostNameOf({ headers: { host: '[::1]:51226' } }), '::1')
  assert.equal(hostNameOf({ headers: {} }), '')
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('127.8.9.10'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('evil.example'), false)
})

test('isJsonRequest 只认 application/json（可带参数、大小写不敏感）', () => {
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/json' } }), true)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'Application/JSON; charset=utf-8' } }), true)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'text/plain' } }), false)
  assert.equal(isJsonRequest({ headers: {} }), false)
})

test('POST 不声明 JSON 时回 415（跨站表单无法伪造这个头）', async () => {
  const routes = createRoutes({ state: async () => ({}), refresh: async () => {}, writeConfig: async () => ({}) })
  const res = makeRes()
  await routes.handler(
    makeReq('POST', `${ROUTE_PREFIX}/config`, { body: { providerId: 'amd' }, contentType: 'text/plain' }),
    res,
  )
  assert.equal(res.captured.status, 415)
})

test('栅栏返回 403 时直接拒绝', async () => {
  let seen = 0
  const routes = createRoutes({
    state: async () => ({}),
    refresh: async () => {},
    writeConfig: async () => ({}),
    requestRejection: (req) => {
      seen += 1
      return req.headers.origin === 'https://evil.example' ? 403 : undefined
    },
  })
  const ok = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/state`), ok)
  assert.equal(ok.captured.status, 200)

  const blocked = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/state`, { origin: 'https://evil.example' }), blocked)
  assert.equal(blocked.captured.status, 403)
  assert.equal(seen, 2, '每个请求都要问一次栅栏')
})

test('栅栏返回 401 时退回本地判据：回环页面放行，外部页面仍拒绝', async () => {
  // 桌面端页面由 dsh-app:// 加载，与 127.0.0.1 不同源，fetch 不一定带得上
  // auth cookie。若 401 一律拒绝，界面读数会整个消失。
  const routes = createRoutes({
    state: async () => ({}),
    refresh: async () => {},
    writeConfig: async () => ({}),
    requestRejection: () => 401,
  })

  const desktopLike = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/state`, { host: '127.0.0.1:52191' }), desktopLike)
  assert.equal(desktopLike.captured.status, 200, '回环页面的请求应当放行')

  const rebound = makeRes()
  await routes.handler(
    makeReq('GET', `${ROUTE_PREFIX}/state`, { host: 'evil.example', origin: 'http://evil.example' }),
    rebound,
  )
  assert.equal(rebound.captured.status, 403, 'DNS rebinding 形态仍然被第 2 层挡住')
})

test('DSH 信任栅栏自己抛错时不能让请求崩掉', async () => {
  const routes = createRoutes({
    state: async () => ({}),
    refresh: async () => {},
    writeConfig: async () => ({}),
    requestRejection: () => {
      throw new Error('service exploded')
    },
  })
  const res = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/state`), res)
  assert.equal(res.captured.status, 200, '栅栏异常时退回本地兜底，而不是 500')
})

test('诊断端点：栅栏之前可读，但只限回环 Host，且只回拒绝记录', async () => {
  const routes = createRoutes({
    state: async () => ({}),
    refresh: async () => {},
    writeConfig: async () => ({}),
    requestRejection: (req) => (req.headers.origin === 'https://evil.example' ? 403 : undefined),
  })

  // 先制造一次被栅栏拒绝的请求
  const blocked = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/state`, { origin: 'https://evil.example' }), blocked)
  assert.equal(blocked.captured.status, 403)

  // 诊断端点本身能读到那次拒绝（否则永远不知道原因）
  const diag = makeRes()
  await routes.handler(makeReq('GET', `${ROUTE_PREFIX}/diagnostics`), diag)
  assert.equal(diag.captured.status, 200)
  assert.equal(diag.captured.body.value.fenceActive, true)
  assert.equal(diag.captured.body.value.rejections.length, 1)
  assert.equal(diag.captured.body.value.rejections[0].code, 403)
  assert.equal(diag.captured.body.value.rejections[0].layer, 'connection')
  // 只回元数据，不回请求体 / 凭据
  assert.equal(diag.captured.body.value.rejections[0].body, undefined)
})

test('诊断端点：外部 Host 读不到（DNS rebinding 不开口子）', async () => {
  const routes = createRoutes({ state: async () => ({}), refresh: async () => {}, writeConfig: async () => ({}) })
  const res = makeRes()
  await routes.handler(
    makeReq('GET', `${ROUTE_PREFIX}/diagnostics`, { host: 'evil.example', origin: 'http://evil.example' }),
    res,
  )
  assert.equal(res.captured.status, 403)
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

test('POST /config 不等容量刷新：写配置不能被 25 秒的容量请求拖住', async () => {
  // 回归：之前 `await deps.refresh(true)` 让按钮卡在「写入中…」整整 25 秒，
  // 而配置其实早就落库了。现在刷新是后台跑，响应立刻回来。
  let refreshFinished = false
  const routes = createRoutes({
    state: async () => ({ provider: { id: 'amd' } }),
    refresh: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      refreshFinished = true
    },
    writeConfig: async (body) => ({ entryId: 'llm-pi-ai', providerId: body.providerId }),
  })
  const req = makeReq('POST', `${ROUTE_PREFIX}/config`, { body: { providerId: 'amd' } })
  const res = makeRes()
  const started = Date.now()
  await routes.handler(req, res)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1_000, `响应应当在 1 秒内返回，实际 ${elapsed}ms`)
  assert.equal(refreshFinished, false, '刷新仍在后台跑，不该阻塞响应')
  assert.equal(res.captured.status, 200)
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
