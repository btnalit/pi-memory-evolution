import type {
	AgendaCandidate,
	AgendaEvidence,
	ProposalStatus,
} from "../store/agenda-store.ts";

/** Hours until a pending proposal expires without an approval decision. */
export const PROPOSAL_APPROVAL_HOURS = 24;

/** One proposal waiting for user approval (approved P5 plan). */
export interface ProposalDraft {
	readonly id: string;
	readonly title: string;
	readonly type: string;
	readonly status: ProposalStatus;
	readonly evidence: readonly AgendaEvidence[];
	readonly approval: {
		readonly required: true;
		readonly approvedBy: null;
		readonly approvedAt: null;
	};
	readonly timestamps: {
		readonly createdAt: string;
		readonly updatedAt: string;
		readonly expiresAt: string;
	};
}

/** Creates a pending proposal from a speak-gate approved agenda candidate. */
export function createProposalFromCandidate(
	candidate: AgendaCandidate,
	evidence: readonly AgendaEvidence[],
	now: string,
): ProposalDraft {
	return {
		id: `P-${now.replace(/\D/g, "").slice(0, 8)}-${randomSuffix()}`,
		title: candidate.title,
		type: candidate.type,
		status: "pending_user_approval",
		evidence: [...evidence],
		approval: {
			required: true,
			approvedBy: null,
			approvedAt: null,
		},
		timestamps: {
			createdAt: now,
			updatedAt: now,
			expiresAt: new Date(
				Date.parse(now) + PROPOSAL_APPROVAL_HOURS * 3_600_000,
			).toISOString(),
		},
	};
}

/** Returns a short random hex suffix for unique proposal ids. */
function randomSuffix(): string {
	return Math.random().toString(16).slice(2, 6);
}
