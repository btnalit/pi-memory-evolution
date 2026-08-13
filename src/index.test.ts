import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryEvolution from "./index.ts";
import { createAgendaStore } from "./store/agenda-store.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Records pi.on registrations for assertion and manual triggering. */
interface RegisteredHook {
	readonly event: string;
	readonly handler: (...args: unknown[]) => unknown;
}

/** Minimal pi-like object that records hook registrations. */
function recordingPi(): {
	pi: Partial<ExtensionAPI>;
	registered: RegisteredHook[];
} {
	const registered: RegisteredHook[] = [];
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			registered.push({ event, handler });
		},
	} as Partial<ExtensionAPI>;
	return { pi, registered };
}

/** Triggers one registered hook with the given arguments. */
async function trigger(
	registered: RegisteredHook[],
	event: string,
	args: unknown[] = [],
): Promise<unknown> {
	const hook = registered.find((item) => item.event === event);
	assert.ok(hook !== undefined, `hook ${event} was not registered`);
	return hook.handler(...args);
}

/** Creates a temporary state directory and returns its path. */
async function createTempStateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pme-index-"));
}

/** Mock ctx with a session manager exposing cwd. */
function mockCtx(cwd = "/tmp/project", confirmResult = false) {
	return {
		sessionManager: { getCwd: () => cwd },
		ui: { confirm: async () => confirmResult },
	};
}

/** Builds a minimal agent-end message batch. */
function agentMessages(): unknown[] {
	return [
		{ role: "user", content: "hello", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "ok" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
			],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			usage: { input: 1, output: 1, totalTokens: 2 },
			stopReason: "stop",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "output" }],
			isError: false,
			timestamp: 3,
		},
	];
}

describe("memoryEvolution extension entry (P1)", () => {
	test("registers the five lifecycle hooks when capabilities are available", () => {
		const { pi, registered } = recordingPi();
		memoryEvolution(pi as ExtensionAPI, {
			stateDir: "/tmp/unused",
			env: {},
		});
		const events = registered.map((hook) => hook.event);
		for (const expected of [
			"before_agent_start",
			"session_compact",
			"agent_end",
			"turn_end",
			"session_shutdown",
		]) {
			assert.ok(events.includes(expected), `missing hook ${expected}`);
		}
	});

	test("does not throw when pi lacks required capabilities", () => {
		assert.doesNotThrow(() => memoryEvolution({} as ExtensionAPI));
		assert.doesNotThrow(() =>
			memoryEvolution(undefined as unknown as ExtensionAPI),
		);
	});

	test("does not register hooks when on is missing", () => {
		const { pi, registered } = recordingPi();
		delete (pi as Record<string, unknown>).on;
		memoryEvolution(pi as ExtensionAPI, { stateDir: "/tmp/x", env: {} });
		assert.equal(registered.length, 0);
	});

	test("does not throw when pi.on itself throws", () => {
		const pi = {
			on: () => {
				throw new Error("on failed");
			},
		} as unknown as ExtensionAPI;
		assert.doesNotThrow(() => memoryEvolution(pi));
	});

	test("skips hook registration in subagent processes", () => {
		const { pi, registered } = recordingPi();
		memoryEvolution(pi as ExtensionAPI, {
			stateDir: "/tmp/x",
			env: { PI_SUBAGENT_AGENT_ID: "Researcher" },
		});
		assert.equal(registered.length, 0);
	});

	test("writes session stats only after a compaction enables collection", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });

			// Before compaction: agent_end must not write signals.
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx(),
			]);
			await assert.rejects(readFile(join(stateDir, "signals.jsonl"), "utf8"), {
				code: "ENOENT",
			});

			// After compaction: agent_end writes a session_stats record.
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx(),
			]);
			const content = await readFile(join(stateDir, "signals.jsonl"), "utf8");
			const lines = content.trim().split("\n");
			assert.equal(lines.length, 1);
			const record = JSON.parse(lines[0]);
			assert.equal(record.type, "session_stats");
			assert.equal(record.toolCallCount, 1);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("writes a projection signal when notices are present", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			const messages = [
				...agentMessages(),
				{
					role: "toolResult",
					toolCallId: "c2",
					toolName: "read",
					content: [
						{ type: "text", text: "Result omitted. Run tool again for full result." },
					],
					isError: false,
					timestamp: 4,
				},
			];
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages },
				mockCtx(),
			]);
			const content = await readFile(join(stateDir, "signals.jsonl"), "utf8");
			const records = content
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const projection = records.find((r) => r.type === "projection");
			assert.ok(projection !== undefined);
			assert.equal(projection.count, 1);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("writes a feedback signal on correction keywords in user messages", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			const userMsg = { role: "user", content: "不对，应该改成 X", timestamp: 1 };
			await trigger(registered, "turn_end", [
				{
					type: "turn_end",
					turnIndex: 0,
					message: userMsg,
					toolResults: [],
				},
			]);
			const content = await readFile(join(stateDir, "signals.jsonl"), "utf8");
			const records = content
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const feedback = records.find((r) => r.type === "feedback");
			assert.ok(feedback !== undefined);
			assert.ok(feedback.keywords.includes("不对"));
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("writes a journal entry on session shutdown", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await trigger(registered, "session_shutdown", [
				{ type: "session_shutdown", reason: "quit" },
			]);
			const content = await readFile(join(stateDir, "evolution_journal.md"), "utf8");
			assert.ok(content.includes("session"));
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("before_agent_start handler returns undefined without failing", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			const result = await trigger(
				registered,
				"before_agent_start",
				[{ type: "before_agent_start" }, mockCtx()],
			);
			assert.equal(result, undefined);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});

describe("memoryEvolution extension entry (P2 maturation)", () => {
	test("does not run evaluation before three sessions are collected", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx(),
			]);
			await assert.rejects(
				readFile(join(stateDir, "agenda_candidates.yaml"), "utf8"),
				{ code: "ENOENT" },
			);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("runs the maturation pipeline after three sessions are collected", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			for (let index = 0; index < 3; index++) {
				await trigger(registered, "agent_end", [
					{ type: "agent_end", messages: agentMessages() },
					mockCtx(),
				]);
			}
			const candidates = await readFile(
				join(stateDir, "agenda_candidates.yaml"),
				"utf8",
			);
			assert.ok(candidates.includes("shadow_mode"));
			const journal = await readFile(
				join(stateDir, "evolution_journal.md"),
				"utf8",
			);
			assert.ok(journal.includes("maturation"));
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});

describe("memoryEvolution extension entry (P3/P4 speak gate + digest)", () => {
	/** Writes a pre-matured candidate directly into the store. */
	async function seedCandidate(stateDir: string): Promise<void> {
		const store = createAgendaStore(stateDir);
		store.writeCandidates([
			{
				candidateId: "C-000001",
				agendaId: "A-000001",
				title: "测试候选",
				type: "quality_improvement",
				maturityScore: 0.85,
				action: "create_proposal",
				status: "candidate_ready",
				evidenceCount: 5,
				observationDays: 10,
				suggestedMessage: "议题：测试候选",
			},
		]);
	}

	test("writes a pending proposal after speak gate without ui.confirm", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await seedCandidate(stateDir);
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			// No UI context: approval is deferred to the auto-approval channel (Q4-1).
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx("/tmp/project", false),
			]);
			const queue = await readFile(
				join(stateDir, "proposal_queue.yaml"),
				"utf8",
			);
			assert.ok(queue.includes("测试候选"));
			assert.ok(queue.includes("pending_user_approval"));
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("advances a pending proposal through approval to implemented on agent_end", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await seedCandidate(stateDir);
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			// First agent_end: speak gate writes a pending proposal.
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx(),
			]);
			const store = createAgendaStore(stateDir);
			const [pending] = store.readProposalQueue();
			assert.equal(pending.status, "pending_user_approval");
			// Second agent_end: the agent message approves the proposal by id.
			const approving = agentMessages().map((message) =>
				message.role === "assistant"
					? { ...message, content: [{ type: "text", text: `批准 ${pending.id} 这个提案` }] }
					: message,
			);
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: approving },
				mockCtx(),
			]);
			const [decided] = store.readProposalQueue();
			assert.equal(decided.status, "implemented");
			assert.ok(store.readExecutionPlan(pending.id) !== undefined);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("rejects a pending proposal after its approval window expires", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await seedCandidate(stateDir);
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			// First agent_end: speak gate writes a pending proposal.
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx(),
			]);
			const store = createAgendaStore(stateDir);
			const [pending] = store.readProposalQueue();
			assert.equal(pending.status, "pending_user_approval");
			// Backdate the expiry so the next agent_end rejects the proposal.
			store.writeProposalQueue([
				{
					...pending,
					timestamps: { ...pending.timestamps, expiresAt: "2020-01-01T00:00:00.000Z" },
				},
			]);
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx(),
			]);
			const [decided] = store.readProposalQueue();
			assert.equal(decided.status, "rejected");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("appends a speak decision to the decision log", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await seedCandidate(stateDir);
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx("/tmp/project", false),
			]);
			const decisions = await readFile(
				join(stateDir, "speak_decisions.jsonl"),
				"utf8",
			);
			assert.ok(decisions.includes("测试候选"));
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("injects a runtime digest into the system prompt on before_agent_start", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await seedCandidate(stateDir);
			const result = await trigger(
				registered,
				"before_agent_start",
				[{ type: "before_agent_start" }, mockCtx()],
			);
			assert.ok(result !== undefined);
			const resultObj = result as { systemPrompt?: string };
			assert.ok(resultObj.systemPrompt !== undefined);
			assert.ok(resultObj.systemPrompt.includes("测试候选"));
			assert.ok(resultObj.systemPrompt.includes("advisory"));
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("returns undefined from before_agent_start when there is nothing to report", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			const result = await trigger(
				registered,
				"before_agent_start",
				[{ type: "before_agent_start" }, mockCtx()],
			);
			assert.equal(result, undefined);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("deduplicates by agenda id across runs with regenerated candidate ids", async () => {
		const stateDir = await createTempStateDir();
		try {
			const { pi, registered } = recordingPi();
			memoryEvolution(pi as ExtensionAPI, { stateDir, env: {} });
			await seedCandidate(stateDir);
			await trigger(registered, "session_compact", [
				{ type: "session_compact", reason: "threshold", fromExtension: false },
			]);
			// First agent_end evaluates and logs a decision.
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx("/tmp/project", false),
			]);
			const firstCount = (await readFile(join(stateDir, "speak_decisions.jsonl"), "utf8"))
				.trim().split("\n").filter(Boolean).length;
			// A regenerated candidate id for the same agenda must not re-evaluate.
			const store = createAgendaStore(stateDir);
			store.writeCandidates([
				{
					candidateId: "C-NEW-REGENERATED",
					agendaId: "A-000001",
					title: "测试候选",
					type: "quality_improvement",
					maturityScore: 0.85,
					action: "create_proposal",
					status: "candidate_ready",
					evidenceCount: 5,
					observationDays: 10,
					suggestedMessage: "议题：测试候选",
				},
			]);
			await trigger(registered, "agent_end", [
				{ type: "agent_end", messages: agentMessages() },
				mockCtx("/tmp/project", false),
			]);
			const secondCount = (await readFile(join(stateDir, "speak_decisions.jsonl"), "utf8"))
				.trim().split("\n").filter(Boolean).length;
			assert.equal(secondCount, firstCount);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});
