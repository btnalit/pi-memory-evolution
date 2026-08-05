import type { PiAgentMessage } from "../adapter/pi-api.ts";

/** Session-level statistics collected from one agent-end message batch. */
export interface SessionStats {
	readonly messageCount: number;
	readonly userCount: number;
	readonly assistantCount: number;
	readonly toolResultCount: number;
	readonly toolCallCount: number;
}

/** Counts messages by role and assistant tool calls. */
export function collectSessionStats(
	messages: readonly PiAgentMessage[],
): SessionStats {
	let messageCount = 0;
	let userCount = 0;
	let assistantCount = 0;
	let toolResultCount = 0;
	let toolCallCount = 0;

	for (const message of messages) {
		messageCount += 1;
		switch (message.role) {
			case "user":
				userCount += 1;
				break;
			case "assistant":
				assistantCount += 1;
				toolCallCount += countToolCalls(message);
				break;
			case "toolResult":
				toolResultCount += 1;
				break;
		}
	}

	return {
		messageCount,
		userCount,
		assistantCount,
		toolResultCount,
		toolCallCount,
	};
}

/** Counts tool-call content parts in one assistant message. */
function countToolCalls(
	message: Extract<PiAgentMessage, { role: "assistant" }>,
): number {
	const content = message.content;
	if (!Array.isArray(content)) {
		return 0;
	}
	return content.reduce(
		(count, part) => (part.type === "toolCall" ? count + 1 : count),
		0,
	);
}
