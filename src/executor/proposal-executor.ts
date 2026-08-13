import type {
	AgendaStore,
	ProposalRecord,
} from "../store/agenda-store.ts";
import { transitionProposal } from "../governor/proposal-state.ts";

/**
 * Executes every approved proposal by writing a record-first execution plan.
 *
 * Each approved proposal gets a markdown plan in `executions/` that describes
 * the change, rollback, verification and evidence paths. Real behavior changes
 * stay manual: the user follows the plan outside the extension. A proposal
 * whose plan cannot be written (unsafe id, IO failure) is marked `failed` and
 * the remaining proposals still execute.
 */
export function executeApprovedProposals(
	store: AgendaStore,
	now: string,
): void {
	const queue = store.readProposalQueue();
	let changed = false;

	const updated = queue.map((proposal) => {
		if (proposal.status !== "approved") {
			return proposal;
		}
		changed = true;
		try {
			assertSafePlanId(proposal.id);
			store.writeExecutionPlan(proposal.id, buildExecutionPlanMarkdown(proposal, now));
			const next = transitionProposal(proposal, "implemented", now);
			store.appendJournal(
				`- ${now} proposal ${proposal.id} (${proposal.title}) implemented: execution plan written`,
			);
			return next;
		} catch (error) {
			const next = transitionProposal(proposal, "failed", now);
			store.appendJournal(
				`- ${now} proposal ${proposal.id} (${proposal.title}) failed: ${String(error)}`,
			);
			return next;
		}
	});

	if (changed) {
		store.writeProposalQueue(updated);
	}
}

/** Throws when a proposal id cannot safely become a file name. */
function assertSafePlanId(planId: string): void {
	if (
		planId.length === 0 ||
		planId.includes("/") ||
		planId.includes("\\") ||
		planId.includes("..")
	) {
		throw new Error(`unsafe plan id: ${planId}`);
	}
}

/**
 * Builds the record-first execution plan markdown for one approved proposal.
 *
 * The change/rollback/verification sections are templates with guidance;
 * the evidence section cites the real collected evidence. Nothing here
 * modifies pi or any external file.
 */
export function buildExecutionPlanMarkdown(
	proposal: ProposalRecord,
	now: string,
): string {
	const lines: string[] = [];
	lines.push(`# Execution Plan: ${proposal.title}`);
	lines.push("");
	lines.push(`- proposal: ${proposal.id}`);
	lines.push(`- type: ${proposal.type}`);
	lines.push(`- created: ${now}`);
	lines.push(`- status: manual (record-first, user executes outside the extension)`);
	lines.push("");
	lines.push("## Change");
	lines.push("");
	lines.push(`Proposal: ${proposal.title} (${proposal.type}).`);
	lines.push("Describe the exact change to apply when executing this plan.");
	lines.push("");
	lines.push("## Evidence");
	lines.push("");
	if (proposal.evidence.length === 0) {
		lines.push("(no collected evidence records)");
	} else {
		for (const record of proposal.evidence) {
			lines.push(
				`- ${record.at} [${record.source}] ${record.summary} (weight=${record.weight})`,
			);
		}
	}
	lines.push("");
	lines.push("## Rollback");
	lines.push("");
	lines.push("Describe how to undo this change if it causes problems.");
	lines.push("");
	lines.push("## Verification");
	lines.push("");
	lines.push("Describe how to verify the change works as intended.");
	lines.push("");
	lines.push("## Manual execution checklist");
	lines.push("");
	lines.push("- [ ] Review the change above");
	lines.push("- [ ] Execute the change");
	lines.push("- [ ] Verify per the verification section");
	lines.push("- [ ] Record the result");
	lines.push("");
	return lines.join("\n");
}
