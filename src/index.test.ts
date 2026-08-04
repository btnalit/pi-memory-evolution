import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import memoryEvolution from "./index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Records pi.on registrations for assertion. */
interface RegisteredHook {
	readonly event: string;
	readonly handler: (...args: unknown[]) => unknown;
}

/** Minimal pi-like object that records hook registrations. */
function recordingPi(): {
	pi: Partial<ExtensionAPI>;
	registered: RegisteredHook[];
} {
	const registered: RegisteredHook[] = [];
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			registered.push({ event, handler });
		},
	} as Partial<ExtensionAPI>;
	return { pi, registered };
}

describe("memoryEvolution extension entry", () => {
	test("registers before_agent_start when capabilities are available", () => {
		const { pi, registered } = recordingPi();
		memoryEvolution(pi as ExtensionAPI);
		const events = registered.map((hook) => hook.event);
		assert.ok(events.includes("before_agent_start"));
	});

	test("does not throw when pi lacks required capabilities", () => {
		assert.doesNotThrow(() =>
			memoryEvolution({} as ExtensionAPI),
		);
		assert.doesNotThrow(() =>
			memoryEvolution(undefined as unknown as ExtensionAPI),
		);
	});

	test("does not register hooks when on is missing", () => {
		const { pi, registered } = recordingPi();
		delete (pi as Record<string, unknown>).on;
		memoryEvolution(pi as ExtensionAPI);
		assert.equal(registered.length, 0);
	});

	test("before_agent_start handler returns undefined without failing", async () => {
		const { pi, registered } = recordingPi();
		memoryEvolution(pi as ExtensionAPI);
		const hook = registered.find(
			(item) => item.event === "before_agent_start",
		);
		assert.ok(hook !== undefined);
		const result = await hook.handler(
			{ type: "before_agent_start" },
			{},
		);
		assert.equal(result, undefined);
	});
});
