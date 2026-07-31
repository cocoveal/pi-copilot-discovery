# AGENTS.md — pi-copilot-discovery

A Pi 0.83+ extension that augments the built-in `github-copilot` provider with
model definitions created from the tenant's live `/models` response.

TypeScript is loaded directly by Pi through jiti; there is no build artifact.

## Commands

```bash
npm install

# Typecheck
npx --yes --package typescript@5.9.3 tsc \
  --noEmit --strict --target ES2023 \
  --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions --skipLibCheck \
  src/index.ts src/models.ts src/oauth.ts src/families.ts

# Interactive load test (use the unwrapped Pi binary when a configured wrapper
# already force-loads the published extension)
/path/to/pi --no-extensions -e ~/src/pi-copilot-discovery

# End-to-end: select a live-only model in /model and send "Reply: ok".
# Also run /copilot-refresh and verify the success notification.
```

There is no unit-test suite or linter. Typecheck plus extension loading and one
real Copilot request are the required validation.

## Formatting

- TypeScript uses tabs, width 4.
- JSON, Markdown, and YAML use two spaces.
- LF, UTF-8, final newline, no trailing whitespace.

## Layout

```text
src/index.ts     obtains and wraps Pi's effective native provider
src/models.ts    fetches /models and creates Model[] entries
src/oauth.ts     wraps native login only to enable discovered policies
src/families.ts  maps unfamiliar model families to Pi API/compat metadata
```

## Architecture

Pi 0.83 already calls `/models`, but only extracts IDs and filters its static
`GITHUB_COPILOT_MODELS` catalog. Unknown IDs still need this extension.

```text
session_start
  ├─ ctx.modelRegistry.getProvider("github-copilot")
  ├─ preserve the provider's auth, streams, base behavior, and ID
  ├─ replace getModels/filterModels/refreshModels in a native Provider wrapper
  └─ ctx.modelRegistry.refresh()
       ├─ Pi refreshes the stored OAuth credential under its lock
       ├─ extension receives the valid credential in RefreshModelsContext
       ├─ GET <token-derived proxy>/models
       └─ publish discovered Model[] entries
```

The extension does not read or write `auth.json`. Pi owns credentials,
persistence, token refresh, enterprise endpoint derivation, and logout.

## Critical rules

### Require Pi 0.83+

Pi 0.83 removed `githubCopilotOAuthProvider`, `getGitHubCopilotBaseUrl`, and
`normalizeDomain` from `@earendil-works/pi-ai/oauth`. Do not restore those old
imports. The package's first compatible release is 0.4.0.

### Wrap the effective provider

Do not import `@earendil-works/pi-ai/providers/github-copilot` from an
extension. Pi's jiti aliasing currently treats that subpath as a suffix of its
compat entry and fails resolution. Obtain the provider from
`ctx.modelRegistry.getProvider("github-copilot")` during `session_start`.

### Keep the provider ID `github-copilot`

Pi's OpenAI and Anthropic implementations inject Copilot-specific dynamic
headers only for that literal provider ID. A parallel provider name breaks
quota attribution, vision behavior, and other Copilot request handling.

### Preserve native auth and streaming

The provider wrapper must spread the effective provider and override only:

- `auth.oauth.login` (policy enablement only)
- `getModels`
- `refreshModels`
- `filterModels`

Never reimplement login, refresh, credential persistence, `toAuth`, or stream
functions. `src/oauth.ts` delegates login to the native OAuth object before
performing best-effort policy POSTs.

### Include static Copilot client headers on discovered models

Pi's generated static catalog puts `User-Agent`, `Editor-Version`,
`Editor-Plugin-Version`, and `Copilot-Integration-Id` on each model. Dynamic
models must do the same or the proxy rejects requests (for example, `400
missing Editor-Version header`). Keep `COPILOT_HEADERS` in `src/models.ts`
aligned with upstream's GitHub Copilot OAuth implementation.

### Derive the API host from credentials

Never route authenticated traffic to a hardcoded individual endpoint.
`resolveCopilotBaseUrl()` first calls native OAuth `toAuth()` for OAuth
credentials, then falls back to the token's `proxy-ep`, then the provider's
base URL. Enterprise tenants commonly use `api.enterprise.githubcopilot.com`.

### Retain the previous catalog on refresh failure

`refreshModels` must update its in-memory model list only after a complete,
non-empty response. Offline or failed refreshes leave the built-in or last
successful catalog intact.

### Validate live response records

Do not trust `/models` blindly. Keep only object records with a non-empty string
`id`, chat capability, model-picker availability, and tool-call support. Dedup
by ID before publishing.

### Keep family routing conservative

- Claude → `anthropic-messages`
- GPT-5/o1/o3 → `openai-responses`
- Gemini/Grok/unknown → `openai-completions`

Only advertise reasoning tiers supported by the model family. A wrong tier can
cause `400 Unsupported value` responses.

## Dependencies

Runtime imports come from Pi. Keep them in `devDependencies` for typechecking:

- `@earendil-works/pi-coding-agent` >= 0.83.0
- `@earendil-works/pi-ai` >= 0.83.0
- `@types/node`

Do not add runtime npm dependencies without a compelling reason.

## Release checklist

1. Typecheck.
2. Start Pi with only this checkout loaded; confirm no extension error.
3. Confirm `/model` includes at least one ID absent from Pi's static catalog.
4. Send a short real request through a live-only model.
5. Run `/copilot-refresh` and verify its success notification.
6. Update `package.json` version and lockfile.
7. Commit, tag `vX.Y.Z`, and push the tag to trigger trusted npm publishing.
