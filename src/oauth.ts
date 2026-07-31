/**
 * Add dynamic policy enabling to pi-ai's native GitHub Copilot OAuth flow.
 * Login, refresh, persistence, and request auth remain upstream-owned.
 */

import type { AuthInteraction, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { COPILOT_HEADERS, fetchCopilotModels } from "./models.ts";

async function enablePolicy(
	copilotToken: string,
	baseUrl: string,
	modelId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/models/${modelId}/policy`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${copilotToken}`,
				...COPILOT_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
			signal,
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function enableAllPolicies(
	credential: OAuthCredential,
	oauth: OAuthAuth,
	interaction: AuthInteraction,
): Promise<void> {
	const auth = await oauth.toAuth(credential);
	if (!auth.baseUrl) return;

	const models = await fetchCopilotModels(
		credential.access,
		auth.baseUrl,
		interaction.signal,
	);
	interaction.notify({
		type: "progress",
		message: `Enabling ${models.length} Copilot models...`,
	});
	await Promise.all(
		models.map((model) =>
			enablePolicy(
				credential.access,
				auth.baseUrl!,
				model.id,
				interaction.signal,
			),
		),
	);
}

export function wrapCopilotOAuth(builtin: OAuthAuth): OAuthAuth {
	return {
		...builtin,
		async login(interaction): Promise<OAuthCredential> {
			const credential = await builtin.login(interaction);
			try {
				await enableAllPolicies(credential, builtin, interaction);
			} catch (error) {
				interaction.notify({
					type: "progress",
					message: `Could not enable all Copilot models: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			}
			return credential;
		},
	};
}
