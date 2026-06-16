/**
 * OAuth wiring for the `github-copilot` provider.
 *
 * We delegate GitHub device-code login + Copilot token minting to
 * pi-ai's published helpers so upstream fixes land automatically.
 *
 * On top of that we:
 *   1) enable model policies across the tenant-discovered catalog; and
 *   2) expose an optional login hook so `index.ts` can refresh the
 *      registered model list immediately after `/login`.
 */

import type {
	Api,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import {
	getGitHubCopilotBaseUrl,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "@earendil-works/pi-ai/oauth";
import { COPILOT_HEADERS, type CopilotModel, fetchCopilotModels } from "./models.ts";

export type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };

/**
 * We register under the canonical `github-copilot` provider name so this
 * extension is a drop-in replacement for pi-ai's built-in Copilot provider.
 */
const PROVIDER_NAME = "github-copilot";

type OAuthHooks = {
	onLogin?: (
		credentials: CopilotCredentials,
		onProgress?: (message: string) => void,
	) => Promise<void> | void;
};

/**
 * Enable a single model on the user's account by POSTing to
 * `/models/<id>/policy`. Mirrors pi-ai's internal helper.
 */
async function enablePolicy(
	copilotToken: string,
	enterpriseUrl: string | undefined,
	modelId: string,
): Promise<boolean> {
	const domain = enterpriseUrl ? (normalizeDomain(enterpriseUrl) ?? undefined) : undefined;
	const baseUrl = getGitHubCopilotBaseUrl(copilotToken, domain);
	try {
		const res = await fetch(`${baseUrl}/models/${modelId}/policy`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${copilotToken}`,
				...COPILOT_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function enableAllPolicies(
	copilotToken: string,
	enterpriseUrl: string | undefined,
	models: CopilotModel[],
	onProgress?: (msg: string) => void,
): Promise<void> {
	let done = 0;
	await Promise.all(
		models.map(async (m) => {
			await enablePolicy(copilotToken, enterpriseUrl, m.id);
			done += 1;
			onProgress?.(`Enabled ${done}/${models.length} models`);
		}),
	);
}

export function createCopilotDiscoveryOAuth(hooks: OAuthHooks = {}) {
	return {
		name: "GitHub Copilot",

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const creds = (await loginGitHubCopilot({
				onDeviceCode: callbacks.onDeviceCode,
				onPrompt: callbacks.onPrompt,
				onProgress: callbacks.onProgress,
				signal: callbacks.signal,
			})) as CopilotCredentials;

			// Enable policies across the tenant catalog (non-fatal).
			try {
				const models = await fetchCopilotModels(creds.access, creds.enterpriseUrl);
				callbacks.onProgress?.(`Discovering ${models.length} work-tenant models...`);
				await enableAllPolicies(creds.access, creds.enterpriseUrl, models, callbacks.onProgress);
			} catch (err) {
				callbacks.onProgress?.(
					`Could not enable all policies: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// Best-effort hook: refresh extension model registry immediately
			// after login, so users don't need to restart or run /copilot-refresh.
			if (hooks.onLogin) {
				try {
					await hooks.onLogin(creds, callbacks.onProgress);
				} catch (err) {
					callbacks.onProgress?.(
						`Could not refresh model catalog after login: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}

			return creds;
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			const creds = credentials as CopilotCredentials;
			return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},

		/**
		 * Per request, rewrite every `github-copilot` model's baseUrl to the
		 * proxy endpoint encoded in the current Copilot token.
		 */
		modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
			const creds = credentials as CopilotCredentials;
			const domain = creds.enterpriseUrl
				? (normalizeDomain(creds.enterpriseUrl) ?? undefined)
				: undefined;
			const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);
			return models.map((m) => (m.provider === PROVIDER_NAME ? { ...m, baseUrl } : m));
		},
	};
}

// Backward-compatible default export shape for any external import.
export const copilotDiscoveryOAuth = createCopilotDiscoveryOAuth();
