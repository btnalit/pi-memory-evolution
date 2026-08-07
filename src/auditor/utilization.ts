/** Minimal session-entry shape consumed by utilization computation. */
export interface SessionEntryLike {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
	readonly message?: {
		readonly role?: string;
		readonly content?: readonly { readonly type?: string; readonly text?: string }[];
		readonly toolName?: string;
	};
	readonly summary?: string;
}

/** Utilization metrics derived from one session branch. */
export interface UtilizationMetrics {
	/** Share of projected tool results that were re-run by the agent. */
	readonly projectionReRunRate: number;
	/** Share of compactions followed by a source re-read. */
	readonly reReadExecutionRate: number;
}

/** Default notice text that context-projection inserts for projected results. */
const DEFAULT_OMITTED_NOTICE = "Result omitted. Run tool again for full result.";

/** Default summary notice text for summarized projected results. */
const DEFAULT_SUMMARY_NOTICE =
	"Full result omitted. Summary below. Run tool again for full result.";

/** Tool name whose calls count as a source re-read. */
const RE_READ_TOOL = "read";

/** Computes utilization metrics from one session branch. */
export function computeUtilization(
	entries: readonly SessionEntryLike[],
): UtilizationMetrics {
	let projectedResults = 0;
	let reRunProjections = 0;
	let compactions = 0;
	let reReadAfterCompaction = 0;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "compaction") {
			compactions += 1;
			if (hasFollowingRead(entries, index + 1)) {
				reReadAfterCompaction += 1;
			}
			continue;
		}
		if (entry.type !== "message" || entry.message === undefined) {
			continue;
		}

		const message = entry.message;
		if (message.role === "toolResult" && isProjectedResult(message)) {
			projectedResults += 1;
			if (hasFollowingCall(entries, index + 1, message.toolName)) {
				reRunProjections += 1;
			}
		}
	}

	return {
		projectionReRunRate:
			projectedResults === 0 ? 0 : reRunProjections / projectedResults,
		reReadExecutionRate:
			compactions === 0 ? 0 : reReadAfterCompaction / compactions,
	};
}

/** Returns true when a tool result message carries a projection notice. */
function isProjectedResult(message: NonNullable<SessionEntryLike["message"]>): boolean {
	const content = message.content ?? [];
	return content.some(
		(part) =>
			part.type === "text" &&
			(part.text.includes(DEFAULT_OMITTED_NOTICE) ||
				part.text.includes(DEFAULT_SUMMARY_NOTICE)),
	);
}

/** Returns true when the same tool is called again after the given index. */
function hasFollowingCall(
	entries: readonly SessionEntryLike[],
	startIndex: number,
	toolName: string | undefined,
): boolean {
	if (toolName === undefined) {
		return false;
	}
	for (let index = startIndex; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message === undefined) {
			continue;
		}
		if (
			entry.message.role === "assistant" &&
			entry.message.toolName === toolName
		) {
			return true;
		}
	}
	return false;
}

/** Returns true when a read tool is called after the given index. */
function hasFollowingRead(
	entries: readonly SessionEntryLike[],
	startIndex: number,
): boolean {
	for (let index = startIndex; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message === undefined) {
			continue;
		}
		if (
			entry.message.role === "assistant" &&
			entry.message.toolName === RE_READ_TOOL
		) {
			return true;
		}
	}
	return false;
}
