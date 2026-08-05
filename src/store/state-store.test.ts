import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createStateStore,
	getStateDir,
	type StateStore,
} from "./state-store.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{ store: StateStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pme-store-"));
	const store = createStateStore(dir);
	return { store, dir };
}

describe("getStateDir", () => {
	test("resolves under the pi agent dir with the extension convention", () => {
		const dir = getStateDir("/tmp/fake-pi-agent");
		assert.equal(dir, "/tmp/fake-pi-agent/agent-suite/memory-evolution");
	});
});

describe("StateStore.appendSignal", () => {
	test("writes one JSON line to signals.jsonl with a version field", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.appendSignal({
				ts: "2026-08-04T00:00:00.000Z",
				type: "session_stats",
				source: "agent_end",
				messageCount: 3,
			});
			const content = await readFile(join(dir, "signals.jsonl"), "utf8");
			const lines = content.trim().split("\n");
			assert.equal(lines.length, 1);
			const record = JSON.parse(lines[0]);
			assert.equal(record.version, 1);
			assert.equal(record.type, "session_stats");
			assert.equal(record.messageCount, 3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("appends multiple signals as separate lines", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.appendSignal({ ts: "t1", type: "session_stats", source: "a" });
			store.appendSignal({ ts: "t2", type: "projection", source: "b", count: 2 });
			const content = await readFile(join(dir, "signals.jsonl"), "utf8");
			const lines = content.trim().split("\n");
			assert.equal(lines.length, 2);
			assert.equal(JSON.parse(lines[1]).count, 2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("StateStore.appendJournal", () => {
	test("writes markdown lines to evolution_journal.md", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.appendJournal("- 2026-08-04T00:00:00Z signal collection started");
			store.appendJournal("- 2026-08-04T00:01:00Z session stats recorded");
			const content = await readFile(join(dir, "evolution_journal.md"), "utf8");
			assert.equal(content.trim().split("\n").length, 2);
			assert.ok(content.includes("signal collection started"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("StateStore stateDir", () => {
	test("creates the state directory on first write", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.appendSignal({ ts: "t", type: "session_stats", source: "a" });
			const entries = await readdir(dir);
			assert.deepEqual(entries.sort(), ["signals.jsonl"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
