import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export interface Completion { text: string; model: string }
export type CompleteMemory = (ctx: ExtensionContext, systemPrompt: string, input: string, signal: AbortSignal) => Promise<Completion>;

/** Pi 0.85 public model facade reuses the active model, provider composition and auth. */
export const completeMemory: CompleteMemory = async (ctx, systemPrompt, input, signal) => {
	const model = ctx.model;
	if (!model) throw new Error("No active Pi model");
	const modelId = `${model.provider}/${model.id}`;
	// Feature check allows old Pi to fall back to local extraction.
	const registry = ctx.modelRegistry;
	if (typeof registry.complete !== "function") throw new Error("Automatic semantic evolution requires Pi 0.85+");
	const response = await registry.complete(model, {
		systemPrompt,
		messages: [{ role: "user", content: input, timestamp: Date.now() }],
	}, { signal, maxTokens: 2048, cacheRetention: "none", sessionId: randomUUID() });
	if (response.stopReason !== "stop") throw new Error("Memory completion did not finish");
	return { model: modelId, text: response.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") };
};
