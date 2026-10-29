// The setups runtime: reads and writes `cate-setup` v1 files in the workspace
// and the user's Cate home, and applies one by starting its agents on a canvas
// through ports the composition root fills (workspace modules cannot import
// services).

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger, type Logger } from '@kernel/log/contract'
import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { PlaceTarget, RelationKind } from '@workspace/document/contract'
import {
  DEFAULT_SETUP_NODE_SIZE,
  parseSetup,
  setupToJson,
  slugifySetupName,
  type CateSetup,
  type SetupApplyResult,
  type SetupEntry,
  type SetupScope,
  type setupCapability,
} from '../contract'

export interface SetupStartArgs {
  agentId?: string
  model?: string
  effort?: string
  newWorktree?: string
  title: string
  prompt?: string
  at: PlaceTarget
  orchestrator?: boolean
}

/** What applying a setup needs from other modules. */
export interface SetupRuntimePorts {
  startAgent(args: SetupStartArgs): Promise<{ panelId: string; warning?: string }>
  addRelation(fromPanelId: string, toPanelId: string, kind: RelationKind, label?: string): string
  /** The canvas a canvas panel shows, or null when it is not one. */
  canvasForPanel(canvasPanelId: string): string | null
  /** A canvas panel to build on when the caller names none. */
  defaultCanvasPanel(): string | null
}

export interface SetupRuntimeDeps extends SetupRuntimePorts {
  /** Canonical workspace root. */
  root: string
  /** The user's home; defaults to `os.homedir()`. */
  home?: string
  /** Optional directory of default setups bundled with the runtime. */
  bundledSetupsDir?: string
  trust: { requireTrusted(): void }
  /** Best effort: create `.cate/.gitignore` before writing into `.cate/`. */
  prepareCateDir?: (cateDir: string) => Promise<void>
  log?: Logger
}

export type SetupRuntime = ReturnType<typeof createSetupRuntime>

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function checkedId(id: string): string {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new RpcError('rejected', `invalid-setup-id: ${id}`)
  }
  return id
}

export function createSetupRuntime(deps: SetupRuntimeDeps) {
  const log = deps.log ?? createLogger('setups')
  const localDir = path.join(deps.root, '.cate', 'setups')
  const globalDir = path.join(deps.home ?? os.homedir(), '.cate', 'setups')
  const dirFor = (scope: SetupScope): string => scope === 'global' ? globalDir : localDir
  const fileFor = (scope: SetupScope, id: string): string => path.join(dirFor(scope), `${checkedId(id)}.json`)

  async function readEntry(scope: SetupScope, file: string, id: string): Promise<SetupEntry | null> {
    try {
      const content = await fs.readFile(file, 'utf8')
      const setup = parseSetup(JSON.parse(content), { id })
      if (!setup) {
        log.warn('ignoring %s: not a setup object', file)
        return null
      }
      return { id, scope, path: file, setup }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      log.warn('could not read setup %s: %s', file, errorText(error))
      return null
    }
  }

  async function listDir(scope: SetupScope): Promise<SetupEntry[]> {
    let names: string[]
    try {
      names = await fs.readdir(dirFor(scope))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      log.warn('could not list setups in %s: %s', dirFor(scope), errorText(error))
      return []
    }
    const entries = await Promise.all(names
      .filter((name) => name.endsWith('.json') && SAFE_ID.test(name.slice(0, -5)))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const id = name.slice(0, -5)
        return readEntry(scope, path.join(dirFor(scope), name), id)
      }))
    return entries.filter((entry): entry is SetupEntry => entry !== null)
  }

  let seededBundled: Promise<void> | null = null
  async function ensureBundledSetups(): Promise<void> {
    if (!deps.bundledSetupsDir) return
    seededBundled ??= (async () => {
      let names: string[]
      try {
        names = await fs.readdir(deps.bundledSetupsDir!)
      } catch {
        return
      }
      await fs.mkdir(globalDir, { recursive: true }).catch(() => {})
      for (const name of names) {
        if (!name.endsWith('.json') || !SAFE_ID.test(name.slice(0, -5))) continue
        const target = path.join(globalDir, name)
        try {
          const content = await fs.readFile(path.join(deps.bundledSetupsDir!, name), 'utf8')
          await fs.writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
        } catch {
          // Already exists or unreadable; keep user's copy.
        }
      }
    })()
    await seededBundled
  }

  async function list(): Promise<SetupEntry[]> {
    await ensureBundledSetups()
    const [local, global] = await Promise.all([listDir('local'), listDir('global')])
    return [...local, ...global]
  }

  async function find(id: string, scope?: SetupScope): Promise<SetupEntry> {
    await ensureBundledSetups()
    const safe = checkedId(id)
    const scopes: SetupScope[] = scope ? [scope] : ['local', 'global']
    for (const candidate of scopes) {
      const entry = await readEntry(candidate, fileFor(candidate, safe), safe)
      if (entry) return entry
    }
    throw new RpcError('gone', `setup-not-found: no setup named '${safe}'${scope ? ` in ${scope} setups` : ''}`)
  }

  async function uniqueId(dir: string, base: string): Promise<string> {
    let candidate = base
    for (let attempt = 2; ; attempt += 1) {
      try {
        await fs.access(path.join(dir, `${candidate}.json`))
      } catch {
        return candidate
      }
      candidate = `${base}-${attempt}`
    }
  }

  async function save(input: CateSetup, options: { scope?: SetupScope; id?: string } = {}): Promise<SetupEntry> {
    deps.trust.requireTrusted()
    const scope = options.scope ?? 'local'
    const setup = parseSetup(setupToJson(input), { id: options.id ?? input.name, source: input.source })
    if (!setup) throw new RpcError('rejected', 'invalid-setup')
    if (setup.nodes.length === 0) {
      throw new RpcError('rejected', 'setup-empty: add at least one agent panel on this canvas')
    }
    const dir = dirFor(scope)
    const id = options.id ? checkedId(options.id) : await uniqueId(dir, slugifySetupName(setup.name))
    const file = path.join(dir, `${id}.json`)
    if (scope === 'local' && deps.prepareCateDir) {
      await deps.prepareCateDir(path.dirname(dir)).catch(() => {})
    }
    await fs.mkdir(dir, { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify(setupToJson(setup), null, 2)}\n`, 'utf8')
      await fs.rename(temporary, file)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    return { id, scope, path: file, setup }
  }

  async function apply(params: { id: string; scope?: SetupScope; canvasPanelId?: string; orchestratorPrompt?: string }): Promise<SetupApplyResult> {
    deps.trust.requireTrusted()
    const entry = await find(params.id, params.scope)
    const canvasPanelId = params.canvasPanelId ?? deps.defaultCanvasPanel()
    if (!canvasPanelId) throw new RpcError('rejected', 'no-canvas: this workspace has no canvas panel')
    const canvasId = deps.canvasForPanel(canvasPanelId)
    if (!canvasId) throw new RpcError('rejected', `canvas-not-found: ${canvasPanelId} is not a canvas panel`)

    const panelIds: Record<string, string> = {}
    const warnings: string[] = []
    const task = params.orchestratorPrompt?.trim()
    // Build workers before starting a tasked orchestrator so its prompt can name
    // the real panels, and its first dispatch cannot race their creation.
    const orderedNodes = task
      ? [...entry.setup.nodes.filter((node) => !node.orchestrator), ...entry.setup.nodes.filter((node) => node.orchestrator)]
      : entry.setup.nodes
    for (const node of orderedNodes) {
      const at: Extract<PlaceTarget, { to: 'canvas' }> = {
        to: 'canvas',
        canvasId,
        nodeId: globalThis.crypto.randomUUID(),
        stackId: globalThis.crypto.randomUUID(),
        rect: { origin: node.position, size: node.size ?? DEFAULT_SETUP_NODE_SIZE },
      }
      try {
        const initialPrompt = node.orchestrator && task
          ? [
              node.prompt,
              `Setup panels (node id → panel id):\n${JSON.stringify(panelIds)}`,
              ...entry.setup.nodes.filter((member) => !member.orchestrator).map((member) =>
                `Role ${member.id} (${member.title}): ${member.prompt ?? ''}`),
              ...(warnings.length ? [`Setup warnings: ${warnings.join('; ')}`] : []),
              `Task:\n${task}`,
            ].filter(Boolean).join('\n\n')
          : undefined
        const baseStartArgs = {
          ...(node.agentId ? { agentId: node.agentId } : {}),
          ...(node.model ? { model: node.model } : {}),
          ...(node.effort ? { effort: node.effort } : {}),
          title: node.title,
          ...(initialPrompt ? { prompt: initialPrompt } : {}),
          at,
          ...(node.orchestrator ? { orchestrator: true } : {}),
        }
        let result: { panelId: string; warning?: string }
        if (node.worktree) {
          try {
            result = await deps.startAgent({ ...baseStartArgs, newWorktree: node.worktree })
          } catch {
            result = await deps.startAgent(baseStartArgs)
          }
        } else {
          result = await deps.startAgent(baseStartArgs)
        }
        panelIds[node.id] = result.panelId
        if (result.warning) warnings.push(`${node.title}: ${result.warning}`)
      } catch (error) {
        warnings.push(`${node.title}: ${errorText(error)}`)
      }
    }
    if (Object.keys(panelIds).length === 0) {
      throw new RpcError('rejected', `setup-apply-failed: ${warnings.join('; ') || 'no agents started'}`)
    }

    const relationIds: string[] = []
    for (const edge of entry.setup.edges) {
      const fromPanelId = panelIds[edge.from]
      const toPanelId = panelIds[edge.to]
      if (!fromPanelId || !toPanelId) continue
      try {
        relationIds.push(deps.addRelation(fromPanelId, toPanelId, edge.kind, edge.label))
      } catch (error) {
        warnings.push(`${edge.from} → ${edge.to}: ${errorText(error)}`)
      }
    }
    return { setupId: entry.id, name: entry.setup.name, panelIds, relationIds, warnings }
  }

  return {
    list,
    save,
    apply,
    /** The directories this runtime reads, local first. */
    dirs: (): { scope: SetupScope; path: string }[] => [
      { scope: 'local', path: localDir },
      { scope: 'global', path: globalDir },
    ],
  }
}

export function setupCapabilityImpl(service: SetupRuntime): CapabilityImpl<typeof setupCapability> {
  return {
    list: () => service.list(),
    save: ({ setup, scope, id }) => service.save(setup, { ...(scope ? { scope } : {}), ...(id ? { id } : {}) }),
    apply: ({ id, scope, canvasPanelId, orchestratorPrompt }) => service.apply({
      id,
      ...(scope ? { scope } : {}),
      ...(canvasPanelId ? { canvasPanelId } : {}),
      ...(orchestratorPrompt ? { orchestratorPrompt } : {}),
    }),
  }
}
