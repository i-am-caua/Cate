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
        lead: { title: 'Lead', agent: 'codex', instructions: 'Coordinate', x: 10, y: 20, maestro: true, worktree: null },
        worker: { title: 'Worker', cli: 'opencode', task: 'Build', model: 'gemini-3.8-flash-low', effort: 'medium', tier: 'cheap', mode: 'read-only', worktree: 'feature-auth' },
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
        { id: 'lead', title: 'Lead', agentId: 'codex', prompt: 'Coordinate', worktree: null, position: { x: 10, y: 20 }, orchestrator: true },
        { id: 'worker', title: 'Worker', agentId: 'opencode', model: 'gemini-3.8-flash-low', effort: 'medium', tier: 'cheap', mode: 'read-only', worktree: 'feature-auth', prompt: 'Build', position: { x: 720, y: 0 } },
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
      nodes: [{
        id: 'lead',
        title: 'Lead',
        agentId: 'codex',
        model: 'gemini-4-argon-medium',
        effort: 'high',
        tier: 'strong',
        mode: 'write',
        worktree: 'auth-refactor',
        position: { x: 0, y: 0 },
        size: { width: 600, height: 300 },
      }],
      edges: [],
    }))
    expect(parsed).toMatchObject({
      name: 'Crew',
      description: 'Two agents',
      source: 'ai',
      nodes: [{
        id: 'lead',
        agentId: 'codex',
        model: 'gemini-4-argon-medium',
        effort: 'high',
        tier: 'strong',
        mode: 'write',
        worktree: 'auth-refactor',
        size: { width: 600, height: 300 },
      }],
    })
  })

  it('lays out nodes left to right by topological depth when coordinates are omitted', () => {
    const setup = parseSetup({
      name: 'Flow',
      nodes: [{ id: 'lead' }, { id: 'worker-a' }, { id: 'worker-b' }, { id: 'reviewer' }],
      edges: [
        { from: 'lead', to: 'worker-a' },
        { from: 'lead', to: 'worker-b' },
        { from: 'worker-a', to: 'reviewer' },
      ],
    })

    expect(setup?.nodes.map(({ id, position }) => [id, position])).toEqual([
      ['lead', { x: 0, y: 0 }],
      ['worker-a', { x: 720, y: 0 }],
      ['worker-b', { x: 720, y: 480 }],
      ['reviewer', { x: 1440, y: 0 }],
    ])
  })

  it('captures agent terminal panels and the relations between them', () => {
    const setup = setupFromCanvas(document, 'canvas', 'Canvas crew', {
      lead: { agentId: 'codex', model: 'gemini-4-argon-medium', effort: 'high', orchestrator: true },
      worker: { agentId: 'opencode' },
      notes: { agentId: 'codex' },
    })

    expect(setup.nodes).toEqual([
      { id: 'lead', title: 'Lead', agentId: 'codex', model: 'gemini-4-argon-medium', effort: 'high', position: { x: 100, y: 50 }, size: { width: 640, height: 400 }, orchestrator: true },
      { id: 'worker', title: 'Worker', agentId: 'opencode', position: { x: 124, y: 74 }, size: { width: 640, height: 400 } },
    ])
    expect(setup.edges).toEqual([{ from: 'lead', to: 'worker', kind: 'verify', label: 'Review' }])
  })

  it('makes filename-safe ids', () => {
    expect(slugifySetupName('  Café & Release / 2 ')).toBe('cafe-release-2')
    expect(slugifySetupName('***')).toBe('setup')
  })
})
