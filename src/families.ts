/**
 * Classify a Copilot model into the right pi-ai api family.
 *
 * Prefer Copilot's live `supported_endpoints` when present. That field is the
 * source of truth for which proxy path the tenant will accept — for example
 * `grok-4.5` and `mai-code-1-flash-picker` advertise only `/responses`, and
 * calling `/chat/completions` returns:
 *   400 unsupported_api_for_model
 *
 * Name heuristics (aligned with pi-ai's static github-copilot catalog) remain
 * the fallback when endpoints are missing or ambiguous:
 *
 *   - claude-*   → anthropic-messages   (reasoning where supported)
 *   - gpt-5*     → openai-responses     (reasoning)
 *   - o1, o3     → openai-responses     (reasoning)
 *   - gpt-4*     → openai-completions   (no reasoning)
 *   - gemini-*   → openai-completions   (reasoning when /models advertises
 *                                        reasoning_effort; Copilot proxies Gemini through
 *                                        an OpenAI-compatible endpoint;
 *                                        DO NOT route to google-generative-ai)
 *   - default    → openai-completions   (safe when /chat/completions works)
 *
 * Heuristics are intentionally conservative — when uncertain we choose
 * an api the model is *usable* under even if it is not optimal.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

type ThinkingLevelMap = Model<Api>["thinkingLevelMap"];
type Compat = Model<Api>["compat"];

export type ApiFamily = {
	api: Api;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Compat;
};

export type ClassifyOptions = {
	supportedEndpoints?: readonly string[];
	reasoningEffort?: readonly string[];
};

const OPENAI_RESPONSES_THINKING: ThinkingLevelMap = {
	off: null,
	minimal: "low",
};

// gpt-5.2 and newer (incl. codex / mini / nano variants) expose an extra
// "xhigh" reasoning tier; base gpt-5 and gpt-5-mini do NOT. Advertising
// xhigh for a model that lacks it makes the proxy reject requests with
// 400 "Unsupported value: 'xhigh'". Mirror pi-ai's built-in catalog.
const OPENAI_RESPONSES_THINKING_XHIGH: ThinkingLevelMap = {
	off: null,
	minimal: "low",
	xhigh: "xhigh",
};

function normalizeEndpoints(endpoints: readonly string[] | undefined): Set<string> {
	const out = new Set<string>();
	for (const endpoint of endpoints ?? []) {
		let path = endpoint.trim();
		if (!path) continue;
		// Copilot returns both "/responses" and occasional "ws:/responses".
		if (path.startsWith("ws:")) path = path.slice(3);
		if (!path.startsWith("/")) path = `/${path}`;
		out.add(path);
	}
	return out;
}

function effortThinkingMap(reasoningEffort: readonly string[] | undefined): ThinkingLevelMap {
	const efforts = new Set((reasoningEffort ?? []).map((e) => e.toLowerCase()));
	if (efforts.size === 0) return { ...OPENAI_RESPONSES_THINKING };

	const map: ThinkingLevelMap = { ...OPENAI_RESPONSES_THINKING };
	if (efforts.has("xhigh")) map.xhigh = "xhigh";
	if (efforts.has("max")) map.max = "max";
	return map;
}

function classifyByEndpoints(options: ClassifyOptions): ApiFamily | undefined {
	const endpoints = normalizeEndpoints(options.supportedEndpoints);
	if (endpoints.size === 0) return undefined;

	const hasMessages = endpoints.has("/v1/messages");
	const hasResponses = endpoints.has("/responses");
	const hasChatCompletions = endpoints.has("/chat/completions");

	// Responses-only models (grok-4.5, mai-code-1-flash-picker, many gpt-5*)
	// must not fall through to openai-completions.
	if (hasResponses && !hasChatCompletions && !hasMessages) {
		const efforts = options.reasoningEffort ?? [];
		return {
			api: "openai-responses",
			reasoning: efforts.length > 0,
			thinkingLevelMap: efforts.length > 0 ? effortThinkingMap(efforts) : undefined,
		};
	}

	return undefined;
}

export function classify(familyOrId: string, options: ClassifyOptions = {}): ApiFamily {
	const fromEndpoints = classifyByEndpoints(options);
	const s = familyOrId.toLowerCase();

	// ---- Claude (Anthropic Messages API) ----
	if (s.startsWith("claude")) {
		// Match both Copilot id formats:
		//   claude-{kind}-{version}  (e.g. claude-haiku-4.5, claude-opus-4.7)
		//   claude-{version}-{kind}  (e.g. claude-3.7-sonnet, claude-3.5-haiku)
		//
		// Reasoning support: 3.5 introduced extended thinking on Sonnet; 3.7
		// and the 4.x / 5.x line broadened it. Default reasoning to true
		// unless the id clearly says Claude 3 (non-3.5/3.7) or earlier.
		const isClaude3OrOlder = /claude-(3(?!\.[57])|2|1)/.test(s) && !/-4|-5|-6|-7|-8|-9/.test(s);
		const reasoning = !isClaude3OrOlder;

		// pi-ai's built-in entries set forceAdaptiveThinking on Opus/Sonnet 4.6+
		// and every claude-{kind}-5+ (e.g. Fable). Mirror that for unknown IDs.
		const needsAdaptive =
			/claude-(opus|sonnet)-4\.[6-9]/.test(s) || /claude-[a-z]+-([5-9]|[1-9]\d)(\.|-|$)/.test(s);

		// Opus 4.7+ has an "xhigh" tier that maps to provider "xhigh".
		const xhighMax = /claude-opus-(4\.[7-9]|[5-9])/.test(s);

		const compat: Compat | undefined = needsAdaptive
			? { forceAdaptiveThinking: true }
			: undefined;

		return {
			api: "anthropic-messages",
			reasoning,
			thinkingLevelMap: xhighMax ? { xhigh: "xhigh" } : undefined,
			compat,
		};
	}

	// ---- OpenAI reasoning families (Responses API) ----
	if (/^(gpt-5|o1|o3)/.test(s)) {
		const supportsXhigh = /gpt-5\.(?:[2-9]|\d\d)/.test(s);
		return {
			api: "openai-responses",
			reasoning: true,
			thinkingLevelMap: supportsXhigh
				? OPENAI_RESPONSES_THINKING_XHIGH
				: OPENAI_RESPONSES_THINKING,
		};
	}

	// Copilot serves current Grok chat models on /responses only. Keep this
	// name fallback for catalogs that omit supported_endpoints.
	if (s.startsWith("grok")) {
		return {
			api: "openai-responses",
			reasoning: true,
			thinkingLevelMap: effortThinkingMap(options.reasoningEffort),
		};
	}

	if (fromEndpoints) return fromEndpoints;

	// ---- Everything else → OpenAI Chat Completions ----
	// This intentionally includes:
	//   - gpt-4o, gpt-4.1, gpt-4-* (no native reasoning)
	//   - gemini-* (Copilot proxies as OpenAI-compatible)
	//   - any unknown new family that still advertises /chat/completions
	// Reasoning only when Copilot advertises reasoning_effort (e.g. Gemini:
	// low/medium/high, some also xhigh); Pi then sends `reasoning_effort`.
	const efforts = options.reasoningEffort ?? [];
	if (efforts.length > 0) {
		return {
			api: "openai-completions",
			reasoning: true,
			thinkingLevelMap: effortThinkingMap(efforts),
		};
	}
	return { api: "openai-completions", reasoning: false };
}
