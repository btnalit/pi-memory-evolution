import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Extension policy only: model catalog, credentials and the default model belong to Pi. */
export interface RoutingPolicy {
 crossProviderFallback: boolean;
 fallbackModels: string[];
 callsPerHour: number;
 sourceCalls: number;
 sourceModels: number;
 timeoutMs: number;
 sourceTimeMs: number;
 dailyEstimatedUsd: number | null;
}
/** Fixed and safe to show a user: it names the file, never its contents. */
export const INVALID_POLICY_MESSAGE = 'Invalid recovery.json';
export const DEFAULT_POLICY: RoutingPolicy = {
 crossProviderFallback: true, fallbackModels: [], callsPerHour: 20, sourceCalls: 4, sourceModels: 2,
 timeoutMs: 120_000, sourceTimeMs: 300_000, dailyEstimatedUsd: null,
};
export function loadRoutingPolicy(dir: string): RoutingPolicy {
 let value: unknown;
 try { const text = readFileSync(join(dir, 'recovery.json'), 'utf8'); if (Buffer.byteLength(text) > 8192) throw new Error(); value = JSON.parse(text); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_POLICY, fallbackModels: [] }; throw new Error(INVALID_POLICY_MESSAGE); }
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_POLICY_MESSAGE);
 const p = { ...DEFAULT_POLICY, ...value } as RoutingPolicy;
 const bounds = { callsPerHour: [1, 1000], sourceCalls: [1, 8], sourceModels: [1, 3], timeoutMs: [1000, 120_000], sourceTimeMs: [1000, 600_000] };
 if (Object.keys(value).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || typeof p.crossProviderFallback !== 'boolean'
  || !Array.isArray(p.fallbackModels) || p.fallbackModels.length > 16 || !p.fallbackModels.every(m => typeof m === 'string' && m.length <= 200 && /^[^\s/]+\/.+$/u.test(m))
  || Object.entries(bounds).some(([k, [min, max]]) => !Number.isSafeInteger(p[k as keyof typeof bounds]) || p[k as keyof typeof bounds] < min || p[k as keyof typeof bounds] > max)
  || (p.dailyEstimatedUsd !== null && (!Number.isFinite(p.dailyEstimatedUsd) || p.dailyEstimatedUsd <= 0 || p.dailyEstimatedUsd > 1000))) throw new Error(INVALID_POLICY_MESSAGE);
 return p;
}
