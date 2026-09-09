import { type Claim } from './extractor.ts';
import { MAX_CLAIMS, MAX_CLAIM_CHARS, MIN_CLAIM_CHARS } from './limits.ts';
import { MEMORY_KINDS } from './memory-store.ts';
import { EvolutionError } from './recovery.ts';
import { OUTPUT_PROTOCOL_VERSION, type Diagnostic, type DiagnosticReason } from './diagnostics.ts';
import { validSearchTerms } from './search.ts';

/** One bounded, unambiguous JSON value; no JSON repair or extraction from nested broken output. */
function jsonValue(text: string, fail: (reason: DiagnosticReason) => never): unknown {
 const body = text.trim();
 if (!body) return fail('empty_text');
 try { return JSON.parse(body); } catch { /* Permit only a single complete envelope below. */ }
 // Starting a JSON document and then truncating/corrupting it cannot fall back to an inner claim.
 if (/^[{[]/u.test(body)) return fail('json_syntax');
 const start = body.search(/[{[]/u);
 if (start < 0) return fail('json_syntax');
 const stack: string[] = [];
 let quoted = false, escaped = false, end = -1;
 for (let i = start; i < body.length; i++) {
  const c = body[i];
  if (quoted) {
   if (escaped) escaped = false;
   else if (c === '\\') escaped = true;
   else if (c === '"') quoted = false;
   continue;
  }
  if (c === '"') quoted = true;
  else if (c === '{' || c === '[') {
   stack.push(c);
   if (stack.length > 64) return fail('json_syntax');
  } else if (c === '}' || c === ']') {
   if (stack.pop() !== (c === '}' ? '{' : '[')) return fail('json_syntax');
   if (!stack.length) { end = i + 1; break; }
  }
 }
 if (end < 0) return fail('json_syntax');
 let prefix = body.slice(0, start), suffix = body.slice(end);
 // A single matching fence is presentation only. Extra fences/containers are ambiguous.
 const fenced = /```(?:json)?\s*$/iu.test(prefix);
 if (fenced) {
  prefix = prefix.replace(/```(?:json)?\s*$/iu, '');
  if (!/^\s*```/u.test(suffix)) return fail('json_syntax');
  suffix = suffix.replace(/^\s*```/u, '');
 }
 if (/[{}[\]]|```/u.test(prefix + suffix)) return fail('ambiguous_json');
 try { return JSON.parse(body.slice(start, end)); } catch { return fail('json_syntax'); }
}

export function parseMemoryOutput(text: string): { claims: Claim[]; diagnostic: Diagnostic } {
 const diagnostic: Diagnostic = { protocol: OUTPUT_PROTOCOL_VERSION, outputBytes: Buffer.byteLength(text) };
 const fail = (reason: DiagnosticReason, field = 'result', actual?: number): never => {
  throw new EvolutionError('invalid_output', { ...diagnostic, reason, field, ...(actual === undefined ? {} : { actual }) });
 };
 if (diagnostic.outputBytes! > 64_000) fail('output_too_large');
 const value = jsonValue(text, fail);
 if (!value || typeof value !== 'object' || Array.isArray(value)) fail('result_shape');
 const root = value as Record<string, unknown>;
 if (Object.keys(root).some(k => k !== 'memories')) fail('unknown_field');
 if (!Array.isArray(root.memories)) fail('result_shape', 'memories');
 const memories = root.memories as unknown[];
 if (memories.length > MAX_CLAIMS) fail('too_many_claims', 'memories', memories.length);
 let ignoredAliases = 0;
 const claims = memories.map((claim, index): Claim => {
  const field = `memories[${index}]`;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) fail('claim_shape', field);
  const c = claim as Record<string, unknown>;
  if (Object.keys(c).some(k => !['kind', 'content', 'replaces', 'searchTerms'].includes(k))) fail('unknown_field', field);
  if (!MEMORY_KINDS.has(c.kind as Claim['kind'])) fail('invalid_kind', `${field}.kind`);
  if (typeof c.content !== 'string') fail('content_type', `${field}.content`);
  const content = (c.content as string).trim();
  if (content.length < MIN_CLAIM_CHARS || content.length > MAX_CLAIM_CHARS) fail('content_length', `${field}.content`, content.length);
  if (c.replaces !== undefined && (typeof c.replaces !== 'string' || !c.replaces.trim())) fail('invalid_replaces', `${field}.replaces`);
  // Aliases are optional recall hints, never authority. Drop, don't repair or echo, invalid values.
  const searchTerms: string[] = [];
  if (c.searchTerms !== undefined) {
   if (!Array.isArray(c.searchTerms)) ignoredAliases++;
   else for (const term of c.searchTerms) {
    if (!validSearchTerms([term]) || !validSearchTerms([...searchTerms, term])) { ignoredAliases++; continue; }
    if (!searchTerms.includes(term as string)) searchTerms.push(term as string);
   }
  }
  return { kind: c.kind as Claim['kind'], content,
   ...(c.replaces === undefined ? {} : { replaces: c.replaces as string }),
   ...(searchTerms.length ? { searchTerms } : {}) };
 });
 if (ignoredAliases) diagnostic.ignoredAliases = ignoredAliases;
 return { claims, diagnostic };
}
