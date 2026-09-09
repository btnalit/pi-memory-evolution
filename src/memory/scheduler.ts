import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeMemory, type CompleteMemory } from '../adapter/pi-api.ts';
import { modelLabel } from './diagnostics.ts';
import { evolve } from './evolution.ts';
import { failureCode } from './recovery.ts';
import type { MemoryStore, RetryMode } from './memory-store.ts';

type Model = NonNullable<ExtensionContext['model']>;
export const modelKey = (model: Model): string => modelLabel(`${model.provider}/${model.id}`);
/** Catalog lookup only: no paid probes, credential reads, or changes to the foreground model. */
export function routeCandidates(ctx: ExtensionContext, store: MemoryStore): Model[] {
 const primary = ctx.model;
 if (!primary) return [];
 if (!store.policy.crossProviderFallback) return [primary];
 const available = typeof ctx.modelRegistry?.getAvailable === 'function' ? ctx.modelRegistry.getAvailable() : [];
 const order = store.policy.fallbackModels;
 const price = (m: Model) => m.cost && m.cost.input + m.cost.output > 0 ? m.cost.input + m.cost.output : Infinity;
 const fallback = available.filter(m => m.provider !== primary.provider && m.input?.includes('text') && ((m as Model & { output?: string[] }).output?.includes('text') ?? true)
  && (!order.length || order.includes(modelKey(m))))
  .sort((a,b) => (order.length ? order.indexOf(modelKey(a)) - order.indexOf(modelKey(b)) : price(a) - price(b))
   || (a.reasoning === b.reasoning ? 0 : a.reasoning ? 1 : -1) || modelKey(a).localeCompare(modelKey(b)));
 return [primary, ...[...new Map(fallback.map(m => [modelKey(m),m])).values()].slice(0,32)];
}
function contextFor(ctx: ExtensionContext, model: Model): ExtensionContext {
 const child = Object.create(ctx) as ExtensionContext;
 Object.defineProperty(child, 'model', { value: model });
 return child;
}
/** At most two immediate attempts. Delayed retries are persisted, never sleeping in the queue. */
export async function evolveRouted(store: MemoryStore, id: string, ctx: ExtensionContext, signal: AbortSignal,
 complete: CompleteMemory = completeMemory, retry: RetryMode = false, timeoutMs = store.policy.timeoutMs): Promise<boolean> {
 const candidates = routeCandidates(ctx, store);
 // Preserve the single-model/old-host error path and dependency-injected test seam.
 if (!candidates.length) return evolve(store, id, ctx, signal, complete, retry, timeoutMs);
 const attempted = new Set<string>();
 let lastError: unknown;
 for (let pass = 0; pass < (retry === true ? 1 : 2); pass++) {
  signal.throwIfAborted();
  const info = store.routingInfo(id);
  const candidate = candidates.find(m => !attempted.has(modelKey(m))
   && (retry === true || (store.routeAvailable(modelKey(m), m.provider)
    && !(info.outputFailures >= 2 && info.model === modelKey(m) && ['invalid_output','output_limit'].includes(info.error))
    && (info.models.includes(modelKey(m)) || info.models.length < store.policy.sourceModels))));
  if (!candidate) break;
  attempted.add(modelKey(candidate));
  try {
   // Only a known route failure justifies bypassing source backoff for an alternate model.
   const result = await evolve(store, id, contextFor(ctx, candidate), signal, complete, pass ? 'fallback' : retry, timeoutMs);
   if (result) return true;
   // A concurrent claim, terminal source or shared budget rejection cannot authorize another call.
   break;
  } catch (error) {
   lastError = error;
   const code = failureCode(error, signal);
   const reroute = ['auth','quota','rate_limit','request','context_limit'].includes(code)
    || (['provider','timeout','invalid_output','output_limit','interrupted'].includes(code)
     && !store.routeAvailable(modelKey(candidate), candidate.provider));
   if (!reroute || retry === true || signal.aborted) throw error;
  }
 }
 store.checked(id); // Round-robin past sources waiting on unavailable routes, without consuming attempts.
 if (lastError) throw lastError;
 return false;
}
