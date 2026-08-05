import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import type { PiAgentMessage } from "../adapter/pi-api.ts";
import { extractCorrectionKeywords } from "./feedback.ts";

/** Builds a minimal user message with the given text. */
function userMessage(text: string): PiAgentMessage {
	return { role: "user", content: text, timestamp: 1 } as PiAgentMessage;
}

describe("extractCorrectionKeywords", () => {
	test("detects a correction keyword in a user message", () => {
		const keywords = extractCorrectionKeywords(userMessage("不对，应该改成 X"));
		assert.ok(keywords.length > 0);
		assert.ok(keywords.includes("不对"));
	});

	test("returns an empty list for a neutral user message", () => {
		const keywords = extractCorrectionKeywords(userMessage("请继续"));
		assert.deepEqual(keywords, []);
	});

	test("returns an empty list for a non-user message", () => {
		const keywords = extractCorrectionKeywords({
			role: "assistant",
			content: [{ type: "text", text: "不对" }],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			usage: { input: 1, output: 1, totalTokens: 2 },
			stopReason: "stop",
			timestamp: 1,
		} as unknown as PiAgentMessage);
		assert.deepEqual(keywords, []);
	});
});
