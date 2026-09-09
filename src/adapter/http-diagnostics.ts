import type { Diagnostic } from '../memory/diagnostics.ts';
import type { FailureCode } from '../memory/recovery.ts';

// Only adapters verified to support request-local fetch injection. Never monkey-patch global fetch,
// replace auth/proxy composition, or pass this option to SDKs (e.g. Google/Bedrock) that reject it.
export const OBSERVABLE_HTTP_APIS = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses',
 'openai-codex-responses', 'anthropic-messages', 'mistral-conversations']);
const ERROR_CODES: Record<string, FailureCode> = {
 insufficient_quota: 'quota', quota_exceeded: 'quota', billing_hard_limit_reached: 'quota', insufficient_balance: 'quota',
 usage_limit_reached: 'quota', usage_not_included: 'quota',
 context_length_exceeded: 'context_limit', max_context_length_exceeded: 'context_limit',
 content_filter: 'safety', content_policy_violation: 'safety', safety: 'safety',
};
export function httpFailure(d: Diagnostic): FailureCode {
 if (d.errorClass) return d.errorClass;
 return d.httpStatus === 401 || d.httpStatus === 403 ? 'auth' : d.httpStatus === 402 ? 'quota'
  : d.httpStatus === 429 ? 'rate_limit' : d.httpStatus === 408 ? 'timeout'
  : [400, 404, 422].includes(d.httpStatus ?? 0) ? 'request' : 'provider';
}
export function observeStatus(d: Diagnostic, status: number, headers?: Record<string, string>, now = Date.now()): void {
 if (Number.isSafeInteger(status) && status >= 100 && status <= 599) d.httpStatus = status;
 const retry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
 if (retry) {
  const delay = /^\d+(?:\.\d+)?$/u.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - now;
  // Preserve long waits (up to the JS timestamp range); never shorten a server's requested pause.
  if (Number.isFinite(delay) && delay > 0 && now + delay <= 8_640_000_000_000_000) d.retryAfterMs = Math.ceil(delay);
 }
}
/** Some SDKs (notably Google) return a complete JSON error document as errorMessage.
 * Decode only that structural shape, not status-looking numbers or prose substrings. */
export function observeStructuredError(d: Diagnostic, message?: string): void {
 if (!message || Buffer.byteLength(message) > 8192) return;
 try {
  const value = JSON.parse(message);
  const status = value?.error?.code ?? value?.status;
  if (d.httpStatus === undefined && Number.isInteger(status) && status >= 400 && status <= 599) observeStatus(d, status);
  const code = [value?.error?.code, value?.error?.type, value?.code].find(c => typeof c === 'string' && Object.hasOwn(ERROR_CODES, c));
  if (code) d.errorClass = ERROR_CODES[code] as Diagnostic['errorClass'];
 } catch { /* Opaque provider errors stay unknown; no raw text is retained or guessed from. */ }
}
export function diagnosticFetch(d: Diagnostic, signal: AbortSignal): typeof globalThis.fetch {
 const underlying = globalThis.fetch;
 return async (input, init) => {
  const response = await underlying(input, init);
  observeStatus(d, response.status, Object.fromEntries(response.headers));
  if (response.status < 400) return response;
  // Inspect only a bounded error JSON clone, without delaying the original body indefinitely.
  // No free-form message, header, URL, credential or body is copied into the diagnostic.
  const reader = response.clone().body?.getReader();
  if (!reader) return response;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inspect = async () => {
   const chunks: Uint8Array[] = []; let bytes = 0;
   while (!signal.aborted) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength; if (bytes > 8192) return;
    chunks.push(value);
   }
   if (signal.aborted) return;
   try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const code = [value?.error?.code, value?.error?.type, value?.code].find(c => typeof c === 'string' && Object.hasOwn(ERROR_CODES, c));
    if (code) {
     d.errorClass = ERROR_CODES[code] as Diagnostic['errorClass'];
     const reset = value?.error?.resets_at;
     if (d.errorClass === 'quota' && Number.isSafeInteger(reset) && reset * 1000 > Date.now() && reset * 1000 <= 8_640_000_000_000_000)
      d.retryAfterMs = Math.max(d.retryAfterMs ?? 0, reset * 1000 - Date.now());
    }
   } catch { /* Unknown/HTML/oversized bodies retain only the status. */ }
  };
  try { await Promise.race([inspect(), new Promise<void>(resolve => { timer = setTimeout(resolve, 200); })]); }
  catch { /* Diagnostics must not change the provider's response handling. */ }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  return response;
 };
}
