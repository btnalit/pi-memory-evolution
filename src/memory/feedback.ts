import type { FeedbackVerdict } from "./quality.ts";

/** Deliberately narrow, whole-message statements. Never guess which injected memory
 * a vague "wrong" refers to; never treat quoted examples or tool prose as feedback. */
export function feedbackCue(text: string): { id: string; verdict: FeedbackVerdict } | undefined {
	const match = /^(?:memory|记忆)\s+([a-f0-9]{24})\s+(?:(?:is|was)\s+)?(useful|unhelpful|accurate|incorrect|有用|没用|正确|错误)[.!。！]?$/iu.exec(text.trim());
	if (!match) return undefined;
	const verdicts: Record<string, FeedbackVerdict> = { useful: "useful", unhelpful: "unhelpful", accurate: "accurate", incorrect: "incorrect",
		有用: "useful", 没用: "unhelpful", 正确: "accurate", 错误: "incorrect" };
	return { id: match[1].toLowerCase(), verdict: verdicts[match[2].toLowerCase()] };
}
