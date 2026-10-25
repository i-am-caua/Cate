// `cate.agent.*`: start an agent in a new terminal panel, and observe and
// prompt the agents running in panels. Served by services/agents, which
// resolves each panel to its agent session.

import {
  ArgError,
  arr,
  bool,
  defineCateApi,
  defineCliArea,
  num,
  oneOf,
  obj,
  opt,
  panel,
  str,
} from '@kernel/api/contract'

export const AGENT_WAIT_DEFAULT_SECONDS = 30
export const AGENT_WAIT_MIN_SECONDS = 5
export const AGENT_WAIT_MAX_SECONDS = 60
/** Slack over the wait itself so the handler answers before the router gives up. */
const WAIT_SLACK_MS = 5_000

const waitSeconds = (fallback: number) =>
  opt(num.min(AGENT_WAIT_MIN_SECONDS).max(AGENT_WAIT_MAX_SECONDS), fallback)

function waitTimeoutMs(args: { timeoutSeconds: number }): number {
  return args.timeoutSeconds * 1_000 + WAIT_SLACK_MS
}

/** `--wait-timeout` is in milliseconds on the command line. */
function parseWaitTimeoutMs(raw: string): number {
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms < AGENT_WAIT_MIN_SECONDS * 1_000 || ms > AGENT_WAIT_MAX_SECONDS * 1_000) {
    throw new ArgError(`--wait-timeout must be between ${AGENT_WAIT_MIN_SECONDS * 1_000} and ${AGENT_WAIT_MAX_SECONDS * 1_000} ms`)
  }
  return ms / 1_000
}

/** The CLI permission area of these methods. */
export const agentCliArea = defineCliArea({
  label: 'Agents & reviews',
  read: {
    key: 'cliAgentReadEnabled',
    code: 'agent-read-disabled',
    detail:
      '`cate agent types / list / wait / read`, `cate relation list` and `cate review inspect`: observe workers, their conversations and terminal output, relations and review state.',
  },
  control: {
    key: 'cliAgentControlEnabled',
    code: 'agent-control-disabled',
    detail:
      '`cate agent start / send / interrupt`, `cate relation add / remove / set / context / orchestrator` and `cate review note / complete`: start and steer terminal agents, draw and update relations, and record review results.',
  },
})

export const agentApi = defineCateApi(
  'agent',
  {
    start: {
      access: 'control',
      handler: 'service',
      summary: 'Start an agent on a prompt in a new terminal panel',
      args: {
        prompt: str.nonEmpty().maxLength(50_000).rest('prompt').help('The first prompt'),
        agentId: opt(str).flag('agent', 'id')
          .help('Agent CLI: claude-code, codex, cursor, grok, kiro or opencode (default: one set up in this workspace)'),
        title: opt(str.maxLength(80)).help('Panel title, at most 80 characters'),
        worktreeId: opt(str).flag('worktree', 'id').help('Run in this existing worktree (default: the calling panel\'s checkout)'),
        newWorktree: opt(str).flag('new-worktree', 'name').help('Create a worktree with this name and run in it'),
        canvasPanelId: opt(panel('canvas')).flag('canvas', 'id')
          .help('Place the panel on this canvas panel\'s canvas (default: next to the calling panel)'),
        from: opt(panel()).flag('from', 'panel').help('Source panel for a relation (default: the calling panel)'),
        kind: opt(oneOf('use', 'context', 'verify', 'trigger')).helpDefault('trigger')
          .help('Relation kind (default trigger when linking)'),
        label: opt(str).help('Label for the new relation'),
        orchestrator: opt(bool, false).help('Mark the new panel as an orchestrator'),
        position: opt(obj({ x: num, y: num })).hidden(),
      },
      timeoutMs: 90_000,
      format: 'createdPanel',
    },
    types: {
      access: 'read',
      handler: 'service',
      summary: 'List the agent CLIs: whether each can start in a terminal here (its Cate hooks are on)',
      // The first hook inspection can run an installed CLI's own check, as
      // start does.
      timeoutMs: 90_000,
      format: 'prettyJson',
    },
    list: {
      access: 'read',
      handler: 'service',
      summary: 'List live agent panels',
      format: 'agentRuns',
    },
    read: {
      access: 'read',
      handler: 'service',
      summary: 'Print an agent panel\'s conversation',
      args: { panelId: panel().pos().help('Agent panel id or unique prefix, from cate agent list') },
      format: 'conversation',
    },
    wait: {
      access: 'read',
      handler: 'service',
      summary: 'Wait until the agent panels are ready for a prompt',
      args: {
        panelIds: opt(arr(panel())).rest('panelId').help('Agent panels to wait for (default: every live agent panel)'),
        timeoutSeconds: waitSeconds(AGENT_WAIT_DEFAULT_SECONDS)
          .flag('wait-timeout', 'ms')
          .parseCli(parseWaitTimeoutMs)
          .helpDefault(String(AGENT_WAIT_DEFAULT_SECONDS * 1_000))
          .help('Give up after this many milliseconds, 5000 to 60000'),
      },
      timeoutMs: waitTimeoutMs,
      format: 'agentWait',
    },
    send: {
      access: 'control',
      handler: 'service',
      summary: 'Send a prompt to an agent panel at its prompt; succeeds once the agent started its turn',
      args: {
        targetPanelId: panel().pos('panelId').flag('panel').help('Agent panel id or unique prefix, from cate agent list'),
        prompt: str.nonEmpty().rest('prompt').help('The prompt'),
      },
      // Waits up to 10 s for the agent's turn to start.
      timeoutMs: 20_000,
    },
    interrupt: {
      access: 'control',
      handler: 'service',
      summary: 'Stop an agent panel\'s turn, as Esc or Ctrl-C would',
      args: { targetPanelId: panel().pos('panelId').flag('panel').help('Agent panel id or unique prefix, from cate agent list') },
    },
  },
  { area: agentCliArea, summary: 'Start agents, and observe and prompt the agents running in panels' },
)

export const relationApi = defineCateApi(
  'relation',
  {
    list: {
      access: 'read',
      handler: 'service',
      summary: 'List panel relations',
      format: 'relationList',
    },
    add: {
      access: 'control',
      handler: 'service',
      summary: 'Add or re-point a relation between panels',
      args: {
        from: panel().pos('from').help('Source panel id or unique prefix'),
        to: panel().pos('to').help('Target panel id or unique prefix'),
        kind: opt(oneOf('use', 'context', 'verify', 'trigger'), 'trigger')
          .help('Relation kind (default trigger)'),
        label: opt(str).help('Label for the relation'),
      },
      format: 'relationAdded',
    },
    remove: {
      access: 'control',
      handler: 'service',
      summary: 'Remove a relation',
      args: { relationId: str.nonEmpty().pos('relation-id').help('Relation id or unique prefix, from cate relation list --json') },
    },
    set: {
      access: 'control',
      handler: 'service',
      summary: 'Set a relation kind or label',
      args: {
        relationId: str.nonEmpty().pos('relation-id').help('Relation id or unique prefix, from cate relation list --json'),
        kind: opt(oneOf('use', 'context', 'verify', 'trigger')).help('New relation kind'),
        label: opt(str).help('New label; an empty label clears it'),
      },
    },
    context: {
      access: 'control',
      handler: 'service',
      summary: 'Set how a panel receives relation context',
      args: {
        panelId: panel().pos('panel').help('Panel id or unique prefix'),
        mode: oneOf('once', 'always', 'off').pos('mode').help('Context mode'),
      },
    },
    orchestrator: {
      access: 'control',
      handler: 'service',
      summary: 'Mark or unmark an orchestrator panel',
      args: {
        panelId: panel().pos('panel').help('Panel id or unique prefix'),
        state: oneOf('on', 'off').pos('state').help('Whether the panel is an orchestrator'),
      },
    },
  },
  { area: agentCliArea, summary: 'List and edit panel relations and orchestrator routing' },
)
