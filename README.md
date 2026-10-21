# dsh-radeon-capacity

给 [DeepSeek Harness](https://github.com/deepseek-ai/harness) 的独立插件：**在选模型之前，就能看到 AMD Radeon Cloud（Token Factory）每个模型现在忙不忙。**

主功能是**容量读数**。配置能力是顺带的 —— 已经配好 Radeon provider 的人装完即用，什么都不用填。额度也会显示，但**仅作展示**：AMD 目前免费不限量，这个数字不影响你能不能调用。

它不接管任何模型调用 —— 传输、思考字段、用量计量仍由 DSH 自带的 `dsh-llm-pi-ai` 承担。

## 它解决什么

Radeon Cloud 的模型会在 `idle / busy / full` 之间浮动，这才是真正会咬人的东西 —— 撞上 `full` 就得等并发配额腾出来。原来的信息只有两个去处：

1. Radeon 的网页控制台（要切窗口、要登录）；
2. 撞上限流之后看报错。

控制台里那根「AI Capacity」进度条的来源是 `GET /radeon/api/tokenfactory/load`，而 DSH 的模型选择器恰好有一个可以承载徽章的槽。把两边接起来，**在你点下模型之前**就知道它现在挤不挤。

## 它长什么样

| 位置 | 内容 |
|---|---|
| 模型选择器 | 每个 Radeon 模型名后一枚徽章：`● 12%`（绿）/ `● 63%`（橙）/ `● 100%`（红） |
| 模型选择器同一行 | 当前选中模型的容量，就在模型名左边（WorkBuddy / Trae 挂积分的位置）；额度弱化跟在后面：`● Busy 55% · $0.97 / $1.00` |
| 设置 → 插件 → dsh-radeon-capacity | 已写入的模型连同实时容量逐条列出；配置区（可选） |

徽章是**探测到 Radeon provider 之后才注册**的。没有 Radeon provider 时它根本不占那个槽，不会把内核自带的模型标注顶掉。

读数挂在 `conversation.input.right` —— 它和模型选择器在同一个 `standardControls`
容器里、渲染顺序就在选择器左边，所以读数和模型名是**并排**的；选好模型、还没开始
会话时同样显示 —— 它和模型选择器共用同一个 `sessionId` 守卫，**看得见模型选择器就看
得见读数**。（早期版本用的是输入框下方的 `conversation.composer.dock`，那个槽
只在 `composer` 变体渲染，新会话是 `hero` 变体，于是"选定但未开始"时读数会消失。）

界面上的读数一律**英文**（`Idle / Busy / Full` 是 AMD 控制台自己的术语）；设置页
走 DSH 的 locale 机制，中英双语，跟随界面语言。

## 安装

```sh
cd ~/.dsh/profiles/desktop
pnpm add dsh-radeon-capacity      # 或 pnpm add /path/to/this/repo
# 登记到 profile 的 bundles：
#   ~/.dsh/profiles/desktop/package.json → "dsh": { "profile": { "bundles": [ ... "dsh-radeon-capacity" ] } }
```

**不用重启 DSH。** 内核的 HMR（`dsh-hmr`）同时盯着 profile 的 `package.json` 和
`cordis.patch.yml`，一改就重算补丁、把新 bundle 装进来；客户端半区由
`dsh-client-hmr` 轮询 bundle 的 mtime，变了就推 `/plugins/events`，浏览器自动换成新
revision 的 `client.js`。

例外只有一种：日志里出现
`changed modules keep running their previous code until a restart` 时，那些**已经被
旧代码加载过**的模块要重启才换得掉。第一次安装不涉及这条（旧代码压根没加载过）。

## 已经配好 Radeon provider 的人：装完就有读数

**什么都不用做。** 插件按 **baseURL 里是否含 `developer.amd.com.cn`** 认人，不看你把 provider 叫 `amd` 还是 `radeon-cloud`，也不管密钥引用叫 `AMD_API_KEY` 还是别的。容量读数会直接出现在界面上，额度作为参考值跟在后面。

这是设计上的取舍：认 baseURL 而不是认 provider id，所以你已有的配置不需要为这个插件改任何东西。

## 顺带：还没有 provider 的话，插件也能替你配

设置 → 插件 → dsh-radeon-capacity → 填三格：

- **provider id**：模型选择器里的路由名，默认 `amd`；
- **凭据引用名**：默认 `AMD_API_KEY`，密钥存在 `~/.dsh/.credentials.yaml` 的这个键下；
- **API 密钥**：`rc-…`，只经过宿主内存，不落浏览器、不回显。

点「写入配置」。写入的是 **DSH 用户层**（`ctx.settings.update` → profile 补丁），因此：

> **卸载本插件之后，provider 仍然在、仍然能用。**

配置页不会让你对着一个空表单重新猜一遍 —— 它把**已写入的真实状态**摆出来：哪些模型已经写进去了、每个模型旁边标「已写入 / 新增 / 将移除」，按钮文案也跟着变（「新增 provider」/「保存修改」/「重新写入（无变化）」），下面还有一块「本次操作」把要加什么、要减什么逐条列清。

配置在提交后立刻返回，不等容量刷新 —— 容量端点单次约 25 秒，等它会让按钮白卡 25 秒，而配置其实早已落库。

### 插件自身的配置（可选）

写在 profile 的 `cordis.patch.yml` 里那行 `radeon-capacity` 下：

```yaml
- id: radeon-capacity
  name: dsh-radeon-capacity
  config:
    providerId: amd              # 新建 provider 时的默认路由名
    apiKeyEnv: AMD_API_KEY       # 默认凭据引用
    displayName: Radeon Cloud    # 选择器里显示的供应商名
    baseURL: https://developer.amd.com.cn/radeon/api/v1
    quotaProbe: true             # 关掉就不再发 1-token 探针（额度读数消失）
    capacityTtlMs: 30000         # 容量缓存
    quotaTtlMs: 60000            # 额度缓存
```

插件自己只声明一行 `insert`，**不写任何 provider 定义** —— 否则卸载插件会连带把 provider 带走。

## 数据源

### 容量：`GET /radeon/api/tokenfactory/load`

```json
{ "models": { "GLM-5.3-Flash": { "state": "full", "label": "At capacity", "utilization": 100 } } }
```

这是控制台内部路由（不在公开文档里），有三个必须按它设计的事实：

- **慢**：TTFB 稳定在 ~25 秒，`cache-control: no-store`，`?model=` 之类的过滤参数无效 → 必须缓存 + 单飞，绝不能每次打开选择器就直连；
- **集合会浮动**：不同时刻返回 13～16 个模型（只含有流量的），所以「查不到」是正常状态，界面如实显示无读数，**不猜成空闲**；
- **未文档化**：随时可能消失，一切失败都静默降级。

因为慢，宿主侧是 `stale-while-revalidate`：过期就先给旧值、后台刷新，界面从不挂在一次 25 秒的请求上。数据年龄会出现在 tooltip 和插件配置页里 —— 读数最多就是 30 秒级新鲜，这是服务端决定的，做到更快只能造假。

### 额度（仅展示）：`x-ratelimit-*` 响应头

网关在**任何**正常响应上都会回这几个头：

```
x-ratelimit-limit-user-daily-usd: 1
x-ratelimit-remaining-user-daily-usd: 0.982
x-ratelimit-limit-user-rpm: 20
x-ratelimit-remaining-user-rpm: 17
```

**AMD 目前免费不限量，这些数字是名义值**，不构成实际限制。所以插件只把它们**展示出来**：

- 不做任何门控 —— 不会因为「额度用完」禁用模型或拦截请求；
- 不参与告警、不改变颜色、不进主读数，界面上弱化处理；
- tooltip 里明确写了「仅供参考，不影响能否调用」。

没有「查额度」的独立端点，所以插件发一次 `max_tokens: 1` 的探针把这些头读出来（实测 0.31 秒，成本可忽略，占 1 次 RPM）。探针有独立的 60 秒 TTL 与单飞，不与容量一起高频轮询。**觉得没必要就 `quotaProbe: false` 完全关掉** —— 关掉只少一个参考数字，容量读数不受影响。

### 模型发现

档位表是**实测快照**（10 个对话模型）。上游会加新模型（2026-10 实测多了
`Gemma-4-31B-IT`；同一份目录里还有 `Clef` / `d3` / `OmniVoice` 这类
`context_length: 0`、输出模态是 `decision` 的**辅助路由服务**，不是对话模型，会被过滤）。

插件配置页会额外问一次 `GET /v1/models`，把「线上有、表里没有」的模型单独列出来。
勾选后按 `reasoningEfforts: false` 写入 —— 猜档位会让请求直接 400，关掉档位至少能正常对话。

### 思考档位

Radeon 的模型目录接口不返回 `reasoning_effort` 支持情况，只能实测。本插件内置一张实测表（10 个对话模型，四种档位形状），配置 provider 时连同 `reasoningEfforts` 一起写进去：

| 形状 | 模型 | 档位 |
|---|---|---|
| 全档 | DeepSeek-V4.1-Flash / V4-Flash / Vision-Exp、MiMo-V2.6-Flash、MiniCPM-V-4.7-35B-A3B | off(none) + minimal/low/medium/high/xhigh/max |
| Qwen 系 | Qwen3.8-27B、Qwen3.8-Flash-Next | off(none) + low/medium/xhigh（传 high 会 400） |
| 三档 | GLM-5.3-Flash、MiniCPM-V-4.7-1B | low/medium/high（关不掉思考） |
| 无 | MiniCPM5-2B | `false`（接受档位但不返回分离思考内容） |

`MinerU2.5-Pro` 刻意不收：它走 `/v1/ocr`，`context_length` 为 0，当对话模型用必然失败。

配套的 `compat` 也有实测依据（6/10 个模型拒绝 DSH 默认发的 developer 角色、网关不认 `max_completion_tokens`、`thinking_budget` 三种写法都被静默丢弃），逐条注释见 `src/shared/catalog.js`。

## 实现要点（也给二次开发的人）

- **只读同源路由**：`/api/radeon-capacity/{state,catalog,refresh,config}`，`Origin` 不同源一律 403；
- **不把上游 body 透传**：`normalizeLoad` 只保留 `state/label/utilization` 三个字段并夹到 0–100；
- **凭据解析顺序**：探测到的 provider 的 `apiKeyEnv` → 插件配置的 ref → `RADEON_CLOUD_API_KEY`，每次刷新重新解析（换钥免重启）；
- **客户端是手写单文件 bundle**：`window.__ModuleLoader__.load({ id, factory })`，`require()` 只能拿平台 seed（`react` 等），所以没有构建步骤、没有相对 import；
- **single 槽的坑**：`conversation.input.model.label` 声明为 `kind: "single"`，渲染时取 `entriesOfSlot(key)[0]`。抢占它必须同时满足「`priority` 更靠前」和「自己输出模型名」—— `fallback: model.name` 只在槽里一条都没有时生效。所以本插件在没有 Radeon provider 时**不注册**，而不是注册一个空壳。
- **接管是全局的**：一旦接管，内核自带的 `dsh-client-ui-deepseek-model-label-1017` 就再也不会渲染。所以本插件按同一套判定（provider.id / model.id / model.name）把那个 `1017` 标记等价补上；内核改判定时要跟着改。不想承担这个耦合就把 `modelLabelBadge` 关掉（代价是选择器里没有容量徽章）。
- **表单初值必须是派生的，不能靠 effect 回填**：面板可能在 `/state` 返回前就渲染，那一刻「默认全选」会被固定成用户的选择，结果界面显示全部模型、实际只写入几个。这条有回归测试盯着。

## 已知限制

- 容量读数**最细只能到 ~30 秒**（上游 25 秒 TTFB + 缓存），不是秒级；
- `full` 表示**并发预算已满**，不等于不能用 —— 所以任何地方都不做硬禁用，只标红；
- 上游只返回「有流量」的模型，冷门模型没有读数；
- 额度是**名义值**（AMD 当前免费不限量），仅展示、不做门控；探针本身占 1 次 RPM；
- 控制台内部端点可能变更；变更后容量会退回「暂无读数」，其余功能不受影响。

## 开发

```sh
npm test                        # 44 项：缓存/单飞/退避、额度头解析、provider 探测、路由，
                                # 以及把客户端 bundle 真加载一遍的界面集成测试
node scripts/smoke.mjs          # 真机冒烟：打真实端点，只打印容量与额度，不打印密钥
```

`npm test` 带 `--test-force-exit`：客户端半区会起一个轮询定时器（界面行为），
不带的话测试进程会一直挂着。

## 许可

MIT。思考档位与 `compat` 的实测表来自社区插件 [`@zhz8888/dsh-radeon-cloud-patcher`](https://www.npmjs.com/package/@zhz8888/dsh-radeon-cloud-patcher)（MIT）的线上实测，本仓库独立实现读数与配置两半，未复用其代码路径。
