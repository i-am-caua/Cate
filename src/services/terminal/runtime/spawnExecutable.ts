// A shell-free Windows spawn must name the program's file, not the command a
// person would type. node-pty's ConPTY backend searches PATH for the exact
// file name, while cmd and PowerShell also try each PATHEXT extension: a bare
// `codex` therefore fails with "File not found" even when `codex.exe` is on
// PATH. Terminals that run a launch command (agents started in place of the
// shell) take this path, so resolve the name first.

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  if (env[key] !== undefined) return env[key]
  const match = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  return match ? env[match] : undefined
}

/** The absolute program a Windows command name names, or the input unchanged
 *  when it is already a path, is not on PATH, or the host is not Windows. */
export function resolveSpawnExecutable(
  file: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || !file) return file
  // Only a bare command is searched, as a shell would; an explicit path is
  // the caller's to resolve and validate.
  if (path.isAbsolute(file) || /[\\/]/.test(file)) return file
  const pathValue = envValue(env, 'PATH')
  if (!pathValue) return file

  const extensions = (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT.join(';'))
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
  // A name with an extension is tried as written; a bare name gets PATHEXT.
  const candidates = path.extname(file)
    ? [file]
    : extensions.map((extension) => file + (extension.startsWith('.') ? extension : `.${extension}`))

  for (const entry of pathValue.split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    for (const candidate of candidates) {
      const full = path.resolve(dir, candidate)
      try {
        if (fs.statSync(full).isFile()) return full
      } catch {
        // Next candidate or PATH entry.
      }
    }
  }
  return file
}
