import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Capability name used in probe results. */
export type CapabilityName =
	| "registerEvents"
	| "inspectTools"
	| "inspectThinkingLevel";

/** Per-capability probe outcome. */
export interface CapabilityStatus {
	readonly available: boolean;
	readonly reason?: string;
}

/** Complete capability probe outcome for one pi instance. */
export interface CapabilityProbeResult {
	readonly ok: boolean;
	readonly capabilities: Readonly<Record<CapabilityName, CapabilityStatus>>;
	readonly unavailable: readonly CapabilityName[];
}

/** Capability required for the extension to register lifecycle hooks. */
const REQUIRED_CAPABILITIES: readonly CapabilityName[] = ["registerEvents"];

/** All capabilities probed by this extension. */
const PROBED_CAPABILITIES: readonly CapabilityName[] = [
	"registerEvents",
	"inspectTools",
	"inspectThinkingLevel",
];

/** Probes the pi instance and reports which extension capabilities are usable. */
export function probeCapabilities(
	pi: unknown,
): CapabilityProbeResult {
	const capabilities = probeAll(pi);
	const unavailable = PROBED_CAPABILITIES.filter(
		(name) => capabilities[name].available === false,
	);
	const ok = REQUIRED_CAPABILITIES.every(
		(name) => capabilities[name].available === true,
	);
	return { ok, capabilities, unavailable };
}

/** Probes every capability in isolation so one failure cannot hide others. */
function probeAll(
	pi: unknown,
): Record<CapabilityName, CapabilityStatus> {
	if (!isRecord(pi)) {
		return {
			registerEvents: unavailable("pi is not an object"),
			inspectTools: unavailable("pi is not an object"),
			inspectThinkingLevel: unavailable("pi is not an object"),
		};
	}

	return {
		registerEvents: probeMethod(pi, "on"),
		inspectTools: probeMethod(pi, "getActiveTools"),
		inspectThinkingLevel: probeMethod(pi, "getThinkingLevel"),
	};
}

/** Probes one method by shape, isolating any accessor or call failure. */
function probeMethod(
	pi: Record<string, unknown>,
	methodName: keyof ExtensionAPI,
): CapabilityStatus {
	try {
		const value = pi[methodName];
		return typeof value === "function"
			? { available: true }
			: unavailable(`${methodName} is not a function`);
	} catch (error) {
		return unavailable(formatProbeError(methodName, error));
	}
}

/** Builds a fail-closed status for one probed capability. */
function unavailable(reason: string): CapabilityStatus {
	return { available: false, reason };
}

/** Converts probe failures into stable diagnostics. */
function formatProbeError(
	methodName: string,
	error: unknown,
): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `${methodName} probe failed: ${detail}`;
}

/** Returns true when a value is a plain object suitable for capability probing. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
