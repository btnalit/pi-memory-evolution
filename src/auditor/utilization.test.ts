import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	computeUtilization,
	type SessionEntryLike,
} from "./utilization.ts";

/** Builds a message entry with the given role and tool name. */
function messageEntry(
	role: "user" | "assistant" | "toolResult",
	toolName: string | undefined,
	text = "content",
): SessionEntryLike {
	return {
		type: "message",
		id: `id-${Math.random()}`,
		parentId: null,
		timestamp: "2026-08-05T00:00:00.000Z",
		message: {
			role,
			content: [{ type: "text", text }],
			toolName,
		},
	} as unknown as SessionEntryLike;
}

/** Builds a projected tool result entry (omitted notice text). */
function projectedToolResult(toolName: string): SessionEntryLike {
	return messageEntry(
		"toolResult",
		toolName,
		"Result omitted. Run tool again for full result.",
	);
}

/** Builds a compaction entry. */
function compactionEntry(): SessionEntryLike {
	return {
		type: "compaction",
		id: `comp-${Math.random()}`,
		parentId: null,
		timestamp: "2026-08-05T00:00:00.000Z",
		summary: "summary",
		firstKeptEntryId: "id-1",
		tokensBefore: 100,
	} as unknown as SessionEntryLike;
}

describe("computeUtilization", () => {
	test("returns zero rates for empty entries", () => {
		const metrics = computeUtilization([]);
		assert.equal(metrics.projectionReRunRate, 0);
		assert.equal(metrics.reReadExecutionRate, 0);
	});

	test("computes projection re-run rate from projected results followed by re-calls", () => {
		const entries = [
			projectedToolResult("bash"),
			messageEntry("assistant", "bash"), // re-call of the same tool
			projectedToolResult("read"),
			messageEntry("assistant", "bash"), // different tool, not a re-run
		];
		const metrics = computeUtilization(entries);
		// 1 of 2 projected results was re-run
		assert.ok(Math.abs(metrics.projectionReRunRate - 0.5) < 0.001);
	});

	test("computes re-read execution rate after compaction", () => {
		const entries = [
			compactionEntry(),
			messageEntry("assistant", "read"), // re-read after compaction
			compactionEntry(), // no re-read after this one
		];
		const metrics = computeUtilization(entries);
		// 1 of 2 compactions was followed by a read
		assert.ok(Math.abs(metrics.reReadExecutionRate - 0.5) < 0.001);
	});

	test("handles no projection and no compaction as zero denominators", () => {
		const metrics = computeUtilization([
			messageEntry("user", undefined),
			messageEntry("assistant", "bash"),
		]);
		assert.equal(metrics.projectionReRunRate, 0);
		assert.equal(metrics.reReadExecutionRate, 0);
	});
});
