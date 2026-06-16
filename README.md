# pi-copilot-discovery

A [pi](https://github.com/earendil-works/pi) extension that replaces pi's
built-in `github-copilot` provider with one that discovers your Copilot
tenant's full model catalog at runtime instead of using pi-ai's bundled
static list.

## Why

pi-ai ships a hand-curated `models.generated.js` listing the GitHub Copilot
models pi knows about. That list lags real Copilot tenants in two ways:

- **Preview / tenant-private models are invisible.** Internal model families,
  early-access SKUs, and anything your enterprise has been allow-listed for
  never show up in `/model`.
- **New public models need a pi-ai release.** When Copilot exposes a new
  model id, pi can't talk to it until pi-ai cuts a release that adds it.

This extension solves both by calling Copilot's own `/models` endpoint on
startup and registering every chat-capable model the signed-in account is
entitled to. Routing to the right pi-ai streamer (`anthropic-messages`,
`openai-responses`, `openai-completions`) is derived from each model's
family.

## What it does

- **Replaces the built-in `github-copilot` provider.** Same provider name, so
  existing credentials, sessions, and `/login github-copilot` workflows keep
  working. `pi --list-models` and `/model` simply show a larger, more
  accurate catalog.
- **Live discovery.** Fetches `/models` on extension load (before the agent
  starts) so the live list is available to `pi --list-models` and the model
  picker without an interactive session.
- **Re-injects Copilot dynamic headers.** pi-ai's built-in streamers add
  `X-Initiator`, `Openai-Intent`, and `Copilot-Vision-Request` only when
  the built-in handler is the one running; this extension installs its own
  `streamSimple` wrapper that re-adds them, preserving agent-vs-user quota
  accounting and vision support.
- **Enables tenant policies post-login.** Runs
  `POST /models/<id>/policy {state:"enabled"}` against *every* discovered
  model after `/login github-copilot`, so preview-tier models accept requests
  on first use. (pi-ai's built-in flow only enables its hardcoded list.)
- **Supports GitHub Enterprise.** The login flow prompts for an enterprise
  domain; `enterpriseUrl` is preserved across pi restarts via
  `OAuthCredentials`'s open-ended index signature.

The personal `github-copilot` credentials, sessions, and behavior stay
intact — this is a drop-in upgrade of the provider, not a parallel one.

## Install

### As a pi package (recommended once published)

```bash
pi install npm:pi-copilot-discovery
```

Or try it for one session without installing:

```bash
pi -e npm:pi-copilot-discovery
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

Either form auto-discovers as a global pi extension. Restart pi (or run
`/reload`) and the live model list takes effect.

### After installing

- If you already have a `github-copilot` entry in `~/.pi/agent/auth.json`, no
  action needed — the existing token is reused.
- Otherwise: `/login github-copilot`. The flow prompts for an enterprise
  host (leave blank for `github.com`).

## Commands

| Command                         | What it does                                              |
| ------------------------------- | --------------------------------------------------------- |
| `/login github-copilot`         | Device-code login + enable policies on all live models    |
| `/copilot-discovery-refresh`    | Re-fetch the `/models` catalog without restarting pi      |
| `/logout github-copilot`        | (Built-in) Clear stored credentials                       |

## How it works

```
pi starts
  └─ extension factory runs (awaited by pi before startup completes)
       ├─ read ~/.pi/agent/auth.json["github-copilot"]
       ├─ if credentials present & not expired:
       │     GET <proxy>/models  →  ProviderModelConfig[]
       │     ├─ classify each model's family → { api, reasoning, compat }
       │     └─ pi.registerProvider("github-copilot", { models, oauth, streamSimple, ... })
       └─ if no credentials: register with models: [] (login still surfaces in /login)

per request
  └─ pi resolves apiKey via oauth.getApiKey(creds)
       └─ pi-copilot-discovery.streamSimple
            ├─ inject {X-Initiator, Openai-Intent, [Copilot-Vision-Request]}
            └─ dispatch on model.api → pi-ai streamSimple* (Anthropic / OpenAI Responses / Completions)
```

### Family → API routing

| Model family pattern            | pi-ai api            | Reasoning |
| ------------------------------- | -------------------- | --------- |
| `claude-*` (3.5+, 4.x, 5.x)     | `anthropic-messages` | yes       |
| `claude-2.x`, `claude-3` (3.0–3.4) | `anthropic-messages` | no    |
| `gpt-5*`, `o1`, `o3`            | `openai-responses`   | yes       |
| `gpt-4*`, `gemini-*`, `grok-*`, other | `openai-completions` | no  |

Heuristics live in `families.ts` and are intentionally conservative — when
uncertain we choose an `api` the model is *usable* under even if not optimal.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/model` shows no Copilot entries before login | No credentials yet. | Run `/login github-copilot`. |
| `/model` empty *after* login on a fresh pi start | Stored access token was already expired; discovery was skipped to let pi refresh on first use. | Run `/copilot-discovery-refresh`. |
| Some model returns 403 the first time you use it | Tenant policy was `"unconfigured"` and post-login policy enable didn't succeed. | Run `/copilot-discovery-refresh` (or re-run `/login github-copilot`). |
| Editor-Version / User-Agent rejected by the work proxy | pi-ai bumped its hardcoded Copilot client strings. | Update `COPILOT_HEADERS` in `models.ts` and `index.ts` to the new values. |
| A new family is misrouted to `openai-completions` | Default fallback. | Open an issue with the model id and tenant `capabilities.family`, or send a PR refining `families.ts`. |

## Compatibility

- pi-coding-agent ≥ 0.78.0 (uses the async extension factory, per-model
  `api` override, OAuth `ProviderConfig`, and the `streamSimple` escape
  hatch).
- pi-ai ≥ 0.78.0 (uses `loginGitHubCopilot`, `refreshGitHubCopilotToken`,
  `getGitHubCopilotBaseUrl`, `normalizeDomain`, and the `streamSimple*`
  family).
- Node.js ≥ 22.19.0 (matches pi's `engines` requirement).

## Publishing

```bash
npm version patch
git push origin main --follow-tags
```

Pushing a `v*.*.*` tag triggers the npm publish workflow, which verifies the
tag matches `package.json` and publishes the package to npm.

## Layout

```
.
├── package.json     pi extension manifest, no runtime npm deps
├── src/
│   ├── index.ts     async factory: registerProvider + /command
│   ├── oauth.ts     wraps pi-ai loginGitHubCopilot/refresh; enables policies
│   ├── models.ts    fetch /models, build ProviderModelConfig[]
│   ├── families.ts  pure: family/id → { api, reasoning, thinkingLevelMap, compat }
│   ├── stream.ts    streamSimple wrapper: inject headers, dispatch
│   └── headers.ts   local re-impl of pi-ai's Copilot dynamic headers
├── docs/
│   └── PLAN.md      original design / build plan
├── AGENTS.md        contributor guide for AI agents
├── README.md
└── LICENSE
```

## License

[MIT](./LICENSE)
