import type {
	AgentEndEvent,
	ExtensionAPI,
	SessionCompactEvent,
	SessionShutdownEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	probeCapabilities,
	type CapabilityProbeResult,
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
	registerHook(pi, AGENT_END_EVENT, (event) => {
		if (!collectionEnabled) {
			return;
		}
		handleAgentEnd(store, (event as AgentEndEvent).messages);
		maybeRunEvaluation(store);
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
	registerHook(pi, BEFORE_AGENT_START_EVENT, (_event) => {
		handleBeforeAgentStart(probe);
	});
}

/** Registers one hook so both registration and handler failures degrade silently. */
function registerHook(
	pi: ExtensionAPI,
	event: string,
	handler: (event: unknown) => void,
): void {
	try {
		pi.on(event, (eventArg: unknown) => {
			try {
				handler(eventArg);
			} catch {
				return;
			}
			return undefined;
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

/** Placeholder for future runtime-digest injection (design phase P3). */
function handleBeforeAgentStart(_probe: CapabilityProbeResult): void {
	return;
}

/** Returns the current UTC timestamp in ISO format. */
function nowIso(): string {
	return new Date().toISOString();
}
