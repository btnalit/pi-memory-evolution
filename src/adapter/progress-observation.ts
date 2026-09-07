import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { clipBytes, fingerprint, redact } from "../memory/privacy.ts";
type Message = SessionMessageEntry["message"];
const WORK = /提交|推送|完成|修复|实现|安装|更新|迁移|部署|测试|验证|审查|继续|接着|\b(?:commit|push|finish|fix|implement|install|update|migrate|deploy|test|verify|review|continue|resume)\b/iu;

function text(content: unknown): string {
	return typeof content === "string" ? content : Array.isArray(content)
		? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
}
function preview(value: string, budget: number): string {
	const clean = redact(value);
	if (Buffer.byteLength(clean) <= budget) return clean;
	const tail = [...clipBytes([...clean].reverse().join(""), Math.floor((budget - 5) / 2))].reverse().join("");
	return clipBytes(clean, Math.floor((budget - 5) / 2)) + "\n…\n" + tail;
}

/** One completed work turn, never a tool/assistant memory instruction. The caller
 * nominates existing project-state targets separately, using user topic/operation paths.
 * Success flags are observations, not a verification or authorization certificate. */
export function progressObservation(messages: readonly Message[], sessionId: string) {
	const start = messages.findLastIndex((message) => message.role === "user");
	if (start < 0) return;
	const user = messages[start];
	const userText = text("content" in user ? user.content : "");
	if (!WORK.test(userText) || !Number.isFinite(user.timestamp)) return;
	const turn = messages.slice(start + 1);
	const last = turn.at(-1);
	if (last?.role !== "assistant" || last.stopReason !== "stop" || !Number.isFinite(last.timestamp)) return;
	const calls = new Map<string, { name: string; args: string }>();
	const observations: { tool: string; arguments: string; output: string; isError: boolean }[] = [];
	for (const message of turn.slice(-64)) {
		if (message.role === "assistant") for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const args = part.arguments ?? {};
			const operation = args.command ?? args.path ?? args.file_path ?? args.filePath ?? "";
			calls.set(part.id, { name: part.name, args: preview(String(operation), 1024) });
		}
		if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (!call || call.name !== message.toolName) continue;
			observations.push({ tool: call.name, arguments: call.args, output: preview(text(message.content), 2048), isError: message.isError !== false });
		}
	}
	if (!observations.length) return;
	const payload = { request: preview(userText, 2048), observations: observations.slice(-8),
		assistantReport: preview(text(last.content), 2048) };
	while (Buffer.byteLength(JSON.stringify(payload)) > 28_000 && payload.observations.length > 1) payload.observations.shift();
	const content = JSON.stringify(payload);
	return { id: `progress:${sessionId}:${user.timestamp}:${fingerprint(content)}`, kind: "progress" as const,
		createdAt: new Date(last.timestamp).toISOString(), content, userText: preview(userText, 2048),
		queryHints: payload.observations.map((item) => item.arguments).join("\n") };
}
