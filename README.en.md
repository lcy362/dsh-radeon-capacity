# dsh-radeon-capacity

An independent plugin for [DeepSeek Harness](https://github.com/deepseek-ai/harness) that shows **how busy each AMD Radeon Cloud (Token Factory) model is, and how much daily quota is left — before you pick a model.**

Reading numbers is the point. Writing config is a side feature: if you already have a Radeon provider, install and you're done.

It never proxies model calls: transport, reasoning fields and usage accounting stay with DSH's own `dsh-llm-pi-ai`.

## The problem

Radeon Cloud gives you "$1/day + 20 requests/minute", and its models drift between `idle / busy / full`. Until now that information lived in two bad places:

1. Radeon's web console (switch windows, log in);
2. an error, after you already hit the rate limit.

The console's "AI Capacity" bar is fed by `GET /radeon/api/tokenfactory/load`, and the DSH model picker happens to have a slot that can carry a badge. Wiring the two together means you know **before you click** whether a model is congested.

## What you get

| Where | What |
|---|---|
| Model picker | A badge after every Radeon model: `● 12%` (green) / `● 63%` (amber) / `● 100%` (red) |
| Below the composer | Capacity + daily quota of the selected model: `● Busy 55% · $0.97 / $1.00` |
| Settings → Plugins → dsh-radeon-capacity | Every written model with its live capacity; config area (optional) |

The badge only registers **after** a Radeon provider is detected, so it never hijacks the core model-label slot when you don't use Radeon.

## Install

```sh
cd ~/.dsh/profiles/desktop
pnpm add dsh-radeon-capacity        # or: pnpm add /path/to/this/repo
# register "dsh-radeon-capacity" in package.json → dsh.profile.bundles
```

**No restart needed.** The kernel's HMR (`dsh-hmr`) watches the profile
`package.json` and `cordis.patch.yml` and recomposes patches live; the client half
(`dsh-client-hmr`) polls bundle mtimes and pushes `/plugins/events`, so the browser
swaps in the new `client.js` revision on its own.

The one exception is a log line like
`changed modules keep running their previous code until a restart` — modules already
loaded under the old code need a restart. A first install never hits this.

## Already have a Radeon provider? It just works

**Nothing to do.** Detection is by **`baseURL` containing `developer.amd.com.cn`**, so the provider id (`amd`, `radeon-cloud`, anything) and the credential ref don't matter. Capacity and quota appear immediately.

That's a deliberate trade-off: matching on baseURL rather than provider id means your existing setup needs no changes for this plugin.

## Side feature: it can also set up the provider for you

Settings → Plugins → dsh-radeon-capacity — three fields:

- **provider id** — the route name in the model picker, default `amd`;
- **credential ref** — default `AMD_API_KEY`, stored under that key in `~/.dsh/.credentials.yaml`;
- **API key** — `rc-…`, passes through host memory only, never into the browser, never echoed back.

Then "Write config". It is written to the **DSH user layer** (`ctx.settings.update` → profile patch), which means:

> **The provider keeps working after you uninstall this plugin.**

The form doesn't make you re-guess an empty form. It shows the **real written state**: which models are already in, each tagged `written / adding / removing`, with the button label following suit ("Add provider" / "Save changes" / "Rewrite (no change)"), plus a "this operation" block listing exactly what gets added and removed.

Submitting returns immediately without waiting on the capacity refresh — that endpoint takes ~25 s, and awaiting it left the button stuck on "writing…" while the config had long been persisted.

### Optional plugin config

Under the `radeon-capacity` row in the profile's `cordis.patch.yml`:

```yaml
- id: radeon-capacity
  name: dsh-radeon-capacity
  config:
    providerId: amd
    apiKeyEnv: AMD_API_KEY
    displayName: Radeon Cloud
    baseURL: https://developer.amd.com.cn/radeon/api/v1
    quotaProbe: true             # false stops the 1-token quota probe
    capacityTtlMs: 30000
    quotaTtlMs: 60000
```

The plugin declares a single `insert` row and **no provider definition** — otherwise uninstalling it would take the provider with it.

## Data sources

### Capacity — `GET /radeon/api/tokenfactory/load`

```json
{ "models": { "GLM-5.3-Flash": { "state": "full", "label": "At capacity", "utilization": 100 } } }
```

A console-internal route (undocumented), with three facts the design must respect:

- **Slow** — ~25 s TTFB, `cache-control: no-store`, `?model=` filters ignored → cache + single-flight; never hit it per picker open.
- **Floating set** — returns 13–16 models depending on traffic (only ones with traffic), so "not found" is normal: shown as unknown, **never assumed idle**.
- **Undocumented** — may vanish; every failure degrades silently.

Because it's slow, the host does `stale-while-revalidate`: serve the old value, refresh in the background. The UI never hangs on a 25 s request, and data age is shown in the tooltip and settings page. ~30 s freshness is the server's limit; anything faster would be fabrication.

### Quota — `x-ratelimit-*` headers

The gateway returns these on **any** successful response:

```
x-ratelimit-limit-user-daily-usd: 1
x-ratelimit-remaining-user-daily-usd: 0.982
x-ratelimit-limit-user-rpm: 20
x-ratelimit-remaining-user-rpm: 17
```

There is no quota endpoint, so a single `max_tokens: 1` probe reads them (measured 0.31 s, negligible cost, 1 RPM). The probe has its own 60 s TTL and single-flight, decoupled from capacity polling; `quotaProbe: false` turns it off entirely.

### Model discovery

The tier table is a **measured snapshot** (10 chat models). Upstream adds models (2026-10 brought `Gemma-4-31B-IT`; the same catalog also lists `Clef` / `d3` / `OmniVoice` — auxiliary routing services with `context_length: 0` and `decision` output, not chat models, filtered out).

The settings page also queries `GET /v1/models` and lists "online but unmeasured" models separately. Selecting one writes it with `reasoningEfforts: false` — guessing tiers produces 400s, disabling them at least keeps it usable.

### Reasoning tiers

Radeon's catalog doesn't report `reasoning_effort` support, so it's measured. The plugin ships a measured table (10 chat models, 4 tier shapes) and writes `reasoningEfforts` into the provider definition on setup:

| Shape | Models | Tiers |
|---|---|---|
| Full | DeepSeek-V4.1-Flash / V4-Flash / Vision-Exp, MiMo-V2.6-Flash, MiniCPM-V-4.7-35B-A3B | off(none) + minimal/low/medium/high/xhigh/max |
| Qwen | Qwen3.8-27B, Qwen3.8-Flash-Next | off(none) + low/medium/xhigh (`high` returns 400) |
| Three | GLM-5.3-Flash, MiniCPM-V-4.7-1B | low/medium/high (thinking can't be turned off) |
| None | MiniCPM5-2B | `false` (accepts tiers, returns no separate thinking content) |

`MinerU2.5-Pro` is deliberately excluded: it serves `/v1/ocr` with `context_length: 0` and always fails as a chat model.

The accompanying `compat` flags are equally measured (6/10 models reject DSH's default developer role, the gateway doesn't accept `max_completion_tokens`, and all three `thinking_budget` spellings are silently dropped); per-field rationale lives in `src/shared/catalog.js`.

## Design notes

- Read-only same-origin routes under `/api/radeon-capacity`; cross-origin requests get 403.
- Upstream bodies are normalized (`state`/`label`/`utilization` only, clamped to 0–100) and never passed through.
- Credential resolution re-runs on every refresh: detected provider's `apiKeyEnv` → plugin ref → `RADEON_CLOUD_API_KEY`.
- The client half is a hand-written single-file `window.__ModuleLoader__.load({ id, factory })` bundle — no build step, no relative imports, `require()` resolves platform seeds only.
- `conversation.input.model.label` is a `single` slot (`entriesOfSlot(key)[0]`). Taking it over requires both a leading `priority` and rendering the model name yourself; we therefore register lazily instead — and re-implement the kernel's `1017` marker, which the takeover would otherwise swallow.
- Form initial values must be **derived, not seeded via effect**: the panel can render before `/state` arrives, and a "select all" default would then be frozen as the user's choice — the UI would show every model while only a few get written. A regression test guards this.

## Limits

- Capacity is ~30 s granular, never second-level.
- `full` means the concurrency budget is exhausted, **not** that the model is unusable — nothing is ever hard-disabled.
- Models with no traffic have no reading (shown as unknown, never assumed idle).
- The quota probe costs 1 RPM and a tiny fraction of a cent.
- The console-internal endpoint may change; if it does, capacity degrades to "no reading" and everything else keeps working.

## Development

```sh
npm test                        # 41 tests: caching/single-flight/backoff, quota header
                                # parsing, provider detection, routes, and UI integration
                                # tests that really load the client bundle
node scripts/smoke.mjs          # live smoke test against real endpoints; prints capacity
                                # and quota, never the key
```

`npm test` uses `--test-force-exit`: the client half starts a polling timer (real UI behaviour), so the process would otherwise hang.

## License

MIT. The measured reasoning-tier and `compat` tables derive from the community plugin [`@zhz8888/dsh-radeon-cloud-patcher`](https://www.npmjs.com/package/@zhz8888/dsh-radeon-cloud-patcher) (MIT); the reading and configuration halves here are implemented independently.
