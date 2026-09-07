/** Bounded background work; retries are persisted by MemoryStore, not session timers. */
export const EVOLUTION_TIMEOUT_MS = 120_000;
export const EVOLUTION_MAX_TOKENS = 8192;
export const RECOVERY_POLL_MS = 15_000;
export const LEASE_GRACE_MS = 30_000;
export const MAX_FAILURES = 5;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];

export const FAILURE_CODES = ["timeout", "cancelled", "output_limit", "invalid_output", "stale", "write_rejected", "unavailable", "provider", "interrupted", "unknown"] as const;
export type FailureCode = typeof FAILURE_CODES[number];

/** Never persist raw exception messages/provider bodies (they may contain secrets). */
export class EvolutionError extends Error {
	readonly code: FailureCode;
	constructor(code: FailureCode) { super(`Memory evolution: ${code}`); this.code = code; }
}
export function failureCode(error: unknown, signal?: AbortSignal): FailureCode {
	if (signal?.aborted) return signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled";
	return error instanceof EvolutionError ? error.code : "unknown";
}
export function retryAt(failures: number, now: number): number {
	return failures >= MAX_FAILURES ? 0 : now + RETRY_DELAYS_MS[Math.max(0, failures - 1)]!;
}
