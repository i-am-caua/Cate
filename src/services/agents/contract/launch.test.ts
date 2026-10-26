import { describe, expect, it } from 'vitest'
import { AGENTS } from './registry'
import { agentLaunchCommand, agentTaskText } from './launch'

describe('agentLaunchCommand', () => {
  it('resolves only canonical agent ids to exact argv without a shell', () => {
    const task = 'Fix it; touch /tmp/pwned'
    const prefixed = `Complete this coding task:\n\n${task}`
    expect(AGENTS.map((agent) => ({ id: agent.id, command: agentLaunchCommand({ agentId: agent.id, prompt: task }) }))).toEqual([
      { id: 'claude-code', command: { executable: 'claude', args: [prefixed] } },
      { id: 'codex', command: { executable: 'codex', args: [prefixed] } },
      { id: 'cursor', command: { executable: 'cursor-agent', args: [prefixed] } },
      { id: 'grok', command: { executable: 'grok', args: [prefixed] } },
      { id: 'opencode', command: { executable: 'opencode', args: ['--prompt', prefixed] } },
      { id: 'kiro', command: { executable: 'kiro-cli', args: ['chat', '--v3', prefixed] } },
      { id: 'agy', command: { executable: 'agy', args: ['-i', prefixed] } },
    ])
  })

  it('keeps option-looking and subcommand-looking prompts positional', () => {
    expect(agentLaunchCommand({ agentId: 'codex', prompt: '--dangerously-bypass-approvals-and-sandbox' }).args).toEqual([
      'Complete this coding task:\n\n--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(agentLaunchCommand({ agentId: 'codex', prompt: 'exec' }).args).toEqual(['Complete this coding task:\n\nexec'])
  })

  it('opens the interactive session without a prompt', () => {
    expect(AGENTS.map((agent) => ({ id: agent.id, command: agentLaunchCommand({ agentId: agent.id }) }))).toEqual([
      { id: 'claude-code', command: { executable: 'claude', args: [] } },
      { id: 'codex', command: { executable: 'codex', args: [] } },
      { id: 'cursor', command: { executable: 'cursor-agent', args: [] } },
      { id: 'grok', command: { executable: 'grok', args: [] } },
      { id: 'opencode', command: { executable: 'opencode', args: [] } },
      { id: 'kiro', command: { executable: 'kiro-cli', args: ['chat', '--v3'] } },
      { id: 'agy', command: { executable: 'agy', args: [] } },
    ])
  })

  it('adds model and effort to agy with and without a prompt', () => {
    const flags = ['--model', 'gemini-3.8-flash-low', '--effort', 'low']
    expect(agentLaunchCommand({ agentId: 'agy', model: 'gemini-3.8-flash-low', effort: 'low' }).args).toEqual(flags)
    expect(agentLaunchCommand({ agentId: 'agy', prompt: 'Fix it', model: 'gemini-3.8-flash-low', effort: 'low' }).args).toEqual([
      ...flags,
      '-i',
      'Complete this coding task:\n\nFix it',
    ])
  })

  it('adds model and effort in the Codex CLI format', () => {
    expect(agentLaunchCommand({ agentId: 'codex', model: 'gpt-6-luna', effort: 'medium' }).args).toEqual([
      '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="medium"',
    ])
  })

  it('adds model and effort flags to Claude Code', () => {
    expect(agentLaunchCommand({ agentId: 'claude-code', model: 'claude-sonnet', effort: 'high' }).args).toEqual([
      '--model', 'claude-sonnet', '--effort', 'high',
    ])
  })

  it('starts OpenCode in standalone mode when a model is pinned', () => {
    expect(agentLaunchCommand({ agentId: 'opencode', model: 'provider/model' }).args).toEqual(['--standalone'])
    expect(agentLaunchCommand({ agentId: 'opencode', prompt: 'Fix it', model: 'provider/model' }).args).toEqual([
      '--standalone', '--prompt', 'Complete this coding task:\n\nFix it',
    ])
  })

  it.each([
    ['model', '--bad'],
    ['model', ' has spaces '],
    ['effort', '--bad'],
    ['effort', 'has spaces'],
  ] as const)('rejects unsafe %s value %j', (key, value) => {
    expect(() => agentLaunchCommand({ agentId: 'codex', [key]: value })).toThrow(`Invalid ${key}`)
  })

  it('rejects blank prompts', () => {
    expect(() => agentLaunchCommand({ agentId: 'codex', prompt: '   ' })).toThrow('A prompt is required')
  })

  it('shows the prompt as written', () => {
    const [arg] = agentLaunchCommand({ agentId: 'codex', prompt: 'Fix it' }).args
    expect(agentTaskText(arg)).toBe('Fix it')
    expect(agentTaskText('Plain')).toBe('Plain')
  })
})
