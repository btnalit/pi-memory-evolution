import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	probeCapabilities,
	type CapabilityProbeResult,
} from "./adapter/capability-probe.ts";

/** Event hook name that carries the assembled system prompt into every session. */
const BEFORE_AGENT_START_EVENT = "before_agent_start";

/** Registers the memory-evolution lifecycle hooks with capability-aware degradation. */
export default function memoryEvolution(pi: ExtensionAPI): void {
	const probe = probeCapabilities(pi);
	if (!probe.ok) {
		return;
	}

	pi.on(BEFORE_AGENT_START_EVENT, () => {
		handleBeforeAgentStart(probe);
		return undefined;
	});
}

/** Placeholder for future runtime-digest injection (design phase P3). */
function handleBeforeAgentStart(_probe: CapabilityProbeResult): void {
	return;
}
