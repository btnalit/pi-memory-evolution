import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "./memory-store.ts";

async function createTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pme-memory-"));
}

function draft(id: string, content: string) {
	return {
		id,
		kind: "compaction_summary" as const,
		createdAt: "2026-08-13T04:00:00.000Z",
		sourceEntryId: id.replace("compaction:", ""),
		content,
	};
}

describe("MemoryStore", () => {
	test("round-trips durable memories", async () => {
		const dir = await createTempDir();
		try {
			const store = createMemoryStore(dir);
			store.appendMemory(draft("compaction:a1", "用户偏好本地优先。"));
			const memories = store.readMemories();
			assert.equal(memories.length, 1);
			assert.equal(memories[0].sourceEntryId, "a1");
			assert.equal(memories[0].content, "用户偏好本地优先。");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("deduplicates the same compaction entry", async () => {
		const dir = await createTempDir();
		try {
			const store = createMemoryStore(dir);
			store.appendMemory(draft("compaction:a1", "第一次摘要"));
			store.appendMemory(draft("compaction:a1", "重复摘要"));
			assert.equal(store.readMemories().length, 1);
			assert.equal(store.readMemories()[0].content, "第一次摘要");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("redacts common credentials before persistence", async () => {
		const dir = await createTempDir();
		try {
			const store = createMemoryStore(dir);
			store.appendMemory(
				draft(
					"compaction:a1",
					"api_key=secret123 token=gho_abc123 sk-test_value",
				),
			);
			const content = await readFile(join(dir, "memories.jsonl"), "utf8");
			assert.ok(!content.includes("secret123"));
			assert.ok(!content.includes("gho_abc123"));
			assert.ok(!content.includes("sk-test_value"));
			assert.ok(content.includes("[REDACTED]"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("projects explicit lifecycle actions without rewriting the base record", async () => {
		const dir = await createTempDir();
		try {
			const store = createMemoryStore(dir);
			store.appendMemory(draft("compaction:a1", "旧的项目状态"));
			store.appendAction({ memoryId: "compaction:a1", type: "correct", content: "修正后的项目状态" });
			store.appendAction({ memoryId: "compaction:a1", type: "pin" });
			const memories = store.readMemories();
			assert.equal(memories[0].content, "修正后的项目状态");
			assert.equal(memories[0].status, "confirmed");
			assert.equal(memories[0].layer, "pinned");
			assert.ok((await readFile(join(dir, "memory-actions.jsonl"), "utf8")).split("\n").length >= 3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("marks both sides of an explicit conflict and supports forgetting", async () => {
		const dir = await createTempDir();
		try {
			const store = createMemoryStore(dir);
			store.appendMemory(draft("compaction:a1", "使用 DP-1"));
			store.appendMemory(draft("compaction:a2", "使用 HDMI-1"));
			store.appendAction({ memoryId: "compaction:a1", type: "conflict", conflictWith: "compaction:a2" });
			assert.equal(store.readMemories().every((memory) => memory.status === "conflicted"), true);
			store.appendAction({ memoryId: "compaction:a1", type: "forget" });
			assert.equal(store.readMemories().find((memory) => memory.id === "compaction:a1")?.status, "forgotten");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("ignores malformed records", async () => {
		const dir = await createTempDir();
		try {
			await writeFile(
				join(dir, "memories.jsonl"),
				"not-json\n{\"version\":99}\n",
			);
			assert.deepEqual(createMemoryStore(dir).readMemories(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
