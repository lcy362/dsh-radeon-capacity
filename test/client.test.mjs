import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 客户端半区的离线集成测试。
 *
 * 这里不跑浏览器：用最小可用的 `window.__ModuleLoader__` + React 桩把
 * `src/client/index.js` 真跑一遍，验证
 *   1. 单文件 bundle 的包装格式能被解析、factory 能执行；
 *   2. 没有 Radeon provider 时**不**注册模型标注槽（不顶掉内核的 1017）；
 *   3. 探测到 provider 之后徽章注册、渲染出百分比；
 *   4. 胶囊按当前选择决定出不出。
 */

/** 极简 React 桩：只实现这几个组件用到的那几个 hook。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useCallback: (fn) => fn,
  useEffect: (fn) => {
    fn()
  },
  useState: (initial) => [
    typeof initial === 'function' ? initial() : initial,
    () => {},
  ],
}

/** 一份「探测到 Radeon provider 且容量已就绪」的宿主状态。 */
const READY_STATE = {
  provider: { entryId: 'llm-pi-ai', id: 'amd', displayName: 'Radeon Cloud', baseURL: 'https://developer.amd.com.cn/radeon/api/v1', apiKeyEnv: 'AMD_API_KEY', modelCount: 10, modelIds: ['GLM-5.3-Flash'], reasoning: 'medium' },
  providerId: 'amd',
  suggested: { providerId: 'amd', apiKeyEnv: 'AMD_API_KEY', displayName: 'Radeon Cloud', baseURL: 'https://developer.amd.com.cn/radeon/api/v1' },
  credential: { ref: 'AMD_API_KEY', configured: true },
  capacity: { ok: true, models: { 'GLM-5.3-Flash': { state: 'busy', label: 'Busy', utilization: 55 } }, fetchedAt: Date.now(), ageMs: 3000, stale: false, refreshing: false, error: null },
  quota: { ok: true, quota: { dailyUsd: { limit: 1, remaining: 0.97, used: 0.03, resetAt: null }, rpm: { limit: 20, remaining: 18 } }, fetchedAt: Date.now(), ageMs: 1000, error: null },
  now: Date.now(),
}

/**
 * 把客户端 bundle 加载进一个假运行环境。
 *
 * @param {object} options
 * @param {object|null} options.state 宿主 `/state` 的返回（null 表示没有 provider）
 * @returns {Promise<{exports: any, registrations: Array<object>, ctx: any}>} 加载结果
 */
async function loadClient({ state = null } = {}) {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        captured = entry
      },
    },
  }
  globalThis.document = { hidden: false, head: { appendChild() {} }, querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }) }
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/state')) {
      return { ok: true, json: async () => ({ ok: true, value: state }) }
    }
    if (String(url).endsWith('/catalog')) {
      return { ok: true, json: async () => ({ ok: true, value: { models: [] } }) }
    }
    if (String(url).endsWith('/discover')) {
      return { ok: true, json: async () => ({ ok: true, value: { models: [], measured: [] } }) }
    }
    return { ok: true, json: async () => ({ ok: true, value: {} }) }
  }

  const url = new URL('../src/client/index.js', import.meta.url)
  await import(`${url.href}?t=${Math.random()}`)
  assert.ok(captured !== null, '客户端 bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-radeon-capacity')

  const module = captured.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Tag: 'tag' }
    throw new Error(`客户端 require 了未声明的模块：${specifier}`)
  })

  const registrations = []
  const directory = {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ current: { provider: 'amd', model: 'GLM-5.3-Flash' }, status: 'ready' }),
    },
  }
  const ctx = {
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    inject: (_names, callback) => callback({ modelDirectories: { directoryFor: () => directory } }),
    effect: (fn) => fn(),
  }
  return { exports: module, registrations, ctx }
}

/** 等一轮 setTimeout，让轮询把 /state 灌进 store。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** 从渲染树里收集文本。 */
function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.children)
}

test('bundle 能被解析，且导出面齐全', async () => {
  const { exports } = await loadClient({ state: null })
  assert.equal(exports.name, 'dsh-radeon-capacity')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('没有 Radeon provider 时不注册模型标注槽（不顶掉内核 1017）', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: null })
  exports.apply(ctx)
  await tick()
  assert.equal(
    registrations.some((row) => row.spec.name === 'conversation.input.model.label'),
    false,
  )
  // 胶囊与设置页照常注册
  assert.equal(registrations.some((row) => row.spec.name === 'conversation.composer.dock'), true)
  assert.equal(registrations.some((row) => row.spec.name === 'settings.section'), true)
})

test('探测到 provider 后注册徽章，并渲染出容量百分比', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const badge = registrations.find((row) => row.spec.name === 'conversation.input.model.label')
  assert.ok(badge !== undefined, '应当接管模型标注槽')
  assert.equal(badge.spec.priority, -1, '必须排在 single 槽的第一位')

  const tree = badge.component({
    provider: { id: 'amd' },
    model: { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' },
    placement: 'menu',
  })
  const flat = texts(tree).join('')
  assert.match(flat, /GLM-5\.3-Flash/)
  assert.match(flat, /55%/)

  // trigger 位置只留圆点，不重复数字（空间太小）
  const compact = texts(
    badge.component({ provider: { id: 'amd' }, model: { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' }, placement: 'trigger' }),
  ).join('')
  assert.equal(compact.includes('55%'), false)
})

test('非 Radeon 模型原样输出名字（接管后仍不破坏其它模型）', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const badge = registrations.find((row) => row.spec.name === 'conversation.input.model.label')
  const plain = badge.component({
    provider: { id: 'opencode2dsh' },
    model: { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek-V4.1-Flash (free)' },
    placement: 'menu',
  })
  assert.equal(plain, 'DeepSeek-V4.1-Flash (free)')
})

test('内核 1017 标记在接管后仍然渲染', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const badge = registrations.find((row) => row.spec.name === 'conversation.input.model.label')
  const tree = badge.component({
    provider: { id: 'deepseek-account' },
    model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    placement: 'menu',
  })
  assert.match(texts(tree).join(''), /1017/)
})

test('胶囊：选中 Radeon 模型时出容量与额度，选别家时不出', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const pill = registrations.find((row) => row.spec.name === 'conversation.composer.dock')
  assert.ok(pill !== undefined)

  const directory = { store: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'amd', model: 'GLM-5.3-Flash' } }) } }
  const rendered = texts(pill.component({ directory })).join('')
  assert.match(rendered, /Busy 55%/)
  assert.match(rendered, /0\.97/)

  const other = { store: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'trae', model: 'x' } }) } }
  assert.equal(pill.component({ directory: other }), null)
})
