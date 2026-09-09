import type { DurableMemory } from './memory-store.ts';
import type { OperationResource } from '../adapter/operations.ts';
import { queryFeatures, queryText, type RecallInput } from './query.ts';
import { features } from './search.ts';
import { clipBytes, redact } from './privacy.ts';

const GENERIC_NAMES = new Set(['work','home','tmp','src','test','tests','docs','project','projects','repo','repository','node_modules']);
const ESCAPE = /[.*+?^${}()|[\]\\]/gu;
const genericTopic = new Set(['优化','完善','排查','任务','工作','实现','完成','进行','继续','接着','core','requirements','requirement','implement','optimize','finish']);
const pending = /待|尚未|未完成|未提交|未推送|未验证|进行中|仍在|\b(?:pending|not (?:yet |final |fully )?(?:committed|pushed|accepted|verified|complete)|in (?:progress|validation)|validation\/tuning)\b/iu;
function names(text: string, name: string): boolean {
 return name.length >= 3 && !GENERIC_NAMES.has(name.toLowerCase())
  && new RegExp(`(?<![\\p{L}\\p{N}_-])${name.replace(ESCAPE,'\\$&')}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
}

/** Update nomination is deliberately separate from answering a question. It retains
 * affected/stale state candidates, not only top-2 near-duplicate answer snippets.
 * Resource identity nominates; it never verifies success or authorizes cross-origin writes. */
export function nominateProgress(memories: readonly DurableMemory[], input: { scope: string; query: RecallInput; resources: readonly OperationResource[] }, limit = 8) {
 const topic = new Set([...queryFeatures(queryText(input.query))].filter(w => !genericTopic.has(w)));
 const resources = [...new Map(input.resources.map(r => [r.path, r])).values()].slice(0,16);
 const rows = memories.map(memory => {
  let reason = memory.scope !== input.scope ? 'other-origin' : memory.kind !== 'project_state' ? 'not-project-state'
   : memory.layer === 'pinned' ? 'pinned' : ['forgotten','conflicted'].includes(memory.status) || memory.feedback?.accuracy?.verdict === 'incorrect' ? 'suppressed' : '';
  const body = features(memory.content), aliases = features((memory.searchTerms ?? []).join(' '));
  let resourceScore = 0, resourceReason = '', resourceConflict = false;
  for (const resource of resources) {
   const path = resource.path; // Do not merge case-distinct files/directories on the host.
   const literals = [...body].filter(w => w.startsWith('literal:/')).map(w => w.slice(8));
   const exact = literals.some(l => l === path || (resource.kind === 'directory' && l.startsWith(path + '/')));
   const named = resource.kind === 'directory' && names(memory.content, resource.name);
   // Equal basenames of explicitly different absolute resources are not identity.
   const conflictingPath = literals.some(l => names(l, resource.name) && l !== path && !l.startsWith(path + '/'));
   resourceConflict ||= conflictingPath;
   const score = exact ? 60 : named && !conflictingPath ? 50 : 0;
   if (score > resourceScore) { resourceScore = score; resourceReason = exact ? 'operation-resource' : 'explicit-project-name'; }
  }
  const matched = [...topic].filter(w => body.has(w) || aliases.has(w));
  const coverage = topic.size ? matched.length / topic.size : 0;
  const topical = matched.length >= 2 || (topic.size === 1 && matched.length === 1);
  const relevant = resourceScore > 0 || (!resourceConflict && topical && coverage >= 0.3);
  if (!reason) reason = relevant ? resourceReason || 'user-topic' : resourceConflict ? 'resource-conflict' : 'unrelated';
  const eligible = relevant && ['operation-resource','explicit-project-name','user-topic'].includes(reason);
  const score = resourceScore + Math.min(matched.length, 8) * 2 + (eligible && pending.test(memory.content) ? 20 : 0);
  return { memory, reason, eligible, score };
 });
 rows.sort((a,b) => Number(b.eligible)-Number(a.eligible) || b.score-a.score
  || Date.parse(a.memory.updatedAt)-Date.parse(b.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
 const selected = rows.filter(r => r.eligible).slice(0,Math.max(0,Math.min(8,limit))).map(r => r.memory.id);
 return { targets: selected, diagnostics: { mode: 'operation-and-topic', resources: resources.map(r => ({ path: clipBytes(redact(r.path),160), kind:r.kind })),
  eligible: rows.filter(r=>r.eligible).length, selected, candidates: rows.slice(0,16).map(r=>({id:clipBytes(redact(r.memory.id),120),score:r.score,reason:r.eligible&&!selected.includes(r.memory.id)?'candidate-limit':r.reason})) } };
}
