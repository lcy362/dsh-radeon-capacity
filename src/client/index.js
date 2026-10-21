/**
 * dsh-radeon-capacity —— 浏览器半区。
 *
 * 宿主用 `window.__ModuleLoader__.load({ id, factory })` 加载客户端包，`factory`
 * 里的 `require()` 只能解析平台 seed（react / react-dom / cordis / primitives 等），
 * 所以这个文件是**手写的单文件 bundle**：没有构建步骤、没有相对 import。
 *
 * 三处显示：
 *   1. `conversation.input.model.label` —— 模型选择器里每个 Radeon 模型后面一枚
 *      容量徽章（●idle / ●busy / ●full + 百分比）。这个槽声明为 `kind: "single"`，
 *      只有 `priority` 更靠前的那一条会被渲染，所以注册时要 `priority: -1`，
 *      并且**必须自己输出模型名**（`fallback: model.name` 只在槽里一条都没有时生效）。
 *   2. `conversation.input.right` —— **模型选择器同一行**的容量读数。
 *      这是 WorkBuddy / Trae 挂积分的那个槽：它和 `conversation.input.model` 在
 *      同一个 `standardControls` 里，渲染顺序就在模型选择器左边，所以读数跟模型名
 *      是并排的，而不是掉到输入框下方。选好模型、还没开始会话时同样显示。
 *      （早先用的是 `conversation.composer.dock`，那个槽只在 `variant === "composer"`
 *      时渲染 —— 新会话是 `hero` 变体，于是"选定但未开始会话"整个不显示。）
 *   3. `plugins.bundle.config` / `plugins.row.config` —— 配置页长在「设置 → 插件」
 *      里本插件自己的页面上（状态、一键写入 provider、模型发现），**不往 DSH
 *      设置页加分区**。
 *
 * 语言：界面读数一律**英文**（跟随 AMD 官方的英文术语 idle/busy/full）；配置页
 * 走 DSH 的 locale 机制，中英双语，跟随界面语言。
 *
 * 徽章是**先探测、后注册**：没有 Radeon provider 时根本不占那个 single 槽，
 * 不会把内核自带的模型标注顶掉。
 */
window.__ModuleLoader__.load({
  id: 'dsh-radeon-capacity',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    // ── 语言 ────────────────────────────────────────────────────────────────
    /**
     * 两套文案。
     *
     * 读数（徽章 / 行内读数）**只用英文**：`idle / busy / full` 是 AMD 控制台自己的
     * 英文术语，翻成中文反而和官方界面对不上。配置页走 DSH 的 locale 机制，
     * 中英双语跟随界面语言。
     */
    const LOCALE_NS = 'dsh-radeon-capacity'
    const zh = {
      'row.provider': '已接入 provider',
      'row.endpoint': '端点',
      'row.credential': '凭据引用',
      'row.models': '模型数',
      'row.capacity': '容量',
      'row.quota': '额度（参考）',
      'state.none': '未发现 —— 可以在下面一键写入，或先到 设置 → 模型 里自行配置',
      'state.written': '已写入 {count} 个模型',
      'capacity.ok': '{count} 个模型有读数（{ago}）',
      'capacity.none': '暂无（{error}）',
      'quota.ok': '网关回报当日剩余 {left} / {limit}',
      'quota.none': '暂无（{error}）',
      'summary.noProvider': '未接入 Radeon provider —— 点「配置」写入',
      'summary.capacity': '{count} 个模型有读数',
      'summary.noCapacity': '容量暂无',
      'models.title': '已写入的模型（{count}）',
      'models.noReading': '无读数',
      'section.status': '当前状态',
      'section.api': '接口配置',
      'section.apiHelp': '写入的是 DSH 用户层配置（profile 补丁），不是本插件内部 —— 所以卸载本插件后 provider 仍然可用。凭据只经过宿主内存，不会回传给浏览器。',
      'field.providerId': 'provider id（模型选择器里的路由名）',
      'field.apiKeyEnv': '凭据引用名（apiKeyEnv）',
      'field.apiKey': 'API 密钥（rc-…，留空表示不改动）',
      'field.apiKeySet': '已配置，留空即保持不变',
      'warn.providerId': '注意：当前已写入的是 {current}，改成 {next} 会另建一个 provider，旧的那个仍然保留。',
      'warn.apiKeyEnv': '注意：当前已写入的是 {current}，改这里不会搬走已存的密钥，需要重新填一次。',
      'models.header': '收录模型（已选 {chosen} / 目录 {total}）',
      'models.helpWritten': '当前已写入 {count} 个模型。绿色=已写入，蓝色=本次新增，红色=本次将移除。',
      'models.helpNew': '还没有写入过 provider —— 这次提交是「新增」，默认全选实测过的模型。',
      'models.nonReasoning': '非推理',
      'models.tiers': '{count} 档',
      'discovered.title': '线上还有 {count} 个未实测模型',
      'discovered.help': '档位表是实测快照，这几个是上游新加的。勾上会以「不声明思考档位」的方式写入 —— 猜档位会导致 400，关掉至少能正常对话。',
      'tag.written': '已写入',
      'tag.add': '新增',
      'tag.remove': '将移除',
      'tag.unmeasured': '未实测',
      'action.create': '本次操作：新增 provider',
      'action.noop': '本次操作：无变化',
      'action.modify': '本次操作：修改 provider',
      'action.current': '当前：providers.{id} · {count} 个模型',
      'action.currentNone': '当前：尚未写入',
      'action.add': '新增 {count} 个：{list}',
      'action.remove': '移除 {count} 个：{list}',
      'action.addExtra': '新增未实测 {count} 个：{list}',
      'action.noopHelp': '模型清单与已写入的一致；填了密钥仍会保存密钥。',
      'button.create': '新增 provider',
      'button.save': '保存修改',
      'button.rewrite': '重新写入（无变化）',
      'button.saving': '写入中…',
      'button.refresh': '立即刷新容量',
      'button.refreshing': '刷新中…',
      'done.create': '已新增 providers.{id}（共 {count} 个模型）{credential}。配置在用户层，卸载本插件后依然有效。容量读数会在几十秒内自动出现。',
      'done.update': '已更新 providers.{id}（共 {count} 个模型）{credential}。配置在用户层，卸载本插件后依然有效。容量读数会在几十秒内自动出现。',
      'done.credential': '，并保存了 API 密钥',
      'done.refresh': '已重新拉取容量与额度。',
    }
    const en = {
      'row.provider': 'Provider',
      'row.endpoint': 'Endpoint',
      'row.credential': 'Credential ref',
      'row.models': 'Models',
      'row.capacity': 'Capacity',
      'row.quota': 'Quota (reference)',
      'state.none': 'not found — write one below, or configure it under Settings → Models first',
      'state.written': '{count} models written',
      'capacity.ok': '{count} models reporting ({ago})',
      'capacity.none': 'none ({error})',
      'quota.ok': 'gateway reports {left} / {limit} left today',
      'quota.none': 'none ({error})',
      'summary.noProvider': 'no Radeon provider — click Configure to write one',
      'summary.capacity': '{count} models reporting',
      'summary.noCapacity': 'no capacity reading',
      'models.title': 'Written models ({count})',
      'models.noReading': 'no reading',
      'section.status': 'Current status',
      'section.api': 'Endpoint',
      'section.apiHelp': 'This writes DSH user-layer config (the profile patch), not plugin-internal state — so the provider keeps working after you uninstall this plugin. The key only passes through host memory and is never sent back to the browser.',
      'field.providerId': 'provider id (the route name in the model picker)',
      'field.apiKeyEnv': 'credential ref (apiKeyEnv)',
      'field.apiKey': 'API key (rc-…, leave empty to keep the current one)',
      'field.apiKeySet': 'already configured — leave empty to keep it',
      'warn.providerId': 'Heads up: {current} is what is written today. Renaming to {next} creates a second provider; the old one stays.',
      'warn.apiKeyEnv': 'Heads up: {current} is what is written today. Changing this does not move the stored key — you need to enter it again.',
      'models.header': 'Models ({chosen} selected / {total} in catalog)',
      'models.helpWritten': '{count} models are written today. Green = written, blue = adding, red = removing.',
      'models.helpNew': 'No provider written yet — this submission creates one, with every measured model selected by default.',
      'models.nonReasoning': 'no tiers',
      'models.tiers': '{count} tiers',
      'discovered.title': '{count} unmeasured models upstream',
      'discovered.help': 'The tier table is a measured snapshot; these were added upstream. Selecting them writes them without reasoning tiers — guessing tiers returns 400, so leaving them off at least keeps them usable.',
      'tag.written': 'written',
      'tag.add': 'add',
      'tag.remove': 'remove',
      'tag.unmeasured': 'unmeasured',
      'action.create': 'This will: add a provider',
      'action.noop': 'This will: change nothing',
      'action.modify': 'This will: modify the provider',
      'action.current': 'Now: providers.{id} · {count} models',
      'action.currentNone': 'Now: nothing written',
      'action.add': 'Add {count}: {list}',
      'action.remove': 'Remove {count}: {list}',
      'action.addExtra': 'Add {count} unmeasured: {list}',
      'action.noopHelp': 'The model list already matches what is written; a key you type is still saved.',
      'button.create': 'Add provider',
      'button.save': 'Save changes',
      'button.rewrite': 'Rewrite (no change)',
      'button.saving': 'Writing…',
      'button.refresh': 'Refresh capacity',
      'button.refreshing': 'Refreshing…',
      'done.create': 'Added providers.{id} ({count} models){credential}. Written to the user layer, so it survives uninstalling this plugin. Capacity readings appear within a minute.',
      'done.update': 'Updated providers.{id} ({count} models){credential}. Written to the user layer, so it survives uninstalling this plugin. Capacity readings appear within a minute.',
      'done.credential': ', and saved the API key',
      'done.refresh': 'Capacity and quota refreshed.',
    }

    /**
     * 宿主没注入 `t` 时的兜底：直接取英文字典。
     *
     * 正常路径是槽注册时带 `locale`，宿主把 `t` 塞进 props；这条只是让组件在
     * 测试或非标准挂载下也能渲染出人话，不至于显示成键名。
     */
    function fallbackT(key, params) {
      const template = en[key] ?? key
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** 客户端版本号：改这个文件就顺手改它，便于确认界面上跑的是哪一版。 */
    const CLIENT_VERSION = 'client@2026-10-21.4'
    /** 宿主路由前缀。 */
    const API = '/api/radeon-capacity'

    /** 数据就绪时的轮询间隔（上游本身要 25 秒，比特快也没意义）。 */
    const READY_POLL_MS = 30_000
    /** 还没有数据时的快轮询间隔。 */
    const WARMING_POLL_MS = 5_000
    /** 完全没有 provider / 密钥时的慢轮询（等用户去配置）。 */
    const IDLE_POLL_MS = 60_000

    // ── 共享 store：所有挂点共用一份状态，多开面板也不会重复请求 ──────────────
    const store = {
      value: null,
      at: 0,
      inflight: null,
      error: null,
      listeners: new Set(),
    }

    /** 订阅（useSyncExternalStore 的 subscribe）。 */
    const subscribe = (listener) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }
    /** 取快照（useSyncExternalStore 的 getSnapshot，必须是稳定引用）。 */
    const getSnapshot = () => store.value
    /** 通知所有订阅者。 */
    const emit = () => {
      for (const listener of [...store.listeners]) listener()
    }

    /** 拉一次宿主状态；单飞，失败保留旧值。 */
    function ensureFresh() {
      if (store.inflight !== null) return store.inflight
      store.inflight = fetch(`${API}/state`, { headers: { accept: 'application/json' } })
        .then((response) => response.json())
        .then((body) => {
          if (body !== null && body.ok === true) {
            store.value = body.value
            store.at = Date.now()
            store.error = null
          } else {
            store.error = typeof body?.error === 'string' ? body.error : 'state request failed'
          }
        })
        .catch((error) => {
          store.error = error instanceof Error ? error.message : String(error)
        })
        .finally(() => {
          store.inflight = null
          emit()
        })
      return store.inflight
    }

    /** 发一个 POST；返回解析后的 body。 */
    async function post(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const parsed = await response.json().catch(() => null)
      if (parsed === null) throw new Error(`HTTP ${response.status}`)
      if (parsed.ok !== true) throw new Error(typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`)
      return parsed.value
    }

    /** 轮询间隔：有数据就慢，没数据就快，完全没配就最慢。 */
    function pollInterval(state) {
      if (state === null) return WARMING_POLL_MS
      if (state.capacity?.ok === true) return READY_POLL_MS
      if (state.provider === null && state.credential?.configured !== true) return IDLE_POLL_MS
      return WARMING_POLL_MS
    }

    /** 轮询是否已经在跑（HMR 重载时会重复调用 apply，这里兜一下）。 */
    let polling = false

    /** 启动全局轮询（只启动一次）。 */
    function startPoller() {
      if (polling) return
      polling = true
      const step = () => {
        if (typeof document !== 'undefined' && document.hidden) {
          timer = setTimeout(step, READY_POLL_MS)
          return
        }
        ensureFresh().finally(() => {
          timer = setTimeout(step, pollInterval(store.value))
        })
      }
      let timer = setTimeout(step, 0)
    }

    /** 三档状态 → 颜色。 */
    function toneOf(state) {
      if (state === 'full') return '#d92d20'
      if (state === 'busy') return '#f79009'
      if (state === 'idle') return '#12b76a'
      return '#98a2b3'
    }

    /** 格式化「多久以前」。 */
    function ago(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown'
      if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
      return `${Math.round(ms / 60_000)}m ago`
    }

    /** 额度文本：`$0.97 / $1.00 · 日`。 */
    function quotaText(quota) {
      const daily = quota?.dailyUsd
      if (daily === null || daily === undefined || typeof daily.remaining !== 'number') return null
      const limit = typeof daily.limit === 'number' ? daily.limit.toFixed(2) : '?'
      return `$${Math.round(daily.remaining * 100) / 100} / $${limit}`
    }

    /** 该 provider 是不是宿主探测到的那个 Radeon provider。 */
    function isRadeon(state, provider) {
      if (state?.provider === null || state?.provider === undefined) return false
      const expected = state.provider.id
      const actual = provider?.id
      return typeof expected === 'string' && typeof actual === 'string' && expected === actual
    }

    /** 该模型的容量读数（可能没有：上游只回有流量的模型）。 */
    function loadOf(state, modelId) {
      if (typeof modelId !== 'string') return null
      const models = state?.capacity?.models
      if (models === null || models === undefined) return null
      return models[modelId] ?? null
    }

    // ── 1) 模型选择器里的容量徽章 ─────────────────────────────────────────────
    /**
     * 内核自带的机型标注（`dsh-client-ui-deepseek-model-label-1017`）的等价判断。
     *
     * 为什么要抄一份：这个槽是 single 型，我们一旦接管，内核那一条就再也不会被渲染 ——
     * 也只对 **Radeon 模型** 加徽章，但接管是全局的。不补这一步，官方 DeepSeek 模型
     * 上的 1017 标记会凭空消失。条件与文案照抄 1017 插件（provider.id / model.id /
     * model.name 三重判定）；内核那边一旦改判定，这里要跟着改。
     */
    function isOfficialFlash1017(provider, model) {
      return (
        (provider?.id === 'deepseek-account' || provider?.id === 'deepseek-official') &&
        model?.id === 'deepseek-flash' &&
        model?.name === 'DeepSeek-V4.1-Flash'
      )
    }

    /** 小胶囊样式（容量徽章与 1017 标记共用）。 */
    function chipStyle(color) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10,
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        color,
        background: 'rgba(128,128,128,0.10)',
        borderRadius: 4,
        padding: '0 4px',
        lineHeight: '15px',
        flex: 'none',
      }
    }

    /**
     * 渲染模型标签。**必须**在没有数据时原样返回模型名 —— 这个槽是 single 型，
     * 我们接管之后它就是唯一的渲染者。
     */
    function ModelLabel(props) {
      const model = props?.model
      const provider = props?.provider
      const placement = props?.placement
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const name = typeof model?.name === 'string' && model.name !== '' ? model.name : (model?.id ?? '')
      const load = isRadeon(state, provider) ? loadOf(state, model?.id) : null
      const official = isOfficialFlash1017(provider, model)
      if (load === null && !official) return name
      const utilization = Math.round(load?.utilization ?? 0)
      const compact = placement === 'trigger'
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 } },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
        official
          ? h('span', { style: chipStyle('#0b6bcb'), title: 'Built-in release marker (1017)' }, '1017')
          : null,
        load === null
          ? null
          : h('span', {
            title: `Radeon capacity: ${utilization}% of the concurrency budget used (${load.label}, data ${ago(state?.capacity?.ageMs)})`,
            style: chipStyle(toneOf(load.state)),
          },
          h('span', { style: { fontSize: 8, lineHeight: '8px' } }, '●'),
          compact ? null : `${utilization}%`),
      )
    }

    // ── 2) 模型选择器同一行的容量读数 ─────────────────────────────────────────
    /** 取某个会话的模型选择目录（拿不到就返回 null，读数自动隐藏）。 */
    function directoryFor(modelDirectories, sessionId) {
      try {
        const directory = modelDirectories.directoryFor(sessionId)
        return directory === undefined || directory === null ? null : directory
      } catch {
        return null
      }
    }

    /**
     * 把模型选择目录包成 `{subscribe, getSnapshot}`。
     *
     * `useSyncExternalStore` 要求这两个函数的引用跨渲染稳定，所以按目录对象缓存；
     * 优先用目录内部的 snapshot store（`directory.store`），取不到再退回目录自身的方法。
     */
    const sources = new WeakMap()
    function sourceOf(directory) {
      if (directory === null || directory === undefined) {
        return { subscribe: () => () => {}, getSnapshot: () => null }
      }
      const cached = sources.get(directory)
      if (cached !== undefined) return cached
      const store = typeof directory.store?.getSnapshot === 'function' ? directory.store : directory
      const source = {
        subscribe: (listener) => (typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {}),
        getSnapshot: () => (typeof store.getSnapshot === 'function' ? store.getSnapshot() : null),
      }
      sources.set(directory, source)
      return source
    }

    /**
     * 模型选择器同一行的容量读数。
     *
     * 挂在 `conversation.input.right` —— 和 `conversation.input.model` 在同一个
     * `standardControls` 容器里，渲染顺序在模型选择器左边，所以读数和模型名并排。
     * 这个槽由 `sessionId !== undefined` 把守，**选好模型但还没发第一条消息时也成立**
     * （新会话会先建出来），因此"选定未开始会话"同样能看见。
     *
     * 文案一律英文：`Idle / Busy / Full` 是 AMD 控制台自己的术语。
     */
    function CapacityInline(props) {
      const source = sourceOf(props?.directory ?? null)
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const dirState = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
      const current = dirState?.current
      if (!isRadeon(state, { id: current?.provider })) return null
      const load = loadOf(state, current?.model)
      const quota = state?.quota?.ok === true ? state.quota.quota : null
      const quotaLabel = quotaText(quota)
      // 容量没读数时仍然出读数：额度虽然是参考值，但「这个模型现在没流量」本身也是信息。
      if (load === null && quotaLabel === null) return null
      const utilization = load === null ? null : Math.round(load.utilization)
      const rpm = quota?.rpm
      const title = [
        load === null
          ? 'Capacity: no reading (upstream only reports models with traffic)'
          : `Capacity: ${load.label}, ${utilization}% of the concurrency budget used (data ${ago(state?.capacity?.ageMs)})`,
        quotaLabel === null
          ? 'Quota: no reading'
          : `Quota: the gateway reports ${quotaLabel} left today${typeof rpm?.remaining === 'number' ? `, ${rpm.remaining} requests left this minute` : ''} (data ${ago(state?.quota?.ageMs)})`,
        'Quota is a reference value only — AMD is currently free and unmetered, so it never affects whether you can call a model.',
      ].join('\n')
      return h(
        'span',
        {
          title,
          'data-radeon-capacity': 'inline',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            marginRight: 6,
            fontSize: 11,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--dsw-alias-label-secondary, inherit)',
            whiteSpace: 'nowrap',
            flex: 'none',
          },
        },
        load === null
          ? null
          : h('span', { style: { color: toneOf(load.state), fontSize: 9 } }, '●'),
        load === null
          ? h('span', { style: { opacity: 0.55 } }, 'No reading')
          : h('span', null, `${load.label} ${utilization}%`),
        quotaLabel === null
          ? null
          : h('span', { style: { opacity: 0.5, fontWeight: 400 } }, `· ${quotaLabel}`),
      )
    }

    // ── 3) 设置页：状态 + 一键配置 provider ───────────────────────────────────
    /** 小标题。 */
    function Section(props) {
      return h(
        'div',
        { style: { marginTop: 18 } },
        h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 6 } }, props.title),
        props.children,
      )
    }

    /**
     * 一键配置表单。
     *
     * 设计要点：**表单要能回答「现在是什么状态、按下去会发生什么」**，而不是一个
     * 每次都得重新勾一遍的空表单。所以：
     *   - 初始值来自宿主报回来的**真实已写入配置**（provider 定义里的模型清单），
     *     不是目录里的全部模型；
     *   - 每个模型标出「已写入 / 待新增 / 待移除」，提交按钮的文案与颜色跟着变
     *     （新增 vs 修改），一眼能看出这次是加东西还是改东西。
     */
    function ConfigForm(props) {
      const t = props.t
      const state = props.state
      const [catalog, setCatalog] = React.useState(null)
      const [providerId, setProviderId] = React.useState('')
      const [apiKeyEnv, setApiKeyEnv] = React.useState('')
      const [apiKey, setApiKey] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [discovered, setDiscovered] = React.useState(null)
      const [extraSelected, setExtraSelected] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        fetch(`${API}/catalog`)
          .then((response) => response.json())
          .then((body) => {
            if (!alive || body?.ok !== true) return
            setCatalog(body.value)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      // 顺带问一次线上目录：档位表是快照，上游会加新模型（Gemma/Clef/d3 就是这样来的）。
      // 拿不到（没配密钥 / 端点变了）就不显示那一组，不影响已实测的 10 个。
      const refreshDiscovered = React.useCallback(() => {
        fetch(`${API}/discover`)
          .then((response) => response.json())
          .then((body) => {
            if (body?.ok !== true) return
            setDiscovered((body.value.models ?? []).filter((model) => model.known !== true))
          })
          .catch(() => {})
      }, [])

      React.useEffect(() => {
        refreshDiscovered()
      }, [refreshDiscovered])

      /** 宿主报回来的、真正写进 provider 的模型 id。 */
      const written = Array.isArray(state?.provider?.modelIds) ? state.provider.modelIds : []
      const hasProvider = state?.provider !== null && state?.provider !== undefined
      const models = catalog?.models ?? []

      /**
       * 表单初值一律**派生**，不用 effect 回填。
       *
       * 用 effect 回填过一次，踩了个真坑：面板可能在 `/state` 还没回来时就先渲染，
       * 那时 `hasProvider` 还是 false，于是「默认全选」被当成用户的选择固定下来；
       * 等真实配置到了，回填又因为「已经初始化过」而跳过 —— 界面显示的是全部模型，
       * 实际写入的只有几个。派生写法下 `selected === null` 一直是「跟随真实配置」，
       * 用户一动手才变成他自己的选择。
       */
      const initialSelection = state === null || state === undefined
        ? null
        : hasProvider
          ? written.filter((id) => models.some((model) => model.id === id))
          : models.map((model) => model.id)
      const chosen = Array.isArray(selected) ? selected : (initialSelection ?? [])
      const effectiveProviderId = providerId !== '' ? providerId : (state?.provider?.id ?? state?.suggested?.providerId ?? '')
      const effectiveApiKeyEnv = apiKeyEnv !== '' ? apiKeyEnv : (state?.provider?.apiKeyEnv ?? state?.suggested?.apiKeyEnv ?? '')

      const toggle = (id) => {
        setSelected((current) => {
          const list = Array.isArray(current) ? [...current] : [...chosen]
          const at = list.indexOf(id)
          if (at === -1) list.push(id)
          else list.splice(at, 1)
          return list
        })
      }
      const toggleExtra = (id) => {
        setExtraSelected((current) => {
          const list = [...current]
          const at = list.indexOf(id)
          if (at === -1) list.push(id)
          else list.splice(at, 1)
          return list
        })
      }

      // ── 差异：这次提交会新增什么、移除什么 ──────────────────────────────────
      const toAdd = chosen.filter((id) => !written.includes(id))
      const toRemove = written.filter((id) => !chosen.includes(id))
      const extraList = (discovered ?? []).filter((model) => extraSelected.includes(model.id))
      const willWrite = [...chosen, ...extraList.map((model) => model.id)]
      const isCreate = !hasProvider
      const isNoop = !isCreate && toAdd.length === 0 && toRemove.length === 0 && extraList.length === 0
      const changesProviderId = hasProvider && state?.provider?.id !== effectiveProviderId
      const changesKeyEnv = hasProvider && state?.provider?.apiKeyEnv !== effectiveApiKeyEnv

      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          const value = await post('/config', {
            providerId: effectiveProviderId,
            apiKeyEnv: effectiveApiKeyEnv,
            ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
            modelIds: chosen,
            extraModels: extraList.map((model) => ({ id: model.id, contextWindow: model.contextWindow })),
          })
          setApiKey('')
          setExtraSelected([])
          // 密钥刚落库，这时候才发现得了新模型。
          refreshDiscovered()
          const done = value?.written
          setMessage({
            tone: 'ok',
            text: t(isCreate ? 'done.create' : 'done.update', {
              id: done?.providerId ?? effectiveProviderId,
              count: willWrite.length,
              credential: done?.credentialWritten === true ? t('done.credential') : '',
            }),
          })
        } catch (error) {
          setMessage({ tone: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const reload = async () => {
        setBusy('reload')
        setMessage(null)
        try {
          await post('/refresh', {})
          setMessage({ tone: 'ok', text: t('done.refresh') })
        } catch (error) {
          setMessage({ tone: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
      }
      const labelStyle = { display: 'block', fontSize: 11, opacity: 0.75, margin: '10px 0 4px' }
      const buttonStyle = {
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'rgba(128,128,128,0.10)',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      }
      const chip = (text, color, key) =>
        h('span', {
          key,
          style: {
            display: 'inline-block',
            fontSize: 10,
            lineHeight: 1.6,
            padding: '0 6px',
            marginLeft: 6,
            borderRadius: 999,
            color,
            border: `1px solid ${color}`,
            whiteSpace: 'nowrap',
          },
        }, text)

      /** 每个模型在「已写入 / 本次将写入」里的状态。 */
      const modelState = (id) => {
        const inWritten = written.includes(id)
        const inChosen = chosen.includes(id)
        if (inWritten && inChosen) return { tag: t('tag.written'), color: '#12b76a' }
        if (!inWritten && inChosen) return { tag: t('tag.add'), color: '#2e90fa' }
        if (inWritten && !inChosen) return { tag: t('tag.remove'), color: '#d92d20' }
        return null
      }

      return h(
        'div',
        null,
        h(Section, { title: t('section.api') },
          h('div', { style: { fontSize: 11, opacity: 0.75, lineHeight: 1.7 } },
            t('section.apiHelp'),
          ),
          h('label', { style: labelStyle }, t('field.providerId')),
          h('input', {
            style: inputStyle,
            value: effectiveProviderId,
            placeholder: 'amd',
            onChange: (event) => setProviderId(event.target.value),
          }),
          changesProviderId
            ? h('div', { style: { fontSize: 10, color: '#f79009', marginTop: 4 } },
              t('warn.providerId', { current: state?.provider?.id, next: effectiveProviderId }))
            : null,
          h('label', { style: labelStyle }, t('field.apiKeyEnv')),
          h('input', {
            style: inputStyle,
            value: effectiveApiKeyEnv,
            placeholder: 'AMD_API_KEY',
            onChange: (event) => setApiKeyEnv(event.target.value),
          }),
          changesKeyEnv
            ? h('div', { style: { fontSize: 10, color: '#f79009', marginTop: 4 } },
              t('warn.apiKeyEnv', { current: state?.provider?.apiKeyEnv, next: effectiveApiKeyEnv }))
            : null,
          h('label', { style: labelStyle }, t('field.apiKey')),
          h('input', {
            style: inputStyle,
            type: 'password',
            value: apiKey,
            placeholder: state?.credential?.configured === true ? t('field.apiKeySet') : 'rc-xxxxxxxx',
            autoComplete: 'off',
            onChange: (event) => setApiKey(event.target.value),
          }),
        ),

        h(Section, { title: t('models.header', { chosen: chosen.length, total: models.length }) },
          h('div', { style: { fontSize: 11, opacity: 0.75, marginBottom: 6, lineHeight: 1.7 } },
            hasProvider ? t('models.helpWritten', { count: written.length }) : t('models.helpNew'),
          ),
          h('div', {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: '2px 12px',
              fontSize: 12,
            },
          },
            models.map((model) => {
              const checked = chosen.includes(model.id)
              const mark = modelState(model.id)
              const load = loadOf(state, model.id)
              return h('label', { key: model.id, style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked, onChange: () => toggle(model.id) }),
                h('span', { style: { opacity: mark !== null && mark.color === '#d92d20' ? 0.45 : 1 } }, model.id),
                mark === null ? null : chip(mark.tag, mark.color, `m-${model.id}`),
                load === null
                  ? null
                  : h('span', { style: { color: toneOf(load.state), fontSize: 10 } }, `● ${Math.round(load.utilization)}%`),
                h('span', { style: { opacity: 0.55, fontSize: 10 } },
                  model.tiers.length === 0 ? t('models.nonReasoning') : t('models.tiers', { count: model.tiers.length })),
              )
            }),
          ),
        ),

        Array.isArray(discovered) && discovered.length > 0
          ? h(Section, { title: t('discovered.title', { count: discovered.length }) },
            h('div', { style: { fontSize: 11, opacity: 0.75, marginBottom: 6, lineHeight: 1.7 } },
              t('discovered.help'),
            ),
            h('div', {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: '2px 12px',
                fontSize: 12,
              },
            },
              discovered.map((model) => {
                const already = written.includes(model.id)
                return h('label', { key: model.id, style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: already || extraSelected.includes(model.id),
                    disabled: already,
                    onChange: () => toggleExtra(model.id),
                  }),
                  h('span', null, model.id),
                  already ? chip(t('tag.written'), '#12b76a', `d-${model.id}`) : chip(t('tag.unmeasured'), '#98a2b3', `d-${model.id}`),
                )
              }),
            ),
          )
          : null,

        // ── 本次提交会做什么 ────────────────────────────────────────────────
        h('div', {
          style: {
            marginTop: 14,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid rgba(128,128,128,0.28)',
            fontSize: 11,
            lineHeight: 1.8,
          },
        },
          h('div', { style: { fontWeight: 700, marginBottom: 2 } },
            isCreate ? t('action.create') : isNoop ? t('action.noop') : t('action.modify')),
          hasProvider
            ? h('div', null, t('action.current', { id: state.provider.id, count: written.length }))
            : h('div', null, t('action.currentNone')),
          toAdd.length > 0 ? h('div', { style: { color: '#2e90fa' } }, t('action.add', { count: toAdd.length, list: toAdd.join(', ') })) : null,
          toRemove.length > 0 ? h('div', { style: { color: '#d92d20' } }, t('action.remove', { count: toRemove.length, list: toRemove.join(', ') })) : null,
          extraList.length > 0 ? h('div', { style: { color: '#2e90fa' } }, t('action.addExtra', { count: extraList.length, list: extraList.map((model) => model.id).join(', ') })) : null,
          isNoop ? h('div', { style: { opacity: 0.7 } }, t('action.noopHelp')) : null,
        ),

        h('div', { style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' } },
          h('button', {
            style: {
              ...buttonStyle,
              ...(isCreate || (!isNoop && (toAdd.length > 0 || extraList.length > 0)) ? { borderColor: '#2e90fa' } : {}),
            },
            disabled: busy !== '',
            onClick: save,
          },
            busy === 'save' ? t('button.saving') : isCreate ? t('button.create') : isNoop ? t('button.rewrite') : t('button.save')),
          h('button', { style: buttonStyle, disabled: busy !== '', onClick: reload },
            busy === 'reload' ? t('button.refreshing') : t('button.refresh')),
        ),
        message === null
          ? null
          : h('div', {
            style: {
              marginTop: 10,
              fontSize: 11,
              lineHeight: 1.6,
              color: message.tone === 'ok' ? '#12b76a' : '#d92d20',
            },
          }, message.text),
      )
    }

    /**
     * 插件配置页主面板（挂在「设置 → 插件」本插件页面里）。
     *
     * 同一个组件服务两种视图：插件管理器用 `view: 'summary'` 把内容塞进行描述位置，
     * 用 `view: 'page'` 渲染包页面里的完整配置区。summary 必须是一行短文案，
     * 否则整块面板会挤进列表行里。
     */
    function SettingsPanel(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const provider = state?.provider ?? null
      const capacity = state?.capacity ?? null
      const quota = state?.quota ?? null
      const daily = quota?.ok === true ? quota.quota?.dailyUsd : null
      const rows = []
      if (provider !== null) {
        rows.push([t('row.provider'), `${provider.displayName} (${provider.id})`])
        rows.push([t('row.endpoint'), provider.baseURL])
        rows.push([t('row.credential'), `${provider.apiKeyEnv}${state?.credential?.configured === true ? ' ✓' : ' ✗'}`])
        rows.push([t('row.models'), String(provider.modelCount)])
      } else {
        rows.push([t('row.provider'), t('state.none')])
      }
      rows.push([
        t('row.capacity'),
        capacity?.ok === true
          ? t('capacity.ok', { count: Object.keys(capacity.models).length, ago: ago(capacity.ageMs) })
          : t('capacity.none', { error: capacity?.error ?? 'unknown' }),
      ])
      rows.push([
        t('row.quota'),
        daily === null || daily === undefined
          ? t('quota.none', { error: quota?.error ?? 'unknown' })
          : t('quota.ok', {
            left: `$${Math.round(daily.remaining * 100) / 100}`,
            limit: `$${daily.limit.toFixed(2)}`,
          }),
      ])

      /** 已写入的模型 + 它们的实时容量，一张小表看清「写了什么、现在忙不忙」。 */
      const writtenModels = Array.isArray(provider?.modelIds) ? provider.modelIds : []
      const modelTable = writtenModels.length === 0
        ? null
        : h('div', { style: { marginTop: 6 } },
          h('div', { style: { fontSize: 11, opacity: 0.75, marginBottom: 4 } },
            t('models.title', { count: writtenModels.length })),
          h('table', { style: { fontSize: 12, borderCollapse: 'collapse' } },
            h('tbody', null,
              writtenModels.map((id) => {
                const load = loadOf(state, id)
                return h('tr', { key: id },
                  h('td', { style: { padding: '1px 14px 1px 0', whiteSpace: 'nowrap' } },
                    h('span', { style: { color: load === null ? '#98a2b3' : toneOf(load.state), fontSize: 10 } }, '●'),
                    ' ',
                    id),
                  h('td', { style: { padding: '1px 0', opacity: 0.75, whiteSpace: 'nowrap' } },
                    load === null
                      ? t('models.noReading')
                      : `${load.label ?? load.state} ${Math.round(load.utilization)}%`),
                )
              }),
            ),
          ),
        )

      if (props?.view === 'summary') {
        const cap = capacity?.ok === true
          ? t('summary.capacity', { count: Object.keys(capacity.models).length })
          : t('summary.noCapacity')
        return h(
          'span',
          null,
          provider === null ? t('summary.noProvider') : `${provider.displayName} (${provider.id})`,
          ' · ',
          cap,
        )
      }

      return h(
        'div',
        { style: { padding: '4px 2px', fontSize: 13 } },
        h('div', { style: { fontSize: 11, opacity: 0.6 } }, `dsh-radeon-capacity · ${CLIENT_VERSION}`),
        h(Section, { title: t('section.status') },
          h('table', { style: { fontSize: 12, borderCollapse: 'collapse' } },
            h('tbody', null,
              rows.map(([key, value]) => h('tr', { key },
                h('td', { style: { padding: '2px 14px 2px 0', opacity: 0.65, whiteSpace: 'nowrap', verticalAlign: 'top' } }, key),
                h('td', { style: { padding: '2px 0', wordBreak: 'break-all' } }, value),
              )),
            ),
          ),
          modelTable,
        ),
        h(ConfigForm, { state, t }),
      )
    }

    /**
     * 客户端侧的可选项。
     *
     * 客户端插件的配置由 bundle 层传入，这里只暴露一个开关：`modelLabelBadge`
     * 关掉后不再接管 `conversation.input.model.label`（内核的 1017 标记原样保留，
     * 但模型选择器里也就看不到容量徽章了）。
     */
    const options = { modelLabelBadge: true }

    /** 客户端插件名。 */
    const name = 'dsh-radeon-capacity'
    /** 依赖的客户端服务。 */
    const inject = ['slots']

    /**
     * 挂载。
     *
     * @param {any} ctx 客户端根上下文
     */
    function apply(ctx) {
      // 接管模型标注槽（含内核 1017 标记的等价渲染）。关掉就不会碰内核那一条。
      const takeoverLabel = options.modelLabelBadge !== false
      startPoller()

      // 配置页的中英文案。读数组件不用 t（一律英文），只有设置面板走这条。
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-radeon-capacity: copy')
      } catch (error) {
        console.error('[dsh-radeon-capacity] locale registration failed (readings unaffected)', error)
      }
      const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : (key) => key

      // 1) 模型选择器徽章：**探测到 Radeon provider 之后**才注册。
      //    没注册时那个 single 槽仍归内核自己的标注插件所有，不会被我顶掉。
      let badgeRegistered = false
      const tryRegisterBadge = (state) => {
        if (!takeoverLabel) return
        if (badgeRegistered || state?.provider === null || state?.provider === undefined) return
        badgeRegistered = true
        ctx.slots.inject('conversation.input.model.label', () =>
          ctx.slots.register(
            { name: 'conversation.input.model.label', id: 'radeon-capacity', priority: -1 },
            ModelLabel,
          ),
        )
      }
      tryRegisterBadge(store.value)
      store.listeners.add(() => tryRegisterBadge(store.value))

      // 2) 模型选择器同一行的容量读数。`modelDirectories` 由官方的模型选择插件提供，
      //    取不到时就不注册 —— 少一个挂点，但不会让整个客户端半区加载失败。
      //    挂 `conversation.input.right` 而不是 `conversation.composer.dock`：后者只在
      //    `variant === "composer"` 时渲染，新会话是 hero 变体，选定未开始会话时会消失。
      ctx.inject(['modelDirectories'], (modelCtx) => {
        const directories = modelCtx.modelDirectories
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'radeon-capacity',
              order: 20,
              inject: (sessionId) => ({ directory: directoryFor(directories, sessionId) }),
            },
            CapacityInline,
          ),
        )
      })

      // 3) 配置页：挂在「设置 → 插件」里本插件自己的那一页，**不占** DSH 设置页的
      //    分区槽（settings.section）。两个键都注册，覆盖两种入口：
      //      - plugins.bundle.config：以包名为键，渲染在包的页面（描述与行列表之间）
      //      - plugins.row.config：以 `<包名>#<行 id>` 为键，行上的「配置」按钮直达
      //    行 id 与 cordis.patch.yml 里那条 insert 的 id 必须一致。
      const registerCard = (slotName, key) => {
        try {
          ctx.slots.inject(slotName, () =>
            ctx.slots.register({ name: slotName, key, priority: 30, locale: LOCALE_NS }, SettingsPanel),
          )
        } catch (error) {
          // 配置页注册失败不影响徽章与胶囊，别让整个客户端半区跟着废掉。
          console.error(`[dsh-radeon-capacity] ${slotName} registration failed (badges and readings unaffected)`, error)
        }
      }
      registerCard('plugins.bundle.config', 'dsh-radeon-capacity')
      registerCard('plugins.row.config', 'dsh-radeon-capacity#radeon-capacity')
    }

    const module = { exports: {} }
    module.exports.name = name
    module.exports.inject = inject
    module.exports.apply = apply
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' })
    return module.exports
  },
})
