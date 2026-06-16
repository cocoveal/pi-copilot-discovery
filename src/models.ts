/**
 * Fetch and normalize the Copilot tenant's model catalog.
 *
 * The Copilot `/models` endpoint is the source of truth for what the
 * signed-in account is entitled to — including preview / tenant-private
 * models that don't appear in any static pi-ai list.
 *
 * Returned `ProviderModelConfig` entries carry per-model `api` overrides
 * so a single `copilot-msft` provider can host Anthropic, OpenAI
 * Responses, and OpenAI Completions backed models in one list.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getGitHubCopilotBaseUrl, normalizeDomain } from "@earendil-works/pi-ai/oauth";
import { classify } from "./families.ts";

/**
 * Static Copilot client identification headers.
 * Kept in sync with pi-ai's built-in github-copilot provider
 * (`COPILOT_HEADERS` in pi-ai/src/utils/oauth/github-copilot.ts).
 * Bump together when pi-ai bumps.
 */
export const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

export type CopilotModel = {
	id: string;
	name?: string;
	capabilities?: {
		type?: string;
		family?: string;
		tokenizer?: string;
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

function resolveBaseUrl(token: string, enterpriseUrl?: string): string {
	const domain = enterpriseUrl ? (normalizeDomain(enterpriseUrl) ?? undefined) : undefined;
	return getGitHubCopilotBaseUrl(token, domain);
}

export async function fetchCopilotModels(
	copilotToken: string,
	enterpriseUrl?: string,
): Promise<CopilotModel[]> {
	const baseUrl = resolveBaseUrl(copilotToken, enterpriseUrl);
	const res = await fetch(`${baseUrl}/models`, {
		headers: {
			Authorization: `Bearer ${copilotToken}`,
			Accept: "application/json",
			...COPILOT_HEADERS,
		},
	});
	if (!res.ok) {
		throw new Error(`copilot /models: ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as { data: CopilotModel[] };
	return body.data.filter(
		(m) => m.model_picker_enabled !== false && m.capabilities?.type === "chat",
	);
}

export function toProviderModels(models: CopilotModel[]): ProviderModelConfig[] {
	// Some tenants return multiple entries with the same `id` (e.g. a
	// model and a vision variant). Keep the first by id so /model is sane.
	const seen = new Set<string>();
	const out: ProviderModelConfig[] = [];
	for (const m of models) {
		if (seen.has(m.id)) continue;
		seen.add(m.id);

		const familyOrId = m.capabilities?.family ?? m.id;
		const { api, reasoning, thinkingLevelMap, compat } = classify(familyOrId);
		const vision = m.capabilities?.supports?.vision === true;
		const limits = m.capabilities?.limits ?? {};

		out.push({
			id: m.id,
			name: m.name ?? m.id,
			api,
			reasoning,
			thinkingLevelMap,
			compat,
			input: vision ? ["text", "image"] : ["text"],
			contextWindow:
				limits.max_context_window_tokens ?? limits.max_prompt_tokens ?? 128000,
			maxTokens: limits.max_output_tokens ?? 16384,
			// Copilot is a flat-fee subscription; per-token cost is meaningless.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return out;
}
