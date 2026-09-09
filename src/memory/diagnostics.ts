import { clipBytes, redact } from './privacy.ts';

export const OUTPUT_PROTOCOL_VERSION = 2;
export const DIAGNOSTIC_REASONS = ['empty_text', 'missing_final', 'ambiguous_final', 'unexpected_tool',
 'json_syntax', 'ambiguous_json', 'output_too_large', 'result_shape', 'too_many_claims', 'claim_shape',
 'unknown_field', 'invalid_kind', 'content_type', 'content_length', 'invalid_replaces',
 'http_error', 'abnormal_stop', 'request_failed', 'legacy_import_failed'] as const;
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];
/** Structural metadata only. Never add output snippets, arbitrary keys, headers or exception messages. */
export interface Diagnostic {
 protocol?: number;
 model?: string;
 reason?: DiagnosticReason;
 field?: string;
 actual?: number;
 outputBytes?: number;
 textBlocks?: number;
 finalBlocks?: number;
 commentaryBlocks?: number;
 ignoredAliases?: number;
 httpStatus?: number;
 stopReason?: 'stop' | 'length' | 'error' | 'aborted' | 'toolUse';
 errorClass?: 'quota' | 'context_limit' | 'safety';
 retryAfterMs?: number;
 inputTokens?: number;
 outputTokens?: number;
 reportedUsd?: number;
}
const NUMBERS = ['protocol', 'actual', 'outputBytes', 'textBlocks', 'finalBlocks', 'commentaryBlocks', 'ignoredAliases', 'httpStatus', 'retryAfterMs', 'inputTokens', 'outputTokens'] as const;
const KEYS = new Set<string>([...NUMBERS, 'model', 'reason', 'field', 'stopReason', 'errorClass', 'reportedUsd']);
export function modelLabel(value: string): string { return clipBytes(redact(value), 200); }
export function validDiagnostic(value: unknown): value is Diagnostic {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const d = value as Diagnostic;
 return Object.keys(d).every(k => KEYS.has(k))
  && NUMBERS.every(k => d[k] === undefined || (Number.isSafeInteger(d[k]) && d[k]! >= 0))
  && (d.errorClass === undefined || ['quota', 'context_limit', 'safety'].includes(d.errorClass))
  && (d.reportedUsd === undefined || (Number.isFinite(d.reportedUsd) && d.reportedUsd >= 0))
  && (d.model === undefined || (typeof d.model === 'string' && modelLabel(d.model) === d.model))
  && (d.reason === undefined || DIAGNOSTIC_REASONS.includes(d.reason))
  && (d.field === undefined || (typeof d.field === 'string' && /^(?:result|memories(?:\[(?:[0-9]|1[0-5])\](?:\.(?:kind|content|replaces|searchTerms))?)?)$/u.test(d.field)))
  && (d.stopReason === undefined || ['stop', 'length', 'error', 'aborted', 'toolUse'].includes(d.stopReason));
}
export function parseDiagnostic(text: unknown): Diagnostic {
 const value: unknown = JSON.parse(String(text));
 if (!validDiagnostic(value)) throw new Error('Invalid memory diagnostics');
 return value;
}
