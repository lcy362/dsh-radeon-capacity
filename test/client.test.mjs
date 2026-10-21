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

/**
 * 极简 React 桩。
 *
 * 只实现组件用到的那几个 hook，但**要能跨渲染保存状态**：否则表单里
 * 「已写入 → 勾选 → 差异」这条链路在测试里永远是空的，等于没测。
 * 每个函数组件一份 hook 数组（按调用顺序），和 React 的规则一致。
 */
const hookStore = new WeakMap()
let hookOwner = null
let hookIndex = 0

/** 在「某个组件正在渲染」的上下文里跑一次函数。 */
function renderWithHooks(component, props) {
  const previous = hookOwner
  const previousIndex = hookIndex
  hookOwner = component
  hookIndex = 0
  try {
    return component(props)
  } finally {
    hookOwner = previous
    hookIndex = previousIndex
  }
}

const React = {
  // children 必须同时放进 props.children：React 就是这么传给组件的，
  // 而 Section / ConfigForm / SettingsPanel 都读 props.children。
  createElement: (type, props, ...children) => {
    const flat = children.flat()
    return { type, props: { ...(props ?? {}), ...(flat.length > 0 ? { children: flat } : {}) }, children: flat }
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => {
    const bucket = hookBucket()
    const at = hookIndex++
    if (!(at in bucket)) bucket[at] = { current: initial }
    return bucket[at]
  },
  useState: (initial) => {
    const bucket = hookBucket()
    const at = hookIndex++
    if (!(at in bucket)) bucket[at] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      bucket[at] = typeof next === 'function' ? next(bucket[at]) : next
    }
    return [bucket[at], set]
  },
  useEffect: (fn) => {
    fn()
  },
}

/** 当前组件的 hook 数组。 */
function hookBucket() {
  let bucket = hookStore.get(hookOwner)
  if (bucket === undefined) {
    bucket = []
    hookStore.set(hookOwner, bucket)
  }
  return bucket
}


/**
 * 在渲染树里找某个模型旁边的勾选框。
 *
 * @param {object} node 渲染树
 * @param {string} modelId 模型 id
 * @returns {object|undefined} 该模型的 checkbox 元素
 */
function findCheckbox(node, modelId) {
  if (node === null || node === undefined) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findCheckbox(child, modelId)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node.type === 'function') return findCheckbox(renderWithHooks(node.type, node.props), modelId)
  const children = node.children ?? []
  if (node.type === 'label') {
    // 模型名被包在 <span> 里，所以按「整棵子树的文本里有没有这个 id」判定
    if (!texts(children).some((text) => text === modelId)) return findCheckbox(children, modelId)
    return children.find((child) => typeof child === 'object' && child?.type === 'input')
  }
  return findCheckbox(children, modelId)
}

/** 一份「探测到 Radeon provider 且容量已就绪」的宿主状态。 */
const READY_STATE = {
  provider: { entryId: 'llm-pi-ai', id: 'amd', displayName: 'Radeon Cloud', baseURL: 'https://developer.amd.com.cn/radeon/api/v1', apiKeyEnv: 'AMD_API_KEY', modelCount: 10, modelIds: ['GLM-5.3-Flash', 'Qwen3.8-27B'], reasoning: 'medium' },
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
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            models: [
              { id: 'GLM-5.3-Flash', tiers: ['low', 'medium', 'high'], contextWindow: 131072 },
              { id: 'Qwen3.8-27B', tiers: ['low', 'medium'], contextWindow: 131072 },
              { id: 'MiniCPM5-2B', tiers: [], contextWindow: 32768 },
            ],
          },
        }),
      }
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

/**
 * 从渲染树里收集文本。
 *
 * 函数组件（`h(ConfigForm, props)`）在这里**真的被调用**——React 会这么做，
 * 而我们的桩把组件存成了 `type`。不调用的话，面板里嵌的表单在测试里等于不存在。
 */
function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  if (typeof node.type === 'function') {
    // 渲染两次：第一次让 useEffect 把状态填进去，第二次才是 React 真正画出来的那棵。
    renderWithHooks(node.type, node.props)
    return texts(renderWithHooks(node.type, node.props))
  }
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
  // 胶囊与插件配置页照常注册
  assert.equal(registrations.some((row) => row.spec.name === 'conversation.composer.dock'), true)
  assert.equal(registrations.some((row) => row.spec.name === 'plugins.bundle.config'), true)
  assert.equal(registrations.some((row) => row.spec.name === 'plugins.row.config'), true)
  // 明确**不**往 DSH 设置页加分区
  assert.equal(registrations.some((row) => row.spec.name === 'settings.section'), false)
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

test('配置页键名与 patch 里的行 id 对齐', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const bundleCard = registrations.find((row) => row.spec.name === 'plugins.bundle.config')
  const rowCard = registrations.find((row) => row.spec.name === 'plugins.row.config')
  assert.equal(bundleCard.spec.key, 'dsh-radeon-capacity')
  assert.equal(rowCard.spec.key, 'dsh-radeon-capacity#radeon-capacity')
  // 行 id 必须与 cordis.patch.yml 里 insert 的 id 一致，否则「配置」按钮点不进来
  const patch = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
  )
  assert.match(patch, /id:\s*radeon-capacity/)
})

test('配置页：把已写入的配置和本次差异都摆出来', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const card = registrations.find((row) => row.spec.name === 'plugins.bundle.config')
  // 第一次渲染触发 catalog 的 useEffect，等它落地再渲染一次才是真实画面。
  texts(card.component({ view: 'page' }))
  await tick()
  const flat = texts(card.component({ view: 'page' })).join(' ')
  // 已写入的状态要能被看见：provider id、已写入的模型、以及每个模型的状态标签
  assert.match(flat, /providers\.amd/)
  assert.match(flat, /已写入 2 个模型/)
  assert.match(flat, /GLM-5\.3-Flash 已写入/)
  // 目录里多出来的那个是「可新增」，不是已写入
  assert.match(flat, /MiniCPM5-2B/)
  assert.equal(/MiniCPM5-2B 已写入/.test(flat), false)
  // 勾选与已写入一致 → 无变化
  assert.match(flat, /本次操作：无变化/)
  assert.equal(flat.includes('新增 provider'), false)

  // 再勾一个没写入的 → 变成「新增 N 个」+「保存修改」
  const tree = card.component({ view: 'page' })
  const box = findCheckbox(tree, 'MiniCPM5-2B')
  assert.ok(box !== undefined, '应当渲染出 MiniCPM5-2B 的勾选框')
  box.props.onChange()
  await tick()
  const after = texts(card.component({ view: 'page' })).join(' ')
  assert.match(after, /新增 1 个：MiniCPM5-2B/)
  assert.match(after, /保存修改/)
  assert.match(after, /MiniCPM5-2B 新增/)
})

test('配置页：勾选状态跟随真实配置，不会把「全部模型」当成已写入', async () => {
  // 回归：早先用 useEffect 回填初值，面板若在 /state 之前渲染，就会把
  // 「默认全选」固定下来，界面显示全部模型、实际只写入几个。
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const card = registrations.find((row) => row.spec.name === 'plugins.bundle.config')
  texts(card.component({ view: 'page' }))
  await tick()
  const flat = texts(card.component({ view: 'page' })).join(' ')
  // 目录 3 个，已写入 2 个 → 勾选数必须是 2，不是 3
  assert.match(flat, /已选 2 \/ 目录 3/)
})

test('状态区把已写入的模型连同实时容量列出来', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const card = registrations.find((row) => row.spec.name === 'plugins.bundle.config')
  const flat = texts(card.component({ view: 'page' })).join(' ')
  assert.match(flat, /已写入 2 个模型/)
  // 有读数的显示状态+百分比，没读数的明确写「无读数」而不是留空
  assert.match(flat, /GLM-5\.3-Flash Busy 55%/)
  assert.match(flat, /Qwen3\.8-27B 无读数/)
})

test('配置页：没有 provider 时按「新增」呈现', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: null })
  exports.apply(ctx)
  await tick()
  const card = registrations.find((row) => row.spec.name === 'plugins.bundle.config')
  texts(card.component({ view: 'page' }))
  await tick()
  const flat = texts(card.component({ view: 'page' })).join(' ')
  assert.match(flat, /新增 provider/)
  assert.match(flat, /尚未写入/)
})

test('配置页：summary 视图是一行短文案，不塞整块面板', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const card = registrations.find((row) => row.spec.name === 'plugins.bundle.config')
  const summary = texts(card.component({ view: 'summary' })).join('')
  assert.ok(summary.length > 0)
  assert.equal(summary.includes('接口配置'), false)
})

test('胶囊：容量为主，额度只是弱化的参考值', async () => {
  const { exports, registrations, ctx } = await loadClient({ state: READY_STATE })
  exports.apply(ctx)
  await tick()
  const pill = registrations.find((row) => row.spec.name === 'conversation.composer.dock')
  const directory = { store: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'amd', model: 'GLM-5.3-Flash' } }) } }
  const node = pill.component({ directory })
  // 额度单独一个弱化元素，不和容量挤在同一段文字里
  const flat = texts(node)
  assert.ok(flat.some((text) => /Busy 55%/.test(text)), '容量主读数')
  assert.ok(flat.some((text) => /额度/.test(text)), '额度仍展示')
  assert.equal(flat.some((text) => /Busy 55%.*额度/.test(text)), false, '额度不该并进容量那一段')
  // tooltip 要说明额度只是参考、不影响调用
  assert.match(node.props.title, /AMD 当前免费不限量/)
})

test('胶囊：容量没读数时仍出胶囊，因为「没流量」本身是信息', async () => {
  const noLoad = JSON.parse(JSON.stringify(READY_STATE))
  noLoad.capacity = { ok: true, models: {}, fetchedAt: Date.now(), ageMs: 1000, error: null }
  const { exports, registrations, ctx } = await loadClient({ state: noLoad })
  exports.apply(ctx)
  await tick()
  const pill = registrations.find((row) => row.spec.name === 'conversation.composer.dock')
  const directory = { store: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'amd', model: 'GLM-5.3-Flash' } }) } }
  const node = pill.component({ directory })
  assert.ok(node !== null, '不该整个消失')
  assert.match(texts(node).join(''), /额度/)
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
