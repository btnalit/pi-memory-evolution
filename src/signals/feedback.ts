import type { PiAgentMessage } from "../adapter/pi-api.ts";

/** Correction keywords that indicate user dissatisfaction with prior output. */
const CORRECTION_KEYWORDS = [
	"不对",
	"错误",
	"错了",
	"应该改成",
	"不要",
	"重新来",
	"错了，",
] as const;

/** Extracts correction keywords found in one user message. */
export function extractCorrectionKeywords(
	message: PiAgentMessage,
): readonly string[] {
	if (message.role !== "user") {
		return [];
	}
	const text = messageText(message);
	if (text.length === 0) {
		return [];
	}
	return CORRECTION_KEYWORDS.filter((keyword) => text.includes(keyword));
}

/** Extracts plain text from a user message content of either shape. */
function messageText(
	message: Extract<PiAgentMessage, { role: "user" }>,
): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}
