import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsRuntime, AgentStartArgs } from '@services/agents/runtime'
import type { ApiHandlerContext } from '@kernel/api/contract'
import type { DocChange, WorkspaceDocument } from '@workspace/document/contract'
import type { RelationRuntimeDocument } from '@workspace/relations/runtime'
import { createSetupsRuntime } from './service'

const setup = {
  version: 1,
  id: 'team-flow',
  name: 'Team Flow',
  source: 'manual',
  nodes: [
    { id: 'lead', agent: 'codex', title: 'Lead', orchestrator: true, model: 'gemini-4-argon-medium', effort: 'high', tier: 'strong', prompt: 'Coordinate the work', worktree: null, mode: 'write' },
    { id: 'worker', agent: 'opencode', title: 'Worker', orchestrator: false, model: 'gemini-3.8-flash-low', effort: 'low', prompt: 'Implement the feature', worktree: 'feature-work', mode: 'read-only' },
  ],
  edges: [{ from: 'lead', to: 'worker', kind: 'trigger', label: 'Implementation' }],
  budget: { maxWorkers: 1 },
}

describe('setups runtime', () => {
  let temporary: string
  let root: string
  let homeDir: string

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-setups-'))
    root = path.join(temporary, 'workspace')
    homeDir = path.join(temporary, 'home')
  })

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true })
  })

  function runtime() {
    let documentState = { panels: {}, relations: {} } as unknown as WorkspaceDocument
    const document: RelationRuntimeDocument = {
      get: () => documentState,
      apply(change: DocChange) {
        if (change.kind === 'addRelation') {
          documentState = { ...documentState, relations: { ...documentState.relations, [change.relation.id]: change.relation } }
        } else if (change.kind === 'updatePanel') {
          const panel = documentState.panels[change.id]
          if (panel) {
            documentState = {
              ...documentState,
              panels: {
                ...documentState.panels,
                [change.id]: { ...panel, fields: { ...panel.fields, ...(change.patch.fields ?? {}) } },
              },
            }
          }
        }
        return 1
      },
    }
    let nextPanel = 0
    const start = vi.fn(async (_caller: string | undefined, args: AgentStartArgs) => {
      const panelId = 'panel-' + (++nextPanel)
      documentState = {
        ...documentState,
        panels: {
          ...documentState.panels,
          [panelId]: { id: panelId, type: 'terminal', title: args.title ?? '', fields: {} },
        },
      }
      return { panelId, agentId: args.agentId ?? 'codex' }
    })
    const service = createSetupsRuntime({
      root,
      homeDir,
      agents: { start } as unknown as Pick<AgentsRuntime, 'start'>,
      document,
      relationRole: () => ({ execution: true }),
    })
    return { service, documentState: () => documentState, start }
  }

  const context = {} as ApiHandlerContext

  it('creates both setup directories while listing', async () => {
    const { service } = runtime()
    await expect(service.apiHandlers().list({}, context)).resolves.toEqual([])
    await expect(fs.stat(path.join(root, '.cate', 'setups'))).resolves.toBeDefined()
    await expect(fs.stat(path.join(homeDir, '.cate', 'setups'))).resolves.toBeDefined()
  })

  it('validates and saves a setup with optional id and name overrides', async () => {
    const { service } = runtime()
    const input = path.join(temporary, 'input.json')
    await fs.writeFile(input, JSON.stringify(setup))
    await expect(service.apiHandlers().save({ file: input, global: false, setupId: 'renamed-flow', name: 'Renamed Flow' }, context))
      .resolves.toEqual({ ok: true, setupId: 'renamed-flow', scope: 'workspace' })
    const saved = JSON.parse(await fs.readFile(path.join(root, '.cate', 'setups', 'renamed-flow.json'), 'utf8'))
    expect(saved).toMatchObject({ id: 'renamed-flow', name: 'Renamed Flow', version: 1 })
  })

  it('rejects invalid setup edges on import', async () => {
    const { service } = runtime()
    const input = path.join(temporary, 'invalid.json')
    await fs.writeFile(input, JSON.stringify({ ...setup, edges: [{ from: 'lead', to: 'missing', kind: 'trigger' }] }))
    await expect(service.apiHandlers()['import']({ file: input }, context)).rejects.toThrow(/setup-invalid: edges\[0\]\.to/)
  })

  it('starts nodes idle, forwards model settings, marks orchestrators and adds relations', async () => {
    const { service, documentState, start } = runtime()
    const setupDir = path.join(root, '.cate', 'setups')
    await fs.mkdir(setupDir, { recursive: true })
    await fs.writeFile(path.join(setupDir, setup.id + '.json'), JSON.stringify(setup))
    const result = await service.apiHandlers().apply({ setupId: setup.id, canvasPanelId: 'canvas-panel' }, context)
    expect(result).toMatchObject({ ok: true, setupId: setup.id, panels: { lead: 'panel-1', worker: 'panel-2' } })
    expect((result as { relations: string[] }).relations).toHaveLength(1)
    expect(start).toHaveBeenNthCalledWith(1, undefined, expect.objectContaining({
      agentId: 'codex',
      model: 'gemini-4-argon-medium',
      effort: 'high',
      placement: { near: 'canvas-panel' },
    }))
    expect(start).toHaveBeenNthCalledWith(2, undefined, expect.objectContaining({
      agentId: 'opencode',
      model: 'gemini-3.8-flash-low',
      effort: 'low',
      newWorktree: 'feature-work',
    }))
    expect(start.mock.calls[0]?.[1]).not.toHaveProperty('prompt')
    expect(start.mock.calls[1]?.[1]).not.toHaveProperty('prompt')
    expect(documentState().panels['panel-1'].fields.orchestrator).toBe(true)
    expect(Object.values(documentState().relations)).toMatchObject([{ fromPanelId: 'panel-1', toPanelId: 'panel-2', kind: 'trigger', label: 'Implementation' }])
  })

  it('sends an optional task only to the orchestrator', async () => {
    const { service, start } = runtime()
    const setupDir = path.join(root, '.cate', 'setups')
    await fs.mkdir(setupDir, { recursive: true })
    await fs.writeFile(path.join(setupDir, setup.id + '.json'), JSON.stringify(setup))

    await service.apiHandlers().apply({ setupId: setup.id, task: 'Refactor auth' }, context)

    expect(start.mock.calls[0]?.[1]).toMatchObject({ prompt: 'Refactor auth' })
    expect(start.mock.calls[1]?.[1]).not.toHaveProperty('prompt')
  })
})

