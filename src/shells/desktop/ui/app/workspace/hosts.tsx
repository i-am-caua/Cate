// The contexts workspace UI reads from the client (it may not import the
// client layer): the repository host for the shown workspace and the file
// views host. Opening a review is the review panel's: the shell installs it.

import { useEffect, useMemo, type ReactNode } from 'react'
import { clientUi } from '@kernel/interaction'
import { subscribeRuntimes, tryRuntimeFor } from '@kernel/rpc/client'
import { isIconName } from '@kernel/interaction/contract'
import { documentStoreFor } from '@client/document'
import { useDocument } from '../../client/document'
import { confirmClose, createPanel, creatableDefinitions, focusedPanelId, panelDefinition } from '@client/host'
import { activeCanvasId, createPanelOnCanvas, useCanvasUi } from '../../client/layout/canvas'
import { useWorkspaceRoot } from '../../client/connections'
import { panelsBoundTo } from '@workspace/repository/contract'
import { switchPanelWorktree, type RepositoryHost, type ReviewRequest, type WorktreeLaunchType } from '@workspace/repository/client'
import { RepositoryUiProvider } from '../../workspace/repository'
import { FileViewsContext } from '../../workspace/files'
import type { PanelRecord, WorktreeMeta } from '@workspace/document/contract'
import { fileViewsHost } from './fileActions'
import type { FileAccessRequest } from '@workspace/files/contract'

/** Opens (or reuses) a review panel for a comparison. */
export type ReviewOpener = (request: ReviewRequest & { workspaceId: string }) => Promise<unknown>
let reviewOpener: ReviewOpener | null = null

export function installReviewOpener(opener: ReviewOpener | null): void {
  reviewOpener = opener
}

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i])
const selectWorktrees = (doc: { worktrees: Record<string, WorktreeMeta> }) => Object.values(doc.worktrees)
const selectPanels = (doc: { panels: Record<string, PanelRecord> }) => Object.values(doc.panels)

/** Types created in a checkout, in creation order. */
function worktreeLaunchTypes(): WorktreeLaunchType[] {
  return creatableDefinitions()
    .filter((d) => d.creation?.inWorktree)
    .map((d) => ({ type: d.type, label: d.label, icon: isIconName(d.icon) ? d.icon : 'grid', switches: !!d.switchesWorktree }))
}

export function RepositoryHost({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const root = useWorkspaceRoot(workspaceId)
  const worktrees = useDocument(workspaceId, selectWorktrees, sameList)
  const panels = useDocument(workspaceId, selectPanels, sameList)
  const focusedWorktreeId = useCanvasUi((s) => s.focusedWorktreeId)

  const host = useMemo<RepositoryHost>(() => ({
    workspaceId,
    root,
    worktrees,
    panels,
    launchTypes: worktreeLaunchTypes(),
    focusedWorktreeId,
    setWorktree(meta) {
      documentStoreFor(workspaceId)?.propose({ kind: 'setWorktree', worktree: meta })
    },
    async launchInWorktree(worktree, type, opts) {
      const options = { worktreeId: worktree.id, cwd: worktree.path }
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      const canvasId = opts?.canvasPanelId ? doc?.panels[opts.canvasPanelId]?.canvasId : activeCanvasId(workspaceId)
      if (canvasId) return createPanelOnCanvas(workspaceId, canvasId, type, options) !== null
      return createPanel(workspaceId, type, { ...options, near: focusedPanelId(workspaceId) ?? undefined }) !== null
    },
    worktreePanelSummary(worktreeId) {
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      return { count: doc ? panelsBoundTo(doc, worktreeId).length : 0, hasDirtyEditor: false }
    },
    async prepareWorktreeClose(worktreeId) {
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      if (!doc) return false
      return (await confirmClose(workspaceId, panelsBoundTo(doc, worktreeId).map((p) => p.id))) !== null
    },
    switchesWorktree: (panel) => panelDefinition(panel.type)?.switchesWorktree === true,
    async switchPanelWorktree(panelId, picked) {
      const record = documentStoreFor(workspaceId)?.getSnapshot().panels[panelId]
      const runtime = tryRuntimeFor(workspaceId)
      if (!record || !runtime) return
      await switchPanelWorktree({
        panelId, picked, root, runtime,
        switches: panelDefinition(record.type)?.switchesWorktree === true,
        propose: (op) => documentStoreFor(workspaceId)?.propose(op),
      })
    },
    async openReview(request) {
      await reviewOpener?.({ workspaceId, ...request })
    },
    focusWorktree: (worktreeId) => useCanvasUi.getState().setFocusedWorktree(worktreeId),
    setHoveredWorktree: (worktreeId) => useCanvasUi.getState().setHoveredWorktree(worktreeId),
  }), [workspaceId, root, worktrees, panels, focusedWorktreeId])

  return <RepositoryUiProvider host={host}>{children}</RepositoryUiProvider>
}

export function FileViewsHost({ children }: { children: ReactNode }) {
  return <FileViewsContext.Provider value={fileViewsHost}>{children}</FileViewsContext.Provider>
}

function FileAccessPrompts({ workspaceId }: { workspaceId: string }): null {
  useEffect(() => {
    let stopStream = () => {}
    let attachedRuntime: ReturnType<typeof tryRuntimeFor> = null
    let promptQueue = Promise.resolve()
    const attach = () => {
      const runtime = tryRuntimeFor(workspaceId)
      if (runtime === attachedRuntime) return
      stopStream()
      attachedRuntime = runtime
      if (!runtime) return

      let active = true
      const stream = runtime.file.accessRequests(undefined, { resume: true })
      stream.onEvent((request: FileAccessRequest) => {
        promptQueue = promptQueue.then(async () => {
          if (!active) return
          const operation = request.operation === 'read' ? 'read' : request.operation === 'write' ? 'write to' : 'browse'
          const message = request.grantPath === request.path
            ? `Allow Cate to ${operation} this path?\n\n${request.path}\n\nApproval is remembered for this workspace.`
            : `Allow Cate to ${operation} this path?\n\n${request.path}\n\nApproval also covers this folder and its contents:\n${request.grantPath}`
          const ui = clientUi()
          const allow = ui.confirmFileAccess
            ? await ui.confirmFileAccess(request)
            : await ui.confirm(message)
          if (active) await runtime.file.resolveAccessRequest({ requestId: request.id, allow })
        }).catch(() => { /* the request expires if the runtime disconnects */ })
      })
      stream.done.catch(() => {})
      stopStream = () => {
        active = false
        stream.cancel()
      }
    }

    const unsubscribe = subscribeRuntimes(attach)
    attach()
    return () => {
      unsubscribe()
      stopStream()
    }
  }, [workspaceId])
  return null
}

export function WorkspaceFileAccessPrompts({ workspaceIds }: { workspaceIds: readonly string[] }): JSX.Element {
  return <>{workspaceIds.map((id) => <FileAccessPrompts key={id} workspaceId={id} />)}</>
}

/** The workspace contexts around a window's content: the repository host
 *  (with a shown workspace) and the file views host. */
export function WorkspaceScope({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }) {
  const content = <FileViewsHost>{children}</FileViewsHost>
  return workspaceId
    ? <RepositoryHost key={workspaceId} workspaceId={workspaceId}>{content}</RepositoryHost>
    : content
}
