import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { collectSessionStats } from "./collector.ts";

/** Builds a minimal user message. */
function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

/** Builds a minimal assistant message with optional tool calls. */
function assistantMessage(toolCalls: number): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "thinking" },
			...(toolCalls > 0
				? Array.from({ length: toolCalls }, (_, i) => ({
						type: "toolCall",
						id: `call-${i}`,
						name: "bash",
						arguments: {},
					}))
				: []),
		],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		usage: { input: 1, output: 1, totalTokens: 2 },
		stopReason: "stop",
		timestamp: 2,
	} as unknown as AgentMessage;
}

/** Builds a minimal tool result message. */
function toolResultMessage(): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-0",
		toolName: "bash",
		content: [{ type: "text", text: "output" }],
		isError: false,
		timestamp: 3,
	} as unknown as AgentMessage;
}

describe("collectSessionStats", () => {
	test("counts messages by role and tool calls", () => {
		const stats = collectSessionStats([
			userMessage("hello"),
			assistantMessage(2),
			toolResultMessage(),
		]);
		assert.equal(stats.messageCount, 3);
		assert.equal(stats.userCount, 1);
		assert.equal(stats.assistantCount, 1);
		assert.equal(stats.toolResultCount, 1);
		assert.equal(stats.toolCallCount, 2);
	});

	test("returns zeros for an empty message list", () => {
		const stats = collectSessionStats([]);
		assert.deepEqual(stats, {
			messageCount: 0,
			userCount: 0,
			assistantCount: 0,
			toolResultCount: 0,
			toolCallCount: 0,
		});
	});

	test("counts tool calls across multiple assistant messages", () => {
		const stats = collectSessionStats([
			assistantMessage(1),
			assistantMessage(3),
		]);
		assert.equal(stats.toolCallCount, 4);
	});
});
