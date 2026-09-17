import type { DurableMemory } from "./memory-store.ts";
import { clipBytes, fingerprint, redact } from "./privacy.ts";
import { features, featureOffset } from "./search.ts";
import { memoryQuality } from "./quality.ts";
import { MIN_FOCUS_COVERAGE } from "./limits.ts";
import { FACETS, pastedLiterals, queryFeatures, resolveRecallQuery, type RecallInput } from "./query.ts";
export { recallQuery, resolveRecallQuery } from "./query.ts";

function overlap(text: string, query: Set<string>): number {
	const tokens = features(text);
	return [...query].filter((word) => tokens.has(word)).length;
}

/** Relevance scores are NOT confidence/truth scores. No authority bonus for cwd,
 * legacy labels, source IDs or dates. Metadata can only help an explicit origin query. */
type RecallOptions = { includeDormant?: boolean };
type RankedMemory = { memory: DurableMemory; score: number; rankScore: number; quality: ReturnType<typeof memoryQuality>; coverage: number; matches: string[]; reason?: string };
export interface RecallDiagnostics {
	mode: string;
	query: string[];
	context: string[];
	eligible: number;
	excluded: number;
	matched: number;
	selected: string[];
	candidates: { id: string; score: number; rankScore: number; quality: ReturnType<typeof memoryQuality>; coverage: number; matches: string[]; reason: string }[];
	exclusions?: { id: string; reason: string }[];
}

function evaluate(memories: readonly DurableMemory[], prompt: RecallInput, now: number, options: RecallOptions) {
	const plan = typeof prompt === 'string' ? resolveRecallQuery(prompt) : prompt;
	const query = queryFeatures(plan.query);
	const context = queryFeatures(plan.context ?? '');
	for (const word of query) context.delete(word);
	const qualities = new Map(memories.map(m => [m.id, memoryQuality(m, now)]));
	const excludedReason = (m: DurableMemory) => ["forgotten", "conflicted"].includes(m.status) ? m.status
		: m.feedback?.accuracy?.verdict === "incorrect" ? "disputed"
		: !options.includeDormant && qualities.get(m.id)!.dormant ? "dormant" : undefined;
	const active = memories.filter(m => !excludedReason(m));
	const diagnostics: RecallDiagnostics = { mode: plan.mode, query: [...query].slice(0, 32), context: [...context].slice(0, 32),
		eligible: active.length, excluded: memories.length - active.length, matched: 0, selected: [], candidates: [],
		exclusions: memories.filter(m => excludedReason(m)).slice(0, 10).map(m => ({ id: clipBytes(redact(m.id), 120), reason: excludedReason(m)! })) };
	if (!query.size) return { ranked: [] as RankedMemory[], diagnostics };
	// Repeated origins/aliases (and duplicate legacy text) need segmentation only once
	// per query. No persistent cache of user queries or credential-bearing input.
	const cache = new Map<string, Set<string>>();
	const tokenize = (text: string) => {
		let result = cache.get(text);
		if (!result) { result = features(text); cache.set(text, result); }
		return result;
	};
	const documents = active.map((memory) => ({ memory,
		// A quoted question in an incident/replay note is a mention, not its answer.
		body: tokenize(memory.content.replace(/“[^”\n]*[?？]”|「[^」\n]*[?？]」|"[^"\n]*[?？]"/gu, ' ')),
		mentions: tokenize(memory.content),
		aliases: tokenize((memory.searchTerms ?? []).join(" ")),
		origin: new Set(memory.scope === "legacy" ? [] : [...tokenize(memory.scope),
			...tokenize(memory.scope.split(/[\\/]/u).at(-1) ?? "")].filter((word) => !word.startsWith("concept:"))) }));
	const unknown = new Set<string>();
	const frequency = new Map<string, number>();
	const weights = new Map([...query, ...context].map((word) => {
		const df = documents.filter((d) => d.mentions.has(word) || d.aliases.has(word) || d.origin.has(word)).length;
		frequency.set(word, df);
		if (!df) unknown.add(word);
		// No evidence is not rare evidence: unseen question words must not receive
		// the largest IDF. Exact resource constraints and thin-match gates still apply.
		return [word, (word.startsWith("literal:") ? 2 : 1) * (df ? 1 + Math.log((documents.length + 1) / (df + 1)) : 1)];
	}));
	// A word names a topic only if it is rare in the store. The subject side is only as strong as
	// its weakest alias: the evolution prompt asks for aliases grounded in the claim, so a compliant
	// model writes `server` for a note about the server room, and that everyday word then carried the
	// note onto any task prompt mentioning a server — while its alias-less twin was correctly held
	// out. Rarity is data-driven and prompt-invariant, the property the subject side already has:
	// the same document frequency that weights the word decides whether it can name anything.
	// Exact paths and filenames are identities, not vocabulary, and are exempt.
	const rare = (word: string) => frequency.get(word)! <= Math.max(2, 0.02 * documents.length);
	const total = [...query].reduce((sum, word) => sum + weights.get(word)!, 0);
	// Every literal the user typed is a constraint on every record. One that arrived inside pasted
	// material — a stack frame, a diff, fenced code, a file:line reference — keeps its weight above
	// but is not required, or a trace ahead of the ask would reject the whole store (query.ts).
	const pasted = new Set([...pastedLiterals(plan.query), ...pastedLiterals(plan.context ?? '')]);
	const literals = [...query, ...context].filter(word => word.startsWith('literal:') && !pasted.has(word));
	const subjects = [...context].filter(word => !FACETS.has(word));
	const subjectWeight = subjects.reduce((sum, word) => sum + weights.get(word)!, 0);
	const namedSubjects = subjects.filter(word => !word.startsWith('concept:'));
	// A short named-subject attribute query must not substitute another subject or
	// another attribute when its best answer has been forgotten/quarantined.
	// Generic status/progress words describe the request, not a required answer token.
	const directNames = [...query].filter(word => !word.startsWith('concept:') && !word.startsWith('literal:') && !/^\d/u.test(word) && !FACETS.has(word));
	const directFacets = [...query].filter(word => FACETS.has(word) && !['concept:status', 'concept:progress', 'error', '错误'].includes(word));
	const focusedDirect = !context.size && query.size <= 4 && directNames.length === 1 && directFacets.length > 0;
	const evaluated: RankedMemory[] = documents.map(({ memory, body, mentions, aliases, origin }) => {
		let score = 0, covered = 0, focusMatches = 0, evidenceMatches = 0, topicMatches = 0;
		const matches: string[] = [];
		for (const [word, weight] of weights) {
			const factor = body.has(word) ? 1 : aliases.has(word) ? 0.8 : mentions.has(word) ? 0.25 : origin.has(word) ? 0.2 : 0;
			if (factor) {
				score += weight * factor * (query.has(word) ? 1 : 0.35);
				if (query.has(word)) {
					covered += weight; focusMatches++;
					if (body.has(word) || aliases.has(word) || origin.has(word)) evidenceMatches++;
					// Something that names a topic, as opposed to a word that merely occurs in one:
					// an exact resource identity, or — when rare in the store — a curated concept
					// synonym or one of the aliases the model wrote for this very claim. See the
					// subject gate below, and `rare` above for why an everyday alias is not a name.
					if (word.startsWith('literal:') || ((word.startsWith('concept:') || aliases.has(word)) && rare(word))) topicMatches++;
				}
				matches.push(word);
			}
		}
		// Mild length normalization rewards focused evidence without erasing useful
		// long claims or letting brevity overcome a missing subject/constraint.
		score *= 0.8 + 0.2 * Math.min(1, 12 / Math.max(1, body.size));
		const coverage = covered / total;
		const reason = literals.some(word => !matches.includes(word)) ? 'resource-mismatch'
			: !focusMatches ? 'no-focus-match'
			: !evidenceMatches ? 'question-only'
			: focusedDirect && (directNames.some(word => !body.has(word) && !aliases.has(word) && !origin.has(word))
				|| directFacets.some(word => !body.has(word) && !aliases.has(word))) ? 'subject-attribute-mismatch'
			: (namedSubjects.length ? namedSubjects.some(word => !matches.includes(word))
				: subjects.length && subjects.filter(word => matches.includes(word)).reduce((sum, word) => sum + weights.get(word)!, 0) / subjectWeight < 0.6) ? 'context-mismatch'
			// Either side may carry a record: the prompt is mostly about it (the query-side floor), or
			// the prompt NAMES its topic. Requiring the query side alone made injection fail precisely
			// as a user said more, which is the normal shape of a task prompt. Measuring the subject
			// side as a share of the record's own vocabulary — the store's candidate containment —
			// made it fail as the CLAIM said more instead: a claim may run to 800 characters and carry
			// eight bilingual aliases, so the same two matches that carried a one-line claim sank once
			// it explained itself, and the aliases written to widen a record's recall narrowed it. No
			// share of the record can be the floor here; what the prompt engages is. See limits.ts.
			// Bare prose words cannot carry a record on this side: on a long prompt two coincidental
			// everyday words ("server", "needs") are as many matches as the two words that are a
			// claim's actual topic, and score no lower. Measured on a 20-record store, an unrelated
			// badge-access note and an unrelated onboarding note were both injected next to the correct
			// preference on one ordinary task prompt. So require at least one match that NAMES a topic —
			// a curated concept synonym, an exact path/filename, or one of the model-written aliases for
			// this claim. The query side is unaffected: a prompt that really is about a record needs none.
			: coverage < MIN_FOCUS_COVERAGE && !topicMatches ? 'incidental-overlap'
			: (query.size >= 3 && focusMatches < 2) || (focusMatches === 1 && [...query].some(word => unknown.has(word) && !FACETS.has(word))) ? 'thin-match'
			: undefined;
		const quality = qualities.get(memory.id)!;
		return { memory, score, rankScore: score * quality.factor, quality, coverage, matches, reason };
	});
	const best = evaluated.reduce((best, r) => !r.reason ? Math.max(best, r.score) : best, 0);
	// Quality only orders already-relevant evidence. It cannot rescue weak matches.
	for (const item of evaluated) if (!item.reason && item.score < best * 0.75) item.reason = 'relative-cutoff';
	evaluated.sort((a,b) => b.rankScore-a.rankScore || Number(b.memory.layer === "pinned")-Number(a.memory.layer === "pinned")
		|| Date.parse(b.memory.updatedAt)-Date.parse(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
	const ranked = evaluated.filter(r => !r.reason);
	diagnostics.matched = ranked.length;
	diagnostics.candidates = evaluated.filter(r => r.score > 0).slice(0, 10).map(r => ({ id: clipBytes(redact(r.memory.id), 120),
		score: Number(r.score.toFixed(3)), rankScore: Number(r.rankScore.toFixed(3)), quality: r.quality,
		coverage: Number(r.coverage.toFixed(3)), matches: r.matches.slice(0, 16), reason: r.reason ?? 'eligible' }));
	return { ranked, diagnostics };
}

export function rankMemories(memories: readonly DurableMemory[], prompt: RecallInput, now = Date.now(), options: RecallOptions = {}) {
	return evaluate(memories, prompt, now, options).ranked;
}

function selectRanked(ranked: RankedMemory[], limit: number): DurableMemory[] {
	if (limit <= 0) return [];
	const selected: DurableMemory[] = [];
	const seen = new Set<string>();
	const covered = new Map<string, Set<string>>();
	for (const { memory, matches } of ranked) {
		const key = fingerprint(JSON.stringify([memory.scope, memory.content]));
		if (seen.has(key)) continue;
		// For specific multi-feature questions, don't spend another slot repeating the
		// same matched facets from the same origin. Different origins remain distinct.
		// A progress note mentioning a question must not hide a preference/fact that
		// answers it. Facet diversity is tracked separately for each evidence kind.
		const facetKey = JSON.stringify([memory.scope, memory.kind]);
		const previous = covered.get(facetKey) ?? new Set<string>();
		if (matches.length >= 2 && ranked[0].matches.length >= 3 && matches.every((term) => previous.has(term))) continue;
		seen.add(key); matches.forEach((term) => previous.add(term)); covered.set(facetKey, previous);
		selected.push(memory);
		if (selected.length >= limit) break;
	}
	return selected;
}

/** One evaluation for both injection and transient diagnostics; never persists queries. */
export function retrieveMemories(memories: readonly DurableMemory[], prompt: RecallInput, limit = 3, now = Date.now(), options: RecallOptions = {}) {
	const { ranked, diagnostics } = evaluate(memories, prompt, now, options);
	const selected = selectRanked(ranked, limit);
	diagnostics.selected = selected.map(m => clipBytes(redact(m.id), 120));
	for (const item of diagnostics.candidates) if (item.reason === 'eligible') {
		item.reason = diagnostics.selected.includes(item.id) ? 'selected' : 'selection-limit-or-redundancy';
	}
	return { selected, diagnostics };
}

export function selectRelevantMemories(memories: readonly DurableMemory[], prompt: RecallInput, limit = 3, now = Date.now(), options: RecallOptions = {}): DurableMemory[] {
	return retrieveMemories(memories, prompt, limit, now, options).selected;
}

/** Use the matching sentence instead of blindly cutting off the beginning. */
export function excerpt(content: string, prompt: RecallInput, budget = 400): string {
	const clean = redact(content).trim();
	if (Buffer.byteLength(clean) <= budget) return clean;
	if (budget <= 3) return clipBytes(clean, Math.max(0, budget));
	const query = queryFeatures(typeof prompt === 'string' ? prompt : prompt.query);
	const context = queryFeatures(typeof prompt === 'string' ? '' : prompt.context ?? '');
	const sentences = clean.split(/(?<=[。！？!?])\s*|(?<=\.)\s+|\n+/u).filter(Boolean);
	sentences.sort((a,b) => overlap(b, query)-overlap(a, query) || overlap(b, context)-overlap(a, context));
	const best = sentences[0] ?? clean;
	if (Buffer.byteLength(best) <= budget - 3) return best + "…";
	const positions = [...query].map((word) => featureOffset(best, word)).filter((index) => index >= 0);
	const offset = positions.length ? Math.min(...positions) : 0;
	// Keep a little preceding context, cutting only at code-point boundaries.
	const reversed = [...best.slice(0, offset)].reverse().join("");
	const prefix = [...clipBytes(reversed, Math.floor((budget - 6) / 3))].reverse().join("");
	const start = offset - prefix.length;
	const lead = start > 0 && budget >= 6 ? "…" : "";
	return lead + clipBytes(best.slice(start), budget - Buffer.byteLength(lead) - 3) + "…";
}
