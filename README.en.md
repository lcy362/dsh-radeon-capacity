# dsh-radeon-capacity

An independent plugin for [DeepSeek Harness](https://github.com/deepseek-ai/harness) that shows **how busy each AMD Radeon Cloud (Token Factory) model is, before you pick it.**

Capacity is the point. Writing config is a side feature: if you already have a Radeon provider, install and you're done. Quota is displayed too, but **for reference only** — AMD is currently free and unmetered, so that number never affects whether you can call a model.

It never proxies model calls: transport, reasoning fields and usage accounting stay with DSH's own `dsh-llm-pi-ai`.

## The problem

Radeon Cloud models drift between `idle / busy / full`, and that's the thing that actually bites — hitting `full` means waiting for the concurrency budget to free up. Until now that information lived in two bad places:

1. Radeon's web console (switch windows, log in);
2. an error, after you already hit the rate limit.

The console's "AI Capacity" bar is fed by `GET /radeon/api/tokenfactory/load`, and the DSH model picker happens to have a slot that can carry a badge. Wiring the two together means you know **before you click** whether a model is congested.

## What you get

| Where | What |
|---|---|
| Model picker | A badge after every Radeon model: `● 12%` (green) / `● 63%` (amber) / `● 100%` (red) |
| Same row as the model picker | Capacity of the selected model, immediately left of the model name (where WorkBuddy / Trae put their credits); quota dimmed after it: `● Busy 55% · $0.97 / $1.00` |
| Settings → Plugins → dsh-radeon-capacity | Every written model with its live capacity; config area (optional) |

The badge only registers **after** a Radeon provider is detected, so it never hijacks the core model-label slot when you don't use Radeon.

The reading lives in `conversation.input.right` — the same `standardControls` container
as the model picker, rendered immediately before it, so the reading sits **beside** the
model name. It shares the model picker's `sessionId` guard, so **wherever you can pick a
model you can see the reading** — including once a model is picked but before the first
message is sent.
(Earlier versions used `conversation.composer.dock` below the composer, which only renders
in the `composer` variant — a fresh session is the `hero` variant, so the reading vanished
in the "picked but not started" state.)

On-screen readings are **English only** (`Idle / Busy / Full` are AMD's own console terms);
the settings page goes through DSH's locale mechanism and is bilingual (zh/en), following
the UI language.

## Install

### From npm (recommended)

Published to npm, so you install a prebuilt package — nothing is built at install time:

```sh
dsh plugin --profile <your profile> add dsh-radeon-capacity
```

On DSH Desktop, install it from **Settings → Plugins** inside the app. If you use the CLI against
the desktop profile, **quit the app completely first** — otherwise the command writes into a
different profile (`profiles/web`) and nothing shows up in the UI.

### From the community catalog

The catalog `dshmarket` reads is curated by
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Once listed, the
plugin appears under Plugins → Discover and installs with one click.

### From this repo's own index

Before it is listed anywhere, you can add this repo's [format 1 index](market/index.json) as a
market source (Settings → Plugins → Discover → Index sources). jsDelivr first — it is reachable
from mainland China:

```
https://cdn.jsdelivr.net/gh/lcy362/dsh-radeon-capacity@main/market/index.json
```

The same file on GitHub, for networks where raw is reachable:

```
https://raw.githubusercontent.com/lcy362/dsh-radeon-capacity/main/market/index.json
```

Radeon Capacity then shows up under Discover and installs with one click (the market installs the
commit pinned in the index, never a half-finished branch tip).

### From source

```sh
cd ~/.dsh/profiles/desktop
pnpm add link:/path/to/this/repo
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

**Nothing to do.** Detection is by **`baseURL` containing `developer.amd.com.cn`**, so the provider id (`amd`, `radeon-cloud`, anything) and the credential ref don't matter. Capacity appears immediately, with quota shown as a reference value.

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

### Quota (display only) — `x-ratelimit-*` headers

The gateway returns these on **any** successful response:

```
x-ratelimit-limit-user-daily-usd: 1
x-ratelimit-remaining-user-daily-usd: 0.982
x-ratelimit-limit-user-rpm: 20
x-ratelimit-remaining-user-rpm: 17
```

**AMD is currently free and unmetered; these are nominal values** and impose no real limit. So the plugin only *displays* them:

- no gating — a "spent" quota never disables a model or blocks a request;
- no alerting, no colour changes, kept out of the primary reading and dimmed in the UI;
- the tooltip says outright that it's for reference and doesn't affect whether you can call.

There is no quota endpoint, so a single `max_tokens: 1` probe reads the headers (measured 0.31 s, negligible cost, 1 RPM). It has its own 60 s TTL and single-flight, decoupled from capacity polling. **If you don't care, set `quotaProbe: false`** — you lose one reference number, capacity is unaffected.

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
- Quota is **nominal** (AMD is free and unmetered right now): display only, never gates anything. The probe itself costs 1 RPM.
- The console-internal endpoint may change; if it does, capacity degrades to "no reading" and everything else keeps working.

## Development

```sh
npm test                        # 44 tests: caching/single-flight/backoff, quota header
                                # parsing, provider detection, routes, and UI integration
                                # tests that really load the client bundle
node scripts/smoke.mjs          # live smoke test against real endpoints; prints capacity
                                # and quota, never the key
```

`npm test` uses `--test-force-exit`: the client half starts a polling timer (real UI behaviour), so the process would otherwise hang.

## Releasing and listing (maintainers)

### Cutting a release

```sh
npm version patch --no-git-tag-version   # bump package.json, without tagging yet
git commit -am "chore(release): vX.Y.Z" && git push
bash scripts/release.sh                  # tests -> pack -> tag + GitHub Release
npm publish                              # needs a prior npm login
```

`scripts/release.sh` uploads the artifact under the **fixed** name `dsh-radeon-capacity.tgz` and
prints the new commit SHA, which goes into `market/index.json`'s `source.commit` (the index must
not point at its own commit).

The asset name must not carry the version: the index's `tarball` field points at
`releases/latest/download/`, and a versioned filename 404s as soon as the next release ships —
the catalog's `probe-tarballs.mjs` then **silently drops** the field.

### Why publishing to npm matters

`dshmarket` sorts by "npm downloads (30d)", descending, by default, and its comparator only looks
at `downloads`:

```js
const hasDownloads = (p) => typeof p.downloads === "number"
```

- Entries without an npm count sort **below every entry that has one**; only inside that group does
  it fall back to stars.
- The catalog has **no** `githubReleaseDownloads` field (I checked the live `plugins.json` field
  set), so "skip npm and lean on GitHub Release downloads" does not work here — the card simply
  shows no number.

Two prerequisites:

1. `package.json` must carry a `repository` pointing back at this repo. The catalog's `probe-npm.mjs`
   accepts an npm package only when the registry entry's `repository` points at the same GitHub repo
   (a name-squatting guard). Without it the entry stays `npm: null` forever.
2. The name `dsh-radeon-capacity` is free on npm.

### Listing in the community catalog

The catalog `dshmarket` reads comes from
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):
**one YAML per plugin, one file per PR**:

```
data/plugins/lcy362__dsh-radeon-capacity.yml
```

CI checks that some `package.json` in the repo declares `dsh.bundle`, that the repo is at least a
day old, is not archived and is not DSH itself; it also expects the `dsh-plugin` topic and a
description that matches the code. When both an npm package and a `tarball` exist, the card offers
the npm install command.

`losebird/dsh-plugin-market` is a **separate** registry (`registry/curated/<id>.json`) that
`dshmarket` does not read — seeing an entry there requires adding that index under
Discover → Index sources yourself.


## License

MIT. The measured reasoning-tier and `compat` tables derive from the community plugin [`@zhz8888/dsh-radeon-cloud-patcher`](https://www.npmjs.com/package/@zhz8888/dsh-radeon-cloud-patcher) (MIT); the reading and configuration halves here are implemented independently.
