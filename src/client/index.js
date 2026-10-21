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
 *   2. `conversation.composer.dock` —— 输入框下方胶囊：当前模型的容量 + 额度。
 *   3. `settings.section` —— 「Radeon」设置页：状态、一键配置 provider。
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

    /** 客户端版本号：改这个文件就顺手改它，便于确认界面上跑的是哪一版。 */
    const CLIENT_VERSION = 'client@2026-10-21.1'
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
            store.error = typeof body?.error === 'string' ? body.error : 'state 请求失败'
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
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知'
      if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`
      return `${Math.round(ms / 60_000)} 分钟前`
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
          ? h('span', { style: chipStyle('#0b6bcb'), title: '内置发布标记（1017）' }, '1017')
          : null,
        load === null
          ? null
          : h('span', {
            title: `Radeon 并发配额已用 ${utilization}%（${load.label}，数据 ${ago(state?.capacity?.ageMs)}）`,
            style: chipStyle(toneOf(load.state)),
          },
          h('span', { style: { fontSize: 8, lineHeight: '8px' } }, '●'),
          compact ? null : `${utilization}%`),
      )
    }

    // ── 2) 输入框下方的容量 + 额度胶囊 ────────────────────────────────────────
    /** 取某个会话的模型选择目录（拿不到就返回 null，胶囊自动隐藏）。 */
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

    /** 胶囊组件：只在当前选中的模型属于 Radeon 时出现。 */
    function CapacityPill(props) {
      const source = sourceOf(props?.directory ?? null)
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const dirState = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
      const current = dirState?.current
      if (!isRadeon(state, { id: current?.provider })) return null
      const load = loadOf(state, current?.model)
      const quota = state?.quota?.ok === true ? state.quota.quota : null
      const parts = []
      if (load !== null) {
        parts.push(`● ${load.label} ${Math.round(load.utilization)}%`)
      }
      const quotaLabel = quotaText(quota)
      if (quotaLabel !== null) parts.push(`额度 ${quotaLabel}`)
      if (parts.length === 0) return null
      const rpm = quota?.rpm
      const title = [
        load === null ? '容量：暂无读数（上游只返回有流量的模型）' : `容量：${load.label}，并发配额已用 ${Math.round(load.utilization)}%（数据 ${ago(state?.capacity?.ageMs)}）`,
        quotaLabel === null ? '额度：暂无读数' : `额度：当日剩余 ${quotaLabel}${typeof rpm?.remaining === 'number' ? `，本分钟剩余 ${rpm.remaining} 次` : ''}（数据 ${ago(state?.quota?.ageMs)}）`,
      ].join('\n')
      return h(
        'span',
        {
          title,
          'data-radeon-capacity': 'pill',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--dsw-alias-label-secondary, inherit)',
            background: 'rgba(128,128,128,0.10)',
            borderRadius: 999,
            padding: '1px 8px',
            whiteSpace: 'nowrap',
          },
        },
        load === null
          ? null
          : h('span', { style: { color: toneOf(load.state), fontSize: 9 } }, '●'),
        h('span', null, parts.join(' · ')),
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

    /** 一键配置表单。 */
    function ConfigForm(props) {
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
            setSelected((current) => current ?? body.value.models.map((model) => model.id))
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

      React.useEffect(() => {
        if (state?.suggested === undefined || state?.suggested === null) return
        setProviderId((current) => (current === '' ? state.provider?.id ?? state.suggested.providerId : current))
        setApiKeyEnv((current) => (current === '' ? state.provider?.apiKeyEnv ?? state.suggested.apiKeyEnv : current))
      }, [state?.provider?.id, state?.provider?.apiKeyEnv])

      const models = catalog?.models ?? []
      const toggle = (id) => {
        setSelected((current) => {
          const list = Array.isArray(current) ? [...current] : []
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

      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          const value = await post('/config', {
            providerId,
            apiKeyEnv,
            ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
            modelIds: Array.isArray(selected) ? selected : [],
            extraModels: (discovered ?? [])
              .filter((model) => extraSelected.includes(model.id))
              .map((model) => ({ id: model.id, contextWindow: model.contextWindow })),
          })
          setApiKey('')
          // 密钥刚落库，这时候才发现得了新模型。
          refreshDiscovered()
          const written = value?.written
          setMessage({
            tone: 'ok',
            text: `已写入 ${written?.entryId ?? 'llm-pi-ai'} 的 providers.${written?.providerId ?? providerId}` +
              `${written?.credentialWritten ? '，并保存了 API 密钥' : ''}。配置在用户层，卸载本插件后依然有效。`,
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
          setMessage({ tone: 'ok', text: '已重新拉取容量与额度。' })
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

      return h(
        'div',
        null,
        h(Section, { title: '接口配置' },
          h('div', { style: { fontSize: 11, opacity: 0.75, lineHeight: 1.7 } },
            '写入的是 DSH 用户层配置（profile 补丁），不是本插件内部 —— 所以卸载本插件后 provider 仍然可用。',
            h('br'),
            '凭据只经过宿主内存，不会回传给浏览器。',
          ),
          h('label', { style: labelStyle }, 'provider id（模型选择器里的路由名）'),
          h('input', {
            style: inputStyle,
            value: providerId,
            placeholder: 'amd',
            onChange: (event) => setProviderId(event.target.value),
          }),
          h('label', { style: labelStyle }, '凭据引用名（apiKeyEnv）'),
          h('input', {
            style: inputStyle,
            value: apiKeyEnv,
            placeholder: 'AMD_API_KEY',
            onChange: (event) => setApiKeyEnv(event.target.value),
          }),
          h('label', { style: labelStyle }, 'API 密钥（rc-…，留空表示不改动）'),
          h('input', {
            style: inputStyle,
            type: 'password',
            value: apiKey,
            placeholder: 'rc-xxxxxxxx',
            autoComplete: 'off',
            onChange: (event) => setApiKey(event.target.value),
          }),
          h('label', { style: labelStyle }, `收录模型（${Array.isArray(selected) ? selected.length : 0} / ${models.length}）`),
          h('div', {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '2px 12px',
              fontSize: 12,
            },
          },
            models.map((model) => {
              const checked = Array.isArray(selected) && selected.includes(model.id)
              return h('label', { key: model.id, style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked, onChange: () => toggle(model.id) }),
                h('span', null, model.id),
                h('span', { style: { opacity: 0.55, fontSize: 10 } },
                  model.tiers.length === 0 ? '非推理' : `${model.tiers.length} 档`),
              )
            }),
          ),
        ),
        Array.isArray(discovered) && discovered.length > 0
          ? h(Section, { title: `线上还有 ${discovered.length} 个未实测模型` },
            h('div', { style: { fontSize: 11, opacity: 0.75, marginBottom: 6, lineHeight: 1.7 } },
              '档位表是实测快照，这几个是上游新加的。勾上会以「不声明思考档位」的方式写入 —— 猜档位会导致 400，关掉至少能正常对话。',
            ),
            h('div', {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: '2px 12px',
                fontSize: 12,
              },
            },
              discovered.map((model) => h('label', { key: model.id, style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: extraSelected.includes(model.id), onChange: () => toggleExtra(model.id) }),
                h('span', null, model.id),
                h('span', { style: { opacity: 0.55, fontSize: 10 } }, '未实测'),
              )),
            ),
          )
          : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 14 } },
          h('button', { style: buttonStyle, disabled: busy !== '', onClick: save },
            busy === 'save' ? '写入中…' : '写入配置'),
          h('button', { style: buttonStyle, disabled: busy !== '', onClick: reload },
            busy === 'reload' ? '刷新中…' : '立即刷新容量'),
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

    /** 设置页主面板。 */
    function SettingsPanel() {
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const provider = state?.provider ?? null
      const capacity = state?.capacity ?? null
      const quota = state?.quota ?? null
      const rows = []
      if (provider !== null) {
        rows.push(['已接入 provider', `${provider.displayName}（${provider.id}）`])
        rows.push(['端点', provider.baseURL])
        rows.push(['凭据引用', `${provider.apiKeyEnv}${state?.credential?.configured === true ? '（已配置）' : '（缺失）'}`])
        rows.push(['模型数', String(provider.modelCount)])
      } else {
        rows.push(['已接入 provider', '未发现 —— 可以在下面一键写入，或先到设置 → 模型里自行配置'])
      }
      rows.push([
        '容量',
        capacity?.ok === true
          ? `${Object.keys(capacity.models).length} 个模型有读数（${ago(capacity.ageMs)}）`
          : `暂无（${capacity?.error ?? '未知'}）`,
      ])
      const daily = quota?.ok === true ? quota.quota?.dailyUsd : null
      rows.push([
        '额度',
        daily === null || daily === undefined
          ? `暂无（${quota?.error ?? '未知'}）`
          : `当日剩余 $${Math.round(daily.remaining * 100) / 100} / $${daily.limit.toFixed(2)}`,
      ])

      return h(
        'div',
        { style: { padding: '4px 2px', fontSize: 13 } },
        h('div', { style: { fontSize: 11, opacity: 0.6 } }, `dsh-radeon-capacity · ${CLIENT_VERSION}`),
        h(Section, { title: '当前状态' },
          h('table', { style: { fontSize: 12, borderCollapse: 'collapse' } },
            h('tbody', null,
              rows.map(([key, value]) => h('tr', { key },
                h('td', { style: { padding: '2px 14px 2px 0', opacity: 0.65, whiteSpace: 'nowrap', verticalAlign: 'top' } }, key),
                h('td', { style: { padding: '2px 0', wordBreak: 'break-all' } }, value),
              )),
            ),
          ),
        ),
        h(ConfigForm, { state }),
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

      // 2) 输入框下方胶囊。`modelDirectories` 由官方的模型选择插件提供，取不到时
      //    胶囊就不注册 —— 少一个挂点，但不会让整个客户端半区加载失败。
      ctx.inject(['modelDirectories'], () => {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'radeon-capacity',
              order: 20,
              inject: (sessionId) => ({ directory: directoryFor(ctx.modelDirectories, sessionId) }),
            },
            CapacityPill,
          ),
        )
      })

      // 3) 设置页。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'radeon-capacity',
            order: 60,
            label: () => 'Radeon',
          },
          SettingsPanel,
        ),
      )
    }

    const module = { exports: {} }
    module.exports.name = name
    module.exports.inject = inject
    module.exports.apply = apply
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' })
    return module.exports
  },
})
