/** One evidence record evaluated for maturity. */
export interface MaturityEvidence {
	readonly at: string;
	readonly source: string;
	readonly summary: string;
	readonly weight: number;
	readonly qualified: boolean;
	readonly actionable: boolean;
	readonly relevance: number;
	readonly contribution: number;
}

/** Inputs required to compute one agenda item maturity score. */
export interface MaturityInput {
	readonly evidence: readonly MaturityEvidence[];
	readonly uniqueCount: number;
	readonly observationDays: number;
	readonly recentMentions7d: number;
	readonly unresolvedCost: number;
	readonly actionability?: number;
	readonly type: string;
	readonly now: string;
}

/** Score components produced by the maturity formula. */
export interface MaturityScores {
	readonly evidenceStrength: number;
	readonly trendStrength: number;
	readonly recurrenceDensity: number;
	readonly unresolvedCost: number;
	readonly actionability: number;
	readonly timePressureBonus: number;
	readonly stalenessPenalty: number;
	readonly maturityScore: number;
}

/** Default actionability per mature agenda action. */
export const MATURITY_ACTION_ACTIONABILITY = {
	ask_user_confirmation: 0.7,
	create_proposal: 0.8,
	surface_in_digest: 0.5,
	bypass_maturation_to_speak_gate: 0.9,
	archive_candidate: 0.3,
} as const;

/** Mature action selected per agenda item type. */
export const MATURITY_ACTION_MAP = {
	strategic_positioning: "ask_user_confirmation",
	automation_opportunity: "create_proposal",
	quality_improvement: "create_proposal",
	cleanup_candidate: "surface_in_digest",
	risk_watch: "bypass_maturation_to_speak_gate",
} as const;

/** Default actionability when no type or stored score provides one. */
const DEFAULT_ACTIONABILITY = 0.5;

/** Returns the default actionability derived from the agenda item type. */
export function actionabilityForType(type: string): number {
	const action = MATURITY_ACTION_MAP[type as keyof typeof MATURITY_ACTION_MAP];
	if (action === undefined) {
		return DEFAULT_ACTIONABILITY;
	}
	return MATURITY_ACTION_ACTIONABILITY[action] ?? DEFAULT_ACTIONABILITY;
}

/** Weight of each maturity component. */
const WEIGHTS = {
	evidenceStrength: 0.3,
	trendStrength: 0.25,
	recurrenceDensity: 0.2,
	unresolvedCost: 0.15,
	actionability: 0.1,
} as const;

/** Evidence strength divisor for full evidence. */
const ACTIONABLE_STRENGTH_FULL_EVIDENCE = 1.5;

/** Trend cap when only one actionable evidence exists. */
const SINGLE_ACTIONABLE_TREND_CEILING = 0.35;

/** Trend cap when actionable evidence strength is very low. */
const ACTIONABLE_STRENGTH_SINGLE_CAP_THRESHOLD = 0.1;

/** Trend ceiling when no actionable evidence exists. */
const ZERO_ACTIONABLE_TREND_CEILING = 0.1;

/** Recurrence ceiling when no qualified evidence exists. */
const ZERO_QUALIFIED_RECUR_CEILING = 0.1;

/** Maturity ceiling when no qualified evidence exists. */
const ZERO_QUALIFIED_MATURITY_CEILING = 0.5;

/** Time pressure saturation and growth constants. */
const TIME_PRESSURE_MAX = 0.12;
const TIME_PRESSURE_LOG_FACTOR = 0.03;

/** Staleness penalty activation and growth constants. */
const STALENESS_THRESHOLD_DAYS = 7;
const STALENESS_PENALTY_MAX = 0.3;
const STALENESS_PENALTY_PER_DAY = 0.01;

/** Window in days that marks evidence as fresh. */
const FRESH_WINDOW_DAYS = 7;

/** Computes all maturity score components for one agenda item. */
export function computeScores(input: MaturityInput): MaturityScores {
	const actionableQualified = input.evidence.filter(
		(item) => item.qualified && item.actionable,
	);
	const hasActionable = actionableQualified.length > 0;
	const actionableQualifiedStrength = actionableQualified.reduce(
		(sum, item) => sum + item.weight * item.relevance,
		0,
	);
	const actionability = input.actionability ?? actionabilityForType(input.type);

	const evidenceStrength = computeEvidenceStrength(
		hasActionable,
		actionableQualifiedStrength,
	);
	const trendStrength = computeTrendStrength(input, actionableQualified);
	const recurrenceDensity = computeRecurrenceDensity(
		input,
		hasActionable,
		actionableQualified.length,
	);
	const timePressureBonus = computeTimePressureBonus(input);
	const stalenessPenalty = computeStalenessPenalty(input);
	const rawMaturity =
		WEIGHTS.evidenceStrength * evidenceStrength +
		WEIGHTS.trendStrength * trendStrength +
		WEIGHTS.recurrenceDensity * recurrenceDensity +
		WEIGHTS.unresolvedCost * input.unresolvedCost +
		WEIGHTS.actionability * actionability +
		timePressureBonus -
		stalenessPenalty;

	let maturityScore = rawMaturity;
	const hasQualified = input.evidence.some((item) => item.qualified);
	if (!hasQualified && maturityScore > ZERO_QUALIFIED_MATURITY_CEILING) {
		maturityScore = ZERO_QUALIFIED_MATURITY_CEILING;
	}
	maturityScore = Math.max(0, Math.min(1, maturityScore));

	return {
		evidenceStrength,
		trendStrength,
		recurrenceDensity,
		unresolvedCost: input.unresolvedCost,
		actionability,
		timePressureBonus,
		stalenessPenalty,
		maturityScore,
	};
}

/** Computes evidence strength from actionable qualified weight. */
function computeEvidenceStrength(
	hasActionable: boolean,
	actionableQualifiedStrength: number,
): number {
	if (!hasActionable) {
		return 0;
	}
	return Math.min(
		1,
		actionableQualifiedStrength / ACTIONABLE_STRENGTH_FULL_EVIDENCE,
	);
}

/** Computes trend strength from fresh actionable evidence share. */
function computeTrendStrength(
	input: MaturityInput,
	actionableQualified: readonly MaturityEvidence[],
): number {
	const nowMs = Date.parse(input.now);
	const freshActionable = actionableQualified.filter(
		(item) => daysBetween(item.at, nowMs) <= FRESH_WINDOW_DAYS,
	).length;
	if (actionableQualified.length > 0) {
		const trendRatio = Math.min(
			1,
			freshActionable / Math.max(1, actionableQualified.length),
		);
		const mentionsShare = input.recentMentions7d / 20;
		let trend = Math.min(1, trendRatio * 0.8 + mentionsShare * 0.2);
		const singleEvidence =
			actionableQualified.length === 1 ||
			actionableQualified.reduce(
				(sum, item) => sum + item.weight * item.relevance,
				0,
			) <= ACTIONABLE_STRENGTH_SINGLE_CAP_THRESHOLD;
		if (singleEvidence) {
			trend = Math.min(trend, SINGLE_ACTIONABLE_TREND_CEILING);
		}
		return trend;
	}

	const freshQualified = input.evidence.filter(
		(item) =>
			item.qualified &&
			daysBetween(item.at, nowMs) <= FRESH_WINDOW_DAYS,
	).length;
	return Math.min(
		ZERO_ACTIONABLE_TREND_CEILING,
		(freshQualified / Math.max(1, input.uniqueCount)) * 0.5,
	);
}

/** Computes recurrence density from qualified evidence count. */
function computeRecurrenceDensity(
	input: MaturityInput,
	hasActionable: boolean,
	actionableQualifiedCount: number,
): number {
	if (hasActionable) {
		return Math.min(
			1,
			actionableQualifiedCount / Math.max(5, input.observationDays * 2),
		);
	}
	return Math.min(
		ZERO_QUALIFIED_RECUR_CEILING,
		input.uniqueCount / Math.max(10, input.observationDays * 4),
	);
}

/** Computes the time pressure bonus from observation days. */
function computeTimePressureBonus(input: MaturityInput): number {
	const qualifiedCount = input.evidence.filter((item) => item.qualified).length;
	if (qualifiedCount === 0 && input.evidence.length === 0) {
		return 0;
	}
	return Math.min(
		TIME_PRESSURE_MAX,
		Math.log(input.observationDays + 1) * TIME_PRESSURE_LOG_FACTOR,
	);
}

/** Computes the staleness penalty from the most recent evidence age. */
function computeStalenessPenalty(input: MaturityInput): number {
	if (input.evidence.length === 0) {
		return 0;
	}
	const latestAt = input.evidence.reduce(
		(latest, item) => (item.at > latest ? item.at : latest),
		input.evidence[0].at,
	);
	const days = daysBetween(latestAt, Date.parse(input.now));
	if (days < STALENESS_THRESHOLD_DAYS) {
		return 0;
	}
	return Math.min(STALENESS_PENALTY_MAX, days * STALENESS_PENALTY_PER_DAY);
}

/** Returns whole days between an ISO timestamp and a reference epoch. */
function daysBetween(isoAt: string, nowMs: number): number {
	const atMs = Date.parse(isoAt);
	if (Number.isNaN(atMs)) {
		return 0;
	}
	return Math.max(0, Math.floor((nowMs - atMs) / 86_400_000));
}
