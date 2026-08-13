import type {
	AgendaCandidate,
	AgendaEvidence,
} from "../store/agenda-store.ts";

/** One user-approved proposal waiting for lifecycle handling (P5). */
export interface ProposalDraft {
	readonly id: string;
	readonly title: string;
	readonly type: string;
	readonly status: "draft";
	readonly evidence: readonly AgendaEvidence[];
	readonly approval: {
		readonly required: true;
		readonly approvedBy: null;
		readonly approvedAt: null;
	};
	readonly timestamps: {
		readonly createdAt: string;
		readonly updatedAt: string;
	};
}

/** Creates a draft proposal from a user-approved agenda candidate. */
export function createProposalFromCandidate(
	candidate: AgendaCandidate,
	evidence: readonly AgendaEvidence[],
	now: string,
): ProposalDraft {
	return {
		id: `P-${now.replace(/\D/g, "").slice(0, 8)}-${randomSuffix()}`,
		title: candidate.title,
		type: candidate.type,
		status: "draft",
		evidence: [...evidence],
		approval: {
			required: true,
			approvedBy: null,
			approvedAt: null,
		},
		timestamps: {
			createdAt: now,
			updatedAt: now,
		},
	};
}

/** Returns a short random hex suffix for unique proposal ids. */
function randomSuffix(): string {
	return Math.random().toString(16).slice(2, 6);
}
