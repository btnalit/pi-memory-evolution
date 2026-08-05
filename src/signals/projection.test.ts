import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { countProjectionNotices } from "./projection.ts";

/** Builds a tool result message carrying the given text. */
function toolResultWithText(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-0",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as unknown as AgentMessage;
}

/** Builds a minimal user message. */
function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 2 } as AgentMessage;
}

describe("countProjectionNotices", () => {
	test("counts tool results with the omitted-notice text", () => {
		const messages = [
			toolResultWithText(
				"Result omitted. Run tool again for full result.",
			),
			toolResultWithText("normal output"),
			toolResultWithText("Result omitted. Run tool again for full result."),
		];
		assert.equal(countProjectionNotices(messages), 2);
	});

	test("returns zero when no projection notices are present", () => {
		const messages = [
			toolResultWithText("normal output"),
			userMessage("hello"),
		];
		assert.equal(countProjectionNotices(messages), 0);
	});

	test("returns zero for an empty message list", () => {
		assert.equal(countProjectionNotices([]), 0);
	});
});
