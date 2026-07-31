/**
 * pi-copilot-discovery — dynamic GitHub Copilot model discovery for pi.
 *
 * Pi 0.83 owns the built-in provider's auth, token refresh, request base URL,
 * headers, and streaming. Once a session starts, this extension wraps that
 * effective provider and replaces only its model catalog with live /models data.
 */

import type {
	Api,
	Credential,
	Model,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { fetchCopilotModels, resolveCopilotBaseUrl, toProviderModels } from "./models.ts";
import { wrapCopilotOAuth } from "./oauth.ts";

const PROVIDER_NAME = "github-copilot";
type RefreshResult = { ok: true; count: number } | { ok: false; error: string };

function credentialToken(credential: Credential | undefined): string | undefined {
	if (credential?.type === "oauth") return credential.access;
	return credential?.key;
}

function notifyRefreshResult(result: RefreshResult, ctx: ExtensionCommandContext): void {
	if (result.ok) {
		ctx.ui.notify(`pi-copilot-discovery: refreshed ${result.count} models`, "info");
	} else {
		ctx.ui.notify(`pi-copilot-discovery refresh failed: ${result.error}`, "error");
	}
}

function createDiscoveryProvider(
	builtin: Provider,
	onRefresh: (result: RefreshResult) => void,
): Provider {
	let models: readonly Model<Api>[] = builtin.getModels();

	const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
		if (!context.allowNetwork || context.signal?.aborted) return;

		const token = credentialToken(context.credential);
		if (!token) return;

		try {
			const baseUrl = await resolveCopilotBaseUrl(builtin, context.credential, token);
			const raw = await fetchCopilotModels(token, baseUrl, context.signal);
			const discovered = toProviderModels(raw, baseUrl);
			if (discovered.length === 0) {
				onRefresh({ ok: false, error: "discovery returned no models" });
				return;
			}
			models = discovered;
			onRefresh({ ok: true, count: discovered.length });
		} catch (error) {
			onRefresh({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return {
		...builtin,
		auth: builtin.auth.oauth
			? { ...builtin.auth, oauth: wrapCopilotOAuth(builtin.auth.oauth) }
			: builtin.auth,
		getModels: () => models,
		refreshModels,
		// The live catalog is already credential-specific. The built-in filter
		// projects a static catalog and would remove models unknown to that list.
		filterModels: (available) => available,
	};
}

export default function (pi: ExtensionAPI): void {
	const refreshState: { last: RefreshResult } = {
		last: { ok: false, error: "not logged in" },
	};
	let registered = false;

	pi.on("session_start", async (_event, ctx) => {
		if (!registered) {
			const builtin = ctx.modelRegistry.getProvider(PROVIDER_NAME);
			if (!builtin) {
				refreshState.last = { ok: false, error: "built-in provider not found" };
				return;
			}
			pi.registerProvider(
				createDiscoveryProvider(builtin, (result) => {
					refreshState.last = result;
				}),
			);
			registered = true;
		}
		await ctx.modelRegistry.refresh();
	});

	const refreshHandler = async (
		_args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		refreshState.last = { ok: false, error: "not logged in" };
		await ctx.modelRegistry.refresh();
		notifyRefreshResult(refreshState.last, ctx);
	};

	pi.registerCommand("copilot-refresh", {
		description: "Re-fetch the GitHub Copilot model catalog from /models",
		handler: refreshHandler,
	});
}
