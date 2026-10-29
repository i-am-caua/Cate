// The path scope of one workspace runtime: operations can use its checkouts,
// approved external paths, or external paths allowed by workspace settings.
// Cate's private home data stays protected, and workspace data is read-only.
// There are no scope ids: the connection is the scope, and the daemon serves
// one workspace.

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { RpcError } from '@kernel/rpc/contract'
import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import { dataPaths } from '@runtime/data/runtime'
import type { FileAccessOperation, FileAccessRequest } from '../contract'

export interface PathScope {
  readonly root: string
  readonly dataDir: string
  /** Synchronous check for paths already inside the active scope. */
  resolve(p: string): string
  /** A working directory for a process; lexical like `resolve`. */
  cwd(p: string): string
  /** Resolves symlinks (a missing tail stays literal) and checks the real path.
   *  For reads and anything that follows the path. */
  strict(p: string, operation?: FileAccessOperation, grantPath?: string): Promise<string>
  /** For creating or writing `p`: the parent chain is resolved, the final
   *  segment must not be an existing symlink. Returns realParent + basename.
   *  Never in the workspace data. */
  forCreation(p: string): Promise<string>
  /** For operating on the entry itself (remove, rename source) without
   *  following a final symlink. Never in the workspace data. */
  entry(p: string): Promise<string>
  /** For a folder files are brought into (drops, uploads, copies, moves):
   *  `strict`, and inside a checkout or an approved external path. The
   *  workspace data never receives files through this scope. */
  destination(p: string): Promise<string>
  /** The innermost checkout (the root or a worktree checkout) holding `p`
   *  (already resolved), or null. */
  checkoutOf(p: string): string | null
  /** True when `p` (already resolved) is inside the scope. */
  contains(p: string): boolean
  /** True when an operation on `p` could recursively include Cate's private data. */
  containsPrivateData(p: string): boolean
  /** Hook for the repository module: a worktree checkout outside the root. */
  addCheckout(p: string): void
  removeCheckout(p: string): void
  checkouts(): string[]
  /** Remembers an approved path in `<data>/grants.json`. A granted directory
   *  covers its contents. */
  grant(p: string): Promise<string>
  revokeGrant(p: string): Promise<void>
  grants(): string[]
  dispose(): void
}

export interface PathScopeOptions {
  /** Canonical workspace root. */
  root: string
  /** The workspace data directory. */
  dataDir: string
  accessMode?: () => 'ask' | 'full'
  requestAccess?: (request: Omit<FileAccessRequest, 'id'>) => Promise<boolean>
  platform?: NodeJS.Platform
}

/** Where worktree checkouts of the workspace live. */
export function worktreesDir(root: string): string {
  return path.join(root, '.cate', 'worktrees')
}

export function pathCompareKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.toLowerCase() : p
}

/** Strips the Windows long-path prefix a native realpath may add, so it
 *  compares with `path.resolve` output. */
function normalizeForComparison(p: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return p
  if (p.startsWith('\\\\?\\UNC\\')) return '\\' + p.slice(7)
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

// A root must match both the lexical form and the symlink-free form strict
// checks produce: macOS /tmp is a symlink to /private/tmp, and Windows short
// names expand under the native realpath.
function canonicalForms(resolved: string, platform: NodeJS.Platform): string[] {
  const forms = new Set([resolved, normalizeForComparison(resolved, platform)])
  try {
    let real: string
    try {
      real = fsSync.realpathSync.native(resolved)
    } catch {
      // The native resolver fails on some WinFsp mounts; the JS one works.
      real = fsSync.realpathSync(resolved)
    }
    forms.add(real)
    forms.add(normalizeForComparison(real, platform))
  } catch {
    // Missing root: lexical form only.
  }
  return [...forms]
}

function keyUnder(key: string, root: string, platform: NodeJS.Platform): boolean {
  const rootKey = pathCompareKey(root, platform)
  // Filesystem roots (Z:\, /) already end with a separator.
  const prefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep
  return key === rootKey || key.startsWith(prefix)
}

const MAX_PARENT_TRAVERSALS = 256

async function realpathWithFallback(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
    return fsSync.realpathSync(target)
  }
}

/** Realpath of `target`, tolerating a missing tail: the nearest existing
 *  ancestor is resolved and the rest re-appended. Every existing segment is
 *  resolved, so a symlink out of the scope is still caught. */
export async function realpathAllowingMissing(target: string): Promise<string> {
  const resolved = path.resolve(target)
  const missing: string[] = []
  let cur = resolved
  for (let attempts = 0; ; attempts++) {
    try {
      const real = await realpathWithFallback(cur)
      return missing.length ? path.join(real, ...missing) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const parent = path.dirname(cur)
    if (parent === cur) return resolved
    missing.unshift(path.basename(cur))
    cur = parent
    if (attempts + 1 >= MAX_PARENT_TRAVERSALS) {
      throw new Error(`Too many missing path segments while resolving "${target}"`)
    }
  }
}

function denied(message: string): RpcError {
  return new RpcError('rejected', `Access denied: ${message}`)
}

async function creationTarget(p: string): Promise<string> {
  const parent = path.dirname(path.resolve(p))
  const base = path.basename(p)
  if (!base || base === '.' || base === '..' || base.includes('\0')) throw denied(`invalid entry name "${base}"`)
  let realParent: string
  try {
    realParent = await realpathAllowingMissing(parent)
  } catch (err) {
    throw denied(`cannot resolve real path for parent "${parent}": ${err}`)
  }
  return path.join(realParent, base)
}

export function createPathScope(options: PathScopeOptions): PathScope {
  const platform = options.platform ?? process.platform
  const root = path.resolve(options.root)
  const dataDir = path.resolve(options.dataDir)
  const dataForms = canonicalForms(dataDir, platform)
  const rootForms = canonicalForms(root, platform)
  const data = dataPaths(dataDir)
  const workspaceDataParent = path.dirname(dataDir)
  const cateHome = path.dirname(workspaceDataParent)
  const privateRoot = path.basename(workspaceDataParent) === 'workspaces' && path.basename(cateHome) === '.cate'
    ? cateHome
    : dataDir
  const privateForms = canonicalForms(privateRoot, platform)
  const screenshotForms = canonicalForms(data.screenshots, platform)
  const downloadForms = canonicalForms(data.downloads, platform)
  const accessMode = options.accessMode ?? (() => 'ask')
  const fixedForms = [
    ...rootForms,
    ...canonicalForms(worktreesDir(root), platform),
    ...canonicalForms(data.screenshots, platform),
    ...canonicalForms(data.downloads, platform),
  ]
  const checkoutForms = new Map<string, string[]>()
  const grantsFile: JsonStateFile<string[]> = createJsonStateFile<string[]>({
    file: data.grants,
    defaults: [],
    normalize: (parsed) => Array.isArray(parsed)
      ? [...new Set(parsed.filter((v): v is string => typeof v === 'string' && path.isAbsolute(v)))]
      : [],
  })
  grantsFile.load()
  let grantForms = new Map<string, string[]>()
  const refreshGrants = (list: string[]): void => {
    const next = new Map<string, string[]>()
    for (const p of list) next.set(p, grantForms.get(p) ?? canonicalForms(p, platform))
    grantForms = next
  }
  refreshGrants(grantsFile.get())
  const stopGrants = grantsFile.subscribe((list) => refreshGrants(list))
  let grantQueue = Promise.resolve()

  const serializeGrants = <T,>(run: () => Promise<T>): Promise<T> => {
    const result = grantQueue.then(run, run)
    grantQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const within = (p: string): boolean => {
    const candidates = new Set([pathCompareKey(p, platform), pathCompareKey(normalizeForComparison(p, platform), platform)])
    for (const key of candidates) {
      if (fixedForms.some((f) => keyUnder(key, f, platform))) return true
      for (const forms of checkoutForms.values()) if (forms.some((f) => keyUnder(key, f, platform))) return true
      for (const forms of grantForms.values()) if (forms.some((f) => keyUnder(key, f, platform))) return true
    }
    return false
  }

  const inForms = (p: string, forms: readonly string[]): boolean => {
    const keys = [pathCompareKey(p, platform), pathCompareKey(normalizeForComparison(p, platform), platform)]
    return keys.some((key) => forms.some((form) => keyUnder(key, form, platform)))
  }

  // Full access applies to user files, never Cate's private workspace data.
  // Screenshots and downloads retain their existing scoped behavior.
  const privateData = (p: string): boolean =>
    inForms(p, privateForms)
    && !inForms(p, screenshotForms)
    && !inForms(p, downloadForms)

  const known = (p: string): boolean => !privateData(p) && (within(p) || accessMode() === 'full')
  const containsPrivateData = (p: string): boolean => {
    if (privateData(p)) return true
    const roots = [pathCompareKey(p, platform), pathCompareKey(normalizeForComparison(p, platform), platform)]
    return privateForms.some((form) => roots.some((rootKey) => keyUnder(pathCompareKey(form, platform), rootKey, platform)))
  }

  const resolve = (p: string): string => {
    if (!p || typeof p !== 'string') throw denied('invalid path')
    const normalized = path.resolve(p)
    if (privateData(normalized) || !known(normalized)) throw denied(`path "${p}" is outside the workspace`)
    return normalized
  }

  /** Refuses a resolved path in the workspace data: the runtime's own files. */
  const outsideData = (resolved: string, p: string): string => {
    const keys = [pathCompareKey(resolved, platform), pathCompareKey(normalizeForComparison(resolved, platform), platform)]
    if (keys.some((key) => dataForms.some((f) => keyUnder(key, f, platform)))) throw denied(`"${p}" is in the workspace data, which is read-only`)
    return resolved
  }

  const authorize = async (target: string, operation: FileAccessOperation, grantTarget = target): Promise<void> => {
    if (privateData(target)) throw denied(`"${target}" is in Cate's private workspace data`)
    if (within(target) || accessMode() === 'full') return
    const requestAccess = options.requestAccess
    if (!requestAccess) throw denied(`path "${target}" is outside the workspace`)
    const allowed = await requestAccess({
      path: target,
      grantPath: grantTarget,
      operation,
    })
    if (!allowed) throw denied(`access was not granted for "${target}"`)
    await addGrant(grantTarget)
    if (!within(target)) throw denied(`access was not granted for "${target}"`)
  }

  const strict = async (p: string, operation: FileAccessOperation = 'read', grantPath?: string): Promise<string> => {
    if (!p || typeof p !== 'string') throw denied('invalid path')
    let real: string
    try {
      real = await realpathAllowingMissing(p)
    } catch (err) {
      throw denied(`cannot resolve real path for "${p}": ${err}`)
    }
    let grantTarget = real
    if (grantPath !== undefined) {
      try {
        grantTarget = await realpathAllowingMissing(grantPath)
      } catch (err) {
        throw denied(`cannot resolve access grant path "${grantPath}": ${err}`)
      }
    }
    await authorize(real, operation, grantTarget)
    return real
  }

  const addGrant = async (p: string): Promise<string> => {
    const target = await creationTarget(p)
    if (privateData(target)) throw denied(`"${target}" is in Cate's private workspace data`)
    return serializeGrants(async () => {
      const current = grantsFile.get()
      if (!current.includes(target)) {
        grantsFile.set([...current, target])
        refreshGrants(grantsFile.get())
        await grantsFile.flushDurable()
      }
      return target
    })
  }

  const checkoutOf = (p: string): string | null => {
    const keys = [pathCompareKey(p, platform), pathCompareKey(normalizeForComparison(p, platform), platform)]
    const holds = (forms: string[]) => keys.some((key) => forms.some((f) => keyUnder(key, f, platform)))
    const holding = [...checkoutForms].filter(([, forms]) => holds(forms)).map(([checkout]) => checkout)
    if (holds(rootForms)) holding.push(root)
    // Worktree checkouts may live inside the root: the longest is the innermost.
    return holding.sort((a, b) => b.length - a.length)[0] ?? null
  }

  return {
    root,
    dataDir,
    resolve,
    cwd: resolve,
    contains: known,
    containsPrivateData,

    strict,

    async destination(p) {
      const real = await strict(p, 'write')
      const granted = [...grantForms.values()].some((forms) => inForms(real, forms))
      if (!checkoutOf(real) && accessMode() !== 'full' && !granted) {
        throw denied(`"${p}" is not inside a checkout of the workspace or an approved external folder`)
      }
      return real
    },
    checkoutOf,

    async forCreation(p) {
      const target = await creationTarget(p)
      // The final segment is not resolved, so an existing symlink there would
      // let a write follow it out of the scope.
      const stat = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (stat?.isSymbolicLink()) throw denied(`"${p}" is a symbolic link`)
      // Only the resolved form counts: accepting the lexical one would undo the
      // parent resolution for a symlinked directory inside the root.
      await authorize(target, 'write')
      return outsideData(target, p)
    },

    async entry(p) {
      const target = await creationTarget(p)
      if (containsPrivateData(target)) throw denied(`"${p}" contains Cate's private workspace data`)
      await authorize(target, 'write')
      return outsideData(target, p)
    },

    addCheckout(p) {
      const resolved = path.resolve(p)
      checkoutForms.set(resolved, canonicalForms(resolved, platform))
    },
    removeCheckout(p) {
      checkoutForms.delete(path.resolve(p))
    },
    checkouts: () => [...checkoutForms.keys()],

    async grant(p) {
      return addGrant(p)
    },
    async revokeGrant(p) {
      const target = await creationTarget(p).catch(() => path.resolve(p))
      await serializeGrants(async () => {
        const next = grantsFile.get().filter((g) => g !== target && g !== path.resolve(p))
        grantsFile.set(next)
        refreshGrants(next)
        await grantsFile.flushDurable()
      })
    },
    grants: () => [...grantsFile.get()],

    dispose() {
      stopGrants()
      grantsFile.dispose()
    },
  }
}
