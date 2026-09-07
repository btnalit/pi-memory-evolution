import { clipBytes, redact } from './privacy.ts';
import { features, transformProse } from './search.ts';

export interface RecallQuery {
 query: string;
 /** Supporting subject only: the current query remains mandatory when refining it. */
 context?: string;
 mode: 'direct' | 'followup' | 'empty' | 'reset';
}
export type RecallInput = string | RecallQuery;
const RESET = /换个话题|新话题|从头开始|不是那个|不是这个|\b(?:new topic|start over|forget that|not that|not this)\b/iu;
const FOLLOWUP = /继续|接着|接上|这个|那个|它|其|呢[？?。.!]*$|\b(?:this|that|its?|their|continue|resume|what about|how about)\b/iu;
const FILLER = /为什么|什么|这个|那个|这些|那些|这里|那里|换个话题|新话题|从头开始|不是那个|不是这个|不对|不行|有错|错误|好的|好吧|没错|没问题|有没有|会不会|是不是|能不能|需不需要|还能|你要|我要|记得|回忆|接着|接上|未完成|未完|没完成|刚才|以后|看下|做完|开干|开始|讨论|聊聊|帮我|一下|事情|怎么说|说过|[我你它的了呢吗吧啊呀么那这]|\b(?:go ahead|proceed|okay|ok|thanks|thank you|start over|new topic|forget that)\b/giu;
// These express the act of asking, not a subject. Query-only: stored evidence is intact.
const DISCOURSE = new Set(`有 无 还 好 也 能 会 要 是 很 都 请 先 再 与 就 对 嗯 哦 啊 说 相关 有关 还有 其他 这里 那里 自动 不会 能够 不能 系统 具体 详细 详情 信息 内容 记录 历史 当时 previously still related relevant regarding discussion discussed conversation conversations talked talking said remind reminder reminders details detail information history historical matter matters earlier already exactly know known tell us let's lets please could would does did can you our your about`.split(/\s+/u));
const WEAK = new Set(['配置', '设置', 'config', 'configuration', 'settings', 'setup']);
// Facets can refine an established subject; they cannot make a new named subject inherit
// unrelated context. This is a grammatical/attribute vocabulary, not a domain allowlist.
export const FACETS = new Set([...features('端口 认证 进度 版本 超时 价格 状态 路径 输出 输入 安装 连接 性能 错误 port auth progress version timeout price status path output input installation connection performance error')]);
const clean = (text: string) => clipBytes(redact(text), 2048).trim();

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
 let previous: RecallQuery | undefined;
 for (const text of recentUsers.slice(-6)) {
  const value = clean(text);
  // Pi may already include this turn in its active context.
  if (value !== current) previous = advance(value, previous);
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
