import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { EvolutionError, type FailureCode } from "../memory/recovery.ts";
import { modelLabel, OUTPUT_PROTOCOL_VERSION, type Diagnostic } from '../memory/diagnostics.ts';
import { diagnosticFetch, httpFailure, observeStatus, observeStructuredError, OBSERVABLE_HTTP_APIS } from './http-diagnostics.ts';

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
	// The model's own ceiling, never a smaller number of ours. A caller cap is spent on reasoning
	// before any answer is written, so an invented ceiling can leave a thinking model with no room
	// to answer at all. This one cannot: it is the most the model could ever emit. Not every adapter
	// substitutes a default when the field is omitted, so it is sent explicitly rather than left out.
	const maxTokens = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : undefined;
	try {
		const response = await registry.complete(model, {
			systemPrompt,
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
		}, { signal, ...(maxTokens === undefined ? {} : { maxTokens }), timeoutMs: 120_000, maxRetries: 0, cacheRetention: "none", sessionId: randomUUID(),
			...(OBSERVABLE_HTTP_APIS.has(model.api) ? { fetch: diagnosticFetch(diagnostic, signal) } : {}),
			// A request-local HTTP path exposes failed statuses; the foreground transport is unchanged.
			...(model.api === 'openai-codex-responses' ? { transport: 'sse' as const } : {}),
			onResponse: (response: { status: number; headers?: Record<string, string> }) => observeStatus(diagnostic, response.status, response.headers) });
		const usage = response.usage;
		if (usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0)
			&& usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
			diagnostic.inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			diagnostic.outputTokens = usage.output;
			// A subset of output, when the provider breaks it out: the one signal that says an empty
			// or truncated reply was thinking, not a broken model.
			if (Number.isSafeInteger(usage.reasoning) && usage.reasoning! >= 0) diagnostic.reasoningTokens = usage.reasoning;
			if (Number.isFinite(usage.cost?.total) && usage.cost.total >= 0) diagnostic.reportedUsd = usage.cost.total;
		}
		if (['refusal', 'sensitive', 'content_filter', 'incomplete.content_filter', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(response.rawStopReason ?? ''))
			throw new EvolutionError('safety', { ...diagnostic, errorClass: 'safety' });
		if (['stop', 'length', 'error', 'aborted', 'toolUse'].includes(response.stopReason)) diagnostic.stopReason = response.stopReason as Diagnostic['stopReason'];
		if (response.stopReason !== 'stop') {
			observeStructuredError(diagnostic, response.errorMessage);
			const code: FailureCode = response.stopReason === 'length' ? 'output_limit' : httpFailure(diagnostic);
			throw new EvolutionError(code, { ...diagnostic, reason: 'abnormal_stop' });
		}
		return { model: modelId, text: responseText(response.content, diagnostic), diagnostic };
	} catch (error) {
		if (error instanceof EvolutionError) throw error;
		throw new EvolutionError(httpFailure(diagnostic), { ...diagnostic,
			reason: diagnostic.httpStatus && diagnostic.httpStatus >= 400 ? 'http_error' : 'request_failed' });
	}
};
