import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { EVOLUTION_MAX_TOKENS, EvolutionError, type FailureCode } from "../memory/recovery.ts";
import { modelLabel, OUTPUT_PROTOCOL_VERSION, type Diagnostic } from '../memory/diagnostics.ts';

export interface Completion { text: string; model: string; diagnostic?: Diagnostic }

/** Only interpret the documented v1 phase envelope; opaque provider signatures stay opaque. */
function phase(signature?: string): { phase?: string; id?: string } {
	if (!signature) return {};
	try {
		const value = JSON.parse(signature);
		return value?.v === 1 && typeof value.id === 'string' && ['commentary', 'final_answer'].includes(value.phase)
			? { phase: value.phase, id: value.id } : {};
	} catch { return {}; }
}
function responseText(content: { type: string; text?: string; textSignature?: string }[], diagnostic: Diagnostic): string {
	if (content.some(c => c.type === 'toolCall')) throw new EvolutionError('invalid_output', { ...diagnostic, reason: 'unexpected_tool' });
	const blocks = content.filter(c => c.type === 'text').map(c => ({ ...c, ...phase(c.textSignature) }));
	const finals = blocks.filter(c => c.phase === 'final_answer');
	const comments = blocks.filter(c => c.phase === 'commentary');
	Object.assign(diagnostic, { textBlocks: blocks.length, finalBlocks: finals.length, commentaryBlocks: comments.length });
	if (new Set(finals.map(c => c.id)).size > 1) throw new EvolutionError('invalid_output', { ...diagnostic, reason: 'ambiguous_final' });
	const selected = finals.length ? finals : blocks.filter(c => c.phase !== 'commentary');
	if (!selected.length && comments.length) throw new EvolutionError('invalid_output', { ...diagnostic, reason: 'missing_final' });
	const text = selected.map(c => c.text ?? '').join('');
	if (!text.trim()) throw new EvolutionError('invalid_output', { ...diagnostic, reason: 'empty_text' });
	return text;
}
function providerCode(status?: number): FailureCode {
	return status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit'
		: status === 400 || status === 404 || status === 422 ? 'request' : 'provider';
}
export type CompleteMemory = (ctx: ExtensionContext, systemPrompt: string, input: string, signal: AbortSignal) => Promise<Completion>;

/** Pi 0.85 public model facade reuses the active model, provider composition and auth. */
export const completeMemory: CompleteMemory = async (ctx, systemPrompt, input, signal) => {
	const model = ctx.model;
	if (!model) throw new EvolutionError("unavailable");
	const modelId = modelLabel(`${model.provider}/${model.id}`);
	const diagnostic: Diagnostic = { protocol: OUTPUT_PROTOCOL_VERSION, model: modelId };
	// Feature check allows old Pi to fall back to local extraction.
	const registry = ctx.modelRegistry;
	if (typeof registry.complete !== "function") throw new EvolutionError("unavailable");
	const maxTokens = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
		? Math.min(EVOLUTION_MAX_TOKENS, model.maxTokens) : EVOLUTION_MAX_TOKENS;
	try {
		const response = await registry.complete(model, {
			systemPrompt,
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
		}, { signal, maxTokens, maxRetries: 0, cacheRetention: "none", sessionId: randomUUID(),
			onResponse: (response: { status: number }) => { if (Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599) diagnostic.httpStatus = response.status; } });
		if (['stop', 'length', 'error', 'aborted', 'toolUse'].includes(response.stopReason)) diagnostic.stopReason = response.stopReason as Diagnostic['stopReason'];
		if (response.stopReason !== 'stop') {
			const code: FailureCode = response.stopReason === 'length' ? 'output_limit' : providerCode(diagnostic.httpStatus);
			throw new EvolutionError(code, { ...diagnostic, reason: 'abnormal_stop' });
		}
		return { model: modelId, text: responseText(response.content, diagnostic), diagnostic };
	} catch (error) {
		if (error instanceof EvolutionError) throw error;
		throw new EvolutionError(providerCode(diagnostic.httpStatus), { ...diagnostic,
			reason: diagnostic.httpStatus && diagnostic.httpStatus >= 400 ? 'http_error' : 'request_failed' });
	}
};
