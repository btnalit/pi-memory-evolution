import type {
	AgendaCandidate,
	SpeakDecision,
	SpeakQuota,
} from "../store/agenda-store.ts";

/** Risk dampeners applied to the weighted score. */
const RISK_DAMPENER = {
	none: 1.0,
	low: 0.97,
	medium: 0.82,
	high: 0.55,
	critical: 0.0,
} as const;

/** Scoring weights for the priority score. */
const WEIGHT_IMPACT = 0.4;
const WEIGHT_RECURRENCE = 0.25;
const WEIGHT_CONFIDENCE = 0.35;

/** Cost of interrupting the user. */
const INTERRUPTION_COST = 0.2;

/** Bonus for strategic reflections. */
const STRATEGIC_BONUS = 0.12;

/** Bonus for urgent events. */
const URGENCY_BONUS = 0.15;

/** Thresholds for speak and queue decisions. */
const SPEAK_THRESHOLD = 0.6;
const PRIORITY_QUEUE_THRESHOLD = 0.6;
const DAILY_DIGEST_THRESHOLD = 0.4;

/** Daily quota limits. */
const DAILY_SUGGESTION_LIMIT = 3;
const DAILY_STRATEGIC_LIMIT = 1;

/** Default risk level when the input does not provide one. */
const DEFAULT_RISK_LEVEL = "none";

/** Default actionability per candidate type (mirrors maturity actions). */
const TYPE_ACTIONABILITY: Record<string, number> = {
	strategic_positioning: 0.7,
	automation_opportunity: 0.8,
	quality_improvement: 0.8,
	cleanup_candidate: 0.5,
	risk_watch: 0.9,
};

/** Inputs required to evaluate one agenda candidate. */
export interface SpeakGateInput {
	readonly candidate: AgendaCandidate;
	readonly quota: SpeakQuota;
	readonly riskLevel?: string;
	readonly urgent?: boolean;
	readonly isStrategic?: boolean;
	readonly repeatPenalty?: number;
}

/** Result of one speak-gate evaluation. */
export interface SpeakGateResult {
	readonly decision: SpeakDecision;
	readonly quota: SpeakQuota;
	readonly quotaConsumed: boolean;
}

/** Evaluates one candidate through the speak gate and returns a traceable decision. */
export function evaluateCandidate(input: SpeakGateInput): SpeakGateResult {
	const impact = input.candidate.maturityScore;
	const confidence = input.candidate.maturityScore;
	const recurrence = Math.min(
		1,
		input.candidate.evidenceCount / 3,
	);
	const riskLevel = input.riskLevel ?? DEFAULT_RISK_LEVEL;
	const isStrategic =
		input.isStrategic ?? input.candidate.type === "strategic_positioning";
	const isUrgent = input.urgent ?? false;
	const repeatPenalty = input.repeatPenalty ?? 0;
	const actionability =
		TYPE_ACTIONABILITY[input.candidate.type] ?? 0.5;

	const scoreReasons: string[] = [];
	const weighted = round4(
		impact * WEIGHT_IMPACT +
			recurrence * WEIGHT_RECURRENCE +
			confidence * WEIGHT_CONFIDENCE,
	);
	scoreReasons.push(
		`weighted = ${impact}×0.40 + ${recurrence}×0.25 + ${confidence}×0.35 = ${weighted}`,
	);

	const dampener = RISK_DAMPENER[riskLevel as keyof typeof RISK_DAMPENER] ?? 0.55;
	const dampened = round4(weighted * dampener);
	scoreReasons.push(`× risk_dampener[${riskLevel}=${dampener}] → ${dampened}`);

	const bonus = round4(
		(isStrategic ? STRATEGIC_BONUS : 0) + (isUrgent ? URGENCY_BONUS : 0),
	);
	scoreReasons.push(
		`+ bonuses: ${
			isStrategic && isUrgent
				? "strategic + urgent"
				: isStrategic
					? "strategic"
					: isUrgent
						? "urgent"
						: "none"
		} → ${bonus}`,
	);

	const priorityRaw = dampened + bonus;
	const priorityScore = clamp01(priorityRaw);
	scoreReasons.push(`priority_score = ${round4(priorityScore)}`);

	const speakRaw = priorityRaw - INTERRUPTION_COST - repeatPenalty;
	const speakScore = clamp01(speakRaw);
	scoreReasons.push(
		`speak_score = ${round4(speakRaw)} - 0.20 - ${repeatPenalty} → ${round4(speakScore)}`,
	);

	const actionReasons: string[] = [];
	let action: string;
	if (isUrgent) {
		action = "speak_now_risk_alert";
		actionReasons.push("urgent=true → bypass all gates");
	} else if (riskLevel === "critical") {
		action = "risk_alert_only";
		actionReasons.push("risk_level=critical → alert only, do not act");
	} else {
		const speakPass = speakScore >= SPEAK_THRESHOLD;
		const actionabilityPass = actionability >= SPEAK_THRESHOLD;
		if (speakPass && actionabilityPass) {
			action =
				riskLevel === "medium" || riskLevel === "high"
					? "speak_now_with_approval"
					: "speak_now";
			actionReasons.push(
				`speak(${round4(speakScore)}) >= 0.60 and actionability(${actionability}) >= 0.60 → ${action}`,
			);
		} else if (priorityScore >= PRIORITY_QUEUE_THRESHOLD) {
			action = "proposal_queue";
			actionReasons.push(`priority(${round4(priorityScore)}) >= 0.60 → proposal_queue`);
		} else if (priorityScore >= DAILY_DIGEST_THRESHOLD) {
			action = "daily_digest";
			actionReasons.push(`priority(${round4(priorityScore)}) >= 0.40 → daily_digest`);
		} else {
			action = "silent_log_only";
			actionReasons.push(`priority(${round4(priorityScore)}) < 0.40 → silent_log_only`);
		}
	}

	let finalAction = action;
	let originalAction = action;
	let quotaReason = "no_quota_needed";
	let quota = { ...input.quota };
	const needsQuota = ["speak_now", "speak_now_with_approval", "speak_now_risk_alert"].includes(
		action,
	);
	if (needsQuota) {
		if (isStrategic) {
			if (quota.strategic >= DAILY_STRATEGIC_LIMIT) {
				finalAction = "proposal_queue";
				quotaReason = "strategic_quota_exceeded";
			} else {
				quota = { ...quota, strategic: quota.strategic + 1 };
				quotaReason = "speak_approved";
			}
		} else if (quota.suggestions >= DAILY_SUGGESTION_LIMIT) {
			finalAction = "proposal_queue";
			quotaReason = "suggestion_quota_exceeded";
		} else {
			quota = { ...quota, suggestions: quota.suggestions + 1 };
			quotaReason = "speak_approved";
		}
	}

	const wouldHaveSpokenWithoutQuota =
		needsQuota && finalAction !== originalAction;

	const decisionReason = [
		...scoreReasons,
		"",
		...actionReasons,
		quotaReason === "no_quota_needed"
			? `quota: ${quotaReason}`
			: quotaReason.includes("exceeded")
				? `⚠ quota: ${quotaReason} → downgraded to ${finalAction}`
				: `quota: ${quotaReason}`,
	];

	const decision: SpeakDecision = {
		candidateId: input.candidate.candidateId,
		title: input.candidate.title,
		priorityScore,
		speakScore,
		action: finalAction,
		wouldHaveSpokenWithoutQuota,
		decisionReason,
	};

	return {
		decision,
		quota,
		quotaConsumed: quotaReason === "speak_approved",
	};
}

/** Rounds a number to 4 decimal places. */
function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/** Clamps a number into the [0,1] range. */
function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
