// When an execution panel's prompt takes its connected panels' context: the
// next message only (then off), every message, or never. A panel record
// field, read the same way everywhere.

export type RelationContextMode = 'once' | 'always' | 'off'

/** The record field holding a panel's mode. */
export const RELATION_CONTEXT_MODE_FIELD = 'relationContextMode'

/** The record field marking an execution panel as an orchestrator (Maestro). */
export const ORCHESTRATOR_PANEL_FIELD = 'orchestrator'

/** True when a panel is marked as an orchestrator (`fields.orchestrator === true`). */
export function isOrchestratorPanel(fields: Readonly<Record<string, unknown>>): boolean {
  return fields[ORCHESTRATOR_PANEL_FIELD] === true
}

/** A panel's mode from its record fields; `always` for an orchestrator and
 *  `once` otherwise when never set. */
export function relationContextMode(fields: Readonly<Record<string, unknown>>): RelationContextMode {
  const mode = fields[RELATION_CONTEXT_MODE_FIELD]
  if (mode === 'always' || mode === 'off' || mode === 'once') return mode
  return isOrchestratorPanel(fields) ? 'always' : 'once'
}
