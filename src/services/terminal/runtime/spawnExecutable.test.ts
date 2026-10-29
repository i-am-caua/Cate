import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveSpawnExecutable } from './spawnExecutable'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-exec-'))
  dirs.push(dir)
  return dir
}

function touch(dir: string, name: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, '')
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveSpawnExecutable', () => {
  test('finds a bare command through PATHEXT', () => {
    const dir = tempDir()
    const exe = touch(dir, 'codex.EXE')
    expect(resolveSpawnExecutable('codex', { Path: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toBe(exe)
  })

  test('tries every extension in one PATH entry before the next entry', () => {
    const first = tempDir()
    const second = tempDir()
    const cmd = touch(first, 'codex.CMD')
    touch(second, 'codex.EXE')
    const env = { PATH: `${first};${second}`, PATHEXT: '.EXE;.CMD' }
    expect(resolveSpawnExecutable('codex', env, 'win32')).toBe(cmd)
  })

  test('leaves an explicit path unchanged', () => {
    const dir = tempDir()
    const file = touch(dir, 'codex.exe')
    expect(resolveSpawnExecutable(file, { PATH: dir }, 'win32')).toBe(file)
    expect(resolveSpawnExecutable('C:\\tools\\codex.exe', { PATH: dir }, 'win32')).toBe('C:\\tools\\codex.exe')
  })

  test('leaves a missing command unchanged so the spawn reports it', () => {
    const dir = tempDir()
    expect(resolveSpawnExecutable('codex', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe('codex')
  })

  test('does not resolve on other platforms', () => {
    const dir = tempDir()
    touch(dir, 'codex.EXE')
    expect(resolveSpawnExecutable('codex', { PATH: dir, PATHEXT: '.EXE' }, 'linux')).toBe('codex')
  })
})
