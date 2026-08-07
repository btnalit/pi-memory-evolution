/** Fixed weight assigned to each known pi signal type (O3-1 mapping). */
export const SIGNAL_WEIGHTS = {
	feedback: 0.3,
	projection: 0.15,
	session_stats: 0.05,
} as const;

/** Default weight for unknown signal types. */
const DEFAULT_SIGNAL_WEIGHT = 0.05;

/** Signal types whose evidence is treated as actionable. */
const ACTIONABLE_SIGNALS = new Set(["feedback"]);

/** Signal types whose evidence is treated as qualified. */
const QUALIFIED_SIGNALS = new Set([
	"feedback",
	"projection",
	"session_stats",
]);

/** Classification of one signal type in evidence terms. */
export interface SignalClassification {
	readonly actionable: boolean;
	readonly qualified: boolean;
}

/** Returns the evidence classification for one signal type. */
export function classifySignal(type: string): SignalClassification {
	return {
		actionable: ACTIONABLE_SIGNALS.has(type),
		qualified: QUALIFIED_SIGNALS.has(type),
	};
}

/** Returns the fixed evidence weight for one signal type. */
export function evidenceWeightForSignal(type: string): number {
	const weight = SIGNAL_WEIGHTS[type as keyof typeof SIGNAL_WEIGHTS];
	return weight ?? DEFAULT_SIGNAL_WEIGHT;
}

/** Returns true when one signal type counts as actionable evidence. */
export function isActionableSignal(type: string): boolean {
	return classifySignal(type).actionable;
}

/** Returns true when one signal type counts as qualified evidence. */
export function isQualifiedSignal(type: string): boolean {
	return classifySignal(type).qualified;
}
