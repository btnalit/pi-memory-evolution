import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { selectRelevantMemories, DEFAULT_MEMORY_CHAR_BUDGET } from "./retriever.ts";
import type { DurableMemory } from "./memory-store.ts";

function memory(id: string, content: string, createdAt: string): DurableMemory {
	return {
		version: 1,
		id,
		kind: "compaction_summary",
		createdAt,
		sourceEntryId: id,
		content,
	};
}

describe("selectRelevantMemories", () => {
	test("selects memories relevant to the current prompt", () => {
		const selected = selectRelevantMemories([
			memory("audio", "蓝牙音响已配对，PipeWire 是默认音频输出。", "2026-08-13T04:00:00.000Z"),
			memory("display", "显示器固定使用 1680x1050。", "2026-08-13T05:00:00.000Z"),
		], "继续配置蓝牙音响");
		assert.equal(selected.length, 1);
		assert.ok(selected[0].content.includes("蓝牙音响"));
	});

	test("falls back to recent context for continuation prompts", () => {
		const selected = selectRelevantMemories([
			memory("old", "很早以前的记录", "2026-08-10T04:00:00.000Z"),
			memory("recent", "最近的项目进展", "2026-08-13T04:00:00.000Z"),
		], "继续上次的工作");
		assert.equal(selected[0].id, "recent");
	});

	test("does not inject unrelated context", () => {
		const selected = selectRelevantMemories([
			memory("audio", "蓝牙音响已配对。", "2026-08-13T04:00:00.000Z"),
		], "帮我写一个排序算法");
		assert.deepEqual(selected, []);
	});

	test("respects the character budget", () => {
		const selected = selectRelevantMemories([
			memory("a", "蓝牙音响配置完成。".repeat(200), "2026-08-13T04:00:00.000Z"),
		], "蓝牙音响", 3, DEFAULT_MEMORY_CHAR_BUDGET);
		assert.ok(selected[0].content.length <= DEFAULT_MEMORY_CHAR_BUDGET);
	});
});
