import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerificationSignals } from "./proposal-verification.ts";
import {
	createAgendaStore,
	type AgendaStore,
	type ProposalRecord,
} from "../store/agenda-store.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{ store: AgendaStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pme-ver-"));
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

/** Builds one agent message of either role. */
function message(role: string, content: unknown): Record<string, unknown> {
	return { role, content, timestamp: 1 };
}

describe("runVerificationSignals", () => {
	test("verifies an implemented proposal when a message references its id with a verification keyword", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("implemented")]);
			runVerificationSignals(
				store,
				[message("assistant", "已验证 P-20260805-0001")],
				"2026-08-05T12:00:00.000Z",
			);
			const [p] = store.readProposalQueue();
			assert.equal(p.status, "verified");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("accepts the english verification phrasing", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("implemented")]);
			runVerificationSignals(
				store,
				[message("assistant", "P-20260805-0001 verification passed")],
				"2026-08-05T12:00:00.000Z",
			);
			const [p] = store.readProposalQueue();
			assert.equal(p.status, "verified");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("leaves the proposal implemented when no message references its id", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("implemented")]);
			runVerificationSignals(
				store,
				[message("assistant", "验证通过")],
				"2026-08-05T12:00:00.000Z",
			);
			const [p] = store.readProposalQueue();
			assert.equal(p.status, "implemented");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("leaves the proposal implemented when the message lacks a verification keyword", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("implemented")]);
			runVerificationSignals(
				store,
				[message("assistant", "P-20260805-0001 执行完成")],
				"2026-08-05T12:00:00.000Z",
			);
			const [p] = store.readProposalQueue();
			assert.equal(p.status, "implemented");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("only acts on implemented proposals", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([
				proposal("pending_user_approval", "P-20260805-0001"),
				proposal("approved", "P-20260805-0002"),
			]);
			runVerificationSignals(
				store,
				[
					message("assistant", "已验证 P-20260805-0001"),
					message("assistant", "已验证 P-20260805-0002"),
				],
				"2026-08-05T12:00:00.000Z",
			);
			const [a, b] = store.readProposalQueue();
			assert.equal(a.status, "pending_user_approval");
			assert.equal(b.status, "approved");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("ignores tool result messages", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([proposal("implemented")]);
			runVerificationSignals(
				store,
				[message("toolResult", "已验证 P-20260805-0001")],
				"2026-08-05T12:00:00.000Z",
			);
			const [p] = store.readProposalQueue();
			assert.equal(p.status, "implemented");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
