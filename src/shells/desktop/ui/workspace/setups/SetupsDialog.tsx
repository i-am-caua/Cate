// The canvas toolbar's setups menu: saved agent teams from this workspace and
// the machine, plus capturing the current canvas or asking an agent to design
// a new team. The body mounts only while the menu is open, so listing and the
// agent-type inspection never run for canvases nobody asked about.

import React, { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ArrowLeft, Layers, Play, Plus, RefreshCw, Sparkles, Workflow, X } from 'lucide-react'
import type { AgentId, AgentTypeInfo } from '@services/agents/contract'
import { errorMessage } from '@kernel/interaction'
import { revealPanel } from '@client/host'
import { isOrchestratorPanel } from '@workspace/relations/contract'
import {
  DEFAULT_SETUP_NODE_SIZE,
  setupFromCanvas,
  setupSourceLabel,
  type CateSetup,
  type SetupCanvasAgent,
  type SetupEntry,
  type SetupSource,
} from '@workspace/setups/contract'
import { useDocument } from '../../client/document'
import { canvasViewFor } from '../../client/layout/canvas'
import { InlineNotice, Spinner, Tooltip, useDismissableLayer } from '../../kernel/interaction'
import { useRuntime } from '../../kernel/rpc'
import { useAgentPanels } from '../../services/agents'

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
      "prompt": "The agent's first prompt",
      "position": { "x": 0, "y": 0 },
      "width": 640,
      "height": 400,
      "orchestrator": true
    },
    {
      "id": "builder",
      "title": "Builder",
      "agentId": "opencode",
      "prompt": "The agent's first prompt",
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
- Every node needs a title, an agentId and a useful first prompt.
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
  const [view, setView] = useState<'list' | 'create'>('list')
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

  const apply = useCallback(async (entry: SetupEntry) => {
    if (!runtime) return
    const key = `${entry.scope}:${entry.id}`
    setApplying(key)
    setFeedback(null)
    try {
      const result = await runtime.setup.apply({ id: entry.id, scope: entry.scope, canvasPanelId })
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

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Setups"
      className="fixed z-[1000] flex max-h-[min(600px,calc(100vh-100px))] w-[380px] flex-col overflow-hidden rounded-2xl border border-subtle shadow-xl text-xs"
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
        <span className="font-medium text-primary">{view === 'list' ? 'Setups' : 'New setup'}</span>
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
                onApply={() => void apply(entry)}
              />
            ))
          )}
        </div>
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
  onApply,
}: {
  entry: SetupEntry
  applying: boolean
  disabled: boolean
  onApply(): void
}) {
  const { setup } = entry
  return (
    <div className="flex items-start gap-2 rounded-xl px-2 py-2 hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-primary" title={setup.name}>{setup.name}</span>
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
      </div>
      <button
        type="button"
        aria-label={`Apply ${setup.name}`}
        title={`Apply ${setup.name}`}
        onClick={onApply}
        disabled={disabled}
        className="mt-0.5 flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] text-secondary hover:bg-surface-4 hover:text-primary disabled:opacity-40"
      >
        {applying ? <Spinner size={11} /> : <Play size={11} />} Apply
      </button>
    </div>
  )
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
