import { discoverSkills, type Skill } from '../catalog.ts'
import { Store, type LedgerEntry } from '../apply/store.ts'
import { applyEdits } from '../apply/writer.ts'
import type { Layout } from '../apply/paths.ts'
import type { ArchiveEdit } from '../plan/types.ts'
import type { Client, Reader } from '../types.ts'
import { readUsage, writeUsage, scanUsage, type Usage } from './usage.ts'

export const DAY = 86_400_000

export type CurateOptions = {
  store: Store
  readers?: Partial<Record<Client, Reader>>
  layout?: Layout
  home?: string
  project?: string
  staleDays?: number
  archiveDays?: number
  scanDays?: number
  dry?: boolean
  now?: number
  onPhase?: (phase: string, done: number, total: number) => void
}

export type Verdict = 'active' | 'stale' | 'archive' | 'pinned' | 'human' | 'fresh'

export type CurateRow = {
  skill: Skill
  usage: Usage
  idleDays: number
  verdict: Verdict
}

export type CurateResult = {
  run?: string
  rows: CurateRow[]
  scanned: { sessions: number; turns: number; uses: number }
  archived: LedgerEntry[]
  rejected: LedgerEntry[]
}

export function lastActivity(u: Usage, createdAt: number): number {
  return Math.max(u.last_used_at ?? 0, createdAt, u.first_seen_at)
}

export function verdictFor(skill: Skill, u: Usage, idleDays: number, staleDays: number, archiveDays: number): Verdict {
  if (skill.createdBy !== 'skillmine') return 'human'
  if (u.pinned) return 'pinned'
  if (idleDays >= archiveDays) return 'archive'
  if (idleDays >= staleDays) return 'stale'
  return u.use_count === 0 ? 'fresh' : 'active'
}

export async function curate(opts: CurateOptions): Promise<CurateResult> {
  const now = opts.now ?? Date.now()
  const staleDays = opts.staleDays ?? 14
  const archiveDays = opts.archiveDays ?? 30
  const scanDays = opts.scanDays ?? archiveDays + 1
  const skills = await discoverSkills({ home: opts.home, project: opts.project })
  const mined = skills.filter((s) => s.createdBy === 'skillmine')
  const names = new Set(mined.map((s) => s.name))
  const created = await creationTimes(opts.store)

  const scanned = { sessions: 0, turns: 0, uses: 0 }
  const uses = new Map<string, number[]>()
  const readers = Object.entries(opts.readers ?? {}) as [Client, Reader][]
  if (names.size && readers.length) {
    const since = now - scanDays * DAY
    let done = 0
    for (const [, reader] of readers) {
      const refs = await reader.discover({ since, project: opts.project }).catch(() => [])
      for (const ref of refs) {
        const turns = await reader.read(ref).catch(() => [])
        const scan = scanUsage(turns, names)
        scanned.sessions++
        scanned.turns += scan.turns
        for (const [name, stamps] of scan.uses) uses.set(name, [...(uses.get(name) ?? []), ...stamps])
      }
      opts.onPhase?.('scan', ++done, readers.length)
    }
  }

  const rows: CurateRow[] = []
  for (const skill of skills) {
    const u = await readUsage(skill, now)
    const stamps = uses.get(skill.name) ?? []
    if (stamps.length) {
      const seenUntil = u.scanned_until?.batch ?? 0
      const fresh = stamps.filter((t) => t > seenUntil)
      if (fresh.length) {
        u.use_count += fresh.length
        u.last_used_at = Math.max(u.last_used_at ?? 0, ...fresh)
        scanned.uses += fresh.length
      }
    }
    if (skill.createdBy === 'skillmine') u.scanned_until = { ...u.scanned_until, batch: now }
    const createdAt = created.get(skill.realpath) ?? created.get(skill.name) ?? u.first_seen_at
    const idleDays = Math.floor((now - lastActivity(u, createdAt)) / DAY)
    const verdict = verdictFor(skill, u, idleDays, staleDays, archiveDays)
    if (skill.createdBy === 'skillmine') {
      u.status = verdict === 'stale' || verdict === 'archive' ? 'stale' : 'active'
      if (!opts.dry) await writeUsage(skill, u)
    }
    rows.push({ skill, usage: u, idleDays, verdict })
  }

  const result: CurateResult = { rows, scanned, archived: [], rejected: [] }
  const toArchive = rows.filter((r) => r.verdict === 'archive')
  if (!opts.dry && toArchive.length) {
    const run = opts.store.newId('run')
    const edits: ArchiveEdit[] = toArchive.map((r) => ({
      action: 'archive',
      name: r.skill.name,
      reason: `curate: no use for ${r.idleDays} days (archive after ${archiveDays})`,
      sources: [],
    }))
    const res = await applyEdits(edits, { store: opts.store, layout: opts.layout, project: opts.project ?? '', run, catalog: skills, now: () => now })
    result.run = run
    result.archived = res.applied
    result.rejected = res.rejected
  }
  return result
}

async function creationTimes(store: Store): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const e of await store.entries()) {
    if (e.status !== 'applied') continue
    if (e.action === 'create') {
      if (e.path && !out.has(e.path)) out.set(e.path, e.ts)
      if (!out.has(e.name)) out.set(e.name, e.ts)
    }
  }
  return out
}
