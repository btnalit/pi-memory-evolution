import type {
	AgentEndEvent,
	ExtensionAPI,
	SessionCompactEvent,
	SessionShutdownEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	probeCapabilities,
} from "./adapter/capability-probe.ts";
import { isMemoryEvolutionHost } from "./adapter/pi-api.ts";
import { isSubagentProcess } from "./child-process.ts";
import { collectSessionStats } from "./signals/collector.ts";
import { countProjectionNotices } from "./signals/projection.ts";
import { extractCorrectionKeywords } from "./signals/feedback.ts";
import {
	createAgendaStore,
	type AgendaStore,
} from "./store/agenda-store.ts";
import { getStateDir } from "./store/state-store.ts";
import { runMaturationPipeline } from "./agenda/pipeline.ts";
import { evaluateCandidate } from "./governor/speak-gate.ts";
import { createProposalFromCandidate } from "./governor/proposal-queue.ts";
import { buildRuntimeDigest } from "./injector/digest.ts";

/** Event hook name that carries the assembled system prompt into every session. */
const BEFORE_AGENT_START_EVENT = "before_agent_start";

/** Event fired after a session compaction completes. */
const SESSION_COMPACT_EVENT = "session_compact";

/** Event fired when an agent loop ends. */
const AGENT_END_EVENT = "agent_end";

/** Event fired at the end of each turn. */
const TURN_END_EVENT = "turn_end";

/** Event fired when a session shuts down. */
const SESSION_SHUTDOWN_EVENT = "session_shutdown";

/** Minimum collected sessions before the maturation pipeline may run. */
const MIN_SESSIONS_BEFORE_EVALUATION = 3;

/** Injectable dependencies that isolate state location and subagent detection. */
export interface MemoryEvolutionDependencies {
	readonly stateDir?: string;
	readonly env?: NodeJS.ProcessEnv;
}

/** Registers the memory-evolution lifecycle hooks with capability-aware degradation. */
export default function memoryEvolution(
	pi: ExtensionAPI,
	dependencies?: MemoryEvolutionDependencies,
): void {
	const probe = probeCapabilities(pi);
	if (!probe.ok || !isMemoryEvolutionHost(pi)) {
		return;
	}

	const env = dependencies?.env ?? process.env;
	if (isSubagentProcess(env)) {
		return;
	}

	const store = createAgendaStore(dependencies?.stateDir ?? getStateDir());
	let collectionEnabled = false;

	registerHook(pi, SESSION_COMPACT_EVENT, (_event) => {
		handleSessionCompact(store, () => {
			collectionEnabled = true;
		});
	});
	registerHook(pi, AGENT_END_EVENT, async (event, ctx) => {
		if (!collectionEnabled) {
			return;
		}
		handleAgentEnd(store, (event as AgentEndEvent).messages);
		maybeRunEvaluation(store);
		await runSpeakGate(store, ctx);
	});
	registerHook(pi, TURN_END_EVENT, (event) => {
		if (!collectionEnabled) {
			return;
		}
		handleTurnEnd(store, (event as TurnEndEvent).message);
	});
	registerHook(pi, SESSION_SHUTDOWN_EVENT, (event) => {
		handleSessionShutdown(store, (event as SessionShutdownEvent).reason);
	});
	registerHook(pi, BEFORE_AGENT_START_EVENT, (event) => {
		return injectRuntimeDigest(store, (event as BeforeAgentStartEventLike).systemPrompt);
	});
}

/** Minimal shape of the before_agent_start event needed for digest injection. */
interface BeforeAgentStartEventLike {
	readonly systemPrompt?: string;
}

/** Registers one hook so both registration and handler failures degrade silently. */
function registerHook(
	pi: ExtensionAPI,
	event: string,
	handler: (event: unknown, ctx: unknown) => unknown,
): void {
	try {
		pi.on(event, (eventArg: unknown, ctx: unknown) => {
			try {
				return handler(eventArg, ctx);
			} catch {
				return undefined;
			}
		});
	} catch {
		return;
	}
}

/** Enables collection after the first compaction and records the audit trail. */
function handleSessionCompact(
	store: AgendaStore,
	enable: () => void,
): void {
	enable();
	store.appendJournal(
		`- ${nowIso()} signal collection enabled after session compaction`,
	);
}

/** Records session statistics and projection notices from one agent batch. */
function handleAgentEnd(store: AgendaStore, messages: AgentEndEvent["messages"]): void {
	const stats = collectSessionStats(messages);
	store.appendSignal({
		ts: nowIso(),
		type: "session_stats",
		source: "agent_end",
		...stats,
	});

	const projectionCount = countProjectionNotices(messages);
	if (projectionCount > 0) {
		store.appendSignal({
			ts: nowIso(),
			type: "projection",
			source: "agent_end",
			count: projectionCount,
		});
	}
}

/** Records user correction feedback from one turn message. */
function handleTurnEnd(
	store: AgendaStore,
	message: TurnEndEvent["message"],
): void {
	const keywords = extractCorrectionKeywords(message);
	if (keywords.length === 0) {
		return;
	}
	store.appendSignal({
		ts: nowIso(),
		type: "feedback",
		source: "turn_end",
		keywords: [...keywords],
	});
}

/** Records the session shutdown in the audit trail. */
function handleSessionShutdown(
	store: AgendaStore,
	reason: SessionShutdownEvent["reason"],
): void {
	store.appendJournal(
		`- ${nowIso()} session ended (${reason})`,
	);
}

/** Runs the maturation pipeline once enough sessions have been collected. */
function maybeRunEvaluation(store: AgendaStore): void {
	const signals = store.readSignals();
	const sessionCount = signals.filter(
		(signal) => signal.type === "session_stats",
	).length;
	if (sessionCount < MIN_SESSIONS_BEFORE_EVALUATION) {
		return;
	}
	runMaturationPipeline(store, nowIso());
}

/** Evaluates pending candidates through the speak gate and asks the user to approve. */
async function runSpeakGate(store: AgendaStore, ctx: unknown): Promise<void> {
	const candidates = store.readCandidates();
	if (candidates.length === 0) {
		return;
	}

	const knownAgendas = new Set(
		store.readDecisions().map((decision) => decision.agendaId),
	);
	let quota = store.readQuota();
	const pending = candidates.filter(
		(candidate) => !knownAgendas.has(candidate.agendaId),
	);
	for (const candidate of pending) {
		const result = evaluateCandidate({ candidate, quota });
		store.appendDecision(result.decision);
		quota = result.quota;
		if (result.quotaConsumed && result.decision.action !== "risk_alert_only") {
			const approved = await awaitConfirm(ctx, candidate.suggestedMessage);
			if (approved) {
				const proposal = createProposalFromCandidate(candidate, [], nowIso());
				store.writeProposalQueue([
					...store.readProposalQueue(),
					proposal,
				]);
			}
		}
		markSurfaced(store, candidate.agendaId);
	}
	store.writeQuota(quota);
}

/** Advances a decided agenda item from candidate_ready to surfaced. */
function markSurfaced(store: AgendaStore, agendaId: string): void {
	const agenda = store.readAgenda();
	let changed = false;
	const updated = agenda.map((item) => {
		if (item.id === agendaId && item.status === "candidate_ready") {
			changed = true;
			return { ...item, status: "surfaced" };
		}
		return item;
	});
	if (changed) {
		store.writeAgenda(updated);
	}
}

/** Shows the approval dialog and resolves false when no UI is available. */
async function awaitConfirm(ctx: unknown, message: string): Promise<boolean> {
	const ui = (ctx as { ui?: { confirm?: (title: string, msg: string) => Promise<boolean> } })
		?.ui;
	if (ui?.confirm === undefined) {
		return false;
	}
	try {
		return await ui.confirm("Memory Evolution", message);
	} catch {
		return false;
	}
}

/** Appends the runtime digest to the assembled system prompt when available. */
function injectRuntimeDigest(
	store: AgendaStore,
	currentSystemPrompt: string | undefined,
): { readonly systemPrompt: string } | undefined {
	const knownAgendas = new Set(
		store.readDecisions().map((decision) => decision.agendaId),
	);
	const pendingCandidates = store
		.readCandidates()
		.filter((candidate) => !knownAgendas.has(candidate.agendaId));
	const digest = buildRuntimeDigest({
		now: nowIso(),
		candidates: pendingCandidates,
		decisions: store.readDecisions().slice(-3),
	});
	if (digest === undefined) {
		return undefined;
	}
	return {
		systemPrompt: `${currentSystemPrompt ?? ""}\n\n${digest}`,
	};
}

/** Returns the current UTC timestamp in ISO format. */
function nowIso(): string {
	return new Date().toISOString();
}
