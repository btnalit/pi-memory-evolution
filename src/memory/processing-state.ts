import type { Database } from './sqlite.ts';
import { fingerprint } from './privacy.ts';
import { CALL_WINDOW_MS, FAILURE_WINDOW_MS, MAX_WINDOW_FAILURES, NOTICE_COOLDOWN_MS, type FailureCode } from './recovery.ts';
import { DEFAULT_POLICY, type RoutingPolicy } from './routing-policy.ts';
import type { Diagnostic } from './diagnostics.ts';

export interface CallPricing { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: { input: number; output: number; cacheRead: number; cacheWrite: number }[] }
export interface CallOptions { provider: string; pricing?: CallPricing; outputTokens?: number; promptBytes?: number }
export function estimatedCost(inputBytes: number, options?: CallOptions): number | null {
 const rates = options?.pricing ? [options.pricing, ...(options.pricing.tiers ?? [])] : [];
 if (!rates.length || rates.some(r => ![r.input,r.output,r.cacheRead,r.cacheWrite].every(n => Number.isFinite(n) && n >= 0))) return null;
 const input = Math.max(...rates.flatMap(r => [r.input,r.cacheRead,r.cacheWrite]));
 const output = Math.max(...rates.map(r => r.output));
 // All-zero custom catalog pricing is frequently missing, not proof of a free account.
 if (!input && !output) return null;
 return ((inputBytes + (options?.promptBytes ?? 20_000)) * input + (options?.outputTokens ?? 8192) * output) / 1_000_000;
}
/** Atomic callers share the hard request ceiling across models/providers and Pi processes. */
export function budgetUntil(db: Database, model: string, now: number, policy: RoutingPolicy = DEFAULT_POLICY, reserveUsd?: number | null): number {
 const calls = db.prepare('SELECT at FROM model_calls WHERE at>? ORDER BY at DESC').all(now - CALL_WINDOW_MS);
 const failures = db.prepare("SELECT finished_at AS at FROM model_calls WHERE model=? AND outcome='failed' AND code IN ('provider','timeout','interrupted') AND finished_at>? ORDER BY finished_at DESC")
  .all(model, now - FAILURE_WINDOW_MS);
 let until = Math.max(calls.length >= policy.callsPerHour ? Number(calls[policy.callsPerHour - 1].at) + CALL_WINDOW_MS : 0,
  failures.length >= MAX_WINDOW_FAILURES ? Number(failures[MAX_WINDOW_FAILURES - 1].at) + FAILURE_WINDOW_MS : 0);
 if (policy.dailyEstimatedUsd !== null) {
  const day = db.prepare('SELECT at,reserved_usd,charged_usd FROM model_calls WHERE at>? ORDER BY at').all(now - 86_400_000);
  const cost = day.reduce((sum, r) => sum + Number(r.charged_usd ?? r.reserved_usd ?? 0), 0);
  if (reserveUsd === null || day.some(r => r.charged_usd === null && r.reserved_usd === null)
   || cost + (reserveUsd ?? 0) > policy.dailyEstimatedUsd) until = Math.max(until, Number(day[0]?.at ?? now) + 86_400_000);
 }
 return until;
}
export function reserveCall(db: Database, source: string, attempt: number, model: string, now: number, provider = model.split('/')[0], reserveUsd: number | null = null): void {
 db.prepare("DELETE FROM model_calls WHERE at<? AND outcome!='running'").run(now - 86_400_000);
 db.prepare('INSERT INTO model_calls(source_id,attempt,model,provider,at,reserved_usd) VALUES (?,?,?,?,?,?)').run(source, attempt, model, provider, now, reserveUsd);
}
export function finishCall(db: Database, source: string, attempt: number, outcome: 'done' | 'failed' | 'cancelled', now: number, code: FailureCode | '' = '', diagnostic: Diagnostic = {}): void {
 const row = db.prepare("SELECT at,model,provider FROM model_calls WHERE source_id=? AND attempt=? AND outcome='running'").get(source, attempt);
 if (!row) return;
 // Zero usage on an error/timeout is not a receipt proving a request was free.
 const reported = diagnostic.reportedUsd !== undefined && (outcome === 'done' || diagnostic.inputTokens || diagnostic.outputTokens) ? diagnostic.reportedUsd : null;
 db.prepare("UPDATE model_calls SET outcome=?,finished_at=?,code=?,charged_usd=?,input_tokens=?,output_tokens=? WHERE source_id=? AND attempt=?")
  .run(outcome, now, code, reported, diagnostic.inputTokens ?? null, diagnostic.outputTokens ?? null, source, attempt);
 db.prepare('UPDATE sources SET call_ms=call_ms+? WHERE id=?').run(Math.max(0, now - Number(row.at)), source);
 if (outcome !== 'failed' || !code) return;
 let scope = '', delay = 0;
 if (['auth','quota','rate_limit'].includes(code)) {
  scope = `provider:${row.provider}`;
  delay = code === 'auth' ? 900_000 : code === 'quota' ? 3_600_000 : 60_000;
 } else if (['request','context_limit'].includes(code)) { scope = `model:${row.model}`; delay = 3_600_000; }
 else if (['provider','timeout','interrupted','invalid_output','output_limit'].includes(code)) {
  const family = ['invalid_output','output_limit'].includes(code) ? "'invalid_output','output_limit'" : "'provider','timeout','interrupted'";
  const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM model_calls WHERE model=? AND outcome='failed' AND code IN (${family}) AND finished_at>?`).get(row.model, now - FAILURE_WINDOW_MS)!.n);
  if (count >= 2) { scope = `model:${row.model}`; delay = FAILURE_WINDOW_MS; }
 }
 if (scope) db.prepare('INSERT INTO route_health VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET until=MAX(until,excluded.until),code=excluded.code')
  .run(scope, now + Math.max(delay, diagnostic.retryAfterMs ?? 0), code);
}
export function routeUntil(db: Database, model: string, provider: string, now: number): number {
 const row = db.prepare('SELECT MAX(until) AS until FROM route_health WHERE id IN (?,?)').get(`model:${model}`, `provider:${provider}`);
 return Math.max(now, Number(row?.until ?? 0));
}
export function takeNotice(db: Database, identity: string, now: number): boolean {
 const key = fingerprint(identity);
 db.prepare('DELETE FROM recovery_notices WHERE at<=?').run(now - NOTICE_COOLDOWN_MS);
 return !!db.prepare('INSERT OR IGNORE INTO recovery_notices VALUES (?,?)').run(key, now).changes;
}
