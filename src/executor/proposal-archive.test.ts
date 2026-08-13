import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTerminalProposals } from "./proposal-archive.ts";
import {
	createAgendaStore,
	type AgendaStore,
	type ProposalRecord,
} from "../store/agenda-store.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{ store: AgendaStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pme-arch-"));
	const store = createAgendaStore(dir);
	return { store, dir };
}

/** Builds a proposal in a given lifecycle status. */
function proposal(status: ProposalRecord["status"], id = "P-20260805-0001"): ProposalRecord {
	return {
		id,
		title: "测试提案",
		type: "quality_improvement",
		status,
		evidence: [],
		approval: { required: true, approvedBy: null, approvedAt: null },
		timestamps: {
			createdAt: "2026-08-05T00:00:00.000Z",
			updatedAt: "2026-08-05T00:00:00.000Z",
			expiresAt: "2026-08-06T00:00:00.000Z",
		},
	};
}

describe("archiveTerminalProposals", () => {
	test("archives the execution plan of a terminal proposal", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("verified")]);
			store.writeExecutionPlan("P-20260805-0001", "# plan");
			const result = archiveTerminalProposals(store, "2026-08-10T00:00:00.000Z");
			assert.equal(result.archived, 1);
			assert.equal(store.readExecutionPlan("P-20260805-0001"), undefined);
			assert.ok(store.readArchivedPlan("P-20260805-0001") !== undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("archives rejected and rollback_required proposals too", async () => {
		const { store, dir } = await createTempStore();
		try {
			for (const status of ["rejected", "rollback_required"] as const) {
				store.writeProposalQueue([proposal(status)]);
				store.writeExecutionPlan("P-20260805-0001", "# plan");
			}
			store.writeProposalQueue([
				proposal("rejected", "P-20260805-0001"),
				proposal("rollback_required", "P-20260805-0002"),
			]);
			store.writeExecutionPlan("P-20260805-0001", "# a");
			store.writeExecutionPlan("P-20260805-0002", "# b");
			const result = archiveTerminalProposals(store, "2026-08-10T00:00:00.000Z");
			assert.equal(result.archived, 2);
			assert.ok(store.readArchivedPlan("P-20260805-0001") !== undefined);
			assert.ok(store.readArchivedPlan("P-20260805-0002") !== undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("does not archive the plan of an implemented (still active) proposal", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("implemented")]);
			store.writeExecutionPlan("P-20260805-0001", "# plan");
			const result = archiveTerminalProposals(store, "2026-08-10T00:00:00.000Z");
			assert.equal(result.archived, 0);
			assert.ok(store.readExecutionPlan("P-20260805-0001") !== undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("skips terminal proposals without an execution plan", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("rejected")]);
			const result = archiveTerminalProposals(store, "2026-08-10T00:00:00.000Z");
			assert.equal(result.archived, 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("purges expired archives and journals the cleanup", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("verified")]);
			store.writeExecutionPlan("P-20260805-0001", "# plan");
			archiveTerminalProposals(store, "2026-08-10T00:00:00.000Z");
			// Backdate the archived file beyond the 90-day retention window.
			const archivedPath = join(dir, "executions", "archive", "P-20260805-0001.md");
			const { utimes } = await import("node:fs/promises");
			const oldTime = Date.parse("2026-08-10T00:00:00.000Z") - 100 * 24 * 3_600_000;
			await utimes(archivedPath, new Date(oldTime), new Date(oldTime));
			const result = archiveTerminalProposals(store, "2026-08-10T00:00:00.000Z");
			assert.equal(result.archived, 0);
			assert.equal(store.readArchivedPlan("P-20260805-0001"), undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
