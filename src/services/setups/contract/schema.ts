// cate-setup v1 files shared by the setup API and runtime.

export const SETUP_AGENT_IDS = ['codex', 'opencode', 'agy', 'claude-code'] as const
export type SetupAgentId = (typeof SETUP_AGENT_IDS)[number]
export type SetupSource = 'alethe' | 'manual' | 'ai'
export type SetupMode = 'read-only' | 'write'
export type SetupEdgeKind = 'trigger' | 'verify' | 'context' | 'use'
export type SetupScope = 'workspace' | 'global'

export interface SetupNode {
  id: string
  agent: SetupAgentId
  title: string
  orchestrator: boolean
  model?: string
  effort?: string
  tier?: string
  prompt: string
  worktree: string | null
  mode: SetupMode
}

export interface SetupEdge {
  from: string
  to: string
  kind: SetupEdgeKind
  label?: string
}

export interface CateSetup {
  version: 1
  id: string
  name: string
  source: SetupSource
  nodes: SetupNode[]
  edges: SetupEdge[]
  budget: { maxWorkers: number }
}

export type ListedSetup = CateSetup & { scope: SetupScope }

