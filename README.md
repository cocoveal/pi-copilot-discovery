# pi-copilot-discovery

A [pi](https://github.com/earendil-works/pi) extension that augments the
built-in `github-copilot` provider with the full live model catalog returned by
your Copilot tenant.

This is a fork of
[milespossing/pi-copilot-discovery](https://github.com/milespossing/pi-copilot-discovery)
that targets Pi 1.5+. Upstream targets Pi 0.83 and fails on Pi 1.5 with `refresh
failed: not logged in`. See [docs/maintaining-fork.md](./docs/maintaining-fork.md).

## Why

Pi performs **dynamic availability filtering**, but its model definitions
remain static:

1. Pi calls Copilot's `/models` endpoint and records the available model IDs.
2. Pi filters its bundled `GITHUB_COPILOT_MODELS` catalog to those IDs.
3. IDs absent from the bundled catalog are still invisible because Pi has no
   model configuration for them.

This extension uses the full `/models` response to create model definitions at
runtime. That surfaces new public, preview, and tenant-private models without
waiting for another Pi release.

## What it does

- **Preserves Pi's built-in provider.** Authentication, credential persistence,
  token refresh, enterprise endpoint selection, request headers, and streaming
  remain owned by Pi's native `github-copilot` provider.
- **Discovers models on session start and after login.** The extension wraps the
  built-in provider with a native `refreshModels` implementation.
- **Persists the live catalog.** Discovered models are stored through Pi's
  model store (`~/.pi/agent/models-store.json`), so they survive restarts,
  offline sessions, and `enabledModels` scope resolution in other processes.
- **Refreshes on demand.** `/copilot-refresh` re-fetches the tenant catalog.
- **Enables tenant policies after login.** The wrapped built-in OAuth login runs
  `POST /models/<id>/policy {"state":"enabled"}` for every discovered model.
- **Classifies unknown models conservatively.** Claude uses Anthropic Messages,
  GPT-5/o1/o3 use OpenAI Responses, responses-only models (for example Grok 4.5)
  use OpenAI Responses from `supported_endpoints`, and remaining chat models use
  OpenAI Chat Completions.

## Install

### From git (pinned tag)

```bash
pi install git:github.com/cocoveal/pi-copilot-discovery@v0.5.0
```

Or try it for one session:

```bash
pi -e git:github.com/cocoveal/pi-copilot-discovery@v0.5.0
```

The npm package `@milespossing/pi-copilot-discovery` is upstream's Pi 0.83
build and does not work on Pi 1.5+.

### From a local checkout

```bash
git clone https://github.com/cocoveal/pi-copilot-discovery ~/src/pi-copilot-discovery
pi -e ~/src/pi-copilot-discovery
```

Remove an installed git package first, or both copies register the provider.

Restart Pi or run `/reload`. Existing `github-copilot` credentials continue to
work. If needed, run `/login github-copilot`.

## Commands

| Command | What it does |
| --- | --- |
| `/login github-copilot` | Built-in device-code login plus policy enablement for live models |
| `/copilot-refresh` | Re-fetch the live `/models` catalog |
| `/logout github-copilot` | Built-in credential removal |

## How it works

```text
extension load
  ├─ take github-copilot from builtinProviders() (@earendil-works/pi-ai/providers/all)
  ├─ wrap it without replacing auth or streaming
  └─ register it before enabledModels / --models scope resolution
refreshModels (offline phase)
  └─ restore the persisted live catalog from context.stored
session_start → ctx.modelRegistry.refresh()
  └─ refreshModels receives Pi's refreshed credential (refreshModelsAuth: "credential")
       ├─ GET <credential-specific proxy>/models
       ├─ build Model[] from the live response
       └─ context.publish(): persist and expose via getModels()/getAllModels()
```

The wrapper keeps the literal provider ID `github-copilot`, so Pi's built-in
Copilot header injection and provider-specific request behavior still apply.
Each discovered model also receives the static Copilot client headers required
by the proxy.

### Family → API routing

| Model family / endpoint signal | Pi API | Reasoning |
| --- | --- | --- |
| `claude-*` (3.5+, 4.x, 5.x) | `anthropic-messages` | yes |
| `claude-2.x`, `claude-3` (3.0–3.4) | `anthropic-messages` | no |
| `gpt-5*`, `o1`, `o3` | `openai-responses` | yes |
| responses-only (`supported_endpoints: ["/responses"]`) | `openai-responses` | if advertised |
| `gpt-4*`, `gemini-*`, other chat-completions | `openai-completions` | if `reasoning_effort` advertised |

`supported_endpoints` wins for responses-only models such as `grok-4.5` and
`mai-code-1-flash-picker`. Routing those to `/chat/completions` yields
`unsupported_api_for_model`. Name heuristics still classify Claude and GPT-5
families when endpoints are absent or include multiple paths.

The heuristics in `src/families.ts` intentionally choose the safest known API
for an unfamiliar family.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/model` has no Copilot entries | No configured Copilot credential | Run `/login github-copilot` |
| Only Pi's bundled models appear | Live refresh failed or the extension did not load | Run `/copilot-refresh` and inspect the notification |
| A preview model returns 403 | Its tenant policy was not enabled | Re-run `/login github-copilot` |
| Proxy rejects `Editor-Version` or `User-Agent` | Pi changed its Copilot client headers | Update `COPILOT_HEADERS` in `src/models.ts` |
| `unsupported_api_for_model` on `/chat/completions` | Model is responses-only (`supported_endpoints: ["/responses"]`) | Ensure discovery reads `supported_endpoints`; update if needed |
| A new family is misrouted | Conservative fallback selected `openai-completions` | Refine `src/families.ts` using the returned family/id/endpoints |

## Requirements

- `@earendil-works/pi-coding-agent` >= 1.5.0
- `@earendil-works/pi-ai` >= 1.5.0
- Node.js >= 22.19.0

Version 0.5.0 is the first release for Pi 1.5+. Use upstream 0.4.x for Pi 0.83.

## Development

```bash
npm install
npx --yes --package typescript@5.9.3 tsc \
  --noEmit --strict --target ES2023 \
  --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions --skipLibCheck \
  src/index.ts src/models.ts src/oauth.ts src/families.ts
```

For an end-to-end test, force-load the checkout with Pi 1.5+, select a model
that is absent from Pi's bundled catalog, and send a short prompt.
Verification commands are in [docs/maintaining-fork.md](./docs/maintaining-fork.md).

## Releasing

Releases are git tags consumed with `pi install git:...@vX.Y.Z`. The inherited
npm publishing workflow runs on tag push but has no trusted publisher for this
fork, so it does not publish.

## Layout

```text
.
├── package.json
├── src/
│   ├── index.ts     wrap the native provider and register refresh commands
│   ├── oauth.ts     wrap native login only to enable discovered policies
│   ├── models.ts    fetch /models and build native Model[] entries
│   └── families.ts  map family/id to API and compatibility metadata
├── docs/
│   └── maintaining-fork.md  fork setup, release, and Pi 1.5 notes
├── AGENTS.md
├── README.md
└── LICENSE
```

## License

[MIT](./LICENSE)
