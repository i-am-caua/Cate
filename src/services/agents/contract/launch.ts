// Starting an agent (`cate.agent.start`): what the CLI runs in a terminal in
// place of the shell, and the agent CLIs a start can pick. Pure.

import { AGENT_DEFS, type AgentId } from './registry'

/** An agent CLI a start can pick (`cate.agent.types`). */
export interface AgentTypeInfo {
  agentId: AgentId
  displayName: string
  /** Its Cate hooks are on here, so it can start in a terminal. */
  ready: boolean
}

const AGENT_TASK_PREFIX = 'Complete this coding task:\n\n'
const SAFE_MODEL_OR_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/

/**
 * The exact executable + argv of a started agent's PTY. No shell is involved,
 * so prompt text cannot become shell syntax, and prefixing the positional
 * prompt prevents option or subcommand injection into the CLI's argv parser.
 * Every executable comes from the registry; callers cannot provide a path or
 * flags. Without a prompt the CLI opens its interactive session.
 */
export function agentLaunchCommand(launch: { agentId: AgentId; prompt?: string; model?: string; effort?: string }): { executable: string; args: string[] } {
  const agent = AGENT_DEFS[launch.agentId]
  if (!agent) throw new Error(`Unsupported agent: ${launch.agentId}`)

  let model: string | undefined
  if (launch.model !== undefined) {
    model = launch.model.trim()
    if (!model || !SAFE_MODEL_OR_EFFORT.test(model)) throw new Error('Invalid model')
  }
  let effort: string | undefined
  if (launch.effort !== undefined) {
    effort = launch.effort.trim()
    if (!effort || !SAFE_MODEL_OR_EFFORT.test(effort)) throw new Error('Invalid effort')
  }

  const extraArgs: string[] = []
  if (launch.agentId === 'agy' || launch.agentId === 'claude-code') {
    if (model) extraArgs.push('--model', model)
    if (effort) extraArgs.push('--effort', effort)
  }
  if (launch.agentId === 'codex') {
    if (model) extraArgs.push('--model', model)
    if (effort) extraArgs.push('-c', `model_reasoning_effort="${effort}"`)
  }
  if (launch.agentId === 'opencode' && model) extraArgs.push('--standalone')

  if (launch.prompt === undefined) {
    return { executable: agent.command, args: [...extraArgs, ...agent.startArgs] }
  }
  const prompt = launch.prompt.trim()
  if (!prompt) throw new Error('A prompt is required')
  if (prompt.includes('\0')) throw new Error('Prompts cannot contain NUL bytes')
  return {
    executable: agent.command,
    args: [...extraArgs, ...agent.promptArgs(`${AGENT_TASK_PREFIX}${prompt}`)],
  }
}

/** A started agent's first prompt as the person wrote it, without the prefix
 *  its launch added (`agentLaunchCommand`). */
export function agentTaskText(text: string): string {
  return text.startsWith(AGENT_TASK_PREFIX) ? text.slice(AGENT_TASK_PREFIX.length) : text
}
