# dsh-radeon-capacity

An independent plugin for [DeepSeek Harness](https://github.com/deepseek-ai/harness) that surfaces **AMD Radeon Cloud (Token Factory)** model load and daily quota inside the UI — and can optionally write your provider config for you.

It never proxies model calls: transport, reasoning fields and usage accounting stay with DSH's own `dsh-llm-pi-ai`. This plugin only *reads* numbers and *writes* configuration.

## What you get

| Where | What |
|---|---|
| Model picker | A badge after every Radeon model: `● 12%` (green) / `● 63%` (amber) / `● 100%` (red) |
| Below the composer | Capacity + daily quota of the selected model: `● Busy 55% · $0.97 / $1.00` |
| Settings → Plugins → dsh-radeon-capacity | Status overview + one-click provider setup (stores the key, picks models) |

The badge only registers **after** a Radeon provider is detected, so it never hijacks the core model-label slot when you don't use Radeon.

## Install

```sh
# Quit the DSH app first, then:
cd ~/.dsh/profiles/desktop
pnpm add dsh-radeon-capacity        # or: pnpm add /path/to/this/repo
# register "dsh-radeon-capacity" in package.json → dsh.profile.bundles
# restart DSH
```

## Configuration

- **Already have a Radeon provider?** Nothing to do. Detection is by `baseURL` containing `developer.amd.com.cn`, so the provider id (`amd`, `radeon-cloud`, anything) and the credential ref don't matter.
- **No provider yet?** Settings → Plugins → dsh-radeon-capacity: provider id, credential ref (`AMD_API_KEY`), API key (`rc-…`), then "Write config". It is written to the **user layer** via `ctx.settings.update`, which means **the provider keeps working after you uninstall this plugin** — the exact opposite of shipping a provider inside a plugin bundle layer.
- Optional plugin config: `providerId`, `apiKeyEnv`, `displayName`, `baseURL`, `quotaProbe`, `capacityTtlMs`, `quotaTtlMs`.

## Data sources

- **Capacity** — `GET /radeon/api/tokenfactory/load` (the source of the console's "AI Capacity" bar). It takes ~25 s TTFB, returns 13–16 models depending on traffic, and is undocumented, so the host caches (30 s), single-flights, and serves stale-while-revalidate. Freshness is therefore ~30 s at best; that is a server-side limit, not a shortcut.
- **Quota** — `x-ratelimit-*-user-daily-usd` / `-user-rpm` response headers. There is no quota endpoint, so a single `max_tokens: 1` probe reads them (≈0.3 s, 1 RPM, negligible cost), cached 60 s, single-flighted, and switchable off with `quotaProbe: false`.
- **Reasoning tiers** — measured, not documented: 10 chat models in 4 tier shapes, written into the provider definition on setup. Field-by-field rationale lives in `src/shared/catalog.js`.
- **Model discovery** — `GET /v1/models` is queried separately so models added upstream (e.g. `Gemma-4-31B-IT`) stay selectable even though the tier table is a snapshot. Unmeasured models are written with `reasoningEfforts: false`; guessing tiers produces 400s. Auxiliary routing services (`Clef`, `d3`, `OmniVoice`, `context_length: 0`) are filtered out.

## Design notes

- Read-only same-origin routes under `/api/radeon-capacity`; cross-origin requests get 403.
- Upstream bodies are normalized (`state`/`label`/`utilization` only, clamped to 0–100) and never passed through.
- Credential resolution re-runs on every refresh: detected provider's `apiKeyEnv` → plugin ref → `RADEON_CLOUD_API_KEY`.
- The client half is a hand-written single-file `window.__ModuleLoader__.load({ id, factory })` bundle — no build step, no relative imports, `require()` resolves platform seeds only.
- `conversation.input.model.label` is a `single` slot (`entriesOfSlot(key)[0]`). Taking it over requires both a leading `priority` and rendering the model name yourself; we therefore register lazily instead — and re-implement the kernel's `1017` marker, which the takeover would otherwise swallow.

## Limits

- Capacity is ~30 s granular, never second-level.
- `full` means the concurrency budget is exhausted, **not** that the model is unusable — nothing is ever hard-disabled.
- Models with no traffic have no reading (shown as unknown, never assumed idle).
- The console-internal endpoint may change; if it does, capacity degrades to "no reading" and everything else keeps working.

## License

MIT. The measured reasoning-tier and `compat` tables derive from the community plugin [`@zhz8888/dsh-radeon-cloud-patcher`](https://www.npmjs.com/package/@zhz8888/dsh-radeon-cloud-patcher) (MIT); the reading and configuration halves here are implemented independently.
