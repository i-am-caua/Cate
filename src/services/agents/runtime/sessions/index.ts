import type { AgentSessionStores } from './types'
import { claudeSessionStore } from './claude'
import { codexSessionStore } from './codex'
import { cursorSessionStore } from './cursor'
import { grokSessionStore } from './grok'
import { kiroSessionStore } from './kiro'
import { openCodeSessionStore } from './opencode'
import { agySessionStore } from './agy'

/** CLI-specific session persistence behind one exhaustive runtime lookup. */
export const AGENT_SESSION_STORES: AgentSessionStores = {
  'claude-code': claudeSessionStore,
  codex: codexSessionStore,
  cursor: cursorSessionStore,
  grok: grokSessionStore,
  kiro: kiroSessionStore,
  opencode: openCodeSessionStore,
  agy: agySessionStore,
}

export { createAgentTitleTracker } from './tracker'
