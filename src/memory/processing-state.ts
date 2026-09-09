import type { Database } from './sqlite.ts';
import { fingerprint } from './privacy.ts';
import { CALL_WINDOW_MS, MAX_CALLS_PER_WINDOW, FAILURE_WINDOW_MS, MAX_WINDOW_FAILURES, NOTICE_COOLDOWN_MS } from './recovery.ts';

/** Called inside the store's write transaction, so multiple Pi processes share one budget. */
export function budgetUntil(db: Database, model: string, now: number): number {
 const calls = db.prepare('SELECT at FROM model_calls WHERE model=? AND at>? ORDER BY at DESC').all(model, now - CALL_WINDOW_MS);
 const failures = db.prepare("SELECT finished_at AS at FROM model_calls WHERE model=? AND outcome='failed' AND finished_at>? ORDER BY finished_at DESC")
  .all(model, now - FAILURE_WINDOW_MS);
 return Math.max(calls.length >= MAX_CALLS_PER_WINDOW ? Number(calls[MAX_CALLS_PER_WINDOW - 1].at) + CALL_WINDOW_MS : 0,
  failures.length >= MAX_WINDOW_FAILURES ? Number(failures[MAX_WINDOW_FAILURES - 1].at) + FAILURE_WINDOW_MS : 0);
}
export function reserveCall(db: Database, source: string, attempt: number, model: string, now: number): void {
 // Retain at most a day's operational receipts, not model bodies or token-level traces.
 db.prepare("DELETE FROM model_calls WHERE at<? AND outcome!='running'").run(now - 86_400_000);
 db.prepare('INSERT INTO model_calls(source_id,attempt,model,at) VALUES (?,?,?,?)').run(source, attempt, model, now);
}
export function finishCall(db: Database, source: string, attempt: number, outcome: 'done' | 'failed' | 'cancelled', now: number): void {
 db.prepare("UPDATE model_calls SET outcome=?,finished_at=? WHERE source_id=? AND attempt=? AND outcome='running'").run(outcome, now, source, attempt);
}
/** Fixed keys/hashes only; atomic callers prevent duplicate warnings across reload/processes. */
export function takeNotice(db: Database, identity: string, now: number): boolean {
 const key = fingerprint(identity);
 db.prepare('DELETE FROM recovery_notices WHERE at<=?').run(now - NOTICE_COOLDOWN_MS);
 return !!db.prepare('INSERT OR IGNORE INTO recovery_notices VALUES (?,?)').run(key, now).changes;
}
