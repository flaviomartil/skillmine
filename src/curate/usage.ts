import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Skill } from '../catalog.ts'
import type { Turn } from '../types.ts'

export const USAGE_FILE = '.usage.json'

export type Usage = {
  use_count: number
  last_used_at: number | null
  patch_count: number
  pinned: boolean
  first_seen_at: number
  status?: 'active' | 'stale'
  scanned_until?: Partial<Record<string, number>>
}

export function emptyUsage(now: number): Usage {
  return { use_count: 0, last_used_at: null, patch_count: 0, pinned: false, first_seen_at: now }
}

export function usagePath(skill: Pick<Skill, 'realpath'>): string {
  return join(dirname(skill.realpath), USAGE_FILE)
}

export async function readUsage(skill: Pick<Skill, 'realpath'>, now = Date.now()): Promise<Usage> {
  try {
    const parsed = JSON.parse(await readFile(usagePath(skill), 'utf8')) as Partial<Usage>
    return { ...emptyUsage(now), ...parsed }
  } catch {
    return emptyUsage(now)
  }
}

export async function writeUsage(skill: Pick<Skill, 'realpath'>, usage: Usage): Promise<void> {
  const path = usagePath(skill)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(usage, null, 2) + '\n')
  await rename(tmp, path)
}

export async function recordUse(skill: Pick<Skill, 'realpath'>, at = Date.now()): Promise<Usage> {
  const u = await readUsage(skill, at)
  u.use_count += 1
  u.last_used_at = Math.max(u.last_used_at ?? 0, at)
  u.status = 'active'
  await writeUsage(skill, u)
  return u
}

export async function setPinned(skill: Pick<Skill, 'realpath'>, pinned: boolean): Promise<Usage> {
  const u = await readUsage(skill)
  u.pinned = pinned
  await writeUsage(skill, u)
  return u
}

const SKILL_TOOLS = new Set(['skill', 'skills', 'use_skill', 'load_skill', 'read_skill'])

export function skillUsesIn(turn: Turn, names: Set<string>): string[] {
  const hits = new Set<string>()
  for (const t of turn.tools) {
    const tool = t.name.toLowerCase()
    if (SKILL_TOOLS.has(tool)) {
      const arg = t.arg.trim().replace(/^\//, '').split(/[\s:]/)[0] ?? ''
      if (names.has(arg)) hits.add(arg)
      continue
    }
    const m = /(?:^|\/)skills\/([A-Za-z0-9._-]+)\/SKILL\.md/.exec(t.arg)
    if (m && names.has(m[1]!)) hits.add(m[1]!)
  }
  if (turn.role === 'user') {
    const m = /^\s*\/([A-Za-z0-9._-]+)(?:\s|$)/.exec(turn.text)
    if (m && names.has(m[1]!)) hits.add(m[1]!)
  }
  return [...hits]
}

export type UsageScan = { uses: Map<string, number[]>; turns: number }

export function scanUsage(turns: Iterable<Turn>, names: Set<string>): UsageScan {
  const uses = new Map<string, number[]>()
  let n = 0
  for (const turn of turns) {
    n++
    for (const name of skillUsesIn(turn, names)) {
      const list = uses.get(name) ?? []
      list.push(turn.ts)
      uses.set(name, list)
    }
  }
  return { uses, turns: n }
}
