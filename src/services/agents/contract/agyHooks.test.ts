import { describe, expect, it } from 'vitest'
import { AGENT_HOOK_SPECS, normalizeAgentHookPayload } from './hooks'

const native = { conversationId: 'session', workspacePaths: ['C:\\Work space\\repo'] }

describe('Antigravity native hooks', () => {
  it('declares the event name in each hook command, including quoted Windows paths', () => {
    const command = '"C:/Users/Name With Spaces/cate-hook-bridge-agy.cmd"'
    const config = JSON.parse(AGENT_HOOK_SPECS.agy.projectFiles![0].build(null, { bridgeCommand: command })!)['cate-hook']
    expect(config.PreInvocation[0].command).toBe(`${command} PreInvocation`)
    expect(config.PostToolUse[0].hooks[0].command).toBe(`${command} PostToolUse`)
  })

  it('uses native session and workspace fields and waits for a fully idle stop', () => {
    expect(normalizeAgentHookPayload('agy', 'terminal', { ...native, hook_event_name: 'PreInvocation' })).toMatchObject({
      kind: 'turn-start', sessionId: 'session', cwd: native.workspacePaths[0],
    })
    expect(normalizeAgentHookPayload('agy', 'terminal', { ...native, hook_event_name: 'Stop', fullyIdle: false })).toBeNull()
    expect(normalizeAgentHookPayload('agy', 'terminal', { ...native, hook_event_name: 'Stop', fullyIdle: true })?.kind).toBe('turn-end')
    expect(AGENT_HOOK_SPECS.agy.repeatsTurnStart).toBe(true)
  })

  it('captures completed native tools with stable step identity and failure status', () => {
    const call = AGENT_HOOK_SPECS.agy.toolCall({ ...native, hook_event_name: 'PostToolUse', stepIdx: 4,
      toolCall: { name: 'write_file', args: { Path: 'C:\\Work space\\repo\\created.txt', Content: 'hello' } },
    })
    expect(call).toMatchObject({ sessionId: 'session', name: 'write_file', callId: '4', input: { file_path: 'C:\\Work space\\repo\\created.txt', content: 'hello' } })
    expect(call?.failed).toBeUndefined()
    expect(AGENT_HOOK_SPECS.agy.toolCall({ ...native, hook_event_name: 'PostToolUse', error: 'permission denied',
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: native.workspacePaths[0] } },
    })).toMatchObject({ failed: true, input: { command: 'npm test' }, cwd: native.workspacePaths[0] })
    expect(AGENT_HOOK_SPECS.agy.toolCall({ ...native, hook_event_name: 'PreInvocation' })).toBeNull()
  })
})
