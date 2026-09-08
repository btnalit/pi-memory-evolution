import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { clipBytes, fingerprint, redact } from '../memory/privacy.ts';
import { isInternalObservation, operationPriority, operationResources, type OperationResource } from './operations.ts';
type Message = SessionMessageEntry['message'];
const WORK = /提交|推送|完成|修复|实现|安装|更新|迁移|部署|测试|验证|审查|排查|检查|构建|运行|优化|完善|继续|接着|\b(?:commit|push|finish|fix|implement|install|update|migrate|deploy|tests?|verify|review|optimize|run|check|inspect|investigate|build|continue|resume)\b/iu;
const ALLOWED = new Set(['bash','write','edit','read','grep','find','ls']);
export interface ProgressDiagnostics {
 reason: string; scanned: number; scanLimited: boolean; linked: number; ignored: number; kept: number; omitted: number; completion?: string;
}
export interface Observation { tool: string; arguments: string; output: string; isError: boolean }

function text(content: unknown): string {
 return typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
}
function preview(value: string, budget: number): string {
 const clean = redact(value);
 if (Buffer.byteLength(clean) <= budget) return clean;
 const tail = [...clipBytes([...clean].reverse().join(''), Math.floor((budget - 5) / 2))].reverse().join('');
 return clipBytes(clean, Math.floor((budget - 5) / 2)) + '\n…\n' + tail;
}

/** Preserve important linked operations across long turns, including operations completed
 * before an interrupted final response. A partial turn is NOT a completed task. */
export function inspectProgress(messages: readonly Message[], sessionId: string, options: { cwd?: string; stateDir?: string } = {}) {
 const diagnostics: ProgressDiagnostics = { reason: 'no-user', scanned: 0, scanLimited: false, linked: 0, ignored: 0, kept: 0, omitted: 0 };
 const none = (reason: string) => ({ diagnostics: { ...diagnostics, reason }, observation: undefined });
 const start = messages.findLastIndex(message => message.role === 'user');
 if (start < 0) return none('no-user');
 const user = messages[start]; const userText = text('content' in user ? user.content : '');
 if (!WORK.test(userText) || !Number.isFinite(user.timestamp)) return none('not-work-request');
 const turn = messages.slice(start + 1);
 const last = turn.at(-1);
 if (last?.role !== 'assistant' || !['stop','error','aborted'].includes(last.stopReason)
  || !Number.isFinite(last.timestamp) || last.timestamp < user.timestamp) return none('unfinished-response');
 const completion = last.stopReason === 'stop' ? 'completed' : 'interrupted';
 diagnostics.completion = completion;
 diagnostics.scanned = Math.min(turn.length, 4096); diagnostics.scanLimited = turn.length > 4096;
 const calls = new Map<string, { name: string; args: string; priority: number; resources: OperationResource[] }>();
 const seen = new Set<string>();
 const linked: { item: Observation; priority: number; order: number; resources: OperationResource[] }[] = [];
 for (const message of turn.slice(-4096)) {
  if (message.role === 'assistant') for (const part of message.content) {
   if (part.type !== 'toolCall') continue;
   const args = part.arguments ?? {};
   const operation = preview(String(args.command ?? args.path ?? args.file_path ?? args.filePath ?? ''), 8192);
   if (!ALLOWED.has(part.name) || isInternalObservation(part.name, operation, options.stateDir)) { diagnostics.ignored++; continue; }
   calls.set(part.id, { name: part.name, args: preview(operation, 1024), priority: operationPriority(part.name, operation),
    resources: operationResources(part.name, operation, options.cwd ?? '/') });
  }
  if (message.role === 'toolResult') {
   const call = calls.get(message.toolCallId);
   if (!call || call.name !== message.toolName || seen.has(message.toolCallId)) continue;
   seen.add(message.toolCallId); diagnostics.linked++;
   linked.push({ item: { tool: call.name, arguments: call.args, output: preview(text(message.content), 2048), isError: message.isError !== false },
    priority: call.priority, order: linked.length, resources: call.resources });
  }
 }
 if (!linked.some(item => item.priority > 0)) return none('no-work-observation');
 // Publication/test results outrank routine edits/inspection, irrespective of position.
 // Keep chronology in the final payload so the model can distinguish earlier failures.
 const selected = [...linked].sort((a,b) => b.priority-a.priority || b.order-a.order).slice(0,8).sort((a,b) => a.order-b.order);
 const selectedResources = () => [...new Map([...selected].sort((a,b)=>b.priority-a.priority).flatMap(item=>item.resources).map(item=>[item.path,item])).values()].slice(0,16);
 const modelResources = () => selectedResources().filter(r=>Buffer.byteLength(r.path)<=512).slice(0,8);
 const payload = { request: preview(userText, 2048), completion, observations: selected.map(item => item.item),
  operationResources: modelResources(), omittedObservations: linked.length-selected.length, scanLimited: diagnostics.scanLimited,
  assistantReport: completion === 'completed' ? preview(text(last.content), 2048) : '' };
 while (Buffer.byteLength(JSON.stringify(payload)) > 28_000 && selected.length > 1) {
  const least = selected.reduce((best, item, i) => item.priority < selected[best].priority ? i : best, 0);
  selected.splice(least, 1); payload.observations.splice(least, 1);
  payload.operationResources = modelResources(); payload.omittedObservations = linked.length-selected.length;
 }
 const content = JSON.stringify(payload);
 const resources = selectedResources();
 diagnostics.reason = 'observed'; diagnostics.kept = selected.length; diagnostics.omitted = linked.length-selected.length;
 return { diagnostics, observation: { id: `progress:${sessionId}:${user.timestamp}:${fingerprint(content)}`, kind: 'progress' as const,
  createdAt: new Date(last.timestamp).toISOString(), content, userText: preview(userText, 2048), resources,
  queryHints: selected.map(item => item.item.arguments).join('\n') } };
}

export function progressObservation(messages: readonly Message[], sessionId: string, options: { cwd?: string; stateDir?: string } = {}) {
 return inspectProgress(messages, sessionId, options).observation;
}
