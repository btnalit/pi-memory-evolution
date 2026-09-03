import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { extractStructuredMemories } from "./extractor.ts";

describe("extractStructuredMemories", () => {
	test("maps bounded summary sections to provisional memory kinds", () => {
		const memories = extractStructuredMemories(
			[
				"## Constraints & Preferences",
				"- 用户偏好本地优先。",
				"- 等 USB 适配器到货后配置音响。",
				"## Key Decisions",
				"- 保持人工批准机制。",
				"## Progress",
				"- [x] 持久记忆已写入。",
				"## Critical Context",
				"- 主机名：omarchy。",
			].join("\n"),
			"compaction:c1",
			"2026-09-03T08:00:00.000Z",
		);
		assert.deepEqual(memories.map((memory) => memory.kind), [
			"preference", "preference", "decision", "project_state", "fact",
		]);
		assert.ok(memories.every((memory) => memory.status === "provisional"));
		assert.ok(memories.every((memory) => memory.layer === "durable"));
		assert.ok(memories.every((memory) => memory.id.startsWith("derived:compaction:c1:")));
	});

	test("does not cross section boundaries and skips sensitive bullets", () => {
		const memories = extractStructuredMemories(
			[
				"## Constraints & Preferences",
				"- password=do-not-store",
				"- 只使用本地存储。",
				"## Unrelated Heading",
				"- 这不是一个偏好条目。",
			].join("\n"),
			"c2",
			"2026-09-03T08:00:00.000Z",
		);
		assert.equal(memories.length, 1);
		assert.equal(memories[0].content, "只使用本地存储。");
	});

	test("deduplicates and bounds extracted candidates", () => {
		const bullets = Array.from({ length: 20 }, (_, index) => `- 偏好项目 ${index} 保持本地。`);
		const memories = extractStructuredMemories(
			["## 偏好", ...bullets, "- 偏好项目 0 保持本地。"].join("\n"),
			"c3",
			"2026-09-03T08:00:00.000Z",
		);
		assert.equal(memories.length, 6);
		assert.equal(new Set(memories.map((memory) => memory.id)).size, 6);
	});
});
