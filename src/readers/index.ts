import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Client, Reader } from '../types.ts'
import { ClaudeReader } from './claude.ts'
import { CodexReader } from './codex.ts'
import { KimiReader } from './kimi.ts'
import { OpenCodeReader } from './opencode.ts'
import { AntigravityReader } from './antigravity.ts'
import { isInjectedIndex } from '../util/internal.ts'

export type ReaderPaths = {
  claude: string
  codex: string
  kimi: string
  kimiCode?: string
  kimiConfig: string
  opencode: string
  antigravity: string
}

export function defaultPaths(home = homedir()): ReaderPaths {
  const kimiCode = join(home, '.kimi-code', 'sessions')
  const kimiLegacy = join(home, '.kimi', 'sessions')
  return {
    claude: join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
    kimi: existsSync(kimiCode) && !existsSync(kimiLegacy) ? kimiCode : kimiLegacy,
    kimiCode,
    kimiConfig: join(home, '.kimi', 'kimi.json'),
    opencode: join(home, '.local', 'share', 'opencode', 'opencode.db'),
    antigravity: join(home, '.gemini', 'antigravity-cli'),
  }
}

function skipInjected(reader: Reader): Reader {
  return {
    client: reader.client,
    discover: (opts) => reader.discover(opts),
    read: async (ref) => (await reader.read(ref)).filter((t) => !isInjectedIndex(t.role, t.text)),
  }
}

export function createReaders(paths: ReaderPaths = defaultPaths()): Record<Client, Reader> {
  return {
    claude: skipInjected(new ClaudeReader(paths.claude)),
    codex: skipInjected(new CodexReader(paths.codex)),
    kimi: skipInjected(new KimiReader(paths.kimi, paths.kimiConfig, paths.kimiCode)),
    opencode: skipInjected(new OpenCodeReader(paths.opencode)),
    antigravity: skipInjected(new AntigravityReader(paths.antigravity)),
  }
}
