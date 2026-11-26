/**
 * pi-copilot-discovery — dynamic GitHub Copilot model discovery for pi.
 *
 * Pi 1.5+ owns the built-in provider's auth, token refresh, request base URL,
 * headers, and streaming. At load, this extension wraps that built-in provider
 * and replaces only its model catalog with live /models data.
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

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	fetchCopilotModels,
	resolveCopilotBaseUrl,
	toProviderModels,
	withBuiltinMetadata,
} from "./models.ts";
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
	const builtinById = new Map(models.map((m) => [m.id, m]));

	const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
		// Restore the persisted live catalog so offline/early reads (other processes, t3code) see it.
		// Re-overlay built-in metadata: entries persisted by <=0.5.1 lack compat.
		const stored = (
			context.stored?.models.filter((m) => m.provider === PROVIDER_NAME) as
				| Model<Api>[]
				| undefined
		)?.map((m) => withBuiltinMetadata(m, builtinById));
		if (stored?.length && !(await context.publish({ update: () => { models = stored; } }))) return;

		if (!context.allowNetwork || context.signal?.aborted) return;

		const token = credentialToken(context.credential);
		if (!token) return;

		try {
			const baseUrl = await resolveCopilotBaseUrl(builtin, context.credential, token);
			const raw = await fetchCopilotModels(token, baseUrl, context.signal);
			const discovered = toProviderModels(raw, baseUrl, builtinById);
			if (discovered.length === 0) {
				onRefresh({ ok: false, error: "discovery returned no models" });
				return;
			}
			const published = await context.publish({
				persist: { models: discovered, checkedAt: Date.now() },
				update: () => { models = discovered; },
			});
			if (!published) return;
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
		// pi >=1.x marks the built-in catalog "configured" (no credential); discovery needs the token.
		refreshModelsAuth: "credential",
		getModels: () => models,
		getAllModels: () => models,
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
	// Register at load (not session_start) so the persisted live catalog exists before
	// enabledModels / --models scope resolution.
	pi.registerProvider(
		createDiscoveryProvider(builtinProviders().find((p) => p.id === PROVIDER_NAME)!, (result) => {
			refreshState.last = result;
		}),
	);

	pi.on("session_start", async (_event, ctx) => {
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
