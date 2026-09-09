import { validDiagnostic, type Diagnostic } from './diagnostics.ts';

/** Bounded background work; retries are persisted by MemoryStore, not session timers. */
export const EVOLUTION_TIMEOUT_MS = 120_000;
export const EVOLUTION_MAX_TOKENS = 8192;
export const RECOVERY_POLL_MS = 15_000;
export const LEASE_GRACE_MS = 30_000;
export const MAX_FAILURES = 5;
export const MAX_OUTPUT_FAILURES = 2;
export const CALL_WINDOW_MS = 3_600_000;
export const MAX_CALLS_PER_WINDOW = 20;
export const FAILURE_WINDOW_MS = 900_000;
export const MAX_WINDOW_FAILURES = 5;
export const NOTICE_COOLDOWN_MS = 3_600_000;
export const PAUSED_SQL = `(failures>=${MAX_FAILURES} OR output_failures>=${MAX_OUTPUT_FAILURES} OR last_error IN ('write_rejected','unavailable','auth','request'))`;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];

export const FAILURE_CODES = ["timeout", "cancelled", "output_limit", "invalid_output", "stale", "write_rejected", "unavailable", "provider", "auth", "request", "rate_limit", "interrupted", "unknown"] as const;
export type FailureCode = typeof FAILURE_CODES[number];

/** Never persist raw exception messages/provider bodies (they may contain secrets). */
export class EvolutionError extends Error {
	readonly code: FailureCode;
	readonly diagnostic: Diagnostic;
	constructor(code: FailureCode, diagnostic: Diagnostic = {}) {
		super(`Memory evolution: ${code}`);
		if (!validDiagnostic(diagnostic)) throw new Error('Invalid memory diagnostics');
		this.code = code; this.diagnostic = { ...diagnostic };
	}
}
export function failureCode(error: unknown, signal?: AbortSignal): FailureCode {
	if (signal?.aborted) return signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled";
	return error instanceof EvolutionError ? error.code : "unknown";
}
export function retryAt(failures: number, now: number): number {
	return failures >= MAX_FAILURES ? 0 : now + RETRY_DELAYS_MS[Math.max(0, failures - 1)]!;
}
