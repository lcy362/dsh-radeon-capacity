/**
 * 宿主侧的 HTTP 面：只给本机界面用，同源 + 只读优先。
 *
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
 * @param {(error: unknown) => void} [deps.log] 错误日志
 * @returns {{kind: 'prefix', path: string, handler: (req: any, res: any) => Promise<void>}} 路由对象
 */
export function createRoutes(deps) {
  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        const url = new URL(req.url ?? ROUTE_PREFIX, 'http://localhost')
        const pathname = url.pathname

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
}
