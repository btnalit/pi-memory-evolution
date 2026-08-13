import type {
	ProposalRecord,
	ProposalStatus,
} from "../store/agenda-store.ts";

/** Legal transitions of the proposal lifecycle state machine (approved P5 plan). */
const TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
	draft: ["pending_user_approval", "rejected"],
	pending_user_approval: ["approved", "rejected"],
	approved: ["implemented", "rejected", "failed"],
	implemented: ["verified", "failed", "rollback_required"],
	verified: [],
	rejected: [],
	failed: ["rollback_required"],
	rollback_required: [],
};

/** Statuses that end the proposal lifecycle. */
export const PROPOSAL_TERMINAL_STATUSES: readonly ProposalStatus[] = [
	"verified",
	"rejected",
	"rollback_required",
];

/**
 * Returns a new proposal with the given status, or throws on illegal transitions.
 *
 * The original proposal is never mutated. Every transition refreshes
 * `timestamps.updatedAt` so the audit trail stays accurate.
 */
export function transitionProposal(
	proposal: ProposalRecord,
	to: ProposalStatus,
	now: string,
): ProposalRecord {
	if (!TRANSITIONS[proposal.status].includes(to)) {
		throw new Error(
			`illegal transition: ${proposal.status} -> ${to}`,
		);
	}
	return {
		...proposal,
		status: to,
		timestamps: {
			...proposal.timestamps,
			updatedAt: now,
		},
	};
}
