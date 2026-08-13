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

/** Approval identity recorded when a proposal decision is made. */
export interface ProposalApproval {
	readonly approvedBy: string;
	readonly approvedAt: string;
}

/**
 * Returns a new proposal with the given status, or throws on illegal transitions.
 *
 * The original proposal is never mutated. Every transition refreshes
 * `timestamps.updatedAt` so the audit trail stays accurate. When the target
 * status is approved or rejected and `approval` is provided, the decision
 * identity (who decided, when) is recorded on the proposal.
 */
export function transitionProposal(
	proposal: ProposalRecord,
	to: ProposalStatus,
	now: string,
	approval?: ProposalApproval,
): ProposalRecord {
	if (!TRANSITIONS[proposal.status].includes(to)) {
		throw new Error(
			`illegal transition: ${proposal.status} -> ${to}`,
		);
	}
	const nextApproval =
		approval !== undefined && (to === "approved" || to === "rejected")
			? { ...proposal.approval, ...approval }
			: proposal.approval;
	return {
		...proposal,
		status: to,
		approval: nextApproval,
		timestamps: {
			...proposal.timestamps,
			updatedAt: now,
		},
	};
}
