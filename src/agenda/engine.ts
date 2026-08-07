/** Maturation thresholds used to advance one agenda item. */
export interface MaturationPolicy {
	readonly minScoreToSurface: number;
	readonly minEvidenceCount: number;
	readonly minObservationDays: number;
	readonly maxObservationDaysBeforeReview: number;
	readonly autoArchiveIfNoEvidenceDays: number;
	readonly sameAgendaCooldownDays: number;
}

/** Default maturation thresholds (Hermes V1.4.1c defaults). */
export const DEFAULT_MATURATION_POLICY: MaturationPolicy = {
	minScoreToSurface: 0.72,
	minEvidenceCount: 3,
	minObservationDays: 3,
	maxObservationDaysBeforeReview: 14,
	autoArchiveIfNoEvidenceDays: 21,
	sameAgendaCooldownDays: 7,
};

/** Inputs required to advance one agenda item state. */
export interface AdvanceInput {
	readonly status: string;
	readonly evidenceCount: number;
	readonly uniqueCount: number;
	readonly actionableCount: number;
	readonly observationDays: number;
	readonly maturityScore: number;
	readonly evidenceStrength: number;
	readonly lastSurfacedAt: string | null;
	readonly now: string;
}

/** Outcome of one state advancement pass. */
export interface AdvanceResult {
	readonly status: string;
	readonly decision: string;
}

/** Terminal statuses that are never advanced. */
const TERMINAL_STATUSES = new Set(["resolved", "archived", "surfaced"]);

/** Minimum actionable evidence required for a candidate. */
const MIN_ACTIONABLE_COUNT = 2;

/** Advances one agenda item through the maturation state machine. */
export function advanceState(
	input: AdvanceInput,
	policy: MaturationPolicy,
): AdvanceResult {
	if (TERMINAL_STATUSES.has(input.status)) {
		return { status: input.status, decision: "terminal" };
	}

	if (
		input.observationDays >= policy.autoArchiveIfNoEvidenceDays &&
		input.evidenceCount === 0
	) {
		return { status: "archived", decision: "auto_archive" };
	}

	if (isWithinCooldown(input, policy)) {
		return { status: input.status, decision: "cooldown" };
	}

	if (isCandidateReady(input, policy)) {
		return { status: "candidate_ready", decision: "candidate_ready" };
	}

	if (input.observationDays >= policy.maxObservationDaysBeforeReview) {
		return input.evidenceCount === 0
			? { status: "archived", decision: "archive_candidate" }
			: { status: "review_pending", decision: "surface_in_digest_for_review" };
	}

	if (input.status === "observing" && input.evidenceCount >= 1) {
		return { status: "accumulating_evidence", decision: "accumulate" };
	}

	return { status: input.status, decision: "continue_observing" };
}

/** Returns true when the last surface happened within the cooldown window. */
function isWithinCooldown(
	input: AdvanceInput,
	policy: MaturationPolicy,
): boolean {
	if (input.lastSurfacedAt === null) {
		return false;
	}
	const days = daysBetween(input.lastSurfacedAt, Date.parse(input.now));
	return days < policy.sameAgendaCooldownDays;
}

/** Returns true when every candidate gate passes. */
function isCandidateReady(
	input: AdvanceInput,
	policy: MaturationPolicy,
): boolean {
	return (
		input.maturityScore >= policy.minScoreToSurface &&
		input.uniqueCount >= policy.minEvidenceCount &&
		input.actionableCount >= MIN_ACTIONABLE_COUNT &&
		input.evidenceStrength >= 0 &&
		input.observationDays >= policy.minObservationDays
	);
}

/** Returns whole days between an ISO timestamp and a reference epoch. */
function daysBetween(isoAt: string, nowMs: number): number {
	const atMs = Date.parse(isoAt);
	if (Number.isNaN(atMs)) {
		return 0;
	}
	return Math.max(0, Math.floor((nowMs - atMs) / 86_400_000));
}
