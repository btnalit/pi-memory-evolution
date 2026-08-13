import type { AgendaStore } from "../store/agenda-store.ts";
import { PROPOSAL_TERMINAL_STATUSES } from "../governor/proposal-state.ts";

/** Days an archived execution plan is kept before deletion. */
export const ARCHIVE_RETENTION_DAYS = 90;

/**
 * Archives execution plans of terminal proposals and purges expired archives.
 *
 * A proposal in a terminal state (verified/rejected/rollback_required) no
 * longer needs its plan in the active executions/ directory: the decision is
 * final. Implemented proposals keep their plan because the user may still be
 * executing it manually. Plans without a matching file are skipped idempotently.
 * Archived plans older than the retention window are deleted.
 */
export function archiveTerminalProposals(
	store: AgendaStore,
	now: string,
): { readonly archived: number } {
	const queue = store.readProposalQueue();
	let archived = 0;

	for (const proposal of queue) {
		if (!PROPOSAL_TERMINAL_STATUSES.includes(proposal.status)) {
			continue;
		}
		if (store.archiveExecutionPlan(proposal.id)) {
			archived++;
			store.appendJournal(
				`- ${now} proposal ${proposal.id} (${proposal.title}) execution plan archived (status=${proposal.status})`,
			);
		}
	}

	const purged = store.purgeExpiredArchives(now, ARCHIVE_RETENTION_DAYS);
	if (purged > 0) {
		store.appendJournal(
			`- ${now} purged ${purged} expired execution plan archive(s)`,
		);
	}

	return { archived };
}
