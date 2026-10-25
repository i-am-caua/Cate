// Runtime edits to the shared relation graph, used by the relation API and
// agent start. The document remains the authority and enforces its guards.

import { RpcError } from '@kernel/rpc/contract'
import type { DocChange, PanelRelation, RelationKind, WorkspaceDocument } from '@workspace/document/contract'
import { newRelationProblem, type RelationRoleOf } from '../contract/graph'
import {
  ORCHESTRATOR_PANEL_FIELD,
  RELATION_CONTEXT_MODE_FIELD,
  type RelationContextMode,
} from '../contract/contextMode'

export interface RelationRuntimeDocument {
  get(): WorkspaceDocument
  apply(change: DocChange): number
}

function refuseRelation(problem: string): never {
  const code = problem.includes('cycle')
    ? 'relation-cycle'
    : problem.includes('only panels')
      ? 'relation-panel-ineligible'
      : 'relation-invalid'
  throw new RpcError('rejected', `${code}: ${problem}`)
}

function relationByRef(document: RelationRuntimeDocument, ref: string): PanelRelation {
  const relations = Object.values(document.get().relations)
  const exact = relations.find((relation) => relation.id === ref)
  if (exact) return exact
  const matches = relations.filter((relation) => relation.id.startsWith(ref))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new RpcError('gone', `relation-not-found: no relation matching '${ref}'`)
  throw new RpcError('rejected', `ambiguous-relation: '${ref}' matches ${matches.map(({ id }) => id.slice(0, 8)).join(', ')}`)
}

/** Add a relation or re-point the existing relation for the same pair. */
export function addPanelRelation(
  document: RelationRuntimeDocument,
  roleOf: RelationRoleOf,
  fromPanelId: string,
  toPanelId: string,
  kind: RelationKind,
  label?: string,
): string {
  const doc = document.get()
  const problem = newRelationProblem(doc, roleOf, fromPanelId, toPanelId)
  if (problem) refuseRelation(problem)

  const existing = Object.values(doc.relations).find((relation) =>
    relation.fromPanelId === fromPanelId && relation.toPanelId === toPanelId)
  if (existing) {
    document.apply({
      kind: 'updateRelation',
      id: existing.id,
      patch: {
        kind,
        fromSide: null,
        toSide: null,
        ...(label !== undefined ? { label: label.trim() || null } : {}),
      },
    })
    return existing.id
  }

  const id = globalThis.crypto.randomUUID()
  document.apply({
    kind: 'addRelation',
    relation: {
      id,
      fromPanelId,
      toPanelId,
      kind,
      ...(label?.trim() ? { label: label.trim() } : {}),
    },
  })
  return id
}

export function updatePanelRelation(
  document: RelationRuntimeDocument,
  relationRef: string,
  patch: { kind?: RelationKind; label?: string },
): string {
  if (patch.kind === undefined && patch.label === undefined) {
    throw new RpcError('rejected', 'relation-set-empty: pass --kind or --label')
  }
  const relation = relationByRef(document, relationRef)
  document.apply({
    kind: 'updateRelation',
    id: relation.id,
    patch: {
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.label !== undefined ? { label: patch.label.trim() || null } : {}),
    },
  })
  return relation.id
}

export function removePanelRelation(document: RelationRuntimeDocument, relationRef: string): string {
  const relation = relationByRef(document, relationRef)
  document.apply({ kind: 'removeRelation', id: relation.id })
  return relation.id
}

export function setPanelRelationContextMode(
  document: RelationRuntimeDocument,
  panelId: string,
  mode: RelationContextMode,
): void {
  document.apply({ kind: 'updatePanel', id: panelId, patch: { fields: { [RELATION_CONTEXT_MODE_FIELD]: mode } } })
}

export function setPanelOrchestratorPanel(document: RelationRuntimeDocument, panelId: string, enabled: boolean): void {
  document.apply({
    kind: 'updatePanel',
    id: panelId,
    patch: {
      fields: enabled
        ? { [ORCHESTRATOR_PANEL_FIELD]: true, [RELATION_CONTEXT_MODE_FIELD]: 'always' }
        : { [ORCHESTRATOR_PANEL_FIELD]: null },
    },
  })
}
