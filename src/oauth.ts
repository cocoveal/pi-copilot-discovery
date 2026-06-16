/**
 * OAuth wiring for the `copilot-msft` provider.
 *
 * We delegate the actual GitHub device-code flow + Copilot session-token
 * mint to pi-ai's published helpers (so an upstream fix or domain change
 * lands here for free). On top of that we:
 *
 *   1. Run `enableAllPolicies` against *every* model the work account is
 *      entitled to (pi-ai's built-in `loginGitHubCopilot` only enables
 *      its hardcoded list).
 *   2. Implement `modifyModels` so each request to a `copilot-msft` model
 *      goes to the proxy-ep encoded in the current Copilot token,
 *      including enterprise tenants.
 *
 * Credential persistence:
 *   pi-ai's `refreshGitHubCopilotToken` returns
 *   `{ refresh, access, expires, enterpriseUrl? }`. `OAuthCredentials` is
 *   `{ ...; [key: string]: unknown }` and pi's auth-storage round-trips
 *   the full object (JSON.parse → JSON.stringify), so `enterpriseUrl`
 *   survives across runs without any sidecar file.
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
 * Existing `~/.pi/agent/auth.json["github-copilot"]` credentials are reused
 * as-is; pi's auth-storage round-trips arbitrary extra fields, so the
 * `enterpriseUrl` field pi-ai writes into the credential is preserved.
 */
const PROVIDER_NAME = "github-copilot";

/**
 * Enable a single model on the user's account by POSTing to
 * `/models/<id>/policy`. Mirrors pi-ai's `enableGitHubCopilotModel`
 * (which is not exported).
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

export const copilotDiscoveryOAuth = {
	name: "GitHub Copilot",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		// Delegates to pi-ai. `loginGitHubCopilot` prompts for an
		// enterprise host ("blank for github.com"), runs the device-code
		// flow, mints the Copilot session token, and (as a side effect)
		// enables pi-ai's *hardcoded* model list.
		const creds = (await loginGitHubCopilot({
			onDeviceCode: callbacks.onDeviceCode,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		})) as CopilotCredentials;

		// Now enable policies for the *full* tenant model set we'll
		// actually be exposing. Non-fatal:
		// preview models that the user lacks entitlements for will
		// simply 403 on first use.
		try {
			const models = await fetchCopilotModels(creds.access, creds.enterpriseUrl);
			callbacks.onProgress?.(`Discovering ${models.length} work-tenant models...`);
			await enableAllPolicies(creds.access, creds.enterpriseUrl, models, callbacks.onProgress);
		} catch (err) {
			callbacks.onProgress?.(
				`Could not enable all policies: ${err instanceof Error ? err.message : String(err)}`,
			);
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
	 * proxy-ep encoded in the current Copilot token. Mirrors pi-ai's
	 * built-in `githubCopilotOAuthProvider.modifyModels`.
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
