/**
 * 宿主侧的 HTTP 面：只给本机界面用，同源 + 只读优先。
 *
 *
 * 信任模型有三层,缺一不可:
 *
 *   1. **DSH 的信任栅栏**(`ctx.connection.requestRejection`)。web carrier 存在
 *      时它是权威判据:Host 必须是回环 / 监听地址 / 受信主机,Origin 必须同源,
 *      并且拒绝 `sec-fetch-site: cross-site`。
 *   2. **本地兜底**(`isLocalRequest`)。为什么不能只比较 Origin 与 Host:那样会
 *      **被 DNS rebinding 绕过** —— evil.com 的页面重绑定到 127.0.0.1 之后,它发出
 *      的 Origin 与 Host 都是 evil.com,两者相等,于是"同源"检查通过。所以本地
 *      兜底额外要求 Host 必须是回环。
 *   3. **写请求必须声明 JSON**(`isJsonRequest`)。浏览器对 application/json 会先发
 *      预检,跨站表单无法自带这个头,于是简单请求类的 CSRF 被挡在外面。
 *
 * 官方 web 面插件(dsh-host-open-in-app)把 connection 声明成硬依赖;这里按可选
 * 服务取,保留"缺服务只降级、不整个加载失败"的性质 —— 没有 connection 就没有
 * web carrier,也就没有浏览器请求需要防。
 * 路由都挂在 `/api/radeon-capacity` 前缀下：
 *   GET  /state     视图：探测到的 provider、容量、额度
 *   GET  /catalog   静态模型表（设置页渲染勾选列表用）
 *   GET  /discover  问上游当前有哪几个模型（用于发现档位表里还没有的新模型）
 *   POST /refresh   强制刷一次容量（额度探针也顺带跑）
 *   POST /config    写入 provider（落用户层，卸载插件后仍生效），可选同时存密钥
 *
 * @module dsh-radeon-capacity/host/routes
 */

import { MODELS, PROVIDER_PARAMS, buildProvider } from '../shared/catalog.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/api/radeon-capacity'

/** 请求体上限：只收一个小 JSON，超过就是异常调用。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 只放行同源请求。浏览器一定带 Origin；curl 之类没有 Origin，按本机可信处理。
 *
 * @param {any} req 请求
 * @returns {boolean} 是否放行
 */
export function sameOrigin(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req?.headers?.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 取 Host 头里的主机名(去掉端口,处理 IPv6 的方括号)。
 *
 * @param {any} req 请求
 * @returns {string} 小写主机名;取不到给空串
 */
export function hostNameOf(req) {
  const host = req?.headers?.host
  if (typeof host !== 'string' || host === '') return ''
  const value = host.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? '' : value.slice(1, end)
  }
  const first = value.indexOf(':')
  if (first === -1) return value
  return first === value.lastIndexOf(':') ? value.slice(0, first) : value
}

/**
 * 主机名是不是回环地址。
 *
 * @param {string} host 主机名
 * @returns {boolean} 是否回环
 */
export function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '::ffff:127.0.0.1'
}

/**
 * 本地兜底判据:回环 Host + 同源 Origin + 不是跨站发起的请求。
 *
 * 只查 Origin 与 Host 是否相等是不够的:DNS rebinding 之后两者会一起变成攻击者
 * 的域名。要求 Host 是回环(或 localhost)才真正把外部页面挡在外面。
 *
 * 没有 Origin 的请求(curl、命令行工具)按本机可信处理 —— 这类请求本来就已经
 * 在本机上了,拦它没有意义。
 *
 * @param {any} req 请求
 * @returns {boolean} 是否放行
 */
export function isLocalRequest(req) {
  if (!isLoopbackHost(hostNameOf(req))) return false
  const secFetchSite = req?.headers?.['sec-fetch-site']
  if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') return false
  return sameOrigin(req)
}

/**
 * 写请求是否声明了 JSON 请求体。
 *
 * 浏览器对 `application/json` 会先发预检,跨站表单无法伪造这个头,所以"必须声明
 * JSON"本身就是一条 CSRF 防线(简单请求类)。
 *
 * @param {any} req 请求
 * @returns {boolean} 是否声明 JSON
 */
export function isJsonRequest(req) {
  const raw = req?.headers?.['content-type']
  if (typeof raw !== 'string') return false
  return raw.split(';')[0].trim().toLowerCase() === 'application/json'
}

/**
 * 回一个 JSON。
 *
 * @param {any} res 响应
 * @param {number} status 状态码
 * @param {any} body 内容
 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 读 JSON 请求体。
 *
 * @param {any} req 请求
 * @returns {Promise<any>} 解析结果；空体给 {}
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是对象')
  return parsed
}

/**
 * 静态模型表的前端视图。
 *
 * @returns {object} 模型与 provider 默认值
 */
export function catalogView() {
  return {
    baseURL: buildProvider().baseURL,
    providerId: undefined,
    params: PROVIDER_PARAMS,
    models: MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      input: [...model.input],
      tiers: model.reasoningEfforts === false ? [] : Object.keys(model.reasoningEfforts),
    })),
  }
}

/**
 * 建路由。
 *
 * @param {object} deps 依赖
 * @param {() => Promise<object>} deps.state 取当前视图
 * @param {(force: boolean) => Promise<void>} deps.refresh 强制刷新
 * @param {(input: any) => Promise<object>} deps.writeConfig 写入 provider
 * @param {() => Promise<object>} [deps.discover] 拉上游模型目录
 * @param {(req: any) => (number | undefined)} [deps.requestRejection] DSH 信任栅栏:返回状态码即拒绝
 * @param {(error: unknown) => void} [deps.log] 错误日志
 * @returns {{kind: 'prefix', path: string, handler: (req: any, res: any) => Promise<void>}} 路由对象
 */
export function createRoutes(deps) {
  /**
   * 最近被拒绝的请求（诊断用，只在内存里留几条）。
   *
   * 栅栏拒绝对界面来说只表现为「读数空白」，没人知道是 401 还是 403。留下
   * 最近几次的方法、路径、Host、Origin、sec-fetch-site 与判定结果，排障时
   * 才不用靠猜。不存任何请求体或凭据。
   */
  const rejections = []
  const noteRejection = (req, code, layer) => {
    rejections.unshift({
      at: new Date().toISOString(),
      code,
      layer,
      method: req?.method,
      path: String(req?.url ?? '').slice(0, 80),
      host: String(req?.headers?.host ?? '').slice(0, 80),
      origin: String(req?.headers?.origin ?? '').slice(0, 80),
      secFetchSite: String(req?.headers?.['sec-fetch-site'] ?? '').slice(0, 20),
      contentType: String(req?.headers?.['content-type'] ?? '').slice(0, 60),
    })
    if (rejections.length > 12) rejections.length = 12
  }

  const routes = {
    kind: 'prefix',
    /** 诊断：最近被拒绝的请求。 */
    rejections,
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        // 诊断端点放在栅栏**之前**：它要回答的正是「为什么我的请求被拒了」，
        // 如果连它自己都被拒，就永远读不到原因。代价是它必须自己守住边界：
        //   - 只允许回环 Host（与栅栏同一判据，DNS rebinding 进不来）；
        //   - 只读，只回最近几次拒绝的元数据；
        //   - 绝不回请求体、凭据或任何密钥。
        // webServer 把 req 原样交给 handler，req.url 是**完整路径**
        // （宿主侧 `await responder.handler(req, res)`，没有裁剪前缀）。
        const target = new URL(req.url ?? ROUTE_PREFIX, 'http://localhost')
        if (target.pathname === `${ROUTE_PREFIX}/diagnostics`) {
          if (!isLoopbackHost(hostNameOf(req))) {
            sendJson(res, 403, { ok: false, error: 'request rejected' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            value: {
              fenceActive: deps.requestRejection !== undefined,
              rejections: routes.rejections,
            },
          })
          return
        }

        // 第 1 层:DSH 自己的信任栅栏(web carrier 在时才有)。它知道受信主机与
        // 监听地址,比本地判断准,所以放在最前面。
        //
        // 对 403 与 401 区别对待:
        //   - 403 是 Host/Origin 栅栏拒绝 —— 请求确实不来自本机页面,直接拒;
        //   - 401 是"可信但未认证"。桌面端的页面由 `dsh-app://` 协议加载,与
        //     127.0.0.1 不同源,它的 fetch 不一定带得上那个 auth cookie。此时
        //     一律按 401 拒会把界面读数整个掐死,所以 401 交给第 2 层判:回环
        //     Host + 无跨站标记就放行(跨站页面会被第 2 层挡掉)。
        if (deps.requestRejection !== undefined) {
          let rejection
          try {
            rejection = deps.requestRejection(req)
          } catch {
            rejection = undefined
          }
          if (rejection === 403) {
            noteRejection(req, 403, 'connection')
            sendJson(res, 403, { ok: false, error: 'request rejected' })
            return
          }
        }
        // 第 2 层:本地兜底(也是 401 时的判据)。
        if (!isLocalRequest(req)) {
          noteRejection(req, 403, 'local')
          sendJson(res, 403, { ok: false, error: 'request rejected' })
          return
        }
        // 第 3 层:写请求必须声明 JSON。
        if (req.method === 'POST' && !isJsonRequest(req)) {
          noteRejection(req, 415, 'content-type')
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        const pathname = target.pathname

        if (pathname === `${ROUTE_PREFIX}/catalog`) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, { ok: true, value: catalogView() })
          return
        }

        if (pathname === ROUTE_PREFIX || pathname === `${ROUTE_PREFIX}/state`) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, { ok: true, value: await deps.state() })
          return
        }

        if (pathname === `${ROUTE_PREFIX}/discover`) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (deps.discover === undefined) {
            sendJson(res, 501, { ok: false, error: 'discovery unavailable' })
            return
          }
          try {
            sendJson(res, 200, { ok: true, value: await deps.discover() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        if (pathname === `${ROUTE_PREFIX}/refresh`) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          await deps.refresh(true)
          sendJson(res, 200, { ok: true, value: await deps.state() })
          return
        }

        if (pathname === `${ROUTE_PREFIX}/config`) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            return
          }
          try {
            const written = await deps.writeConfig(body)
            // 刷新**不 await**：容量端点 TTFB 约 25 秒，等它会让「写入中…」卡死 25 秒，
            // 而配置其实早就落库了。后台刷新，界面下一次轮询自然拿到新读数。
            deps.refresh?.(true)?.catch?.(() => {})
            sendJson(res, 200, { ok: true, value: { written, state: await deps.state() } })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        deps.log?.(error)
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
  return routes
}
