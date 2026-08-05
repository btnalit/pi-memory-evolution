import type { PiAgentMessage } from "../adapter/pi-api.ts";

/** Default notice text that context-projection inserts for omitted results. */
const DEFAULT_OMITTED_NOTICE = "Result omitted. Run tool again for full result.";

/** Default notice text that context-projection inserts for summarized results. */
const DEFAULT_SUMMARY_NOTICE =
	"Full result omitted. Summary below. Run tool again for full result.";

/** Notice texts that mark a projected tool result. */
const PROJECTION_NOTICES = [DEFAULT_OMITTED_NOTICE, DEFAULT_SUMMARY_NOTICE];

/** Counts tool results whose text was replaced by a projection notice. */
export function countProjectionNotices(
	messages: readonly PiAgentMessage[],
): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") {
			continue;
		}
		if (containsProjectionNotice(message.content)) {
			count += 1;
		}
	}
	return count;
}

/** Returns true when any text content part carries a projection notice. */
function containsProjectionNotice(
	content: Extract<PiAgentMessage, { role: "toolResult" }>["content"],
): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	return content.some(
		(part) =>
			part.type === "text" &&
			PROJECTION_NOTICES.some((notice) => part.text.includes(notice)),
	);
}
