// `cate-setup` v1: a portable description of an agent team on a canvas.
// Files are plain JSON under `<root>/.cate/setups` or `~/.cate/setups`, and
// other tools (Alethe among them) may write them, so reading is tolerant:
// unknown keys are ignored, common aliases are accepted, and unusable nodes or
// edges are dropped instead of failing the whole file. What Cate writes is
// always the canonical shape below.

import type { Point, Size } from '@workspace/canvas/contract'
import { dockPanels, type RelationKind, type WorkspaceDocument } from '@workspace/document/contract'

export const CATE_SETUP_VERSION = 1
export const SETUP_SOURCES = ['alethe', 'ai', 'manual'] as const
export type SetupSource = (typeof SETUP_SOURCES)[number]
export type SetupScope = 'local' | 'global'

/** The size a started terminal panel gets when the setup names none. */
export const DEFAULT_SETUP_NODE_SIZE: Size = { width: 640, height: 400 }

export interface SetupNode {
  id: string
  title: string
  /** An agent registry id (`codex`, `opencode`, ...); absent lets the runtime pick. */
  agentId?: string
  /** The agent's first prompt. */
  prompt?: string
  /** Canvas-space top-left of the node. */
  position: Point
  size?: Size
  orchestrator?: boolean
}

export interface SetupEdge {
  /** Setup node ids. */
  from: string
  to: string
  kind: RelationKind
  label?: string
}

export interface CateSetup {
  version: typeof CATE_SETUP_VERSION
  name: string
  description?: string
  source: SetupSource
  nodes: SetupNode[]
  edges: SetupEdge[]
}

/** A setup loaded from a directory, with where it came from. */
export interface SetupEntry {
  id: string
  scope: SetupScope
  /** Absolute path on the runtime's machine. */
  path: string
  setup: CateSetup
}

export interface SetupApplyResult {
  setupId: string
  name: string
  /** Setup node id to the started panel id. */
  panelIds: Record<string, string>
  relationIds: string[]
  /** Non-fatal problems: a node skipped, a relation refused. */
  warnings: string[]
}

export interface SetupCanvasAgent {
  agentId?: string
  orchestrator?: boolean
}

const RELATION_KINDS: readonly RelationKind[] = ['use', 'context', 'verify', 'trigger']

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const boolOf = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

export function isSetupSource(value: unknown): value is SetupSource {
  return typeof value === 'string' && (SETUP_SOURCES as readonly string[]).includes(value)
}

/** A filename-safe setup id. Empty or symbol-only names fall back to `setup`. */
export function slugifySetupName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'setup'
}

export function setupSourceLabel(source: SetupSource): string {
  return source === 'alethe' ? 'Alethe' : source === 'ai' ? 'AI' : 'Manual'
}

function normalizeSource(value: unknown, fallback: SetupSource): SetupSource {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (isSetupSource(source)) return source
  if (source.includes('alethe') || source.includes('maestro')) return 'alethe'
  if (source.includes('ai') || source.includes('agent') || source.includes('generat') || source.includes('llm')) return 'ai'
  return fallback
}

function humanizeId(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function inferSource(raw: Record<string, unknown>, fallback: SetupSource): SetupSource {
  const declared = raw.source ?? raw.origin ?? raw.generatedBy ?? raw.author
  const source = normalizeSource(declared, fallback)
  if (source !== 'manual' || isSetupSource(typeof declared === 'string' ? declared.trim().toLowerCase() : undefined)) return source
  const generator = raw.generator ?? raw.model
  if (generator !== undefined) return 'ai'
  if (raw.generated === true || raw.ai === true) return 'ai'
  return fallback
}

/** Reads a setup id from a node id or a relation endpoint, matching the
 *  sanitization node ids get. */
function nodeRef(value: unknown): string | undefined {
  const raw = stringOf(value)
  if (!raw) return undefined
  return slugifySetupName(raw)
}

function parsePoint(raw: Record<string, unknown>, index: number): Point {
  const position = objectOf(raw.position) ?? objectOf(raw.at)
  const x = numberOf(position?.x) ?? numberOf(raw.x)
  const y = numberOf(position?.y) ?? numberOf(raw.y)
  if (x !== undefined && y !== undefined) return { x, y }
  const column = index % 3
  const row = Math.floor(index / 3)
  return { x: column * (DEFAULT_SETUP_NODE_SIZE.width + 80), y: row * (DEFAULT_SETUP_NODE_SIZE.height + 80) }
}

function parseSize(raw: Record<string, unknown>): Size | undefined {
  const size = objectOf(raw.size) ?? objectOf(raw.rect)
  const width = numberOf(size?.width) ?? numberOf(raw.width)
  const height = numberOf(size?.height) ?? numberOf(raw.height)
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined
  return { width, height }
}

function parseNode(rawValue: unknown, index: number, key: string | undefined, used: Set<string>): SetupNode | null {
  const raw = objectOf(rawValue)
  if (!raw) return null
  let id = nodeRef(raw.id ?? raw.nodeId ?? raw.slug ?? key ?? raw.name ?? raw.title)
  if (!id) id = `node-${index + 1}`
  let unique = id
  let suffix = 2
  while (used.has(unique)) unique = `${id}-${suffix++}`
  used.add(unique)
  const title = stringOf(raw.title) ?? stringOf(raw.name) ?? stringOf(raw.label) ?? humanizeId(unique)
  const agentId = stringOf(raw.agentId) ?? stringOf(raw.agent) ?? stringOf(raw.cli) ?? stringOf(raw.tool)
  const prompt = stringOf(raw.prompt) ?? stringOf(raw.instructions) ?? stringOf(raw.task)
  const orchestrator = boolOf(raw.orchestrator) ?? boolOf(raw.maestro) ?? undefined
  const size = parseSize(raw)
  return {
    id: unique,
    title,
    ...(agentId ? { agentId } : {}),
    ...(prompt ? { prompt } : {}),
    position: parsePoint(raw, index),
    ...(size ? { size } : {}),
    ...(orchestrator !== undefined ? { orchestrator } : {}),
  }
}

function parseEdge(rawValue: unknown, nodeIds: ReadonlySet<string>): SetupEdge | null {
  const raw = objectOf(rawValue)
  if (!raw) return null
  const from = nodeRef(raw.from ?? raw.fromNodeId ?? raw.fromId ?? raw.source ?? raw.sourceId ?? raw.fromPanelId)
  const to = nodeRef(raw.to ?? raw.toNodeId ?? raw.toId ?? raw.target ?? raw.targetId ?? raw.toPanelId)
  if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) return null
  const kindValue = stringOf(raw.kind) ?? stringOf(raw.relation) ?? stringOf(raw.type)
  const kind = kindValue && (RELATION_KINDS as readonly string[]).includes(kindValue)
    ? kindValue as RelationKind
    : 'trigger'
  const label = stringOf(raw.label)
  return { from, to, kind, ...(label ? { label } : {}) }
}

/**
 * Normalizes a parsed JSON value into a `cate-setup` v1. Returns null when the
 * value is not an object at all. `fallbackId` names the setup after its file,
 * and `fallbackSource` classifies files with no usable `source`.
 */
export function parseSetup(value: unknown, options: { id?: string; source?: SetupSource } = {}): CateSetup | null {
  const raw = objectOf(value)
  if (!raw) return null
  const id = options.id ?? stringOf(raw.id) ?? 'setup'
  const nodesValue = raw.nodes ?? raw.agents
  const nodesObject = objectOf(nodesValue)
  const nodesList = Array.isArray(nodesValue)
    ? nodesValue
    : nodesObject
      ? Object.entries(nodesObject).map(([key, node]) => {
          const object = objectOf(node)
          return object ? { ...object, id: object.id ?? key } : node
        })
      : []
  const used = new Set<string>()
  const nodes = nodesList
    .map((node, index) => parseNode(node, index, undefined, used))
    .filter((node): node is SetupNode => node !== null)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edgesValue = raw.edges ?? raw.relations ?? raw.links
  const edgesList = Array.isArray(edgesValue) ? edgesValue : []
  const seenPairs = new Set<string>()
  const edges = edgesList
    .map((edge) => parseEdge(edge, nodeIds))
    .filter((edge): edge is SetupEdge => {
      if (!edge) return false
      const pair = `${edge.from}\u0000${edge.to}`
      if (seenPairs.has(pair)) return false
      seenPairs.add(pair)
      return true
    })
  const name = stringOf(raw.name) ?? stringOf(raw.title) ?? humanizeId(id)
  const description = stringOf(raw.description) ?? stringOf(raw.summary)
  return {
    version: CATE_SETUP_VERSION,
    name,
    ...(description ? { description } : {}),
    source: inferSource(raw, options.source ?? 'manual'),
    nodes,
    edges,
  }
}

/** The canonical file contents. Only defined fields are written, so setup
 *  files stay small and diff cleanly. */
export function setupToJson(setup: CateSetup): Record<string, unknown> {
  return {
    version: CATE_SETUP_VERSION,
    name: setup.name,
    source: setup.source,
    ...(setup.description ? { description: setup.description } : {}),
    nodes: setup.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      ...(node.agentId ? { agentId: node.agentId } : {}),
      ...(node.prompt ? { prompt: node.prompt } : {}),
      position: { x: node.position.x, y: node.position.y },
      ...(node.size ? { width: node.size.width, height: node.size.height } : {}),
      ...(node.orchestrator ? { orchestrator: true } : {}),
    })),
    edges: setup.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.label ? { label: edge.label } : {}),
    })),
  }
}

/** Captures the agent terminal panels on one canvas and the relations between
 *  them. `agents` is keyed by panel id (the UI reads it from the live agent
 *  states); panels with no agent are left out. */
export function setupFromCanvas(
  doc: WorkspaceDocument,
  canvasId: string,
  name: string,
  agents: Readonly<Record<string, SetupCanvasAgent | undefined>>,
  options: { description?: string; source?: SetupSource } = {},
): CateSetup {
  const canvas = doc.canvases[canvasId]
  const nodes: SetupNode[] = []
  const panelIds = new Set<string>()
  for (const canvasNode of Object.values(canvas?.nodes ?? {})) {
    const rect = canvasNode.rect
    let stackIndex = 0
    for (const panelId of dockPanels(canvasNode.dock)) {
      const record = doc.panels[panelId]
      const agent = agents[panelId]
      if (!record || record.type !== 'terminal' || !agent?.agentId) continue
      nodes.push({
        id: panelId,
        title: record.title,
        agentId: agent.agentId,
        position: { x: rect.origin.x + stackIndex * 24, y: rect.origin.y + stackIndex * 24 },
        size: { width: rect.size.width, height: rect.size.height },
        ...(agent.orchestrator ? { orchestrator: true } : {}),
      })
      panelIds.add(panelId)
      stackIndex += 1
    }
  }
  const edges: SetupEdge[] = Object.values(doc.relations)
    .filter((relation) => panelIds.has(relation.fromPanelId) && panelIds.has(relation.toPanelId))
    .map((relation) => ({
      from: relation.fromPanelId,
      to: relation.toPanelId,
      kind: relation.kind,
      ...(relation.label ? { label: relation.label } : {}),
    }))
  return {
    version: CATE_SETUP_VERSION,
    name: name.trim() || 'Untitled setup',
    ...(options.description ? { description: options.description } : {}),
    source: options.source ?? 'manual',
    nodes,
    edges,
  }
}
