import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { MAIN_WINDOW, createDocument } from '@workspace/document/contract'
import type { AgentPanelStates, AgentTypeInfo } from '@services/agents/contract'
import type { CateSetup, SetupEntry } from '@workspace/setups/contract'
import { openTestDocument } from '../../client/layout/canvas/testing'
import { SetupsPopover } from './SetupsDialog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let agentStates: AgentPanelStates = {}
vi.mock('../../services/agents', () => ({
  useAgentPanels: () => agentStates,
}))

const team: CateSetup = {
  version: 1,
  name: 'Release crew',
  source: 'alethe',
  nodes: [{ id: 'lead', title: 'Lead', agentId: 'codex', position: { x: 0, y: 0 } }],
  edges: [],
}

const entry = (patch: Partial<SetupEntry> = {}): SetupEntry => ({
  id: 'release-crew',
  scope: 'local',
  path: '/repo/.cate/setups/release-crew.json',
  setup: team,
  ...patch,
})

describe('SetupsPopover', () => {
  let host: HTMLDivElement
  let root: Root
  let uninstall: () => void
  let detach: (() => void) | undefined
  let setupList: ReturnType<typeof vi.fn>
  let setupApply: ReturnType<typeof vi.fn>
  let setupSave: ReturnType<typeof vi.fn>
  let agentTypes: ReturnType<typeof vi.fn>
  let onClose: () => void

  beforeEach(() => {
    agentStates = {}
    setupList = vi.fn(async () => [entry()])
    setupApply = vi.fn(async () => ({ setupId: 'release-crew', name: 'Release crew', panelIds: { lead: 'panel-1' }, relationIds: [], warnings: [] }))
    setupSave = vi.fn(async ({ setup }: { setup: CateSetup }) => entry({ id: 'release-crew-2', setup }))
    agentTypes = vi.fn(async (): Promise<AgentTypeInfo[]> => [])
    const runtime = {
      setup: { list: setupList, apply: setupApply, save: setupSave },
      agents: { types: agentTypes, start: vi.fn() },
    } as unknown as RuntimeProxy
    uninstall = setRuntimeResolver(() => runtime)
    onClose = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    detach?.()
    uninstall()
    document.body.innerHTML = ''
  })

  async function render(canvasPanelId = 'canvas-panel') {
    await act(async () => {
      root.render(
        <SetupsPopover
          workspaceId="ws"
          canvasPanelId={canvasPanelId}
          pos={{ left: 10, bottom: 10 }}
          triggerRef={{ current: null }}
          onClose={onClose}
        />,
      )
    })
    await act(async () => { await Promise.resolve() })
  }

  it('lists saved setups with source and counts, then applies one', async () => {
    await render()

    expect(host.textContent).toContain('Release crew')
    expect(host.textContent).toContain('Alethe')
    expect(host.textContent).toContain('1 agent')
    expect(host.textContent).toContain('0 relations')

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Apply Release crew"]')!.click())
    await act(async () => { await Promise.resolve() })

    expect(setupApply).toHaveBeenCalledWith({ id: 'release-crew', scope: 'local', canvasPanelId: 'canvas-panel' })
    expect(onClose).toHaveBeenCalled()
  })

  it('captures the canvas agent panels and saves them under a name', async () => {
    const canvasPanel = { id: 'canvas-panel', type: 'canvas' as const, title: 'Canvas', canvasId: 'canvas', fields: {} }
    const lead = { id: 'lead', type: 'terminal' as const, title: 'Lead', fields: { orchestrator: true } }
    const worker = { id: 'worker', type: 'terminal' as const, title: 'Worker', fields: {} }
    detach = openTestDocument('ws', {
      ...createDocument(),
      panels: { 'canvas-panel': canvasPanel, lead, worker },
      windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock: { kind: 'stack', id: 'main', panels: ['canvas-panel'] } } },
      canvases: {
        canvas: {
          id: 'canvas',
          nodes: {
            node: {
              id: 'node',
              rect: { origin: { x: 40, y: 60 }, size: { width: 640, height: 400 } },
              dock: { kind: 'stack', id: 'stack', panels: ['lead', 'worker'] },
            },
          },
        },
      },
      relations: { relation: { id: 'relation', fromPanelId: 'lead', toPanelId: 'worker', kind: 'trigger', label: 'Build' } },
    })
    agentStates = {
      lead: { agentId: 'codex' } as AgentPanelStates[string],
      worker: { agentId: 'opencode' } as AgentPanelStates[string],
    }

    await render()
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New setup"]')!.click())
    expect(host.textContent).toContain('2 agents · 1 relation will be saved.')

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Setup name"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Canvas crew')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Save'))!
    await act(async () => save.click())
    await act(async () => { await Promise.resolve() })

    expect(setupSave).toHaveBeenCalledWith({
      scope: 'local',
      setup: expect.objectContaining({
        name: 'Canvas crew',
        source: 'manual',
        nodes: [
          expect.objectContaining({ id: 'lead', agentId: 'codex', orchestrator: true, position: { x: 40, y: 60 } }),
          expect.objectContaining({ id: 'worker', agentId: 'opencode', position: { x: 64, y: 84 } }),
        ],
        edges: [expect.objectContaining({ from: 'lead', to: 'worker', kind: 'trigger', label: 'Build' })],
      }),
    })
  })

  it('starts the picked agent with a setup-writing prompt', async () => {
    agentTypes.mockResolvedValue([{ agentId: 'codex', displayName: 'Codex', ready: true }])
    const start = vi.fn(async (_args: { prompt?: string }) => ({ panelId: 'panel-1', agentId: 'codex' as const }))
    const runtime = {
      setup: { list: setupList, apply: setupApply, save: setupSave },
      agents: { types: agentTypes, start },
    } as unknown as RuntimeProxy
    uninstall()
    uninstall = setRuntimeResolver(() => runtime)
    const canvasPanel = { id: 'canvas-panel', type: 'canvas' as const, title: 'Canvas', canvasId: 'canvas', fields: {} }
    const lead = { id: 'lead', type: 'terminal' as const, title: 'Lead', fields: {} }
    detach = openTestDocument('ws', {
      ...createDocument(),
      panels: { 'canvas-panel': canvasPanel, lead },
      windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock: { kind: 'stack', id: 'main', panels: ['canvas-panel'] } } },
      canvases: {
        canvas: {
          id: 'canvas',
          nodes: {
            node: {
              id: 'node',
              rect: { origin: { x: 0, y: 0 }, size: { width: 640, height: 400 } },
              dock: { kind: 'stack', id: 'stack', panels: ['lead'] },
            },
          },
        },
      },
    })

    await render()
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New setup"]')!.click())
    const goal = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Setup goal"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, 'Plan and build a CLI')
      goal.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const generate = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Generate'))!
    await act(async () => generate.click())
    await act(async () => { await Promise.resolve() })

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      title: 'Setup generator',
      prompt: expect.stringContaining('Plan and build a CLI'),
      at: expect.objectContaining({ to: 'canvas', canvasId: 'canvas' }),
    }))
    expect(((start.mock.calls as any)[0]?.[0])?.prompt).toContain('.cate/setups/')
    expect(onClose).toHaveBeenCalled()
  })
})
