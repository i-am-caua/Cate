// The canvas toolbar's setups menu: saved agent teams from this workspace and
// the machine, plus capturing the current canvas or asking an agent to design
// a new team. The body mounts only while the menu is open, so listing and the
// agent-type inspection never run for canvases nobody asked about.

import React, { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ArrowLeft, Eye, Layers, Play, Plus, RefreshCw, Sparkles, Workflow, X } from 'lucide-react'
import type { AgentId, AgentTypeInfo } from '@services/agents/contract'
import type { RelationKind } from '@workspace/document/contract'
import { errorMessage } from '@kernel/interaction'
import { revealPanel } from '@client/host'
import { isOrchestratorPanel } from '@workspace/relations/contract'
import {
  DEFAULT_SETUP_NODE_SIZE,
  setupFromCanvas,
  setupSourceLabel,
  type CateSetup,
  type SetupApplyResult,
  type SetupCanvasAgent,
  type SetupEntry,
  type SetupNode,
  type SetupSource,
} from '@workspace/setups/contract'
import { useDocument } from '../../client/document'
import { canvasViewFor } from '../../client/layout/canvas'
import { InlineNotice, Spinner, Tooltip, useDismissableLayer } from '../../kernel/interaction'
import { useRuntime } from '../../kernel/rpc'
import { useAgentPanels } from '../../services/agents'

type SetupNodeWithModel = SetupNode & {
  model?: string
  effort?: string
  tier?: string
  mode?: 'read-only' | 'write'
  worktree?: string | null
}

export interface SetupsPopoverProps {
  workspaceId: string
  /** The canvas new agent terminals land on. */
  canvasPanelId: string
  pos: { left: number; bottom: number }
  triggerRef: RefObject<HTMLButtonElement | null>
  onClose(): void
}

interface Feedback {
  tone: 'error' | 'success' | 'warning'
  text: string
}

const SOURCE_TONE: Record<SetupSource, string> = {
  alethe: 'text-violet-300 bg-violet-500/10 border-violet-400/20',
  ai: 'text-agent-light bg-agent/10 border-agent/20',
  manual: 'text-muted bg-surface-4 border-subtle',
}

/** The prompt that asks an agent to write one `cate-setup` v1 file. */
export function setupGenerationPrompt(goal: string, agentIds: readonly AgentId[]): string {
  const choices = agentIds.length > 0 ? agentIds.join(', ') : 'codex, opencode'
  return `Design a Cate agent-team setup for this goal:

${goal.trim()}

Write one JSON file at .cate/setups/<id>.json in this workspace (create the folder if needed). Use exactly this cate-setup v1 shape:

{
  "version": 1,
  "name": "Short setup name",
  "description": "What this team does",
  "source": "ai",
  "nodes": [
    {
      "id": "planner",
      "title": "Planner",
      "agentId": "codex",
      "model": "gemini-4-argon-medium",
      "effort": "medium",
      "prompt": "Coordinate the team and break down tasks.",
      "position": { "x": 0, "y": 0 },
      "width": 640,
      "height": 400,
      "orchestrator": true
    },
    {
      "id": "builder",
      "title": "Builder",
      "agentId": "opencode",
      "model": "gemini-4-argon-medium",
      "effort": "medium",
      "prompt": "Implement assigned changes and verify tests.",
      "position": { "x": 720, "y": 0 },
      "width": 640,
      "height": 400
    }
  ],
  "edges": [
    { "from": "planner", "to": "builder", "kind": "trigger", "label": "Implementation" }
  ]
}

Rules:
- Node ids are unique lowercase slugs; edges must reference them.
- Every node needs a title, an agentId and a prompt that describes the node's role.
- Nodes of the same agent CLI can specify different model and effort values.
- Use only these agent ids: ${choices}.
- Edge kinds are trigger, use, context or verify.
- Lay nodes out left to right without overlapping (roughly 720px apart).
- Mark a node orchestrator only when the team needs a coordinator.
- Write no other files. Reply with the saved path.`
}

export const SetupsPopover: React.FC<SetupsPopoverProps> = ({
  workspaceId,
  canvasPanelId,
  pos,
  triggerRef,
  onClose,
}) => {
  const runtime = useRuntime(workspaceId)
  const rootRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'list' | 'preview' | 'create'>('list')
  const [previewEntry, setPreviewEntry] = useState<SetupEntry | null>(null)
  const [orchestratorTask, setOrchestratorTask] = useState('')
  const [entries, setEntries] = useState<SetupEntry[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [goal, setGoal] = useState('')
  const [types, setTypes] = useState<AgentTypeInfo[]>([])
  const [agentId, setAgentId] = useState<AgentId | null>(null)
  const [generating, setGenerating] = useState(false)

  useDismissableLayer({ open: true, contentRef: rootRef, triggerRefs: [triggerRef], onDismiss: onClose })

  const doc = useDocument(workspaceId, (value) => value)
  const canvasId = doc.panels[canvasPanelId]?.canvasId ?? null
  const agentStates = useAgentPanels(workspaceId, (states) => states)

  const agents = useMemo(() => {
    const selected: Record<string, SetupCanvasAgent> = {}
    for (const [panelId, state] of Object.entries(agentStates)) {
      if (!state.agentId) continue
      const record = doc.panels[panelId]
      if (!record || record.type !== 'terminal') continue
      selected[panelId] = {
        agentId: state.agentId,
        ...(isOrchestratorPanel(record.fields) ? { orchestrator: true } : {}),
      }
    }
    return selected
  }, [agentStates, doc.panels])

  const canvasSetup = useMemo(
    () => canvasId ? setupFromCanvas(doc, canvasId, 'Untitled setup', agents) : null,
    [canvasId, doc, agents],
  )

  const load = useCallback(async (quiet = false) => {
    if (!runtime) return
    if (!quiet) setRefreshing(true)
    try {
      setEntries(await runtime.setup.list())
      setFeedback((current) => current?.tone === 'error' ? null : current)
    } catch (error) {
      setEntries((current) => current ?? [])
      setFeedback({ tone: 'error', text: errorMessage(error, 'Could not load setups.') })
    } finally {
      if (!quiet) setRefreshing(false)
    }
  }, [runtime])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!runtime) return
    let live = true
    runtime.agents.types().then((list) => {
      if (!live) return
      const ready = list.filter((type) => type.ready)
      setTypes(ready)
      setAgentId((current) => current && ready.some((type) => type.agentId === current)
        ? current
        : ready[0]?.agentId ?? null)
    }, (error) => {
      if (live) setFeedback({ tone: 'error', text: errorMessage(error, 'Could not inspect the agent CLIs.') })
    })
    return () => { live = false }
  }, [runtime])

  const apply = useCallback(async (entry: SetupEntry, task?: string) => {
    if (!runtime) return
    const key = `${entry.scope}:${entry.id}`
    setApplying(key)
    setFeedback(null)
    try {
      const trimmedTask = task?.trim()
      const applySetup = runtime.setup.apply as (args: {
        id: string
        scope?: SetupEntry['scope']
        canvasPanelId?: string
        orchestratorPrompt?: string
      }) => Promise<SetupApplyResult>
      const result = await applySetup(
        trimmedTask
          ? { id: entry.id, scope: entry.scope, canvasPanelId, orchestratorPrompt: trimmedTask }
          : { id: entry.id, scope: entry.scope, canvasPanelId },
      )
      if (result.warnings.length === 0) {
        onClose()
        return
      }
      setFeedback({
        tone: 'warning',
        text: `Started ${Object.keys(result.panelIds).length} of ${entry.setup.nodes.length} agents. ${result.warnings.join(' ')}`,
      })
      void load(true)
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'Could not apply the setup.') })
    } finally {
      setApplying(null)
    }
  }, [runtime, canvasPanelId, onClose, load])

  const save = useCallback(async () => {
    const setupName = name.trim()
    if (!runtime || !canvasSetup || !setupName) return
    setSaving(true)
    setFeedback(null)
    try {
      const setup: CateSetup = { ...canvasSetup, name: setupName, source: 'manual' }
      const entry = await runtime.setup.save({ setup, scope: 'local' })
      setName('')
      setFeedback({ tone: 'success', text: `Saved “${entry.setup.name}” to .cate/setups/${entry.id}.json.` })
      await load(true)
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'Could not save the setup.') })
    } finally {
      setSaving(false)
    }
  }, [runtime, canvasSetup, name, load])

  const generate = useCallback(async () => {
    const brief = goal.trim()
    if (!runtime || !agentId || !brief || !canvasId) return
    const store = canvasViewFor(workspaceId, canvasId)
    if (!store) {
      setFeedback({ tone: 'error', text: 'This canvas is not open in the client.' })
      return
    }
    setGenerating(true)
    setFeedback(null)
    try {
      const at = store.getState().placeTarget(DEFAULT_SETUP_NODE_SIZE)
      const { panelId } = await runtime.agents.start({
        agentId,
        title: 'Setup generator',
        prompt: setupGenerationPrompt(brief, types.map((type) => type.agentId)),
        at,
      })
      onClose()
      void revealPanel(workspaceId, panelId)
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'Could not start the setup agent.') })
    } finally {
      setGenerating(false)
    }
  }, [runtime, agentId, goal, canvasId, workspaceId, types, onClose])

  const saveReady = !!canvasSetup && canvasSetup.nodes.length > 0 && !!name.trim() && !saving
  const generateReady = !!agentId && !!goal.trim() && !!canvasId && !generating
  const fresh = entries !== null && entries.length === 0
  const headerTitle = view === 'list'
    ? 'Setups'
    : view === 'preview' && previewEntry
      ? previewEntry.setup.name
      : 'New setup'

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Setups"
      className={`fixed z-[1000] flex max-h-[min(640px,calc(100vh-100px))] ${view === 'preview' ? 'w-[560px]' : 'w-[380px]'} flex-col overflow-hidden rounded-2xl border border-subtle shadow-xl text-xs`}
      style={{
        left: pos.left,
        bottom: pos.bottom,
        background: 'color-mix(in srgb, var(--surface-0) 88%, transparent)',
        backdropFilter: 'blur(24px) saturate(1.5)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.5)',
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2.5">
        <Layers size={15} className="shrink-0 text-muted" />
        <span className="truncate font-medium text-primary">{headerTitle}</span>
        {view === 'list' && entries !== null && (
          <span className="text-[11px] text-muted tabular-nums">{entries.length}</span>
        )}
        <div className="flex-1" />
        {view === 'list' ? (
          <>
            <Tooltip label="Refresh setups">
              <button
                type="button"
                aria-label="Refresh setups"
                onClick={() => void load()}
                disabled={refreshing}
                className="flex h-6 w-6 items-center justify-center rounded-lg text-muted hover:bg-surface-4 hover:text-primary disabled:opacity-50"
              >
                {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
              </button>
            </Tooltip>
            <Tooltip label="New setup">
              <button
                type="button"
                aria-label="New setup"
                onClick={() => { setView('create'); setFeedback(null) }}
                className="flex h-6 w-6 items-center justify-center rounded-lg text-muted hover:bg-surface-4 hover:text-primary"
              >
                <Plus size={14} />
              </button>
            </Tooltip>
          </>
        ) : (
          <Tooltip label="Back to setups">
            <button
              type="button"
              aria-label="Back to setups"
              onClick={() => { setView('list'); setFeedback(null) }}
              className="flex h-6 w-6 items-center justify-center rounded-lg text-muted hover:bg-surface-4 hover:text-primary"
            >
              <ArrowLeft size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Close">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-muted hover:bg-surface-4 hover:text-primary"
          >
            <X size={13} />
          </button>
        </Tooltip>
      </header>

      {feedback && (
        <div className="shrink-0 px-2.5 pt-2">
          <InlineNotice tone={feedback.tone} className="flex items-start gap-2 border-0">
            <span className="flex-1 whitespace-pre-wrap break-words">{feedback.text}</span>
            <button type="button" aria-label="Dismiss message" onClick={() => setFeedback(null)} className="text-muted hover:text-primary">
              <X size={11} />
            </button>
          </InlineNotice>
        </div>
      )}

      {view === 'list' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {entries === null ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-[11px] text-muted">
              <Spinner size={13} /> Loading setups…
            </div>
          ) : fresh ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <Workflow size={20} className="text-muted opacity-50" />
              <span className="text-[11px] leading-relaxed text-muted">
                No setups yet. Save this canvas or ask an agent to design a team.
              </span>
              <button
                type="button"
                onClick={() => { setView('create'); setFeedback(null) }}
                className="mt-1 flex items-center gap-1.5 rounded-lg bg-surface-3 px-3 py-1.5 text-[11px] text-secondary hover:bg-surface-4 hover:text-primary"
              >
                <Plus size={12} /> New setup
              </button>
            </div>
          ) : (
            entries.map((entry) => (
              <SetupRow
                key={`${entry.scope}:${entry.id}`}
                entry={entry}
                applying={applying === `${entry.scope}:${entry.id}`}
                disabled={applying !== null}
                onPreview={() => {
                  setPreviewEntry(entry)
                  setOrchestratorTask('')
                  setFeedback(null)
                  setView('preview')
                }}
                onApply={() => void apply(entry)}
              />
            ))
          )}
        </div>
      ) : view === 'preview' && previewEntry ? (
        <SetupDiagramPreview
          entry={previewEntry}
          orchestratorTask={orchestratorTask}
          onChangeOrchestratorTask={setOrchestratorTask}
          applying={applying === `${previewEntry.scope}:${previewEntry.id}`}
          disabled={applying !== null}
          onApply={() => void apply(previewEntry, orchestratorTask)}
        />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
          <section className="rounded-xl border border-subtle bg-surface-1 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-secondary">
              <Workflow size={13} /> From this canvas
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {canvasSetup && canvasSetup.nodes.length > 0
                ? `${countLabel(canvasSetup.nodes.length, 'agent')} · ${countLabel(canvasSetup.edges.length, 'relation')} will be saved.`
                : canvasId
                  ? 'Add agent terminals to this canvas to capture a team.'
                  : 'This canvas is not open in the client.'}
            </p>
            <div className="mt-2 flex items-center gap-1.5">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && saveReady) void save() }}
                placeholder="Setup name"
                aria-label="Setup name"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-lg border border-subtle bg-surface-2 px-2 text-[12px] text-primary outline-none placeholder:text-muted focus:border-focus"
              />
              <button
                type="button"
                onClick={() => void save()}
                disabled={!saveReady}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-surface-3 px-2.5 text-[11px] text-secondary hover:bg-surface-4 hover:text-primary disabled:opacity-40"
              >
                {saving ? <Spinner size={12} /> : <Plus size={12} />} Save
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-subtle bg-surface-1 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-secondary">
              <Sparkles size={13} /> Generate with AI
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Describe the team you want. The agent writes a setup file here.
            </p>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={3}
              placeholder="e.g. a planner, two builders and a reviewer for this refactor…"
              aria-label="Setup goal"
              className="mt-2 w-full resize-none rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-[12px] leading-relaxed text-primary outline-none placeholder:text-muted focus:border-focus"
            />
            <div className="mt-1.5 flex items-center gap-1.5">
              <select
                value={agentId ?? ''}
                onChange={(event) => setAgentId(event.target.value as AgentId)}
                aria-label="Setup agent"
                disabled={types.length === 0}
                className="h-7 min-w-0 flex-1 rounded-lg border border-subtle bg-surface-2 px-1.5 text-[11px] text-secondary outline-none disabled:opacity-50"
              >
                {types.length === 0 && <option value="">No agent ready</option>}
                {types.map((type) => (
                  <option key={type.agentId} value={type.agentId}>{type.displayName}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={!generateReady}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-surface-3 px-2.5 text-[11px] text-secondary hover:bg-surface-4 hover:text-primary disabled:opacity-40"
              >
                {generating ? <Spinner size={12} /> : <Sparkles size={12} />} Generate
              </button>
            </div>
            {types.length === 0 && (
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
                No agent CLI is ready here. Turn on an agent’s Cate hooks in Settings → Agents.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function SetupRow({
  entry,
  applying,
  disabled,
  onPreview,
  onApply,
}: {
  entry: SetupEntry
  applying: boolean
  disabled: boolean
  onPreview(): void
  onApply(): void
}) {
  const { setup } = entry
  const nodes = setup.nodes as SetupNodeWithModel[]
  return (
    <div className="flex items-start gap-2 rounded-xl px-2 py-2 hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onPreview}
            className="truncate text-left text-[12px] font-medium text-primary hover:underline"
            title={setup.name}
          >
            {setup.name}
          </button>
          <span className={`shrink-0 rounded border px-1 py-px text-[9px] leading-none ${SOURCE_TONE[setup.source]}`}>
            {setupSourceLabel(setup.source)}
          </span>
        </div>
        {setup.description && (
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-muted">{setup.description}</p>
        )}
        <div className="mt-0.5 truncate text-[10px] text-muted" title={entry.path}>
          {entry.scope === 'local' ? 'Workspace' : 'Global'} · {countLabel(setup.nodes.length, 'agent')} · {countLabel(setup.edges.length, 'relation')}
        </div>
        {nodes.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {nodes.map((node) => {
              const badge = formatModelEffort(node)
              return (
                <span
                  key={node.id}
                  className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-subtle bg-surface-3 px-1.5 py-0.5 text-[9px] text-secondary"
                >
                  {node.orchestrator && <span title="Orchestrator">👑</span>}
                  <span className="truncate font-medium text-primary">{node.title}</span>
                  <span className="text-muted">({node.agentId ?? 'auto'})</span>
                  {badge && <span className="truncate text-muted">· {badge}</span>}
                </span>
              )
            })}
          </div>
        )}
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={`Preview ${setup.name}`}
          title={`Preview ${setup.name}`}
          onClick={onPreview}
          className="flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] text-secondary hover:bg-surface-4 hover:text-primary"
        >
          <Eye size={11} /> Preview
        </button>
        <button
          type="button"
          aria-label={`Apply ${setup.name}`}
          title={`Apply ${setup.name}`}
          onClick={onApply}
          disabled={disabled}
          className="flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] text-secondary hover:bg-surface-4 hover:text-primary disabled:opacity-40"
        >
          {applying ? <Spinner size={11} /> : <Play size={11} />} Apply
        </button>
      </div>
    </div>
  )
}

const EDGE_COLORS: Record<RelationKind, string> = {
  trigger: '#38bdf8',
  verify: '#34d399',
  context: '#a78bfa',
  use: '#fbbf24',
}

const NODE_W = 168
const NODE_H = 68
const COL_GAP = 72
const ROW_GAP = 22
const PAD_X = 20
const PAD_Y = 20

interface PositionedDiagramNode {
  node: SetupNodeWithModel
  x: number
  y: number
}

function layoutDiagramNodes(setup: CateSetup): {
  positioned: PositionedDiagramNode[]
  byId: Record<string, PositionedDiagramNode>
  width: number
  height: number
} {
  const nodes = setup.nodes as SetupNodeWithModel[]
  if (nodes.length === 0) {
    return { positioned: [], byId: {}, width: 480, height: 140 }
  }

  const ranks: Record<string, number> = {}
  const inDegree: Record<string, number> = {}
  for (const node of nodes) {
    ranks[node.id] = 0
    inDegree[node.id] = 0
  }
  for (const edge of setup.edges) {
    if (edge.from in inDegree && edge.to in inDegree) {
      inDegree[edge.to] += 1
    }
  }

  const hasOrchestrator = nodes.some((node) => node.orchestrator)
  if (setup.edges.length > 0) {
    for (const node of nodes) {
      if (hasOrchestrator && !node.orchestrator && inDegree[node.id] === 0) {
        ranks[node.id] = 1
      }
    }
    for (let step = 0; step < nodes.length; step++) {
      let changed = false
      for (const edge of setup.edges) {
        if (!(edge.from in ranks) || !(edge.to in ranks)) continue
        if (nodes.find((n) => n.id === edge.to)?.orchestrator) continue
        const candidate = Math.min(nodes.length - 1, ranks[edge.from] + 1)
        if (candidate > ranks[edge.to]) {
          ranks[edge.to] = candidate
          changed = true
        }
      }
      if (!changed) break
    }
  } else {
    const sortedX = [...new Set(nodes.map((node) => Math.round(node.position.x / 200)))].sort((a, b) => a - b)
    for (const node of nodes) {
      const col = Math.max(0, sortedX.indexOf(Math.round(node.position.x / 200)))
      ranks[node.id] = node.orchestrator ? 0 : col
    }
  }

  const columns = new Map<number, SetupNodeWithModel[]>()
  for (const node of nodes) {
    const col = ranks[node.id] ?? 0
    const list = columns.get(col) ?? []
    list.push(node)
    columns.set(col, list)
  }

  const sortedCols = [...columns.keys()].sort((a, b) => a - b)
  const colHeights = sortedCols.map((col) => {
    const count = columns.get(col)!.length
    return count * NODE_H + Math.max(0, count - 1) * ROW_GAP
  })
  const maxColH = Math.max(NODE_H, ...colHeights)

  const positioned: PositionedDiagramNode[] = []
  const byId: Record<string, PositionedDiagramNode> = {}

  sortedCols.forEach((colKey, colIndex) => {
    const colNodes = columns.get(colKey)!
    colNodes.sort((a, b) => {
      if (Boolean(a.orchestrator) !== Boolean(b.orchestrator)) return a.orchestrator ? -1 : 1
      return a.position.y - b.position.y
    })
    const colH = colNodes.length * NODE_H + Math.max(0, colNodes.length - 1) * ROW_GAP
    const startY = PAD_Y + (maxColH - colH) / 2
    const x = PAD_X + colIndex * (NODE_W + COL_GAP)
    colNodes.forEach((node, rowIndex) => {
      const item: PositionedDiagramNode = {
        node,
        x,
        y: startY + rowIndex * (NODE_H + ROW_GAP),
      }
      positioned.push(item)
      byId[node.id] = item
    })
  })

  const totalCols = Math.max(1, sortedCols.length)
  const width = Math.max(480, PAD_X * 2 + totalCols * NODE_W + Math.max(0, totalCols - 1) * COL_GAP)
  const height = Math.max(130, PAD_Y * 2 + maxColH)

  return { positioned, byId, width, height }
}

function SetupDiagramPreview({
  entry,
  orchestratorTask,
  onChangeOrchestratorTask,
  applying,
  disabled,
  onApply,
}: {
  entry: SetupEntry
  orchestratorTask: string
  onChangeOrchestratorTask(value: string): void
  applying: boolean
  disabled: boolean
  onApply(): void
}) {
  const { setup } = entry
  const nodes = setup.nodes as SetupNodeWithModel[]
  const layout = useMemo(() => layoutDiagramNodes(setup), [setup])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {setup.description && (
          <p className="text-[11px] leading-relaxed text-muted">{setup.description}</p>
        )}

        <div className="overflow-x-auto rounded-xl border border-subtle bg-surface-1 p-2">
          <svg
            data-testid="setup-diagram-svg"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="h-auto min-w-full select-none"
            style={{ maxHeight: 280 }}
          >
            <defs>
              {(['trigger', 'verify', 'context', 'use'] as const).map((kind) => (
                <marker
                  key={kind}
                  id={`setup-arrow-${kind}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 9 5 L 0 9 z" fill={EDGE_COLORS[kind]} />
                </marker>
              ))}
            </defs>

            {setup.edges.map((edge, index) => {
              const from = layout.byId[edge.from]
              const to = layout.byId[edge.to]
              if (!from || !to) return null
              const color = EDGE_COLORS[edge.kind] ?? EDGE_COLORS.trigger
              const forward = from.x < to.x
              const sx = forward ? from.x + NODE_W : from.x
              const sy = from.y + NODE_H / 2
              const tx = forward ? to.x : to.x + NODE_W
              const ty = to.y + NODE_H / 2
              const dx = Math.max(40, Math.abs(tx - sx) * 0.45)
              const c1x = forward ? sx + dx : sx - dx
              const c2x = forward ? tx - dx : tx + dx
              const d = `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`
              const mx = (sx + tx) / 2
              const my = (sy + ty) / 2 - 6
              const edgeText = edge.label && edge.label.toLowerCase() !== edge.kind.toLowerCase()
                ? `${edge.kind} · ${edge.label}`
                : edge.kind
              return (
                <g key={`${edge.from}-${edge.to}-${index}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.75}
                    markerEnd={`url(#setup-arrow-${edge.kind})`}
                  />
                  <text
                    x={mx}
                    y={my}
                    textAnchor="middle"
                    fill={color}
                    fontSize="9"
                    fontWeight="600"
                  >
                    {edgeText}
                  </text>
                </g>
              )
            })}

            {layout.positioned.map(({ node, x, y }) => {
              const modelBadge = formatModelEffort(node)
              return (
                <g key={node.id} transform={`translate(${x}, ${y})`}>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    fill="var(--surface-2)"
                    stroke={node.orchestrator ? '#f59e0b' : 'var(--border-subtle)'}
                    strokeWidth={node.orchestrator ? 1.5 : 1}
                  />
                  <text x={10} y={19} fill="var(--text-primary)" fontSize="11" fontWeight="600">
                    {node.orchestrator ? `👑 ${node.title}` : node.title}
                  </text>
                  <text x={10} y={36} fill="var(--text-secondary)" fontSize="9.5">
                    {node.agentId ?? 'auto'}
                    {node.orchestrator ? ' · Orchestrator' : ''}
                  </text>
                  {modelBadge && (
                    <text x={10} y={53} fill="var(--text-muted)" fontSize="9">
                      {modelBadge}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
            Nodes & Roles ({nodes.length})
          </div>
          {nodes.map((node) => {
            const modelBadge = formatModelEffort(node)
            return (
              <div
                key={node.id}
                className="rounded-xl border border-subtle bg-surface-1 px-2.5 py-2"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {node.orchestrator && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                      👑 Orchestrator
                    </span>
                  )}
                  <span className="text-[11px] font-medium text-primary">{node.title}</span>
                  <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] text-secondary">
                    {node.agentId ?? 'auto'}
                  </span>
                  {modelBadge && (
                    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] text-muted">
                      {modelBadge}
                    </span>
                  )}
                  {node.mode && (
                    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] text-muted">
                      {node.mode}
                    </span>
                  )}
                  {node.worktree && (
                    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] text-muted">
                      wt:{node.worktree}
                    </span>
                  )}
                </div>
                {node.prompt && (
                  <p className="mt-1 text-[10px] leading-relaxed text-muted">
                    <span className="font-medium text-secondary">Role:</span> {node.prompt}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-subtle bg-surface-1 px-3 py-2.5">
        <input
          value={orchestratorTask}
          onChange={(event) => onChangeOrchestratorTask(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !disabled) onApply() }}
          aria-label="Orchestrator task"
          placeholder="Task for the orchestrator (optional — leave empty to open idle)"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-lg border border-subtle bg-surface-2 px-2.5 text-[11px] text-primary outline-none placeholder:text-muted focus:border-focus"
        />
        <button
          type="button"
          aria-label={`Apply ${setup.name}`}
          onClick={onApply}
          disabled={disabled}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-surface-3 px-3 text-[11px] font-medium text-secondary hover:bg-surface-4 hover:text-primary disabled:opacity-40"
        >
          {applying ? <Spinner size={12} /> : <Play size={12} />} Apply setup
        </button>
      </footer>
    </div>
  )
}

function formatModelEffort(node: SetupNodeWithModel): string | null {
  if (node.model && node.effort) return `${node.model} · ${node.effort}`
  if (node.model) return node.model
  if (node.effort) return node.effort
  return null
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
