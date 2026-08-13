import type { PiAgentMessage } from "../adapter/pi-api.ts";
import type {
	AgendaStore,
	ProposalRecord,
} from "../store/agenda-store.ts";
import { transitionProposal } from "./proposal-state.ts";

/** Chinese keywords that signal a user/agent has verified an implemented proposal. */
const VERIFY_KEYWORDS = [
	"已验证",
	"验证通过",
	"验证完成",
	"通过验证",
] as const;

/** English verification phrasings matched on word boundaries. */
const VERIFY_PATTERNS = [/\bverified\b/i, /\bverification passed\b/i] as const;

/** Negated verification forms that must NOT trigger a verified signal. */
const NEGATED_VERIFICATIONS = [
	"未验证通过",
	"未验证完成",
	"未通过验证",
	"not verified",
	"not verification passed",
	"never verified",
] as const;

/** Roles whose messages may carry a verification signal. */
const VERIFY_ROLES = new Set(["assistant", "user"]);

/**
 * Advances implemented proposals to verified from agent messages.
 *
 * Only implemented proposals respond to a verification signal: a message
 * from assistant/user that references the proposal id AND carries an explicit
 * verification keyword. Tool results are data, never a signal. Proposals in
 * other states stay untouched; a proposal approved this turn is verified in a
 * later turn once the user has actually executed the plan.
 */
export function runVerificationSignals(
	store: AgendaStore,
	messages: readonly PiAgentMessage[],
	now: string,
): void {
	const queue = store.readProposalQueue();
	const texts = messages
		.filter((message) => VERIFY_ROLES.has(message.role))
		.map(messageText)
		.filter((text) => text.length > 0);
	let changed = false;

	const updated = queue.map((proposal) => {
		if (proposal.status !== "implemented") {
			return proposal;
		}
		if (!hasVerificationSignal(proposal, texts)) {
			return proposal;
		}
		changed = true;
		const next = transitionProposal(proposal, "verified", now);
		store.appendJournal(
			`- ${now} proposal ${proposal.id} (${proposal.title}) verified via agent message`,
		);
		return next;
	});

	if (changed) {
		store.writeProposalQueue(updated);
	}
}

/** Returns true when any message references the proposal id with a verify intent. */
function hasVerificationSignal(
	proposal: ProposalRecord,
	texts: readonly string[],
): boolean {
	return texts.some(
		(text) =>
			text.includes(proposal.id) &&
			hasVerificationIntent(text),
	);
}

/** Returns true when the text carries a verification intent (negations excluded). */
function hasVerificationIntent(text: string): boolean {
	const stripped = NEGATED_VERIFICATIONS.reduce(
		(acc, negated) => acc.split(negated).join(""),
		text,
	);
	const chineseHit = VERIFY_KEYWORDS.some((kw) => stripped.includes(kw));
	const englishHit = VERIFY_PATTERNS.some((pattern) => pattern.test(stripped));
	return chineseHit || englishHit;
}

/** Extracts plain text from a message of either role and content shape. */
function messageText(message: PiAgentMessage): string {
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
