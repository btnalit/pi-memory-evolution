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
import { runAutoApproval } from "./governor/proposal-approval.ts";
import { runVerificationSignals } from "./governor/proposal-verification.ts";
import { executeApprovedProposals } from "./executor/proposal-executor.ts";
import { archiveTerminalProposals } from "./executor/proposal-archive.ts";
import { buildRuntimeDigest } from "./injector/digest.ts";
import {
	createMemoryStore,
	type MemoryStore,
} from "./memory/memory-store.ts";
import { selectRelevantMemories } from "./memory/retriever.ts";

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

	const stateDir = dependencies?.stateDir ?? getStateDir();
	const store = createAgendaStore(stateDir);
	const memoryStore = createMemoryStore(stateDir);
	let collectionEnabled = false;

	registerHook(pi, SESSION_COMPACT_EVENT, (event) => {
		handleSessionCompact(
			store,
			memoryStore,
			event as SessionCompactEvent,
			() => {
				collectionEnabled = true;
			},
		);
	});
	registerHook(pi, AGENT_END_EVENT, async (event, _ctx) => {
		if (!collectionEnabled) {
			return;
		}
		const messages = (event as AgentEndEvent).messages;
		handleAgentEnd(store, messages);
		maybeRunEvaluation(store);
		runSpeakGate(store);
		runAutoApproval(store, messages, nowIso());
		runVerificationSignals(store, messages, nowIso());
		executeApprovedProposals(store, nowIso());
		archiveTerminalProposals(store, nowIso());
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
		const beforeStart = event as BeforeAgentStartEventLike;
		const memories = selectRelevantMemories(
			memoryStore.readMemories(),
			beforeStart.prompt ?? "",
		);
		return injectRuntimeDigest(
			store,
			memories,
			beforeStart.systemPrompt,
		);
	});
}

/** Minimal shape of the before_agent_start event needed for digest injection. */
interface BeforeAgentStartEventLike {
	readonly prompt?: string;
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
	memoryStore: MemoryStore,
	event: SessionCompactEvent,
	enable: () => void,
): void {
	enable();
	store.appendJournal(
		`- ${nowIso()} signal collection enabled after session compaction`,
	);
	const entry = event.compactionEntry;
	if (entry === undefined || typeof entry.summary !== "string") {
		return;
	}
	const summary = entry.summary.trim();
	if (summary.length === 0) {
		return;
	}
	memoryStore.appendMemory({
		id: `compaction:${entry.id}`,
		kind: "compaction_summary",
		createdAt: entry.timestamp,
		sourceEntryId: entry.id,
		content: summary,
	});
	store.appendJournal(
		`- ${nowIso()} durable memory saved from compaction ${entry.id}`,
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

	// Real pi sends the user input inside agent_end.messages; turn_end.message
	// carries the assistant reply instead, so user corrections are extracted
	// from the agent batch here.
	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}
		const keywords = extractCorrectionKeywords(message);
		if (keywords.length === 0) {
			continue;
		}
		store.appendSignal({
			ts: nowIso(),
			type: "feedback",
			source: "agent_end",
			keywords: [...keywords],
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

/** Evaluates pending candidates through the speak gate and writes pending proposals. */
function runSpeakGate(store: AgendaStore): void {
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
			// Q4-1: approval is deferred to the auto-approval channel; no ui.confirm here.
			const proposal = createProposalFromCandidate(
				candidate,
				candidate.evidence ?? [],
				nowIso(),
			);
			store.writeProposalQueue([
				...store.readProposalQueue(),
				proposal,
			]);
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

/** Appends the runtime digest to the assembled system prompt when available. */
function injectRuntimeDigest(
	store: AgendaStore,
	memories: ReturnType<typeof selectRelevantMemories>,
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
		proposals: store.readProposalQueue(),
		memories,
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
