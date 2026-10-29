// Reads cate-setup v1 files and applies them through the agent and relation
// runtime ports. Older canvas-captured files are normalized on read.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CateServiceHandlers } from '@kernel/api/contract'
import { RpcError } from '@kernel/rpc/contract'
import type { AgentStartArgs, AgentsRuntime } from '@services/agents/runtime'
import type { RelationRoleOf } from '@workspace/relations/contract'
import {
  addPanelRelation,
  setPanelOrchestratorPanel,
  type RelationRuntimeDocument,
} from '@workspace/relations/runtime'
import type { setupApi } from '../contract/api'
import {
  SETUP_AGENT_IDS,
  type CateSetup,
  type ListedSetup,
  type SetupEdge,
  type SetupScope,
  type SetupSource,
} from '../contract/schema'

const SETUP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NODE_ID = /^[a-zA-Z0-9_-]+$/
const SOURCES = ['alethe', 'manual', 'ai'] as const
const EDGE_KINDS = ['trigger', 'verify', 'context', 'use'] as const
const MODES = ['read-only', 'write'] as const

export interface SetupsRuntimeDeps {
  root: string
  homeDir?: string
  agents: Pick<AgentsRuntime, 'start'>
  document: RelationRuntimeDocument
  relationRole: RelationRoleOf
}

function refuse(problem: string): never {
  throw new RpcError('rejected', 'setup-invalid: ' + problem)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T)
}

function validateSetup(value: unknown): CateSetup {
  if (!record(value)) refuse('the file must contain a JSON object')
  if (value.version !== 1) refuse('version must be 1')
  if (typeof value.id !== 'string' || !SETUP_ID.test(value.id)) refuse('id must be a lowercase slug')
  if (typeof value.name !== 'string' || !value.name.trim()) refuse('name must be a non-empty string')
  if (!isOneOf(value.source, SOURCES)) refuse('source must be alethe, manual or ai')
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) refuse('nodes must be a non-empty array')
  if (!Array.isArray(value.edges)) refuse('edges must be an array')
  if (!record(value.budget) || !Number.isInteger(value.budget.maxWorkers) || (value.budget.maxWorkers as number) < 0) {
    refuse('budget.maxWorkers must be a non-negative integer')
  }

  const nodeIds = new Set<string>()
  for (const [index, node] of value.nodes.entries()) {
    if (!record(node)) refuse('nodes[' + index + '] must be an object')
    if (typeof node.id !== 'string' || !NODE_ID.test(node.id)) refuse('nodes[' + index + '].id is invalid')
    if (nodeIds.has(node.id)) refuse('duplicate node id ' + node.id)
    nodeIds.add(node.id)
    if (!isOneOf(node.agent, SETUP_AGENT_IDS)) refuse('nodes[' + index + '].agent is unsupported')
    if (typeof node.title !== 'string' || !node.title.trim() || node.title.length > 80) {
      refuse('nodes[' + index + '].title must contain 1 to 80 characters')
    }
    if (typeof node.orchestrator !== 'boolean') refuse('nodes[' + index + '].orchestrator must be boolean')
    if (node.prompt !== undefined && (typeof node.prompt !== 'string' || node.prompt.length > 50_000)) {
      refuse('nodes[' + index + '].prompt must be a string of at most 50000 characters')
    }
    for (const field of ['model', 'effort', 'tier'] as const) {
      if (node[field] !== undefined && node[field] !== null && (typeof node[field] !== 'string' || !node[field].trim())) {
        refuse('nodes[' + index + '].' + field + ' must be a non-empty string')
      }
    }
    if (node.worktree !== null && (typeof node.worktree !== 'string' || !node.worktree.trim())) {
      refuse('nodes[' + index + '].worktree must be null or a non-empty string')
    }
    if (!isOneOf(node.mode, MODES)) refuse('nodes[' + index + '].mode must be read-only or write')
  }

  for (const [index, edge] of value.edges.entries()) {
    if (!record(edge)) refuse('edges[' + index + '] must be an object')
    if (typeof edge.from !== 'string' || !nodeIds.has(edge.from)) refuse('edges[' + index + '].from must name a node')
    if (typeof edge.to !== 'string' || !nodeIds.has(edge.to)) refuse('edges[' + index + '].to must name a node')
    if (!isOneOf(edge.kind, EDGE_KINDS)) refuse('edges[' + index + '].kind is invalid')
    if (edge.label !== undefined && typeof edge.label !== 'string') refuse('edges[' + index + '].label must be a string')
  }
  return value as unknown as CateSetup
}

function isMissing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT'
}

function setupError(file: string, error: unknown): never {
  if (isMissing(error)) throw new RpcError('gone', 'setup-file-not-found: ' + file)
  throw error
}

async function readJson(file: string): Promise<unknown> {
  let contents: string
  try {
    contents = await fs.readFile(file, 'utf8')
  } catch (error) {
    return setupError(file, error)
  }
  try {
    return JSON.parse(contents) as unknown
  } catch (error) {
    refuse(file + ' is not valid JSON: ' + (error instanceof Error ? error.message : String(error)))
  }
}

function legacySetup(value: Record<string, unknown>, id: string): CateSetup {
  if (value.version !== 1 || !Array.isArray(value.nodes)) return refuse('legacy setup needs version 1 and a nodes array')
  const source: SetupSource = isOneOf(value.source, SOURCES) ? (value.source as SetupSource) : 'manual'
  const nodes = value.nodes.map((raw, index) => {
    if (!record(raw)) return refuse('nodes[' + index + '] must be an object')
    const nodeId = typeof raw.id === 'string' && NODE_ID.test(raw.id) ? raw.id : 'node-' + (index + 1)
    const agent = raw.agent ?? raw.agentId
    if (!isOneOf(agent, SETUP_AGENT_IDS)) return refuse('nodes[' + index + '].agent is unsupported')
    return {
      id: nodeId,
      agent,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : nodeId,
      orchestrator: raw.orchestrator === true,
      prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
      worktree: null,
      mode: 'write' as const,
    }
  })
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = (Array.isArray(value.edges) ? value.edges : []).flatMap((raw): SetupEdge[] => {
    if (!record(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string') return []
    if (!nodeIds.has(raw.from) || !nodeIds.has(raw.to) || !isOneOf(raw.kind, EDGE_KINDS)) return []
    return [{ from: raw.from, to: raw.to, kind: raw.kind as SetupEdge['kind'], ...(typeof raw.label === 'string' ? { label: raw.label } : {}) }]
  })
  return {
    version: 1,
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : id,
    source,
    nodes,
    edges,
    budget: { maxWorkers: nodes.filter((node) => !node.orchestrator).length },
  }
}

async function readStoredSetup(file: string, expectedId: string): Promise<CateSetup> {
  const value = await readJson(file)
  if (record(value) && value.id === undefined && value.budget === undefined) {
    return legacySetup(value, expectedId)
  }
  const setup = validateSetup(value)
  if (setup.id !== expectedId) refuse(file + ' must contain id ' + expectedId)
  return setup
}

export function createSetupsRuntime(deps: SetupsRuntimeDeps) {
  const homeDir = deps.homeDir ?? os.homedir()
  const directory = (scope: SetupScope) => scope === 'workspace'
    ? path.join(deps.root, '.cate', 'setups')
    : path.join(homeDir, '.cate', 'setups')
  const ensureDirectories = async () => {
    await Promise.all([
      fs.mkdir(directory('workspace'), { recursive: true }),
      fs.mkdir(directory('global'), { recursive: true }),
    ])
  }

  async function writeSetup(setup: CateSetup, scope: SetupScope): Promise<void> {
    await ensureDirectories()
    const target = path.join(directory(scope), setup.id + '.json')
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, JSON.stringify(setup, null, 2) + '\n', { flag: 'wx' })
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.unlink(temporary).catch(() => {})
      throw error
    }
  }

  async function list(): Promise<ListedSetup[]> {
    await ensureDirectories()
    const setups: ListedSetup[] = []
    for (const scope of ['workspace', 'global'] as const) {
      const entries = await fs.readdir(directory(scope), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const id = entry.name.slice(0, -5)
        setups.push({ ...(await readStoredSetup(path.join(directory(scope), entry.name), id)), scope })
      }
    }
    return setups.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope))
  }

  async function find(setupId: string): Promise<ListedSetup> {
    if (!SETUP_ID.test(setupId)) refuse('id must be a lowercase slug')
    await ensureDirectories()
    for (const scope of ['workspace', 'global'] as const) {
      const file = path.join(directory(scope), setupId + '.json')
      try {
        await fs.access(file)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      return { ...(await readStoredSetup(file, setupId)), scope }
    }
    throw new RpcError('gone', 'setup-not-found: ' + setupId)
  }

  async function save(args: { file: string; global: boolean; setupId?: string; name?: string }) {
    const input = await readJson(args.file)
    if (!record(input)) refuse('the file must contain a JSON object')
    const setup = validateSetup({
      ...input,
      ...(args.setupId !== undefined ? { id: args.setupId } : {}),
      ...(args.name !== undefined ? { name: args.name } : {}),
    })
    const scope: SetupScope = args.global ? 'global' : 'workspace'
    await writeSetup(setup, scope)
    return { ok: true, setupId: setup.id, scope }
  }

  async function importSetup(file: string) {
    const setup = validateSetup(await readJson(file))
    await writeSetup(setup, 'workspace')
    return { ok: true, setupId: setup.id, scope: 'workspace' as const }
  }

  async function remove(setupId: string, global: boolean) {
    if (!SETUP_ID.test(setupId)) refuse('id must be a lowercase slug')
    await ensureDirectories()
    const scope: SetupScope = global ? 'global' : 'workspace'
    const file = path.join(directory(scope), setupId + '.json')
    try {
      await fs.unlink(file)
    } catch (error) {
      setupError(file, error)
    }
    return { ok: true, setupId, scope }
  }

  async function apply(setupId: string, canvasPanelId?: string, task?: string) {
    const setup = await find(setupId)

    const panels: Record<string, string> = {}
    for (const node of setup.nodes) {
      const baseArgs = {
        agentId: node.agent,
        title: node.title,
        ...(node.orchestrator && task?.trim() ? { prompt: task.trim() } : {}),
        ...(node.model ? { model: node.model } : {}),
        ...(node.effort ? { effort: node.effort } : {}),
        ...(canvasPanelId ? { placement: { near: canvasPanelId } } : {}),
      } as AgentStartArgs
      let started: { panelId: string }
      if (node.worktree !== null) {
        try {
          started = await deps.agents.start(undefined, { ...baseArgs, newWorktree: node.worktree })
        } catch {
          started = await deps.agents.start(undefined, baseArgs)
        }
      } else {
        started = await deps.agents.start(undefined, baseArgs)
      }
      panels[node.id] = started.panelId
      if (node.orchestrator) setPanelOrchestratorPanel(deps.document, started.panelId, true)
    }

    const relations: string[] = []
    for (const edge of setup.edges) {
      relations.push(addPanelRelation(
        deps.document,
        deps.relationRole,
        panels[edge.from],
        panels[edge.to],
        edge.kind,
        edge.label,
      ))
    }
    return { ok: true, setupId, panels, relations }
  }

  return {
    apiHandlers(): CateServiceHandlers<typeof setupApi> {
      return {
        list: () => list(),
        show: ({ setupId }) => find(setupId),
        apply: ({ setupId, canvasPanelId, task }) => apply(setupId, canvasPanelId, task),
        save: (args) => save(args),
        'import': ({ file }) => importSetup(file),
        delete: ({ setupId, global }) => remove(setupId, global),
      }
    },
  }
}

