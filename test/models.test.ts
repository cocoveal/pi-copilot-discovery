import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { toProviderModels, withBuiltinMetadata } from "../src/models.ts";

const live = (id: string) => ({
	id,
	capabilities: {
		type: "chat",
		family: id,
		limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 },
		supports: { tool_calls: true },
	},
});

const fable = {
	id: "claude-fable-5.2",
	api: "anthropic-messages",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
	compat: { supportsStrictTools: true, forceAdaptiveThinking: true },
	thinkingLevelMap: { xhigh: "xhigh", max: "max", off: null },
} as unknown as Model<Api>;
const builtin = new Map([[fable.id, fable]]);

test("known model takes built-in metadata, live limits/baseUrl", () => {
	const [m] = toProviderModels([live("claude-fable-5.2")], "https://proxy", builtin);
	assert.equal((m.compat as { forceAdaptiveThinking?: boolean }).forceAdaptiveThinking, true);
	assert.deepEqual(m.thinkingLevelMap, fable.thinkingLevelMap);
	assert.deepEqual(m.cost, fable.cost);
	assert.equal(m.baseUrl, "https://proxy");
	assert.equal(m.contextWindow, 200000);
	assert.equal(m.headers?.["Editor-Version"] !== undefined, true);
});

test("stored broken entry is repaired", () => {
	const stored = { ...fable, compat: undefined, thinkingLevelMap: undefined, baseUrl: "https://x" };
	const m = withBuiltinMetadata(stored as Model<Api>, builtin);
	assert.equal((m.compat as { forceAdaptiveThinking?: boolean }).forceAdaptiveThinking, true);
	assert.equal(m.baseUrl, "https://x");
});

test("unknown claude 5+ falls back to adaptive classify()", () => {
	const [m] = toProviderModels([live("claude-foo-9")], "https://proxy", builtin);
	assert.equal(m.api, "anthropic-messages");
	assert.equal((m.compat as { forceAdaptiveThinking?: boolean }).forceAdaptiveThinking, true);
	const [old] = toProviderModels([live("claude-sonnet-4.5")], "https://proxy", builtin);
	assert.equal(old.compat, undefined);
});
