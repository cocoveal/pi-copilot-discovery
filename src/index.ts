/**
 * pi-copilot-discovery — dynamic GitHub Copilot provider for pi.
 *
 * Replaces pi-ai's built-in `github-copilot` provider with a version
 * that discovers the model catalog at runtime from the Copilot tenant's
 * `/models` endpoint, instead of using pi-ai's bundled static list.
 *
 * Wins:
 *   - Preview / tenant-private models (e.g. internal MAI families) show
 *     up in `/model` automatically.
 *   - New Copilot models work the day the tenant exposes them, with no
 *     pi-ai release.
 *   - Per-model `api` routing (anthropic-messages / openai-responses /
 *     openai-completions) is derived from each model's family so the
 *     correct pi-ai streamer is used.
 *   - Copilot dynamic headers (`X-Initiator`, `Openai-Intent`,
 *     `Copilot-Vision-Request`) are still injected — the built-in
 *     streamers only add them automatically when the provider name is
 *     literally `"github-copilot"`, which is exactly what we register as.
 *
 * Refresh strategy (v0.2):
 *   - At load time, if the stored access token is expired (or near
 *     expiry), we refresh it *in memory* via pi-ai's
 *     `refreshGitHubCopilotToken` and use the fresh token for `/models`
 *     discovery. We never write back to `auth.json`; pi's auth-storage
 *     owns that file and will refresh + persist on first use. Doing the
 *     in-memory refresh here means the model picker is populated
 *     immediately on cold start, instead of waiting for the user's
 *     first turn.
 *   - After every successful discovery we arm a `setTimeout` to
 *     pre-emptively refetch ~60s before the token expires, so the
 *     catalog stays warm without depending on user activity.
 *   - On a 401 from `/models` we refresh once and retry, in case the
 *     token rotated underneath us (another pi process, /logout+/login,
 *     etc).
 *
 * Resilience (v0.2.1):
 *   - At WSL/login cold start the network, DNS, and clock are often not
 *     ready for a second or two, so the first refresh/`/models` call can
 *     fail with a spurious `401 Bad credentials` even though the stored
 *     `ghu_*` token is perfectly valid. Startup discovery now retries
 *     with backoff across those transient errors instead of giving up.
 *   - If discovery still fails, we register the provider in
 *     *override-only* mode (no `models` key), which keeps pi's built-in
 *     static github-copilot catalog intact rather than wiping it to an
 *     empty list. The session is always usable; worst case we behave
 *     exactly like pi's built-in Copilot provider until the next
 *     successful refresh upgrades us to the live tenant catalog.
 *   - A working live catalog is never downgraded by a *later* failed
 *     refresh, and a failed proactive refresh re-arms a short retry.
 *
 * Compatibility:
 *   - Existing `~/.pi/agent/auth.json["github-copilot"]` credentials are
 *     reused as-is. No re-login required on install.
 *   - `/login github-copilot` runs this extension's login flow (which
 *     additionally enables policies on every discovered model, not just
 *     pi-ai's hardcoded list).
 *   - `/logout github-copilot` works as before via pi's built-in.
 *
 * Commands:
 *   /copilot-refresh             re-fetch the /models catalog (primary)
 *   /copilot-discovery-refresh   alias of /copilot-refresh (back-compat)
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { refreshGitHubCopilotToken } from "@earendil-works/pi-ai/oauth";

import { copilotDiscoveryOAuth, type CopilotCredentials } from "./oauth.ts";
import { fetchCopilotModels, toProviderModels } from "./models.ts";
import { streamCopilotDiscovery } from "./stream.ts";

const PROVIDER_NAME = "github-copilot";

/**
 * Refresh the in-memory access token this far before its stored
 * `expires` timestamp. Just large enough to absorb network latency on
 * the refresh round-trip without ever serving a stale token to /models.
 */
const PROACTIVE_REFRESH_LEAD_MS = 60_000;

/**
 * Treat a stored token as "needs refresh now" once it's within this
 * many ms of expiry. Anything past this → refresh synchronously before
 * the next /models call. Smaller than the proactive lead so we don't
 * loop refreshing.
 */
const STALE_THRESHOLD_MS = 30_000;

/**
 * Backoff schedule (ms) for transient cold-start discovery failures.
 *
 * At WSL/login cold start the network stack, DNS, and even the system
 * clock are frequently not ready for the first second or two, which
 * surfaces as a spurious `401 Bad credentials` from
 * `copilot_internal/v2/token` or a `fetch failed`/`ENOTFOUND` on
 * `/models`. The stored `ghu_*` refresh token is fine — it just needs a
 * second attempt. We retry a few times before giving up and falling
 * back to the built-in static catalog.
 */
const STARTUP_RETRY_BACKOFF_MS = [500, 1500, 3000] as const;

/** Errors worth retrying: transient network / token-mint hiccups. */
function isRetriableDiscoveryError(msg: string): boolean {
	return (
		/\b401\b/.test(msg) ||
		/Bad credentials/i.test(msg) ||
		/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up/i.test(
			msg,
		)
	);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Same logic as pi-coding-agent's `getAgentDir()` in dist/config.js,
// so we read the same auth.json pi writes (including under
// PI_CODING_AGENT_DIR overrides).
function getAuthPath(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	const base = envDir
		? envDir.replace(/^~(\/|$)/, `${homedir()}$1`)
		: join(homedir(), ".pi", "agent");
	return join(base, "auth.json");
}

type StoredCredential = CopilotCredentials & { type?: string };

async function readStoredCredentials(): Promise<CopilotCredentials | null> {
	try {
		const buf = await readFile(getAuthPath(), "utf8");
		const json = JSON.parse(buf) as Record<string, unknown>;
		const entry = json[PROVIDER_NAME];
		if (
			entry &&
			typeof entry === "object" &&
			"access" in entry &&
			typeof (entry as StoredCredential).access === "string"
		) {
			return entry as CopilotCredentials;
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(
				`pi-copilot-discovery: could not read auth.json (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}
	return null;
}

/**
 * Return credentials with a non-stale `access` token. If `creds.access`
 * is within `STALE_THRESHOLD_MS` of expiry (or already past), call
 * pi-ai's `refreshGitHubCopilotToken` to mint a new one and return that
 * — *without* writing to auth.json. Pi's auth-storage owns the file and
 * will refresh + persist itself on first use.
 *
 * Returns `null` if the credentials lack a refresh token or refresh
 * fails.
 */
async function ensureFreshCredentials(
	creds: CopilotCredentials,
): Promise<CopilotCredentials | null> {
	const now = Date.now();
	const expires = typeof creds.expires === "number" ? creds.expires : 0;
	const stale = expires - now <= STALE_THRESHOLD_MS;
	if (!stale) return creds;
	if (typeof creds.refresh !== "string" || creds.refresh.length === 0) {
		return null;
	}
	try {
		const refreshed = (await refreshGitHubCopilotToken(
			creds.refresh,
			creds.enterpriseUrl,
		)) as CopilotCredentials;
		// `refreshGitHubCopilotToken` already preserves enterpriseUrl,
		// but be defensive — older pi-ai versions didn't.
		if (!refreshed.enterpriseUrl && creds.enterpriseUrl) {
			refreshed.enterpriseUrl = creds.enterpriseUrl;
		}
		return refreshed;
	} catch {
		// Silent: a refresh miss is not necessarily fatal (the
		// stale-but-not-yet-expired access token may still satisfy
		// /models), and any genuinely fatal outcome is reported once by
		// the discovery layer rather than once per retry attempt.
		return null;
	}
}

/**
 * Provider config minus `models` — the model list is the only piece
 * that changes between cold-start, post-login, and post-refresh.
 *
 * `baseUrl` is a placeholder; `oauth.modifyModels` rewrites every
 * registered model's baseUrl to the proxy-ep encoded in the current
 * Copilot token before each request.
 *
 * Registering with `name: "github-copilot"` and `models: [...]`
 * replaces pi-ai's built-in static catalog for this provider. The
 * `oauth` block likewise replaces the built-in OAuth handler.
 */
const STATIC_PROVIDER: Omit<ProviderConfig, "models"> = {
	name: "GitHub Copilot",
	baseUrl: "https://api.individual.githubcopilot.com",
	authHeader: true,
	api: "openai-completions",
	headers: {
		"User-Agent": "GitHubCopilotChat/0.35.0",
		"Editor-Version": "vscode/1.107.0",
		"Editor-Plugin-Version": "copilot-chat/0.35.0",
		"Copilot-Integration-Id": "vscode-chat",
	},
	oauth: copilotDiscoveryOAuth,
	streamSimple: streamCopilotDiscovery,
};

/**
 * One-shot discovery: ensure fresh creds, fetch /models, transform.
 *
 * On HTTP 401 we refresh once more and retry. This covers the rare race
 * where another pi process rotated the token between our auth.json read
 * and the /models call.
 */
async function discoverModels(
	rawCreds: CopilotCredentials,
): Promise<{ models: ReturnType<typeof toProviderModels>; creds: CopilotCredentials }> {
	const fresh = (await ensureFreshCredentials(rawCreds)) ?? rawCreds;
	try {
		const raw = await fetchCopilotModels(fresh.access, fresh.enterpriseUrl);
		return { models: toProviderModels(raw), creds: fresh };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// pi-ai's fetch helper throws "copilot /models: 401 …"; match loosely.
		if (/\b401\b/.test(msg) && rawCreds.refresh) {
			try {
				const retryCreds = (await refreshGitHubCopilotToken(
					rawCreds.refresh,
					rawCreds.enterpriseUrl,
				)) as CopilotCredentials;
				const raw = await fetchCopilotModels(retryCreds.access, retryCreds.enterpriseUrl);
				return { models: toProviderModels(raw), creds: retryCreds };
			} catch {
				// Fall through to original error.
			}
		}
		throw err;
	}
}

/**
 * Discovery with bounded retry across transient cold-start failures.
 * Re-reads creds from auth.json between attempts so we pick up a token
 * pi may have refreshed underneath us.
 */
async function discoverWithRetry(
	initial: CopilotCredentials,
	backoff: readonly number[],
): Promise<{ models: ReturnType<typeof toProviderModels>; creds: CopilotCredentials }> {
	let creds = initial;
	let lastErr: unknown;
	for (let attempt = 0; attempt <= backoff.length; attempt++) {
		try {
			return await discoverModels(creds);
		} catch (err) {
			lastErr = err;
			const msg = err instanceof Error ? err.message : String(err);
			if (attempt === backoff.length || !isRetriableDiscoveryError(msg)) break;
			await delay(backoff[attempt]);
			creds = (await readStoredCredentials()) ?? creds;
		}
	}
	throw lastErr;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	let models: ProviderConfig["models"] = [];
	let lastGoodCreds: CopilotCredentials | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Override-only registration: no `models` key. Per pi's model-registry
	 * this keeps the *built-in* static github-copilot catalog intact and
	 * only attaches our oauth + streamSimple + headers. Used as the
	 * fallback whenever live discovery fails so a transient cold-start
	 * blip never leaves the session with an empty model list. Worst case
	 * we behave exactly like pi's built-in Copilot provider.
	 */
	const registerFallback = () => {
		pi.registerProvider(PROVIDER_NAME, { ...STATIC_PROVIDER });
	};

	const armProactiveRefresh = (creds: CopilotCredentials) => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		const expires = typeof creds.expires === "number" ? creds.expires : 0;
		const delay = expires - Date.now() - PROACTIVE_REFRESH_LEAD_MS;
		if (!Number.isFinite(delay) || delay <= 0) return;
		// `unref()` so a long-lived timer never blocks process exit.
		const t = setTimeout(() => {
			void runRefresh("proactive");
		}, delay);
		t.unref?.();
		refreshTimer = t;
	};

	const runRefresh = async (
		reason: "startup" | "proactive" | "command",
	): Promise<{ ok: true; count: number } | { ok: false; error: string }> => {
		// Always re-read auth.json so we pick up creds written by pi after
		// /login or its own auto-refresh.
		const stored = await readStoredCredentials();
		if (!stored?.access) {
			return { ok: false, error: "not logged in" };
		}
		const backoff = reason === "startup" ? STARTUP_RETRY_BACKOFF_MS : [];
		try {
			const { models: next, creds } = await discoverWithRetry(stored, backoff);
			if (next.length === 0) {
				// Tenant returned nothing usable. Don't clobber a catalog we
				// already have; keep built-in models via the fallback path.
				if (models.length === 0) registerFallback();
				return { ok: false, error: "discovery returned no models" };
			}
			models = next;
			lastGoodCreds = creds;
			pi.registerProvider(PROVIDER_NAME, { ...STATIC_PROVIDER, models });
			armProactiveRefresh(creds);
			return { ok: true, count: next.length };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Never downgrade a working live catalog because a *later* refresh
			// failed (e.g. a background blip). Only fall back when we have
			// nothing live yet.
			if (models.length === 0) registerFallback();
			if (reason === "proactive") {
				// Don't spam stderr on background failures; just log once, and
				// re-arm a short retry so a single blip doesn't stop us keeping
				// the catalog warm for the rest of the session.
				console.error(`pi-copilot-discovery: proactive refresh failed (${msg})`);
				if (refreshTimer) clearTimeout(refreshTimer);
				refreshTimer = setTimeout(() => void runRefresh("proactive"), 60_000);
				refreshTimer.unref?.();
			}
			return { ok: false, error: msg };
		}
	};

	// Initial discovery. On any failure `runRefresh` has already attached
	// our oauth/streamSimple to pi's built-in static catalog via
	// `registerFallback`, so the session stays usable and /login works.
	const result = await runRefresh("startup");
	if (!result.ok) {
		if (result.error === "not logged in") {
			// No creds yet: still attach our oauth so /login github-copilot
			// enables the full tenant catalog. Built-in static models remain.
			registerFallback();
		} else {
			console.error(
				`pi-copilot-discovery: live discovery failed at load (${result.error}); ` +
					`using built-in Copilot catalog. It will upgrade automatically on ` +
					`the next refresh, or run /copilot-refresh.`,
			);
		}
	}

	const refreshHandler = async (
		_args: unknown,
		ctx: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } },
	): Promise<void> => {
		const r = await runRefresh("command");
		if (r.ok) {
			ctx.ui.notify(`pi-copilot-discovery: refreshed ${r.count} models`, "info");
		} else if (r.error === "not logged in") {
			ctx.ui.notify(
				"pi-copilot-discovery: not logged in. Run /login github-copilot.",
				"warning",
			);
		} else {
			ctx.ui.notify(`pi-copilot-discovery refresh failed: ${r.error}`, "error");
		}
	};

	pi.registerCommand("copilot-refresh", {
		description: "Re-fetch the GitHub Copilot model catalog from /models",
		// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI command ctx is loosely typed.
		handler: refreshHandler as any,
	});

	// Back-compat alias for users with muscle memory / scripts.
	pi.registerCommand("copilot-discovery-refresh", {
		description: "Alias of /copilot-refresh (back-compat)",
		// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI command ctx is loosely typed.
		handler: refreshHandler as any,
	});

	// Reference `lastGoodCreds` so TS doesn't complain it's unused. It's
	// retained for future use (e.g. exposing /copilot-status) and to make
	// debugging easier when stepping through.
	void lastGoodCreds;
}
