import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryEvolution from "./index.ts";
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
function mockCtx(cwd = "/tmp/project") {
	return {
		sessionManager: { getCwd: () => cwd },
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
