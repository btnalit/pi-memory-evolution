import type { PiAgentMessage } from "../adapter/pi-api.ts";
import type {
	AgendaStore,
	ProposalRecord,
	ProposalStatus,
} from "../store/agenda-store.ts";
import { transitionProposal } from "./proposal-state.ts";

/** Keywords that indicate the agent approves a referenced proposal. */
const APPROVE_KEYWORDS = [
	"批准",
	"同意",
	"可以",
	"执行",
] as const;

/** Negated approval forms that must reject, not approve. */
const NEGATED_APPROVALS = [
	"不批准",
	"不同意",
	"不可以",
	"不执行",
] as const;

/** Keywords that indicate the agent rejects a referenced proposal. */
const REJECT_KEYWORDS = [
	"拒绝",
	"驳回",
	"不要",
	"不批准",
	"不同意",
	"不可以",
	"不执行",
] as const;

/** English keywords matched on word boundaries so "approved"/"token" do not hit. */
const APPROVE_PATTERNS = [/\bapprove\b/i, /\bok\b/i] as const;
const REJECT_PATTERNS = [/\breject\b/i] as const;

/** Roles whose messages may carry an approval decision. Tool output is data, not intent. */
const DECISION_ROLES = new Set(["assistant", "user"]);

/** One message-derived decision with the role that produced it. */
interface DecidedEntry {
	readonly decision: ProposalStatus;
	readonly role: string;
}

/**
 * Decides pending proposals from agent messages and expiry.
 *
 * Decision capture: only assistant/user messages that reference a proposal id
 * AND carry an explicit approval/rejection keyword move that proposal forward.
 * Tool result messages are excluded so data output (e.g. a queue dump) can
 * never trigger a decision. Messages without the id never decide. Proposals
 * past `expiresAt` are rejected. Proposals that stay unexpired and undecided
 * remain pending.
 */
export function runAutoApproval(
	store: AgendaStore,
	messages: readonly PiAgentMessage[],
	now: string,
): void {
	const queue = store.readProposalQueue();
	const entries = messages
		.filter((message) => DECISION_ROLES.has(message.role))
		.map((message) => ({ role: message.role, text: messageText(message) }))
		.filter((entry) => entry.text.length > 0);
	let changed = false;

	const updated = queue.map((proposal) => {
		if (proposal.status !== "pending_user_approval") {
			return proposal;
		}
		const decided = decideFromMessages(proposal, entries);
		if (decided !== undefined) {
			changed = true;
			const next = transitionProposal(proposal, decided.decision, now, {
				approvedBy: decided.role,
				approvedAt: now,
			});
			store.appendJournal(
				`- ${now} proposal ${proposal.id} (${proposal.title}) ${decided.decision} via agent message (role=${decided.role})`,
			);
			return next;
		}
		if (isExpired(proposal, now)) {
			changed = true;
			const next = transitionProposal(proposal, "rejected", now, {
				approvedBy: "expiry",
				approvedAt: now,
			});
			store.appendJournal(
				`- ${now} proposal ${proposal.id} (${proposal.title}) rejected: expired without decision`,
			);
			return next;
		}
		return proposal;
	});

	if (changed) {
		store.writeProposalQueue(updated);
	}
}

/** Returns a decision and its role, or undefined when undecided. */
function decideFromMessages(
	proposal: ProposalRecord,
	entries: readonly { readonly role: string; readonly text: string }[],
): DecidedEntry | undefined {
	const id = proposal.id;
	const approving = entries.find(
		(entry) => entry.text.includes(id) && hasApprovalIntent(entry.text),
	);
	const rejecting = entries.find(
		(entry) => entry.text.includes(id) && hasRejectionIntent(entry.text),
	);
	if (approving !== undefined && rejecting === undefined) {
		return { decision: "approved", role: approving.role };
	}
	if (rejecting !== undefined && approving === undefined) {
		return { decision: "rejected", role: rejecting.role };
	}
	return undefined;
}

/** Returns true when the text carries an approval intent (negations excluded). */
function hasApprovalIntent(text: string): boolean {
	const stripped = NEGATED_APPROVALS.reduce(
		(acc, negated) => acc.split(negated).join(""),
		text,
	);
	const chineseHit = APPROVE_KEYWORDS.some((kw) => stripped.includes(kw));
	const englishHit = APPROVE_PATTERNS.some((pattern) => pattern.test(stripped));
	return chineseHit || englishHit;
}

/** Returns true when the text carries a rejection intent. */
function hasRejectionIntent(text: string): boolean {
	const chineseHit = REJECT_KEYWORDS.some((kw) => text.includes(kw));
	const englishHit = REJECT_PATTERNS.some((pattern) => pattern.test(text));
	return chineseHit || englishHit;
}

/** Returns true when the proposal approval window has passed. */
function isExpired(proposal: ProposalRecord, now: string): boolean {
	return Date.parse(proposal.timestamps.expiresAt) < Date.parse(now);
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
