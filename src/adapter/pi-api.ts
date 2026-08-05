import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

/**
 * Extension-owned pi dependency surface.
 *
 * Business code must only touch these types. The concrete pi object is
 * narrowed to this surface by isMemoryEvolutionHost() at the extension
 * entry, so a pi API change only requires an adapter update.
 */

/** Minimal pi surface required by this extension. */
export interface MemoryEvolutionHost {
	readonly on: (
		event: string,
		handler: (...args: unknown[]) => unknown,
	) => void;
}

/** Agent message type narrowed from the pi agent-end event contract. */
export type PiAgentMessage = AgentEndEvent["messages"][number];

/** Narrowing guard that proves a value satisfies MemoryEvolutionHost. */
export function isMemoryEvolutionHost(
	value: unknown,
): value is MemoryEvolutionHost {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>).on === "function"
	);
}
