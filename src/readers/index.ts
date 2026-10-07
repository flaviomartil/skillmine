import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Client, Reader } from '../types.ts'
import { ClaudeReader } from './claude.ts'
import { CodexReader } from './codex.ts'
import { KimiReader } from './kimi.ts'
import { OpenCodeReader } from './opencode.ts'
import { AntigravityReader } from './antigravity.ts'

export type ReaderPaths = {
  claude: string
  codex: string
  kimi: string
  kimiConfig: string
  opencode: string
  antigravity: string
}

export function defaultPaths(home = homedir()): ReaderPaths {
  return {
    claude: join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
    kimi: join(home, '.kimi', 'sessions'),
    kimiConfig: join(home, '.kimi', 'kimi.json'),
    opencode: join(home, '.local', 'share', 'opencode', 'opencode.db'),
    antigravity: join(home, '.gemini', 'antigravity-cli'),
  }
}

export function createReaders(paths: ReaderPaths = defaultPaths()): Record<Client, Reader> {
  return {
    claude: new ClaudeReader(paths.claude),
    codex: new CodexReader(paths.codex),
    kimi: new KimiReader(paths.kimi, paths.kimiConfig),
    opencode: new OpenCodeReader(paths.opencode),
    antigravity: new AntigravityReader(paths.antigravity),
  }
}
