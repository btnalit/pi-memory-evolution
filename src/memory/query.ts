import { clipBytes, redact } from './privacy.ts';
import { features, literalFeatures, LINE_REFERENCE, LITERALS, transformProse } from './search.ts';
import { MAX_HISTORY_TURN_BYTES, MAX_QUERY_BYTES } from './limits.ts';

export interface RecallQuery {
 query: string;
 /** Supporting subject only: the current query remains mandatory when refining it. */
 context?: string;
 mode: 'direct' | 'followup' | 'empty' | 'reset';
}
export type RecallInput = string | RecallQuery;
const RESET = /换个话题|新话题|从头开始|不是那个|不是这个|\b(?:new topic|start over|forget that|not that|not this)\b/iu;
const FOLLOWUP = /继续|接着|接上|这个|那个|它|其|呢[？?。.!]*$|\b(?:this|that|its?|their|continue|resume|what about|how about)\b/iu;
const FILLER = /为什么|什么|多少|这个|那个|这些|那些|这里|那里|换个话题|新话题|从头开始|不是那个|不是这个|不对|不行|有错|错误|好的|好吧|没错|没问题|有没有|会不会|是不是|能不能|需不需要|还能|你要|我要|记得|回忆|接着|接上|未完成|未完|没完成|刚才|以后|看下|做完|开干|开始|讨论|聊聊|帮我|一下|事情|怎么说|说过|[我你它的了呢吗吧啊呀么那这]|\b(?:go ahead|proceed|okay|ok|thanks|thank you|start over|new topic|forget that)\b/giu;
// These express the act of asking, not a subject. Query-only: stored evidence is intact.
const DISCOURSE = new Set(`有 无 还 好 也 能 会 要 是 很 都 请 先 再 与 就 对 嗯 哦 啊 说 相关 有关 还有 其他 这里 那里 自动 不会 能够 不能 系统 具体 详细 详情 信息 内容 记录 历史 当时 previously still related relevant regarding discussion discussed conversation conversations talked talking said remind reminder reminders details detail information history historical matter matters earlier already exactly know known tell us let's lets please could would does did can you our your about`.split(/\s+/u));
const WEAK = new Set(['配置', '设置', 'config', 'configuration', 'settings', 'setup']);
// Facets can refine an established subject; they cannot make a new named subject inherit
// unrelated context. This is a grammatical/attribute vocabulary, not a domain allowlist.
export const FACETS = new Set([...features('端口 认证 进度 版本 超时 价格 状态 路径 输出 输入 安装 连接 性能 错误 port auth progress version timeout price status path output input installation connection performance error')]);
// Default budget is the LIVE current-turn prompt's, not a history turn's: see MAX_QUERY_BYTES.
const clean = (text: string, budget = MAX_QUERY_BYTES) => clipBytes(redact(text), budget).trim();

/** Asking to retrieve an existing memory is not an instruction to learn a new one. */
export function isRecallQuestion(text: string): boolean {
 return /记得|回忆|\b(?:you\s+(?:still\s+)?(?:remember|recall)|remind\s+me|memories\s+(?:about|of|on|related))\b/iu.test(text);
}

export function queryFeatures(text: string): Set<string> {
 const normalized = transformProse(clean(text), prose => {
  // Remove recall-request framing, not technical subjects such as memory recall systems.
  let value = prose
   .replace(/(?:相关|有关)(?:的)?记忆/gu, ' ')
   .replace(/关于([\s\S]+?)的(?:记忆|印象)/gu, '$1')
   .replace(/\bmemories\s+(?:(?:related|relevant)\s+to|about|of|on|regarding)\b/giu, ' ')
   .replace(/\b(?:do|can|could|would|will)?\s*you\s+(?:still\s+)?recall\b/giu, ' ')
   .replace(/\bremind\s+me\b/giu, ' ');
  if (/记得|回忆/u.test(value) && !/记忆(?:系统|库|召回|检索|注入|算法)/u.test(value)) value = value.replace(/记忆/gu, ' ');
  return value.replace(FILLER, ' ');
 });
 // Keep unindexed single-character subjects on the query side as barriers rather
 // than mistaking them for a topic-less continuation. They earn no fragment matches.
 const result = features(normalized, true);
 for (const word of result) {
  if (DISCOURSE.has(word) || WEAK.has(word)) result.delete(word);
  // A qualified path is one constraint, not a second vote for its shared basename.
  if (word.startsWith('literal:') && word.includes('/')) result.delete(`literal:${word.split('/').at(-1)}`);
 }
 return result;
}

// Lines that are pasted material rather than the ask: a V8 stack frame, a unified-diff header or
// hunk, the body lines of an open hunk, and anything inside a code fence.
const FRAME = /^\s*at\s/u;
const DIFF_HEADER = /^(?:[-+]{3}\s|@@)/u;
/** A hunk header, with the body line counts it declares: `@@ -a[,b] +c[,d] @@`, a count omitted is 1. */
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u;
const DIFF_BODY = /^[-+ \\]/u;
const FENCE = /^\s*(?:```|~~~)/u;
/** Literals that arrived inside pasted material, not as the ask. A path the user types is a
 * constraint — "/srv/wrong.json database port" must not return the /srv/right.json answer — and every
 * literal used to be one, so a five-line stack trace or a diff ahead of the ask rejected every record
 * as resource-mismatch before any other gate ran; traces and diffs always contain paths. A literal
 * on a stack-frame line, a diff header or hunk line, inside a code fence, or carrying a line
 * reference (`file:3:1`) keeps its weight but is not required of every record. A path that ALSO
 * appears on an ordinary line is typed, and stays mandatory: pasting does not launder the ask. */
export function pastedLiterals(text: string): Set<string> {
 const pasted = new Set<string>(), typed = new Set<string>();
 // A hunk ends where its header says: the counts it declares are consumed by its body lines (`-`
 // against the old side, `+` against the new, a context line against both), and the line after the
 // last one is the ask again even if it starts with `-`, `+` or a space — a markdown bullet right
 // after a pasted diff is the ask, and its path must stay typed. Body shape alone decides only for
 // a hunk that is shorter than declared (a truncated paste): body-shaped lines until one that is not.
 let fenced = false, hunk = false, oldLeft = Infinity, newLeft = Infinity;
 for (const line of clean(text).split('\n')) {
  if (FENCE.test(line)) { fenced = !fenced; hunk = false; continue; }
  const header = HUNK.exec(line);
  if (header) { hunk = true; oldLeft = Number(header[1] ?? 1); newLeft = Number(header[2] ?? 1); }
  else if (DIFF_HEADER.test(line)) { hunk = true; oldLeft = newLeft = Infinity; }
  else if (hunk && (!DIFF_BODY.test(line) || (oldLeft <= 0 && newLeft <= 0))) hunk = false;
  else if (hunk) { if (line[0] === '-' || line[0] === ' ') oldLeft--; if (line[0] === '+' || line[0] === ' ') newLeft--; }
  const quoted = fenced || hunk || FRAME.test(line);
  for (const match of line.matchAll(LITERALS)) {
   // A rooted path swallows its `:3:1` into the match; a relative filename stops at its extension,
   // so the reference is what follows it on the line. Either way it is a reference, not the ask.
   const referenced = LINE_REFERENCE.test(match[0]) || /^(?::\d+){1,2}(?![\w.])/u.test(line.slice(match.index + match[0].length));
   for (const feature of literalFeatures(match[0])) (quoted || referenced ? pasted : typed).add(feature);
  }
 }
 for (const feature of typed) pasted.delete(feature);
 return pasted;
}

function advance(current: string, previous?: RecallQuery): RecallQuery {
 const terms = queryFeatures(current);
 if (RESET.test(current)) return { query: terms.size ? current : '', mode: 'reset' };
 if (!terms.size) return previous?.query ? { ...previous, mode: 'followup' } : { query: '', mode: 'empty' };
 if (previous?.query && FOLLOWUP.test(current)) {
  const prior = queryFeatures(queryText(previous));
  const subject = [...terms].filter(term => !FACETS.has(term));
  if (subject.every(term => prior.has(term))) {
   // Keep the established subject, not a growing trail of older attribute questions.
   const context = previous.context ?? previous.query;
   if (queryFeatures(context).size && context !== current) return { query: current, context, mode: 'followup' };
  }
 }
 return { query: current, mode: 'direct' };
}

/** Replay only bounded active-user context, oldest first, so chained refinements retain
 * their subject and explicit new/reset topics form barriers. No corpus or assistant text. */
export function resolveRecallQuery(prompt: string, recentUsers: readonly string[] = []): RecallQuery {
 const current = clean(prompt);
 // What the live prompt would look like as a REPLAYED turn: this is what session-context.ts
 // actually produces for it, so it is what a self-inclusion in recentUsers must compare against
 // — comparing against `current` itself would diverge for any prompt over the history budget,
 // since the two are no longer clipped to the same length, and shadow the real prior turn.
 const currentAsHistory = clean(prompt, MAX_HISTORY_TURN_BYTES);
 let previous: RecallQuery | undefined;
 for (const text of recentUsers.slice(-6)) {
  // A REPLAYED turn, not the live ask: bounded at the history budget, defensively,
  // even though the caller (session-context.ts) already enforces it at the source.
  const value = clean(text, MAX_HISTORY_TURN_BYTES);
  // Pi may already include this turn in its active context.
  if (value !== currentAsHistory) previous = advance(value, previous);
 }
 return advance(current, previous);
}

export function queryText(input: RecallInput): string {
 return typeof input === 'string' ? input : [input.query, input.context].filter(Boolean).join('\n');
}

/** String facade retained for callers that only need the resolved topic text. Runtime
 * retrieval uses the structured plan to keep current focus separate from context. */
export function recallQuery(prompt: string, recentUsers: readonly string[] = []): string {
 return queryText(resolveRecallQuery(prompt, recentUsers));
}
