import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { probeCapabilities } from "./capability-probe.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Minimal pi-like object with all probed capabilities present. */
function completePi(): Partial<ExtensionAPI> {
	return {
		on: () => undefined,
		getActiveTools: () => [],
		getThinkingLevel: () => "medium",
	};
}

describe("probeCapabilities", () => {
	test("returns ok when all required capabilities are present", () => {
		const result = probeCapabilities(completePi());
		assert.equal(result.ok, true);
		assert.equal(result.capabilities.registerEvents.available, true);
		assert.deepEqual(result.unavailable, []);
	});

	test("fails when the on method is missing", () => {
		const result = probeCapabilities({} as Partial<ExtensionAPI>);
		assert.equal(result.ok, false);
		assert.equal(result.capabilities.registerEvents.available, false);
		assert.ok(result.unavailable.includes("registerEvents"));
	});

	test("fails closed when pi is not an object", () => {
		const result = probeCapabilities(undefined as unknown as ExtensionAPI);
		assert.equal(result.ok, false);
		assert.equal(result.capabilities.registerEvents.available, false);
	});

	test("reports optional capabilities as unavailable without failing", () => {
		const pi = {
			on: () => undefined,
		} as Partial<ExtensionAPI>;
		const result = probeCapabilities(pi);
		assert.equal(result.ok, true);
		assert.equal(result.capabilities.inspectTools.available, false);
		assert.equal(result.capabilities.inspectThinkingLevel.available, false);
	});

	test("records a reason when a capability is unavailable", () => {
		const result = probeCapabilities({} as Partial<ExtensionAPI>);
		assert.ok(result.capabilities.registerEvents.reason !== undefined);
	});

	test("keeps a throwing getter isolated from other probes", () => {
		const pi = {
			on: () => undefined,
			get getActiveTools() {
				throw new Error("probe failure");
			},
		} as unknown as Partial<ExtensionAPI>;
		const result = probeCapabilities(pi);
		assert.equal(result.ok, true);
		assert.equal(result.capabilities.inspectTools.available, false);
	});
});
