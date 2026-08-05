import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Default notice text that context-projection inserts for omitted results. */
const DEFAULT_OMITTED_NOTICE = "Result omitted. Run tool again for full result.";

/** Counts tool results whose text was replaced by the projection notice. */
export function countProjectionNotices(
	messages: readonly AgentMessage[],
): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") {
			continue;
		}
		if (containsOmittedNotice(message.content)) {
			count += 1;
		}
	}
	return count;
}

/** Returns true when any text content part carries the omitted-notice text. */
function containsOmittedNotice(
	content: Extract<AgentMessage, { role: "toolResult" }>["content"],
): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	return content.some(
		(part) =>
			part.type === "text" && part.text.includes(DEFAULT_OMITTED_NOTICE),
	);
}
