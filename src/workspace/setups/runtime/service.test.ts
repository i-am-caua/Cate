import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CateSetup } from '../contract'
import { createSetupRuntime, type SetupStartArgs } from './service'

const team: CateSetup = {
  version: 1,
  name: 'Team Flow',
  source: 'manual',
  nodes: [
    {
      id: 'lead',
      title: 'Lead',
      agentId: 'codex',
      model: 'gemini-4-argon-medium',
      effort: 'high',
      worktree: 'lead-worktree',
      prompt: 'Coordinate the work',
      position: { x: 10, y: 20 },
      size: { width: 640, height: 400 },
      orchestrator: true,
    },
    {
      id: 'worker',
      title: 'Worker',
      agentId: 'opencode',
      model: 'gemini-3.8-flash-low',
      effort: 'low',
      worktree: 'feature-work',
      prompt: 'Implement the feature',
      position: { x: 720, y: 20 },
    },
  ],
  edges: [{ from: 'lead', to: 'worker', kind: 'trigger', label: 'Implementation' }],
}

describe('setup runtime', () => {
  let temporary: string
  let root: string
  let home: string
  let nextPanel: number
  let startAgent: ReturnType<typeof vi.fn>
  let addRelation: ReturnType<typeof vi.fn>
  let prepareCateDir: ReturnType<typeof vi.fn>
  let requireTrusted: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-setups-'))
    root = path.join(temporary, 'workspace')
    home = path.join(temporary, 'home')
    nextPanel = 0
    startAgent = vi.fn(async (_args: SetupStartArgs) => ({ panelId: `panel-${++nextPanel}` }))
    addRelation = vi.fn(() => 'relation-1')
    prepareCateDir = vi.fn(async () => {})
    requireTrusted = vi.fn()
  })

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true })
  })

  function runtime(overrides: { startAgent?: any } = {}) {
    return createSetupRuntime({
      root,
      home,
      trust: { requireTrusted: requireTrusted as any },
      prepareCateDir: prepareCateDir as any,
      startAgent: overrides.startAgent ?? (startAgent as any),
      addRelation: addRelation as any,
      canvasForPanel: (id) => id === 'canvas-panel' ? 'canvas' : null,
      defaultCanvasPanel: () => 'canvas-panel',
    })
  }

  it('lists local setups before global ones and tolerates aliases', async () => {
    await fs.mkdir(path.join(root, '.cate', 'setups'), { recursive: true })
    await fs.mkdir(path.join(home, '.cate', 'setups'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'setups', 'local-crew.json'), JSON.stringify({
      name: 'Local crew',
      source: 'alethe',
      agents: { lead: { title: 'Lead', agent: 'codex' } },
    }))
    await fs.writeFile(path.join(home, '.cate', 'setups', 'global-crew.json'), JSON.stringify({
      name: 'Global crew',
      source: 'ai',
      nodes: [{ id: 'worker', title: 'Worker', agentId: 'opencode', position: { x: 1, y: 2 } }],
    }))
    await fs.writeFile(path.join(root, '.cate', 'setups', 'broken.json'), '{')

    const entries = await runtime().list()

    expect(entries.map((entry) => [entry.id, entry.scope, entry.setup.name])).toEqual([
      ['local-crew', 'local', 'Local crew'],
      ['global-crew', 'global', 'Global crew'],
    ])
    expect(entries[0].setup.nodes[0]).toMatchObject({ id: 'lead', agentId: 'codex' })
  })

  it('saves canonical files and keeps names unique unless an id is given', async () => {
    const service = runtime()

    const first = await service.save(team)
    const second = await service.save(team)

    expect(first).toMatchObject({ id: 'team-flow', scope: 'local' })
    expect(second).toMatchObject({ id: 'team-flow-2', scope: 'local' })
    expect(requireTrusted).toHaveBeenCalledTimes(2)
    expect(prepareCateDir).toHaveBeenCalledWith(path.join(root, '.cate'))
    const saved = JSON.parse(await fs.readFile(first.path, 'utf8'))
    expect(saved).toMatchObject({ version: 1, name: 'Team Flow', source: 'manual' })
    expect(saved.nodes[0]).toMatchObject({ id: 'lead', agentId: 'codex', position: { x: 10, y: 20 }, width: 640, height: 400 })
  })

  it('refuses to save an empty setup', async () => {
    await expect(runtime().save({ ...team, nodes: [], edges: [] })).rejects.toThrow(/setup-empty/)
  })

  it('starts every node idle at its saved position and draws the edges', async () => {
    const service = runtime()
    await service.save(team)

    const result = await service.apply({ id: 'team-flow', canvasPanelId: 'canvas-panel' })

    expect(result).toMatchObject({
      setupId: 'team-flow',
      name: 'Team Flow',
      panelIds: { lead: 'panel-1', worker: 'panel-2' },
      relationIds: ['relation-1'],
      warnings: [],
    })
    expect(startAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentId: 'codex',
      model: 'gemini-4-argon-medium',
      effort: 'high',
      newWorktree: 'lead-worktree',
      title: 'Lead',
      orchestrator: true,
      at: expect.objectContaining({
        to: 'canvas',
        canvasId: 'canvas',
        rect: { origin: { x: 10, y: 20 }, size: { width: 640, height: 400 } },
      }),
    }))
    expect(startAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentId: 'opencode',
      model: 'gemini-3.8-flash-low',
      effort: 'low',
      newWorktree: 'feature-work',
      at: expect.objectContaining({
        rect: { origin: { x: 720, y: 20 }, size: { width: 640, height: 400 } },
      }),
    }))
    expect(startAgent.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
    expect(startAgent.mock.calls[1]?.[0]).not.toHaveProperty('prompt')
    expect(addRelation).toHaveBeenCalledWith('panel-1', 'panel-2', 'trigger', 'Implementation')
  })

  it('sends the optional initial prompt only to the orchestrator', async () => {
    const service = runtime()
    await service.save(team)

    await service.apply({ id: 'team-flow', orchestratorPrompt: '  Refactor auth  ' })

    expect(startAgent.mock.calls[0]?.[0]).toMatchObject({ prompt: 'Refactor auth' })
    expect(startAgent.mock.calls[1]?.[0]).not.toHaveProperty('prompt')
  })

  it('keeps going when one agent fails and reports the warning', async () => {
    const failing = vi.fn(async (args: SetupStartArgs) => {
      if (args.title === 'Worker') throw new Error('hooks not ready')
      return { panelId: 'panel-1' }
    })
    const service = runtime({ startAgent: failing })
    await service.save(team)

    const result = await service.apply({ id: 'team-flow' })

    expect(result.panelIds).toEqual({ lead: 'panel-1' })
    expect(result.relationIds).toEqual([])
    expect(result.warnings).toEqual(['Worker: hooks not ready'])
  })

  it('refuses to apply without a canvas', async () => {
    const service = createSetupRuntime({
      root,
      home,
      trust: { requireTrusted: requireTrusted as any },
      startAgent: startAgent as any,
      addRelation: addRelation as any,
      canvasForPanel: () => null,
      defaultCanvasPanel: () => null,
    })
    await service.save(team)

    await expect(service.apply({ id: 'team-flow' })).rejects.toThrow(/no-canvas/)
  })
})
