/**
 * pi-copilot-discovery — dynamic GitHub Copilot provider for pi.
 *
 * Simplified discovery model:
 *   - Register provider override immediately (without `models`) so pi's
 *     built-in static github-copilot catalog remains usable.
 *   - Run one best-effort `/models` discovery on startup (async).
 *   - Run one discovery immediately after successful `/login`.
 *   - Expose `/copilot-refresh` for manual re-discovery.
 *
 * Token refresh/persistence remains owned by pi's OAuth/auth-storage path.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import {
	createCopilotDiscoveryOAuth,
	type CopilotCredentials,
} from "./oauth.ts";
import { fetchCopilotModels, toProviderModels } from "./models.ts";
import { streamCopilotDiscovery } from "./stream.ts";

const PROVIDER_NAME = "github-copilot";

type RefreshReason = "startup" | "login" | "command";
type RefreshResult = { ok: true; count: number } | { ok: false; error: string };

// Same logic as pi-coding-agent's `getAgentDir()` so we read the same
// auth.json pi writes (including PI_CODING_AGENT_DIR overrides).
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

const STATIC_PROVIDER_BASE: Omit<ProviderConfig, "models" | "oauth"> = {
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
	streamSimple: streamCopilotDiscovery,
};

export default async function (pi: ExtensionAPI): Promise<void> {
	let models: ProviderConfig["models"] = [];

	let runRefresh: (
		reason: RefreshReason,
		credentialsOverride?: CopilotCredentials,
	) => Promise<RefreshResult>;

	const oauth = createCopilotDiscoveryOAuth({
		onLogin: async (credentials, onProgress) => {
			onProgress?.("Refreshing Copilot model catalog...");
			const result = await runRefresh("login", credentials);
			if (result.ok) {
				onProgress?.(`Loaded ${result.count} Copilot models`);
			} else {
				onProgress?.(`Model discovery after login failed: ${result.error}`);
			}
		},
	});

	const registerProvider = (nextModels?: ProviderConfig["models"]): void => {
		if (nextModels) {
			pi.registerProvider(PROVIDER_NAME, {
				...STATIC_PROVIDER_BASE,
				oauth,
				models: nextModels,
			});
			return;
		}
		// Override-only mode: keep built-in static catalog; replace oauth + streamSimple.
		pi.registerProvider(PROVIDER_NAME, { ...STATIC_PROVIDER_BASE, oauth });
	};

	runRefresh = async (reason, credentialsOverride) => {
		const credentials = credentialsOverride ?? (await readStoredCredentials());
		if (!credentials?.access) {
			return { ok: false, error: "not logged in" };
		}
		try {
			const raw = await fetchCopilotModels(credentials.access, credentials.enterpriseUrl);
			const next = toProviderModels(raw);
			if (next.length === 0) {
				return { ok: false, error: "discovery returned no models" };
			}
			models = next;
			registerProvider(models);
			return { ok: true, count: next.length };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Never downgrade an already-loaded live catalog.
			if (models.length === 0) {
				registerProvider();
			}
			if (reason !== "command") {
				console.error(`pi-copilot-discovery: ${reason} discovery failed (${msg})`);
			}
			return { ok: false, error: msg };
		}
	};

	// Register override immediately so login/stream behavior is active even
	// before discovery completes.
	registerProvider();

	// One async discovery on startup; no retries/timers.
	void runRefresh("startup");

	const refreshHandler = async (
		_args: unknown,
		ctx: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } },
	): Promise<void> => {
		const result = await runRefresh("command");
		if (result.ok) {
			ctx.ui.notify(`pi-copilot-discovery: refreshed ${result.count} models`, "info");
		} else if (result.error === "not logged in") {
			ctx.ui.notify(
				"pi-copilot-discovery: not logged in. Run /login github-copilot.",
				"warning",
			);
		} else {
			ctx.ui.notify(`pi-copilot-discovery refresh failed: ${result.error}`, "error");
		}
	};

	pi.registerCommand("copilot-refresh", {
		description: "Re-fetch the GitHub Copilot model catalog from /models",
		// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI command ctx is loosely typed.
		handler: refreshHandler as any,
	});

	pi.registerCommand("copilot-discovery-refresh", {
		description: "Alias of /copilot-refresh (back-compat)",
		// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI command ctx is loosely typed.
		handler: refreshHandler as any,
	});
}
