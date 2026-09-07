import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { EVOLUTION_MAX_TOKENS, EvolutionError } from "../memory/recovery.ts";

export interface Completion { text: string; model: string }
export type CompleteMemory = (ctx: ExtensionContext, systemPrompt: string, input: string, signal: AbortSignal) => Promise<Completion>;

/** Pi 0.85 public model facade reuses the active model, provider composition and auth. */
export const completeMemory: CompleteMemory = async (ctx, systemPrompt, input, signal) => {
	const model = ctx.model;
	if (!model) throw new EvolutionError("unavailable");
	const modelId = `${model.provider}/${model.id}`;
	// Feature check allows old Pi to fall back to local extraction.
	const registry = ctx.modelRegistry;
	if (typeof registry.complete !== "function") throw new EvolutionError("unavailable");
	const maxTokens = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
		? Math.min(EVOLUTION_MAX_TOKENS, model.maxTokens) : EVOLUTION_MAX_TOKENS;
	const response = await registry.complete(model, {
		systemPrompt,
		messages: [{ role: "user", content: input, timestamp: Date.now() }],
	}, { signal, maxTokens, cacheRetention: "none", sessionId: randomUUID() });
	if (response.stopReason !== "stop") throw new EvolutionError(response.stopReason === "length" ? "output_limit" : "provider");
	return { model: modelId, text: response.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") };
};
