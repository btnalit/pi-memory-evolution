import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	matchSignalsToAgenda,
	type SignalRecord,
} from "./evidence.ts";
import type { AgendaMatchers } from "../store/agenda-store.ts";

/** Builds a signal record. */
function signal(
	overrides: Partial<SignalRecord> = {},
): SignalRecord {
	return {
		ts: "2026-08-05T00:00:00.000Z",
		type: "feedback",
		source: "turn_end",
		...overrides,
	};
}

/** Builds agenda matchers. */
function matchers(overrides: Partial<AgendaMatchers> = {}): AgendaMatchers {
	return {
		signalTypes: [],
		includeKeywords: [],
		excludeKeywords: [],
		...overrides,
	};
}

describe("matchSignalsToAgenda", () => {
	test("matches all signals when no matchers restrict them", () => {
		const signals = [
			signal({ type: "feedback", ts: "2026-08-05T00:00:00.000Z" }),
			signal({ type: "projection", ts: "2026-08-05T00:00:00.000Z" }),
		];
		const evidence = matchSignalsToAgenda(signals, matchers(), "2026-08-05T00:00:00.000Z");
		assert.equal(evidence.length, 2);
	});

	test("filters by signal type", () => {
		const signals = [
			signal({ type: "feedback" }),
			signal({ type: "projection" }),
		];
		const evidence = matchSignalsToAgenda(
			signals,
			matchers({ signalTypes: ["projection"] }),
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(evidence.length, 1);
		assert.equal(evidence[0].source, "projection");
	});

	test("filters by include keyword against serialized signal text", () => {
		const signals = [
			signal({ type: "feedback", keywords: ["不对"] }),
			signal({ type: "feedback", keywords: ["继续"] }),
		];
		const evidence = matchSignalsToAgenda(
			signals,
			matchers({ includeKeywords: ["不对"] }),
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(evidence.length, 1);
	});

	test("excludes signals carrying an exclude keyword", () => {
		const signals = [
			signal({ type: "feedback", keywords: ["不对"] }),
			signal({ type: "projection", count: 1 }),
		];
		const evidence = matchSignalsToAgenda(
			signals,
			matchers({ excludeKeywords: ["projection"] }),
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(evidence.length, 1);
		assert.equal(evidence[0].source, "feedback");
	});

	test("assigns weight and classification from the signal type", () => {
		const evidence = matchSignalsToAgenda(
			[signal({ type: "feedback" })],
			matchers(),
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(evidence[0].weight, 0.3);
		assert.equal(evidence[0].qualified, true);
		assert.equal(evidence[0].actionable, true);
	});

	test("returns empty when no signals match", () => {
		const evidence = matchSignalsToAgenda(
			[signal({ type: "projection" })],
			matchers({ signalTypes: ["feedback"] }),
			"2026-08-05T00:00:00.000Z",
		);
		assert.deepEqual(evidence, []);
	});
});
