import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isSubagentProcess } from "./child-process.ts";
import { MemoryStore, type MemoryAction } from "./memory/memory-store.ts";
import { selectRelevantMemories } from "./memory/retriever.ts";
import { buildRuntimeDigest } from "./injector/digest.ts";
import { evolve } from "./memory/evolution.ts";
import { fingerprint, redact } from "./memory/privacy.ts";
import { completeMemory, type CompleteMemory } from "./adapter/pi-api.ts";

export interface MemoryEvolutionDependencies {
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	complete?: CompleteMemory;
	/** Tests can exercise timeout without waiting 30 seconds. */
	timeoutMs?: number;
}
const MEMORY_CUE = /记住|偏好|更正|纠正|应该改成|改为|不对|以后|不要|\b(?:remember|prefer|correction|instead)\b/iu;

/** Capture → automatic memory update → scoped recall. No proposals or approval parser. */
export default async function memoryEvolution(pi: ExtensionAPI, dependencies: MemoryEvolutionDependencies = {}): Promise<void> {
	if (!pi || typeof pi.on !== "function" || isSubagentProcess(dependencies.env ?? process.env)) return;
	// Resolve Pi's public path only in the host, not in isolated dependency-injected tests.
	const stateDir = dependencies.stateDir ?? join((await import("@earendil-works/pi-coding-agent")).getAgentDir(), "agent-suite", "memory-evolution");
	let store: MemoryStore | undefined;
	const getStore = () => store ??= new MemoryStore(stateDir);
	const lifetime = new AbortController();
	let work = Promise.resolve();
	let lastError = "";
	let warned = false;
	const report = (ctx: ExtensionContext) => {
		// Do not log exception strings: provider errors can contain credentials or source text.
		lastError = "Memory operation failed; local records retained. Use /memory status and /memory evolve to retry.";
		if (!warned && ctx.hasUI) {
			warned = true;
			try { ctx.ui.notify(lastError, "warning"); } catch { /* UI errors must not break shutdown. */ }
		}
	};
	const guard = <T, R>(fn: (event: T, ctx: ExtensionContext) => R | Promise<R>) => async (event: T, ctx: ExtensionContext): Promise<R | undefined> => {
		if (lifetime.signal.aborted) return;
		try { return await fn(event, ctx); } catch { report(ctx); return; }
	};
	const enqueue = (id: string, ctx: ExtensionContext, retry = false) => {
		work = work.then(async () => {
			if (lifetime.signal.aborted) return;
			const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(dependencies.timeoutMs ?? 30_000), ...(ctx.signal ? [ctx.signal] : [])]);
			try {
				await evolve(getStore(), id, ctx, signal, dependencies.complete ?? completeMemory, retry);
				lastError = "";
			} catch { if (!lifetime.signal.aborted) report(ctx); }
		});
		return work;
	};

	pi.on("session_start", guard((_event, ctx) => {
		const pending = getStore().pending(scopeOf(ctx));
		if (pending) void enqueue(pending, ctx);
	}));
	pi.on("session_compact", guard((event, ctx) => {
		const entry = event.compactionEntry;
		if (!entry || typeof entry.summary !== "string") return;
		const id = `compact:${ctx.sessionManager.getSessionId()}:${entry.id}`;
		if (getStore().capture({ id, scope: scopeOf(ctx), kind: "summary", content: entry.summary, createdAt: entry.timestamp })) void enqueue(id, ctx);
	}));
	pi.on("agent_end", guard((event, ctx) => {
		for (const message of event.messages) {
			if (message.role !== "user" || !Number.isFinite(message.timestamp)) continue;
			const content = typeof message.content === "string" ? message.content : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (!MEMORY_CUE.test(content)) continue;
			const id = `user:${ctx.sessionManager.getSessionId()}:${message.timestamp}:${fingerprint(redact(content))}`;
			if (getStore().capture({ id, scope: scopeOf(ctx), kind: "user", content, createdAt: new Date(message.timestamp).toISOString() })) void enqueue(id, ctx);
		}
	}));
	pi.on("before_agent_start", guard((event, ctx) => {
		const selected = selectRelevantMemories(getStore().readMemories(scopeOf(ctx)), event.prompt);
		const digest = buildRuntimeDigest(selected, event.prompt);
		if (digest) return { systemPrompt: `${event.systemPrompt}\n\n${digest}` };
	}));
	pi.on("session_shutdown", async () => {
		lifetime.abort();
		await work;
		store?.close(); store = undefined;
	});

	pi.registerCommand("memory", {
		description: "Automatic memory: list, show, search, status, history, evolve, undo, correct, forget, pin, conflict, resolve, adopt",
		handler: async (args, ctx) => {
			try {
				const [, operation = "list", id, value = ""] = args.trim().match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u) ?? [];
				const current = getStore();
				const scope = scopeOf(ctx);
				let text: string;
				if (operation === "status") text = `${current.status()}\nScope: ${scope}\n${lastError || "Automatic updates enabled; no approval needed."}`;
				else if (operation === "evolve") {
					const pending = current.pending(scope, true);
					if (pending) await enqueue(pending, ctx, true);
					text = pending ? lastError || "Memory evolution completed." : "No unprocessed source in this scope.";
				} else if (operation === "history") {
					text = current.history(scope).map((e) => `${e.id} ${e.at} ${e.actor}: ${e.reason} (${e.after.length} changes)`).join("\n") || "No history.";
				} else if (operation === "undo") {
					if (!id) throw new Error("Usage: /memory undo <event-id>");
					text = `Undo recorded: ${current.undo(id)}`;
				} else if (["list", "search", "show"].includes(operation)) {
					let memories = current.readMemories(id === "all" && operation === "list" ? undefined : scope);
					if (operation === "show") memories = current.readMemories().filter((m) => m.id === id);
					else if (operation === "search") memories = selectRelevantMemories(memories, [id, value].filter(Boolean).join(" "), 10);
					else memories = memories.filter((m) => m.status !== "forgotten").slice(-20);
					text = memories.map((m) => `${m.id} [${m.scope}; ${m.kind}/${m.status}/${m.layer}; r${m.revision}] ${m.content}`).join("\n") || "No matching memories. /memory list all includes unscoped legacy imports.";
				} else if (["correct", "forget", "pin", "unpin", "conflict", "resolve", "adopt"].includes(operation)) {
					if (!id) throw new Error("A memory id is required");
					text = `Update recorded: ${current.act(id, operation as MemoryAction, operation === "adopt" ? scope : value)}`;
				} else throw new Error("Unknown operation. Use /memory list|show|search|status|history|evolve|undo|correct|forget|pin|unpin|conflict|resolve|adopt");
				ctx.ui.notify(text, "info");
			} catch { report(ctx); ctx.ui.notify("Memory command failed. Check the operation/id and /memory status; no partial update was committed.", "warning"); }
		},
	});
}

function scopeOf(ctx: ExtensionContext): string {
	try { return realpathSync(ctx.cwd); } catch { return resolve(ctx.cwd); }
}
