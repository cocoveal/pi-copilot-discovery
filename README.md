# pi-copilot-discovery

A [pi](https://github.com/earendil-works/pi) extension that augments the
built-in `github-copilot` provider with the full live model catalog returned by
your Copilot tenant.

## Why

Pi 0.83 performs **dynamic availability filtering**, but its model definitions
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
  remain owned by Pi 0.83's native `github-copilot` provider.
- **Discovers models on session start and after login.** The extension wraps the
  effective provider with a native `refreshModels` implementation.
- **Refreshes on demand.** `/copilot-refresh` re-fetches the tenant catalog.
- **Enables tenant policies after login.** The wrapped built-in OAuth login runs
  `POST /models/<id>/policy {"state":"enabled"}` for every discovered model.
- **Classifies unknown models conservatively.** Claude uses Anthropic Messages,
  GPT-5/o1/o3 use OpenAI Responses, and unknown/Gemini/Grok families use OpenAI
  Chat Completions.

## Install

### As a Pi package

```bash
pi install npm:@milespossing/pi-copilot-discovery
```

Or try it for one session:

```bash
pi -e npm:@milespossing/pi-copilot-discovery
```

### Directly from git

```bash
pi install git:github.com/milespossing/pi-copilot-discovery
pi -e git:github.com/milespossing/pi-copilot-discovery
```

### From a local checkout

```bash
git clone https://github.com/milespossing/pi-copilot-discovery ~/src/pi-copilot-discovery
ln -s ~/src/pi-copilot-discovery ~/.pi/agent/extensions/copilot-discovery
```

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
Pi initializes its built-in github-copilot provider
  └─ session_start
       ├─ extension obtains the effective provider from ctx.modelRegistry
       ├─ wraps it without replacing auth or streaming
       ├─ registers a native provider with refreshModels
       └─ refreshModels receives Pi's already-refreshed credential
            ├─ GET <credential-specific proxy>/models
            ├─ build Model[] from the live response
            └─ publish the live catalog synchronously through getModels()
```

The wrapper keeps the literal provider ID `github-copilot`, so Pi's built-in
Copilot header injection and provider-specific request behavior still apply.
Each discovered model also receives the static Copilot client headers required
by the proxy.

### Family → API routing

| Model family pattern | Pi API | Reasoning |
| --- | --- | --- |
| `claude-*` (3.5+, 4.x, 5.x) | `anthropic-messages` | yes |
| `claude-2.x`, `claude-3` (3.0–3.4) | `anthropic-messages` | no |
| `gpt-5*`, `o1`, `o3` | `openai-responses` | yes |
| `gpt-4*`, `gemini-*`, `grok-*`, other | `openai-completions` | no |

The heuristics in `src/families.ts` intentionally choose the safest known API
for an unfamiliar family.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/model` has no Copilot entries | No configured Copilot credential | Run `/login github-copilot` |
| Only Pi's bundled models appear | Live refresh failed or the extension did not load | Run `/copilot-refresh` and inspect the notification |
| A preview model returns 403 | Its tenant policy was not enabled | Re-run `/login github-copilot` |
| Proxy rejects `Editor-Version` or `User-Agent` | Pi changed its Copilot client headers | Update `COPILOT_HEADERS` in `src/models.ts` |
| A new family is misrouted | Conservative fallback selected `openai-completions` | Refine `src/families.ts` using the returned family/id |

## Requirements

- `@earendil-works/pi-coding-agent` >= 0.83.0
- `@earendil-works/pi-ai` >= 0.83.0
- Node.js >= 22.19.0

Version 0.4.0 uses Pi's native Provider and OAuth APIs.

## Development

```bash
npm install
npx --yes --package typescript@5.9.3 tsc \
  --noEmit --strict --target ES2023 \
  --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions --skipLibCheck \
  src/index.ts src/models.ts src/oauth.ts src/families.ts
```

For an end-to-end test, force-load the checkout with Pi 0.83, select a model
that is absent from Pi's bundled catalog, and send a short prompt.

## Publishing

Pushing a `v*.*.*` tag triggers the npm trusted-publishing workflow, which
checks that the tag matches `package.json` before publishing.

## Layout

```text
.
├── package.json
├── src/
│   ├── index.ts     wrap the native provider and register refresh commands
│   ├── oauth.ts     wrap native login only to enable discovered policies
│   ├── models.ts    fetch /models and build native Model[] entries
│   └── families.ts  map family/id to API and compatibility metadata
├── AGENTS.md
├── README.md
└── LICENSE
```

## License

[MIT](./LICENSE)
