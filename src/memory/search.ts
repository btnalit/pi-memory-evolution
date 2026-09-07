import { redact } from "./privacy.ts";

// Small, explicit bilingual bootstrap for existing records, not a general translator.
// New model-derived searchTerms extend recall beyond this vocabulary without model calls
// on the recall path. Synonyms form ONE feature, not several independent votes.
const CONCEPTS: [string, RegExp][] = [
	["memory", /记忆|\bmemor(?:y|ies)\b/giu],
	["session", /会话|\bsessions?\b/giu],
	["project", /项目|\bprojects?\b/giu],
	["directory", /目录|文件夹|\b(?:director(?:y|ies)|folders?|cwd)\b/giu],
	["cross-context", /跨会话|跨项目|跨目录|限定|限制|不限于?|\b(?:across|regardless|restrict(?:ed|ion|ions)?|limit(?:ed|ation|ations)?|cross-session|cross-project|cross-directory)\b/giu],
	["recall", /召回|检索|\b(?:recall|retrieval|retrieve|search)\b/giu],
	["injection", /注入|\binject(?:ion|ed|ing)?\b/giu],
	["preference", /偏好|\bprefer(?:ence|ences|red)?\b/giu],
	["model", /模型|\bmodels?\b/giu],
	["auth", /认证|鉴权|\b(?:auth|authentication|authorization)\b/giu],
	["reuse", /复用|重用|\breus(?:e|ed|ing)\b/giu],
	["database", /数据库|\bdatabases?\b/giu],
	["port", /端口|\bports?\b/giu],
	["network", /网络|\bnetwork(?:s|ing)?\b/giu],
	["bluetooth", /蓝牙|\bbluetooth\b/giu],
	["audio", /音响|音频|\b(?:audio|speakers?)\b/giu],
	["review", /审查|审阅|\breview(?:ed|ing)?\b/giu],
	["commit", /提交|\bcommit(?:s|ted|ting)?\b/giu],
	["push", /推送|\bpush(?:ed|ing)?\b/giu],
	["progress", /进度|进展|\bprogress\b/giu],
	["pending", /尚未|仍在|待完成|未完成|\b(?:pending|not yet|in progress)\b/giu],
	["done", /已完成|完成了|\b(?:completed|finished|done)\b/giu],
	["test", /测试|\btests?(?:ing|ed)?\b/giu],
	["verification", /验证|校验|\b(?:verify|verified|verification|validation|validate)\b/giu],
];
const STOP = new Set(`的 了 是 在 有 没有 现在 目前 当前 这个 那个 这些 那些 什么 哪些 哪个 为什么 怎样 如何 怎么 是否 可以 需要 问题 看看 一下 我们 你们 然后 但是 以及 关于 帮我 谢谢 应该 还是 继续 之前 上次 修复 修改 检查 处理 记住
 the and for with continue resume previous this that these those it its they them their we our you your i me my a an of to in on at is are was were be been do does did has have had no not without now current currently what which who how why can could should would please help check look see any there here also just again about other anything something else one problem problems issue issues wrong broken use used using work home src tmp user users fix change changes need remember discuss show describe explain tell where`.split(/\s+/u));
const WORDS = new Intl.Segmenter("zh", { granularity: "word" });
// Paths and filenames are an exact-literal channel. Their components must not turn a
// repository named pi-memory-evolution into evidence about the meaning of "memory".
const LITERALS = /(?<![\p{L}\p{N}_])(?:~?\/|\.\.?\/)[^\s`"'<>，。！？,;!?]+|(?<![\w./-])(?:[\w.-]+\/)*[\w-]+\.(?:[cm]?[jt]sx?|json|md|sqlite|toml|ya?ml|sh|py|go|rs)\b|(?<![a-z0-9-])[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}/giu;

export function features(text: string): Set<string> {
	const result = new Set<string>();
	let prose = redact(text).replace(/\[REDACTED[^\]\n]*\]/gu, " ");
	prose = prose.replace(LITERALS, (literal) => {
		const clean = literal.replace(/[.:]+$/u, "").toLowerCase();
		result.add(`literal:${clean}`);
		result.add(`literal:${clean.split("/").at(-1)}`);
		return " ";
	});
	// Detect all concepts on the original prose so overlapping phrases such as
	// 跨会话 contribute session + cross-context, but not duplicated English synonyms.
	const masked = prose.split("");
	for (const [name, pattern] of CONCEPTS) {
		pattern.lastIndex = 0;
		for (const match of prose.matchAll(pattern)) {
			result.add(`concept:${name}`);
			for (let i = match.index; i < match.index + match[0].length; i++) masked[i] = " ";
		}
	}
	prose = masked.join("");
	prose = prose.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
	for (const word of WORDS.segment(prose)) {
		if (!word.isWordLike || word.segment.length < 2 || STOP.has(word.segment)) continue;
		result.add(word.segment);
	}
	return result;
}

export function featureOffset(text: string, feature: string): number {
	// Preserve offsets while applying the same literal/prose boundary as indexing.
	const prose = feature.startsWith("literal:") ? text : text.replace(LITERALS, (literal) => " ".repeat(literal.length));
	if (feature.startsWith("concept:")) {
		const pattern = CONCEPTS.find(([name]) => `concept:${name}` === feature)?.[1];
		if (!pattern) return -1;
		pattern.lastIndex = 0;
		return pattern.exec(prose)?.index ?? -1;
	}
	return prose.toLowerCase().indexOf(feature.replace(/^literal:/u, ""));
}

export function validSearchTerms(value: unknown): value is string[] | undefined {
	return value === undefined || (Array.isArray(value) && value.length <= 8 && value.every((term) =>
		typeof term === "string" && term.trim() === term && term.length >= 2 && term.length <= 64
		&& !term.includes("[REDACTED") && redact(term) === term && !/[\r\n]/u.test(term))
		&& Buffer.byteLength(JSON.stringify(value)) <= 1024);
}
