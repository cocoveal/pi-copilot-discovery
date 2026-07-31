/** Fetch and normalize the live GitHub Copilot model catalog. */

import type { Api, Credential, Model, Provider } from "@earendil-works/pi-ai";
import { classify } from "./families.ts";

const PROVIDER_NAME = "github-copilot";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

/** Static client headers mirrored from pi-ai's GitHub Copilot OAuth flow. */
export const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": "2026-06-01",
} as const;

export type CopilotModel = {
	id: string;
	name?: string;
	capabilities?: {
		type?: string;
		family?: string;
		limits?: {
			max_context_window_tokens?: number;
			max_output_tokens?: number;
			max_prompt_tokens?: number;
		};
		supports?: {
			vision?: boolean;
			tool_calls?: boolean;
			streaming?: boolean;
		};
	};
	model_picker_enabled?: boolean;
	policy?: { state?: "enabled" | "disabled" | "unconfigured" };
};

function baseUrlFromToken(token: string): string | undefined {
	const proxyHost = token.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
	return proxyHost ? `https://${proxyHost.replace(/^proxy\./, "api.")}` : undefined;
}

export async function resolveCopilotBaseUrl(
	provider: Provider,
	credential: Credential | undefined,
	token: string,
): Promise<string> {
	if (credential?.type === "oauth" && provider.auth.oauth) {
		const auth = await provider.auth.oauth.toAuth(credential);
		if (auth.baseUrl) return auth.baseUrl;
	}
	return baseUrlFromToken(token) ?? provider.baseUrl ?? DEFAULT_BASE_URL;
}

function isCopilotModel(value: unknown): value is CopilotModel {
	if (!value || typeof value !== "object") return false;
	const model = value as Record<string, unknown>;
	return typeof model.id === "string" && model.id.length > 0;
}

export async function fetchCopilotModels(
	copilotToken: string,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<CopilotModel[]> {
	const timeoutSignal = AbortSignal.timeout(10000);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(`${baseUrl}/models`, {
		headers: {
			Authorization: `Bearer ${copilotToken}`,
			Accept: "application/json",
			...COPILOT_HEADERS,
		},
		signal: requestSignal,
	});
	if (!response.ok) {
		throw new Error(`copilot /models: ${response.status} ${await response.text()}`);
	}

	const body = (await response.json()) as { data?: unknown };
	if (!Array.isArray(body.data)) {
		throw new Error("copilot /models: invalid response");
	}
	return body.data.filter(isCopilotModel).filter(
		(model) =>
			model.model_picker_enabled !== false &&
			model.capabilities?.type === "chat" &&
			model.capabilities.supports?.tool_calls !== false,
	);
}

export function toProviderModels(models: CopilotModel[], baseUrl: string): Model<Api>[] {
	const seen = new Set<string>();
	const output: Model<Api>[] = [];
	for (const model of models) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);

		const familyOrId = model.capabilities?.family ?? model.id;
		const { api, reasoning, thinkingLevelMap, compat } = classify(familyOrId);
		const vision = model.capabilities?.supports?.vision === true;
		const limits = model.capabilities?.limits ?? {};

		output.push({
			id: model.id,
			name: model.name ?? model.id,
			api,
			provider: PROVIDER_NAME,
			baseUrl,
			reasoning,
			thinkingLevelMap,
			compat,
			input: vision ? ["text", "image"] : ["text"],
			contextWindow:
				limits.max_context_window_tokens ?? limits.max_prompt_tokens ?? 128000,
			maxTokens: limits.max_output_tokens ?? 16384,
			headers: { ...COPILOT_HEADERS },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return output;
}
