/** Environment variable set by run-subagent on child agent processes. */
const SUBAGENT_AGENT_ID_ENV = "PI_SUBAGENT_AGENT_ID";

/** Returns true when the current process is a child subagent process. */
export function isSubagentProcess(env: NodeJS.ProcessEnv): boolean {
	const agentId = env[SUBAGENT_AGENT_ID_ENV];
	return agentId !== undefined && agentId !== "";
}
