/**
 * Environment variables set on child agent processes:
 * - PI_SUBAGENT_AGENT_ID: Legacy runner identification.
 * - PI_SUBAGENT_CHILD: Modern pi-subagents standard (set to "1").
 * - PI_SUBAGENT_RUNNER_PID: Detached background runner process.
 */
const SUBAGENT_AGENT_ID_ENV = "PI_SUBAGENT_AGENT_ID";
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const SUBAGENT_RUNNER_PID_ENV = "PI_SUBAGENT_RUNNER_PID";

/** Returns true when the current process is a child subagent process. */
export function isSubagentProcess(env: NodeJS.ProcessEnv): boolean {
	const agentId = env[SUBAGENT_AGENT_ID_ENV];
	if (agentId !== undefined && agentId !== "") return true;
	if (env[SUBAGENT_CHILD_ENV] === "1") return true;
	const runnerPid = env[SUBAGENT_RUNNER_PID_ENV];
	if (runnerPid !== undefined && runnerPid !== "") return true;
	return false;
}
