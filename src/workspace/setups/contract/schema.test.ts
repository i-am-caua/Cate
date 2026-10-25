import { describe, expect, it } from 'vitest'
import type { WorkspaceDocument } from '@workspace/document/contract'
import { parseSetup, setupFromCanvas, setupToJson, slugifySetupName } from './schema'

const document = {
  canvases: {
    canvas: {
      id: 'canvas',
      nodes: {
        node: {
          id: 'node',
          rect: { origin: { x: 100, y: 50 }, size: { width: 640, height: 400 } },
          dock: { kind: 'stack', id: 'stack', panels: ['lead', 'worker', 'notes'] },
        },
      },
    },
  },
  panels: {
    lead: { id: 'lead', type: 'terminal', title: 'Lead', fields: { orchestrator: true } },
    worker: { id: 'worker', type: 'terminal', title: 'Worker', fields: {} },
    notes: { id: 'notes', type: 'editor', title: 'Notes', fields: {} },
  },
  relations: {
    check: { id: 'check', fromPanelId: 'lead', toPanelId: 'worker', kind: 'verify', label: 'Review' },
    offCanvas: { id: 'offCanvas', fromPanelId: 'lead', toPanelId: 'notes', kind: 'use' },
  },
} as unknown as WorkspaceDocument

describe('cate-setup schema', () => {
  it('reads common aliases and drops unusable nodes and edges', () => {
    const setup = parseSetup({
      name: 'Release crew',
      source: 'alethe',
      agents: {
        lead: { title: 'Lead', agent: 'codex', instructions: 'Coordinate', x: 10, y: 20, maestro: true },
        worker: { title: 'Worker', cli: 'opencode', task: 'Build' },
      },
      relations: [
        { fromPanelId: 'lead', toPanelId: 'worker', kind: 'trigger', label: 'Hand off' },
        { from: 'lead', to: 'missing', kind: 'use' },
        { from: 'worker', to: 'worker', kind: 'use' },
      ],
    })

    expect(setup).toMatchObject({
      version: 1,
      name: 'Release crew',
      source: 'alethe',
      nodes: [
        { id: 'lead', title: 'Lead', agentId: 'codex', prompt: 'Coordinate', position: { x: 10, y: 20 }, orchestrator: true },
        { id: 'worker', title: 'Worker', agentId: 'opencode', prompt: 'Build', position: { x: 720, y: 0 } },
      ],
      edges: [{ from: 'lead', to: 'worker', kind: 'trigger', label: 'Hand off' }],
    })
  })

  it('round-trips the canonical shape', () => {
    const parsed = parseSetup(setupToJson({
      version: 1,
      name: 'Crew',
      description: 'Two agents',
      source: 'ai',
      nodes: [{ id: 'lead', title: 'Lead', agentId: 'codex', position: { x: 0, y: 0 }, size: { width: 600, height: 300 } }],
      edges: [],
    }))
    expect(parsed).toMatchObject({
      name: 'Crew',
      description: 'Two agents',
      source: 'ai',
      nodes: [{ id: 'lead', agentId: 'codex', size: { width: 600, height: 300 } }],
    })
  })

  it('captures agent terminal panels and the relations between them', () => {
    const setup = setupFromCanvas(document, 'canvas', 'Canvas crew', {
      lead: { agentId: 'codex', orchestrator: true },
      worker: { agentId: 'opencode' },
      notes: { agentId: 'codex' },
    })

    expect(setup.nodes).toEqual([
      { id: 'lead', title: 'Lead', agentId: 'codex', position: { x: 100, y: 50 }, size: { width: 640, height: 400 }, orchestrator: true },
      { id: 'worker', title: 'Worker', agentId: 'opencode', position: { x: 124, y: 74 }, size: { width: 640, height: 400 } },
    ])
    expect(setup.edges).toEqual([{ from: 'lead', to: 'worker', kind: 'verify', label: 'Review' }])
  })

  it('makes filename-safe ids', () => {
    expect(slugifySetupName('  Café & Release / 2 ')).toBe('cafe-release-2')
    expect(slugifySetupName('***')).toBe('setup')
  })
})
