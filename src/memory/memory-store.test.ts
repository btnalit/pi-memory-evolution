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
