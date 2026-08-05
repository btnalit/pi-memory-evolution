import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import type { PiAgentMessage } from "../adapter/pi-api.ts";
import { countProjectionNotices } from "./projection.ts";

/** Builds a tool result message carrying the given text. */
function toolResultWithText(text: string): PiAgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-0",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as unknown as PiAgentMessage;
}

/** Builds a minimal user message. */
function userMessage(text: string): PiAgentMessage {
	return { role: "user", content: text, timestamp: 2 } as PiAgentMessage;
}

describe("countProjectionNotices", () => {
	test("counts tool results with the omitted-notice text", () => {
		const messages = [
			toolResultWithText(
				"Result omitted. Run tool again for full result.",
			),
			toolResultWithText("normal output"),
			toolResultWithText(
				"Result omitted. Run tool again for full result.",
			),
		];
		assert.equal(countProjectionNotices(messages), 2);
	});

	test("counts tool results with the summary-notice text", () => {
		const messages = [
			toolResultWithText(
				"Full result omitted. Summary below. Run tool again for full result.",
			),
			toolResultWithText(
				"Full result omitted. Summary below. Run tool again for full result. MUST NOT rely on summary when making critical decisions.",
			),
			toolResultWithText("normal output"),
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
