# AGENTS.md — pi-copilot-discovery

A [pi](https://github.com/earendil-works/pi) extension that replaces
pi-ai's built-in `github-copilot` provider with one that discovers the
Copilot tenant's model catalog at runtime from the `/models` endpoint.

All code is TypeScript loaded directly by pi via
[jiti](https://github.com/unjs/jiti) — no build step.

## Build / Test Commands

There is no build step, no test suite, no linter, no CI.

```bash
# Smoke test: provider registers, models discover, no stderr noise.
# Requires an existing ~/.pi/agent/auth.json["github-copilot"] entry.
pi --offline --list-models 2>&1 | head

# Same, but stderr only (extension load errors surface here).
pi --offline --list-models 1>/dev/null 2>&1

# Force-load this checkout (useful when developing without a symlink):
pi --offline --no-extensions -e ~/src/pi-copilot-discovery --list-models

# Verify a single source file parses (Node 22+ loads .ts natively):
node --input-type=module -e "import('./src/families.ts').then(m => console.log(Object.keys(m)))"

# Interactive end-to-end check:
pi
> /login github-copilot               # device-code flow, enables policies
> /model                              # pick a copilot model
> hi
> /copilot-discovery-refresh          # re-fetch /models without restart
```

The interactive `/login github-copilot` and `/copilot-discovery-refresh`
exercises are the only "integration tests" we have. Run them before any
non-trivial change.

## Formatter

There is no formatter configured. Follow `.editorconfig`:

- `.ts` files use **tabs**, width 4.
- `.json`, `.md`, `.yml`, `.yaml` use **2-space indent**.
- LF line endings, UTF-8, final newline, trim trailing whitespace.

Tabs vs. spaces is non-negotiable — Prettier would happily mangle the
indentation if anyone runs it without honoring `.editorconfig`. Don't
add Prettier without a `.prettierrc` that sets `useTabs: true`.

## Repository Layout

```
.
├── package.json     pi extension manifest, no runtime npm deps
├── src/
│   ├── index.ts     async factory; registerProvider + /copilot-discovery-refresh
│   ├── oauth.ts     wraps pi-ai loginGitHubCopilot/refresh; enables policies
│   ├── models.ts    fetch /models, build ProviderModelConfig[]
│   ├── families.ts  pure: family/id → { api, reasoning, thinkingLevelMap, compat }
│   ├── stream.ts    streamSimple wrapper: inject headers, dispatch
│   └── headers.ts   local re-impl of pi-ai's Copilot dynamic headers
├── docs/
│   └── PLAN.md      original design / build plan (historical)
├── AGENTS.md        this file
├── README.md        user-facing docs
└── LICENSE          MIT
```

## Architecture (in one minute)

```
pi starts
  └─ src/index.ts default export (async, awaited by pi)
       ├─ read ~/.pi/agent/auth.json["github-copilot"]
       ├─ if creds & not expired: GET <proxy>/models  →  ProviderModelConfig[]
       │     └─ src/families.ts classifies each model → { api, reasoning, ... }
       └─ pi.registerProvider("github-copilot", { models, oauth, streamSimple, ... })

per request
  └─ pi resolves apiKey via oauth.getApiKey(creds)  (auto-refreshes if expired)
       └─ src/stream.ts streamCopilotDiscovery
            ├─ inject {X-Initiator, Openai-Intent, [Copilot-Vision-Request]}
            └─ dispatch on model.api → pi-ai streamSimpleAnthropic /
                                       streamSimpleOpenAIResponses /
                                       streamSimpleOpenAICompletions
```

## Conventions and Footguns

### `PROVIDER_NAME` must stay `"github-copilot"`

The whole point of this extension is to override pi-ai's built-in.
Registering under any other name reverts you to the parallel-provider
design (and re-introduces the `X-Initiator` quota footgun, because
pi-ai's `model.provider === "github-copilot"` gate is what triggers
the built-in's automatic header injection).

If you genuinely need a parallel install (e.g. two GitHub accounts),
do it in a fork or behind a config flag — don't ship it as the default.

### `COPILOT_HEADERS` lives in two places — keep them in sync

The static client identification headers (`User-Agent`, `Editor-Version`,
`Editor-Plugin-Version`, `Copilot-Integration-Id`) appear in:

- `src/models.ts` (`COPILOT_HEADERS`, used by `fetchCopilotModels` and
  re-exported for `src/oauth.ts`'s policy POSTs)
- `src/index.ts` (inline in `STATIC_PROVIDER.headers`, set on every
  request by pi)

When pi-ai bumps its hardcoded versions (see
[`packages/ai/src/utils/oauth/github-copilot.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/oauth/github-copilot.ts)),
bump both call sites in one commit.

### Per-model `api` override is the routing mechanism

Each entry in the `ProviderModelConfig[]` we register carries an `api`
field that pi-ai uses to pick a streamer. `src/stream.ts` then
switches on `model.api` to dispatch. See
[`custom-provider.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
§ "Model Definition Reference".

If you ever find yourself wanting one provider per family, stop —
that's not the design. Refine `src/families.ts` instead.

### Do not reimplement pi-ai streamers

`src/stream.ts` must always end up calling a `streamSimple*` exported
from `@earendil-works/pi-ai`. Reimplementing one would mean tracking
upstream's bug fixes, tool-call format, and token-counting evolution
by hand. The only thing we add is the header injection.

### Do not bypass pi-ai's OAuth helpers

`loginGitHubCopilot` and `refreshGitHubCopilotToken` from
`@earendil-works/pi-ai/oauth` are the canonical implementations. Wrap
them, don't reimplement them. Upstream domain changes (e.g. a new GHE
proxy host shape) land in our extension for free.

### Heuristics in `families.ts` are intentionally conservative

When uncertain about a new model family, choose `openai-completions`
with `reasoning: false`. The model is then *usable* even if not optimal.
Refine when a real symptom shows up, not preemptively.

The function accepts either an id or a `capabilities.family` string —
Copilot exposes both formats (`claude-haiku-4.5` and `claude-3.7-sonnet`).
Keep both regex shapes covered.

### Credentials are read directly from `auth.json` at load time

`src/index.ts` opens `~/.pi/agent/auth.json` (respecting
`PI_CODING_AGENT_DIR`) once, in the async factory. This is the
documented escape hatch — see `docs/PLAN.md` § 5.6 "Note on the
credential-read sidecar". Do *not* call `refreshGitHubCopilotToken`
from the factory: pi owns refresh, and double-refreshing risks lock
contention on `auth.json`.

If the stored token is expired at load time, register an empty model
list and let the user run `/copilot-discovery-refresh` after pi
refreshes on first use.

## Dependencies

Runtime deps come from pi itself; this extension has no `dependencies`
section in `package.json`. Available imports (provided by pi at runtime):

| Import                                  | Purpose                                                     |
| --------------------------------------- | ----------------------------------------------------------- |
| `@earendil-works/pi-coding-agent`       | `ExtensionAPI`, `ProviderConfig`, `ProviderModelConfig`     |
| `@earendil-works/pi-ai`                 | `Message`, `Model`, `Api`, `Context`, `streamSimple*`, ...  |
| `@earendil-works/pi-ai/oauth`           | `loginGitHubCopilot`, `refreshGitHubCopilotToken`, ...      |
| `node:fs/promises`, `node:os`, `node:path` | Reading `auth.json`                                      |

Tested against pi-coding-agent ≥ 0.78.0 and pi-ai ≥ 0.78.0.

## Where to find upstream source

When implementing or debugging, these are the canonical upstream files.
Links point to `main` on the pi monorepo — contents may drift from
the pinned 0.78.0; cross-check against `node_modules/@earendil-works/pi-ai/dist/`
in your local install if a discrepancy matters.

- [`packages/ai/src/utils/oauth/github-copilot.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/oauth/github-copilot.ts)
  — `loginGitHubCopilot`, `refreshGitHubCopilotToken`,
  `getGitHubCopilotBaseUrl`, `normalizeDomain`, plus the unexported
  `enableGitHubCopilotModel` (we re-implement) and
  `githubCopilotOAuthProvider.modifyModels` (reference impl).
- [`packages/ai/src/providers/github-copilot-headers.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/github-copilot-headers.ts)
  — `inferCopilotInitiator`, `hasCopilotVisionInput`, and
  `buildCopilotDynamicHeaders`. Not in pi-ai's public exports; we
  re-implement them in `src/headers.ts`.
- [`packages/ai/src/providers/openai-completions.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/openai-completions.ts),
  [`openai-responses.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/openai-responses.ts),
  [`anthropic.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/anthropic.ts)
  — grep for `model.provider === "github-copilot"` to find the gates
  we rely on staying gated (so our `streamSimple` wrapper is the only
  place those headers land).
- [`packages/ai/src/models.generated.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.generated.ts)
  (shipped as `dist/models.generated.js`) — pi-ai's static
  github-copilot catalog. Authoritative for
  `compat: { forceAdaptiveThinking: true }` and `thinkingLevelMap`
  defaults; mirror these in `src/families.ts` when refining.
- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
  and [`custom-provider.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
  — `ExtensionAPI`, `ProviderConfig`, OAuth integration, async
  factories. Also shipped in npm installs under
  `node_modules/@earendil-works/pi-coding-agent/docs/`.
- [`packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo)
  — closest design analog: own OAuth, own model list, `streamSimple`
  wrapper dispatching to pi-ai built-ins per backend.

## What this extension does NOT do

- Add new models that the tenant doesn't already expose. We only surface
  what `/models` returns.
- Implement custom rate limiting, retry, or caching. pi-ai handles all of
  that.
- Cache `/models` across pi restarts. Discovery is cheap (one HTTPS call)
  and fresh data is more valuable than the few hundred ms saved.
- Track per-token cost. Copilot is a flat-fee subscription; cost is
  reported as zero. `/usage` token counts are still accurate.
- Replace pi's `/login` or `/logout` machinery. We only plug an `oauth`
  block into the registered provider; pi's command dispatch is unchanged.
- Touch the `anthropic` or `openai-codex` providers. Only `github-copilot`.

## When making changes

1. **Re-read the docs you're touching against.** Always check
   `extensions.md` and `custom-provider.md` (linked above) before
   changing `ExtensionAPI`-shaped code — the docs reflect the pinned
   version.
2. **Run the smoke test.** `pi --offline --list-models` must succeed
   with zero stderr noise and show the full tenant catalog.
3. **Test an actual turn.** Pick the cheapest model in the catalog
   (`gpt-5-mini` is usually it) and send "hi". Confirm a response
   comes back without errors. Bonus: run `/copilot-discovery-refresh`
   mid-session and confirm the model list updates without a restart.
4. **Don't introduce hidden state.** State should live either in
   `auth.json` (pi-owned) or as in-memory data inside the extension
   factory closure. No new sidecar files.
5. **Don't add npm runtime deps.** Anything we'd want is either
   already provided by pi or trivially reimplementable. Keeping
   `dependencies: {}` means installs are instant and reproducible.

## License

MIT. See [LICENSE](./LICENSE).
