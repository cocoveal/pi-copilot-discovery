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
 * Compatibility:
 *   - Existing `~/.pi/agent/auth.json["github-copilot"]` credentials are
 *     reused as-is. No re-login required on install.
 *   - `/login github-copilot` runs this extension's login flow (which
 *     additionally enables policies on every discovered model, not just
 *     pi-ai's hardcoded list).
 *   - `/logout github-copilot` works as before via pi's built-in.
 *
 * Commands:
 *   /copilot-discovery-refresh   re-fetch the /models catalog
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import { copilotDiscoveryOAuth, type CopilotCredentials } from "./oauth.ts";
import { fetchCopilotModels, toProviderModels } from "./models.ts";
import { streamCopilotDiscovery } from "./stream.ts";

const PROVIDER_NAME = "github-copilot";

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

export default async function (pi: ExtensionAPI): Promise<void> {
	// Try to fetch the model catalog using whatever credentials are
	// already on disk. If we have none (first run, pre-/login) or the
	// stored access token has already expired, register the provider
	// with an empty model list so /login is still discoverable.
	let models: ProviderConfig["models"] = [];
	const creds = await readStoredCredentials();
	if (creds && typeof creds.access === "string" && creds.access.length > 0) {
		const now = Date.now();
		if (typeof creds.expires === "number" && creds.expires <= now) {
			// Don't try to refresh from here — pi owns refresh and will
			// do it on first use. The user can re-run
			// /copilot-discovery-refresh afterwards to populate the list.
			console.error(
				`pi-copilot-discovery: stored access token expired; provider will list models after first use or after /copilot-discovery-refresh.`,
			);
		} else {
			try {
				const raw = await fetchCopilotModels(creds.access, creds.enterpriseUrl);
				models = toProviderModels(raw);
			} catch (err) {
				console.error(
					`pi-copilot-discovery: model discovery failed at load (${err instanceof Error ? err.message : String(err)}); ` +
						`provider registered with empty model list. Run /copilot-discovery-refresh or /login github-copilot.`,
				);
			}
		}
	}

	pi.registerProvider(PROVIDER_NAME, { ...STATIC_PROVIDER, models });

	pi.registerCommand("copilot-discovery-refresh", {
		description: "Re-fetch the GitHub Copilot model catalog from /models",
		handler: async (_args, ctx) => {
			const fresh = await readStoredCredentials();
			if (!fresh?.access) {
				ctx.ui.notify(
					"pi-copilot-discovery: not logged in. Run /login github-copilot.",
					"warning",
				);
				return;
			}
			try {
				const raw = await fetchCopilotModels(fresh.access, fresh.enterpriseUrl);
				const next = toProviderModels(raw);
				pi.registerProvider(PROVIDER_NAME, { ...STATIC_PROVIDER, models: next });
				ctx.ui.notify(`pi-copilot-discovery: refreshed ${next.length} models`, "info");
			} catch (err) {
				ctx.ui.notify(
					`pi-copilot-discovery refresh failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}
