import type {
	AgendaCandidate,
	ProposalRecord,
	SpeakDecision,
} from "../store/agenda-store.ts";
import type { DurableMemory } from "../memory/memory-store.ts";

/** Inputs required to build the runtime digest. */
export interface DigestInput {
	readonly now: string;
	readonly candidates: readonly AgendaCandidate[];
	readonly decisions: readonly SpeakDecision[];
	readonly proposals: readonly ProposalRecord[];
	readonly memories?: readonly DurableMemory[];
}

/** Maximum digest size in characters (~2KB token budget). */
const DIGEST_SIZE_LIMIT = 2048;

/** Hours until the digest expires. */
const DIGEST_VALID_HOURS = 24;

/** Builds the session-injected runtime digest, or undefined when empty. */
export function buildRuntimeDigest(input: DigestInput): string | undefined {
	const pendingProposals = input.proposals.filter(
		(proposal) => proposal.status === "pending_user_approval",
	);
	if (
		input.candidates.length === 0 &&
		input.decisions.length === 0 &&
		pendingProposals.length === 0 &&
		(input.memories?.length ?? 0) === 0
	) {
		return undefined;
	}

	const lines: string[] = [];
	lines.push("# Pi Memory Evolution Runtime Digest");
	lines.push(`Last updated: ${formatStamp(input.now)}`);
	lines.push(`Valid until: ${formatValidUntil(input.now)}`);
	lines.push("");

	if (input.memories !== undefined && input.memories.length > 0) {
		lines.push("## Relevant Durable Memory");
		for (const memory of input.memories) {
			const content = memory.content.replace(/\s+/g, " ").trim();
			lines.push(`- [${formatStamp(memory.createdAt)}] ${content}`);
		}
		lines.push("");
	}

	if (input.candidates.length > 0) {
		lines.push("## Proposals Awaiting Your Decision");
		for (const candidate of input.candidates.slice(0, 3)) {
			lines.push(
				`- **${candidate.title}** (maturity=${candidate.maturityScore.toFixed(2)})`,
			);
		}
		lines.push("");
	}

	if (input.decisions.length > 0) {
		lines.push("## Recent Speak Decisions");
		for (const decision of input.decisions.slice(0, 3)) {
			lines.push(
				`- ${decision.title} → ${decision.action} (priority=${decision.priorityScore.toFixed(2)})`,
			);
		}
		lines.push("");
	}

	if (pendingProposals.length > 0) {
		lines.push("## Proposals Awaiting Approval");
		for (const proposal of pendingProposals.slice(0, 3)) {
			lines.push(
				`- **${proposal.id}** ${proposal.title} (expires ${formatStamp(proposal.timestamps.expiresAt)})`,
			);
		}
		lines.push("");
	}

	lines.push("## Runtime Guidance");
	lines.push(
		"- This digest is advisory; the user's current task takes priority.",
	);

	const digest = lines.join("\n");
	return digest.length <= DIGEST_SIZE_LIMIT ? digest : truncate(digest);
}

/** Formats an ISO timestamp as YYYY-MM-DD HH:MM in UTC. */
function formatStamp(iso: string): string {
	return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

/** Formats the expiry stamp (now + 24h) as YYYY-MM-DD HH:MM in UTC. */
function formatValidUntil(iso: string): string {
	const expiry = new Date(Date.parse(iso) + DIGEST_VALID_HOURS * 3_600_000);
	return expiry.toISOString().slice(0, 16).replace("T", " ");
}

/** Truncates the digest to the size limit while keeping the header. */
function truncate(digest: string): string {
	const budget = DIGEST_SIZE_LIMIT - 64;
	return digest.length > budget ? `${digest.slice(0, budget)}\n[truncated]` : digest;
}
