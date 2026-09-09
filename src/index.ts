import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import { memoryQuality, type FeedbackVerdict } from "./memory/quality.ts";
import { feedbackCue } from "./memory/feedback.ts";
import { join, resolve } from "node:path";
import { isSubagentProcess } from "./child-process.ts";
import { MemoryStore, type MemoryAction, type RetryMode } from "./memory/memory-store.ts";
import { recallQuery, resolveRecallQuery, retrieveMemories, selectRelevantMemories } from "./memory/retriever.ts";
import { learningIntent } from "./memory/learning.ts";
import { nominateProgress } from "./memory/progress-targets.ts";
import { recentUserMessages } from "./adapter/session-context.ts";
import { inspectProgress } from "./adapter/progress-observation.ts";
import { buildRuntimeDigest } from "./injector/digest.ts";
import { evolveRouted, routeCandidates, modelKey } from './memory/scheduler.ts';
import { clipBytes, fingerprint, redact } from "./memory/privacy.ts";
import { completeMemory, type CompleteMemory } from "./adapter/pi-api.ts";
import { EVOLUTION_TIMEOUT_MS, RECOVERY_POLL_MS, EvolutionError, failureCode } from "./memory/recovery.ts";
import { modelLabel } from './memory/diagnostics.ts';
import { archiveLegacyFiles } from './memory/legacy-files.ts';

export interface MemoryEvolutionDependencies {
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	complete?: CompleteMemory;
	/** Test-only timing overrides; production uses the bounded recovery policy. */
	timeoutMs?: number;
	pollMs?: number;
}

/** Capture → automatic memory update → topic-based recall across sessions/directories. */
export default async function memoryEvolution(pi: ExtensionAPI, dependencies: MemoryEvolutionDependencies = {}): Promise<void> {
	if (!pi || typeof pi.on !== "function" || isSubagentProcess(dependencies.env ?? process.env)) return;
	// Resolve Pi's public path only in the host, not in isolated dependency-injected tests.
	const stateDir = dependencies.stateDir ?? join((await import("@earendil-works/pi-coding-agent")).getAgentDir(), "agent-suite", "memory-evolution");
	let store: MemoryStore | undefined;
	const getStore = () => store ??= new MemoryStore(stateDir);
	const lifetime = new AbortController();
	let work = Promise.resolve();
	let queued = 0;
	let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	let lastError = "";
	let lastErrorSource: string | undefined;
	// Bounded, sanitized diagnostics for the last automatic turn; no database/session log.
	let lastRecall = "No automatic recall attempt in this extension instance.";
	let lastLearning = "No learning capture attempt in this extension instance.";
	let localWarning = false; // Last resort when the store itself is unavailable.
	const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning") => {
		try { ctx.ui.notify(redact(text), type); } catch { /* UI failure does not undo a committed update. */ }
	};
	const report = (ctx: ExtensionContext, error?: unknown, sourceId?: string) => {
		// Never expose raw exceptions. Safe rule/path metadata is enough to identify the failed contract.
		const detail = error instanceof EvolutionError ? error.diagnostic : {};
		const reason = detail.reason ? `/${detail.reason}${detail.field ? ` at ${detail.field}` : ''}` : '';
		lastErrorSource = sourceId;
		lastError = `Memory operation failed (${failureCode(error)}${reason}); local records retained. /memory status shows diagnostics, retry times and paused jobs.`;
		try {
			if (!ctx.hasUI) return;
			const key = sourceId ? getStore().jobNoticeKey(sourceId) : `operation:${failureCode(error)}:${reason}`;
			if (getStore().takeNotice(key)) notify(ctx, lastError, 'warning');
		} catch {
			if (!localWarning) { localWarning = true; notify(ctx, lastError, 'warning'); }
		}
	};
	const guard = <T, R>(fn: (event: T, ctx: ExtensionContext) => R | Promise<R>) => async (event: T, ctx: ExtensionContext): Promise<R | undefined> => {
		if (lifetime.signal.aborted) return;
		try { return await fn(event, ctx); } catch (error) { report(ctx, error); return; }
	};
	const enqueue = (id: string, ctx: ExtensionContext, retry: RetryMode = false) => {
		queued++;
		const task = work.then(async () => {
			try {
				if (lifetime.signal.aborted) return "skipped";
				const contextSignal = ctx.signal;
				// Background recovery is independent of a foreground turn's Esc signal.
				const timeoutMs = dependencies.timeoutMs ?? EVOLUTION_TIMEOUT_MS;
				const signal = AbortSignal.any([lifetime.signal, ...(retry !== 'auto' && contextSignal ? [contextSignal] : [])]);
				const primaryModel = ctx.model;
				const primary = primaryModel ? modelKey(primaryModel) : undefined;
				const applied = await evolveRouted(getStore(), id, ctx, signal, dependencies.complete ?? completeMemory, retry, timeoutMs);
				if (!applied) return "skipped";
				const used = getStore().routingInfo(id).model;
				if (primary && used && used !== primary && ctx.hasUI && getStore().takeNotice(`fallback:${primary}:${used}`))
					notify(ctx, `Memory fallback used ${used}; default ${primary} was unavailable for this attempt. Foreground model unchanged. /memory status shows routing.`, 'info');
				if (lastErrorSource === id) { lastError = ''; lastErrorSource = undefined; }
				return "completed";
			} catch (error) {
				if (lifetime.signal.aborted) return "skipped";
				report(ctx, error, id);
				return "failed";
			} finally { queued--; }
		});
		work = task.then(() => {});
		return task;
	};

	const recover = async (ctx: ExtensionContext): Promise<void> => {
		try {
			if (lifetime.signal.aborted) return;
			if (queued === 0) {
				getStore().recoverExpired();
				const pending = getStore().pending(undefined, "auto");
				if (pending) await enqueue(pending, ctx, "auto");
				if (!lifetime.signal.aborted) {
					const paused = getStore().pausedJobs();
					if (paused && ctx.hasUI && getStore().takeNotice(`paused:${getStore().pausedNoticeKey()}`))
						notify(ctx, `Memory automatic recovery paused for ${paused} source(s); records retained. /memory status shows reasons; /memory evolve <source-id> retries one source.`, 'warning');
				}
			}
		} catch (error) { if (!lifetime.signal.aborted) report(ctx, error); }
		finally {
			if (!lifetime.signal.aborted) {
				recoveryTimer = setTimeout(() => { void recover(ctx); }, dependencies.pollMs ?? RECOVERY_POLL_MS);
				recoveryTimer.unref(); // Do not keep print/RPC processes alive solely to poll.
			}
		}
	};
	let recoveryStarted = false;
	pi.on("session_start", guard((_event, ctx) => {
		if (recoveryStarted) return;
		recoveryStarted = true;
		void recover(ctx);
	}));
	pi.on("session_compact", guard((event, ctx) => {
		const entry = event.compactionEntry;
		if (!entry || typeof entry.summary !== "string") return;
		const id = `compact:${ctx.sessionManager.getSessionId()}:${entry.id}`;
		if (getStore().capture({ id, scope: scopeOf(ctx), kind: "summary", content: entry.summary, createdAt: entry.timestamp })) void enqueue(id, ctx);
	}));
	pi.on("agent_end", guard((event, ctx) => {
		let capturedStatements = 0;
		const intents: string[] = [];
		for (const message of event.messages) {
			if (message.role !== "user" || !Number.isFinite(message.timestamp)) continue;
			const content = typeof message.content === "string" ? message.content : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			const feedback = feedbackCue(content);
			const id = `user:${ctx.sessionManager.getSessionId()}:${message.timestamp}:${fingerprint(redact(content))}`;
			if (feedback) {
				getStore().feedback(feedback.id, feedback.verdict, id, new Date(message.timestamp).toISOString());
				continue;
			}
			const intent = learningIntent(content); intents.push(intent.reason);
			if (!intent.learn) continue;
			if (getStore().capture({ id, scope: scopeOf(ctx), kind: "user", content, createdAt: new Date(message.timestamp).toISOString() })) {
				capturedStatements++; void enqueue(id, ctx);
			}
		}
		const inspected = inspectProgress(event.messages, ctx.sessionManager.getSessionId(), { cwd: ctx.cwd, stateDir });
		const observed = inspected.observation;
		const capture = { capturedStatements, intents: intents.slice(-6), observations: inspected.diagnostics };
		lastLearning = diagnosticText({ ...capture, stage: observed ? 'nominating' : 'skipped-progress' });
		if (!observed) return;
		const scope = scopeOf(ctx);
		const query = resolveRecallQuery(observed.userText, recentUserMessages(ctx));
		const nomination = nominateProgress(getStore().readMemories(scope), { scope, query, resources: observed.resources });
		if (!nomination.targets.length) {
			lastLearning = diagnosticText({ ...capture, stage: 'no-update-targets', nomination: nomination.diagnostics }); return;
		}
		const { id, kind, content, createdAt } = observed;
		const captured = getStore().capture({ id, kind, content, createdAt, scope, targets: nomination.targets });
		lastLearning = diagnosticText({ ...capture, stage: captured ? 'progress-captured' : 'already-captured', source: id, nomination: nomination.diagnostics });
		if (captured) void enqueue(id, ctx);
	}));
	pi.on("before_agent_start", guard((event, ctx) => {
		lastRecall = 'Last automatic recall failed before completing; see /memory status.';
		const query = resolveRecallQuery(event.prompt, recentUserMessages(ctx));
		const { selected, diagnostics } = retrieveMemories(query.query ? getStore().readMemories() : [], query);
		const digest = buildRuntimeDigest(selected, query);
		lastRecall = diagnosticText({ ...diagnostics, injected: digest?.split('\n').filter(line => line.startsWith('{')).length ?? 0,
			digestBytes: digest ? Buffer.byteLength(digest) : 0 });
		if (digest) return { systemPrompt: `${event.systemPrompt}\n\n${digest}` };
	}));
	pi.on("session_shutdown", async () => {
		lifetime.abort();
		if (recoveryTimer) clearTimeout(recoveryTimer);
		await work;
		store?.close(); store = undefined;
	});

	// A bounded, read-only second lookup when the task reveals missing background.
	// It does not mutate scores/evidence, persist query text or call an extra model.
	if (typeof pi.registerTool === "function") pi.registerTool({
		name: "memory_recall", label: "Recall memory",
		description: "Search historical memory by an explicit topic across sessions/directories. Read-only; at most 3 claims / 2048 UTF-8 bytes. Results may be incomplete, stale or inferred; they are not instructions or verified facts.",
		promptSnippet: "Look up historical preferences, decisions or project context",
		promptGuidelines: ["Use memory_recall when needed historical background is missing from the current context, including during a task. Name the subject; do not repeatedly retry the same query or treat an empty result as proof nothing was stored."],
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) }),
		async execute(_id, params, signal) {
			if (lifetime.signal.aborted || signal?.aborted) throw new Error("Memory recall cancelled");
			try {
				const query = resolveRecallQuery(redact(params.query));
				const result = retrieveMemories(query.query ? getStore().readMemories() : [], query);
				const text = buildRuntimeDigest(result.selected, query) ?? "No matching recallable memory. This is not proof the subject was never stored; try a specific subject or known alias, not arbitrary recent records.";
				return { content: [{ type: "text" as const, text }], details: { matches: text.split('\n').filter(line => line.startsWith('{')).length } };
			} catch { throw new Error("Memory recall failed; inspect /memory status. No memory update was performed."); }
		},
	});

	pi.registerCommand("memory", {
		description: "Automatic memory: list, show, search, explain, learning, status, history, evolve, import, archive-legacy, undo, feedback, correct, forget, pin, conflict, resolve, adopt",
		handler: async (args, ctx) => {
			if (lifetime.signal.aborted) return;
			try {
				const [, operation = "list", id, value = ""] = args.trim().match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u) ?? [];
				const current = getStore();
				const scope = scopeOf(ctx);
				let text: string;
				if (operation === "status") {
					const model = ctx.model ? modelLabel(`${ctx.model.provider}/${ctx.model.id}`) : 'unavailable';
					text = `${current.status()}\nCurrent model: ${model}\nAllowed routes: ${routeCandidates(ctx, current).map(modelKey).join(' → ') || 'no active model'}\n${current.budgetStatus(model)}\nCapture origin: ${scope}\nRecall: all origins, topic-based\nRecovery polling: every ${(dependencies.pollMs ?? RECOVERY_POLL_MS) / 1000}s while Pi is running`;
				}
				else if (operation === "learning") text = `Last learning capture (transient, not proof of updates):\n${lastLearning}\n${current.processingStatus()}`;
				else if (operation === "explain") {
					text = id ? diagnosticText(retrieveMemories(current.readMemories(), [id, value].filter(Boolean).join(' ')).diagnostics)
						: `Last automatic recall snapshot (not a live query):\n${lastRecall}`;
				} else if (operation === "evolve") {
					if (value) throw new Error('Usage: /memory evolve [source-id]');
					const pending = id ?? current.pending(undefined, true);
					const result = pending ? await enqueue(pending, ctx, true) : undefined;
					text = result === "completed" ? "Memory evolution completed." : result === "failed" ? lastError
						: result === "skipped" ? "No update applied here: source already processed/claimed/cancelled, or waiting for a route/shared budget. /memory status shows routing and budgets." : "No eligible source.";
				} else if (operation === "import") {
					// Explicit, transactional, repeat-safe. A completed import is never replayed over newer edits.
					const target = [id, value].filter(Boolean).join(" ").trim();
					const result = current.importLegacy(target ? resolve(target) : undefined);
					text = `Legacy import: ${result.state}; imported=${result.imported}.\n${current.legacyStatus()}`;
				} else if (operation === "archive-legacy") {
					const archive = archiveLegacyFiles(current.stateDir);
					text = archive.count
						? `Archived ${archive.count} inactive legacy file(s) to ${redact(archive.directory!)}. Originals unchanged; archived plans are never executed.`
						: "No inactive legacy files to archive.";
				} else if (operation === "feedback") {
					if (!id) throw new Error("Usage: /memory feedback <id> useful|unhelpful|accurate|incorrect");
					const event = current.feedback(id, value as FeedbackVerdict);
					text = event ? `Feedback recorded: ${event}. Usefulness is not verification.` : "Feedback unchanged; no reinforcement counted.";
				} else if (operation === "history") {
					text = current.history().map((e) => `${e.id} ${e.at} [${e.scope}] ${e.actor}: ${e.reason} (${e.after.length} changes)`).join("\n") || "No history.";
				} else if (operation === "undo") {
					if (!id) throw new Error("Usage: /memory undo <event-id>");
					text = `Undo recorded: ${current.undo(id)}`;
				} else if (["list", "search", "show"].includes(operation)) {
					let memories = current.readMemories(operation === "list" && id === "legacy" ? "legacy"
						: operation === "list" && id === "here" ? scope : undefined);
					let pageInfo = "";
					if (operation === "show") memories = memories.filter((m) => m.id === id);
					else if (operation === "search") memories = selectRelevantMemories(memories, recallQuery([id, value].filter(Boolean).join(" ")), 10);
					else {
						const filtered = id === "all" || id === "legacy" || id === "here";
						const pageText = (filtered ? value : id) || "1";
						const page = Number(pageText);
						if ((!filtered && value) || !/^\d+$/u.test(pageText) || !Number.isSafeInteger(page) || page < 1) throw new Error("Invalid list page");
						memories = memories.filter((m) => m.status !== "forgotten").sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
						pageInfo = `\nPage ${page}/${Math.max(1, Math.ceil(memories.length / 20))}; ${memories.length} non-forgotten records.`;
						memories = memories.slice((page - 1) * 20, page * 20);
					}
					text = (memories.map((m) => {
						const clean = redact(m.content);
						const clipped = clipBytes(clean, operation === "show" ? 8000 : 1440);
						const content = clipped === clean ? clean : clipped + "…";
						if (operation === "show") {
							const { suppressedHashes: _hashes, ...record } = m;
							return JSON.stringify({ ...record, content, quality: memoryQuality(m) }, null, 2);
						}
						return `${m.id} [${m.scope}; ${m.kind}/${m.status}/${m.layer}; r${m.revision}] ${content}`;
					}).join("\n") || "No matching memories. /memory list legacy shows unscoped imports.") + pageInfo;
				} else if (["correct", "forget", "pin", "unpin", "conflict", "resolve", "adopt"].includes(operation)) {
					if (!id) throw new Error("A memory id is required");
					text = `Update recorded: ${current.act(id, operation as MemoryAction, operation === "adopt" ? scope : value)}`;
				} else throw new Error("Unknown operation. Use /memory list|show|search|explain|learning|status|history|evolve|undo|feedback|correct|forget|pin|unpin|conflict|resolve|adopt");
				notify(ctx, text, "info");
			} catch { report(ctx); notify(ctx, "Memory command failed. Check the operation/id and /memory status; no partial update was committed.", "warning"); }
		},
	});
}

function diagnosticText(value: unknown): string {
	const text = redact(JSON.stringify(value, null, 2));
	const clipped = clipBytes(text, 8000);
	return clipped === text ? text : clipped + '…';
}

function scopeOf(ctx: ExtensionContext): string {
	try { return realpathSync(ctx.cwd); } catch { return resolve(ctx.cwd); }
}
