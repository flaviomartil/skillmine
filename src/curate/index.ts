import { realpath } from 'node:fs/promises'
import { discoverSkills, type Skill } from '../catalog.ts'
import { Store, type LedgerEntry } from '../apply/store.ts'
import { applyEdits } from '../apply/writer.ts'
import type { Layout } from '../apply/paths.ts'
import type { ArchiveEdit } from '../plan/types.ts'
import { CLIENTS, type Client, type Reader } from '../types.ts'
import { isInternalProject, internalRoots } from '../util/internal.ts'
import { readUsageStrict, updateUsage, scanUsageDetailed, emptyUsage, LockTimeoutError, type Usage, type UseDetail } from './usage.ts'

export const DAY = 86_400_000
export const FUTURE_SKEW_MS = 60_000

export function defaultMaturity(): number {
  const n = Number(process.env.SKILLMINE_MATURITY)
  return Number.isInteger(n) && n > 0 ? n : 300
}

export function defaultProbationMaxDays(): number {
  const n = Number(process.env.SKILLMINE_PROBATION_MAX_DAYS)
  return Number.isInteger(n) && n > 0 ? n : 180
}

export function validProbationMaxDays(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : defaultProbationMaxDays()
}

export function validMaturity(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : defaultMaturity()
}

export type CurateOptions = {
  store: Store
  readers?: Partial<Record<Client, Reader>>
  layout?: Layout
  home?: string
  project?: string
  staleDays?: number
  archiveDays?: number
  maturity?: number
  probationMaxDays?: number
  scanDays?: number
  dry?: boolean
  now?: number
  onPhase?: (phase: string, done: number, total: number) => void
}

export type Verdict = 'active' | 'stale' | 'archive' | 'pinned' | 'human' | 'fresh' | 'probation' | 'unreadable' | 'locked'

export type CurateRow = {
  skill: Skill
  usage: Usage
  idleDays: number
  offerIdleDays: number
  verdict: Verdict
  error?: string
}

export type CurateResult = {
  run?: string
  rows: CurateRow[]
  scanned: { sessions: number; turns: number; uses: number }
  archived: LedgerEntry[]
  rejected: LedgerEntry[]
  readOnly: boolean
  scanErrors: string[]
  archiveDisabled?: string
}

export function lastActivity(u: Usage, createdAt: number): number {
  return Math.max(u.last_used_at ?? 0, createdAt, u.first_seen_at)
}

export type ProbationLimit = { offerIdleDays: number; maxDays: number }

export function verdictFor(skill: Skill, u: Usage, idleDays: number, staleDays: number, archiveDays: number, maturity?: number, probation?: ProbationLimit): Verdict {
  if (skill.createdBy !== 'skillmine') return 'human'
  if (u.pinned) return 'pinned'
  if (maturity !== undefined && u.offered_count > 0) {
    if (u.offered_count < maturity) {
      if (u.use_count === 0) return probation && probation.offerIdleDays >= probation.maxDays ? 'archive' : 'probation'
    } else if (u.use_count === 0) return 'archive'
  }
  if (idleDays >= archiveDays) return 'archive'
  if (idleDays >= staleDays) return 'stale'
  return u.use_count === 0 ? 'fresh' : 'active'
}

export async function curate(opts: CurateOptions): Promise<CurateResult> {
  const now = opts.now ?? Date.now()
  const staleDays = opts.staleDays ?? 14
  const archiveDays = opts.archiveDays ?? 30
  const maturity = validMaturity(opts.maturity)
  const probationMaxDays = validProbationMaxDays(opts.probationMaxDays)
  const scanDays = opts.scanDays ?? archiveDays + 1
  const skills = await discoverSkills({ home: opts.home, project: opts.project })
  const mined = skills.filter((s) => s.createdBy === 'skillmine')
  const names = new Set(mined.map((s) => s.name))
  const created = await creationTimes(opts.store)

  const readOnly = !!opts.dry || !!opts.project
  const scanned = { sessions: 0, turns: 0, uses: 0 }
  const uses = new Map<string, { name: string; use: UseDetail }[]>()
  const watermarks: Record<string, number> = {}
  const seenSessions: Record<string, Set<string>> = {}
  const scanErrors: string[] = []
  const readers = Object.entries(opts.readers ?? {}) as [Client, Reader][]
  const roots = internalRoots()
  if (names.size && readers.length) {
    const since = now - scanDays * DAY
    let done = 0
    for (const [client, reader] of readers) {
      const found: { name: string; use: UseDetail }[] = []
      const sessionsOf = new Set<string>()
      let ok = true
      let newest = 0
      let refs: Awaited<ReturnType<Reader['discover']>> = []
      try {
        refs = await reader.discover({ since, project: opts.project })
      } catch {
        ok = false
      }
      for (const ref of refs) {
        let turns: Awaited<ReturnType<Reader['read']>>
        try {
          turns = await reader.read(ref)
        } catch {
          ok = false
          continue
        }
        if (isInternalProject(turns[0]?.project ?? ref.project, roots)) continue
        scanned.sessions++
        for (const t of turns) {
          if (!Number.isFinite(t.ts) || t.ts <= 0 || t.ts > now + FUTURE_SKEW_MS) continue
          let scan: ReturnType<typeof scanUsageDetailed>
          try {
            scan = scanUsageDetailed([t], names, true)
          } catch {
            continue
          }
          sessionsOf.add(t.session)
          if (t.ts > newest) newest = t.ts
          scanned.turns++
          for (const [name, list] of scan.uses) for (const use of list) found.push({ name, use })
        }
      }
      if (ok) {
        uses.set(client, found)
        seenSessions[client] = sessionsOf
        if (newest > 0) watermarks[client] = newest
      } else scanErrors.push(client)
      opts.onPhase?.('scan', ++done, readers.length)
    }
  }
  const sameName = new Map<string, number>()
  for (const s of mined) sameName.set(s.name, (sameName.get(s.name) ?? 0) + 1)
  const discoveredReal = new Set(skills.map((s) => s.realpath))
  const realCache = new Map<string, string>()
  const real = async (p: string) => {
    let r = realCache.get(p)
    if (r === undefined) {
      r = await realpath(p).catch(() => p)
      realCache.set(p, r)
    }
    return r
  }
  const usesFor = async (skill: Skill): Promise<Record<string, Stamp[]>> => {
    const out: Record<string, Stamp[]> = {}
    if (skill.createdBy !== 'skillmine') return out
    for (const [client, found] of uses) {
      const list: Stamp[] = []
      for (const { name, use } of found) {
        let hit = false
        if (use.path) {
          const r = await real(use.path)
          if (r === skill.realpath) hit = true
          else if (name === skill.name && !discoveredReal.has(r) && sameName.get(skill.name) === 1) hit = true
        } else if (name === skill.name && sameName.get(skill.name) === 1) hit = true
        if (hit) list.push({ ts: use.ts, session: use.session, turn: use.turn })
      }
      if (list.length) out[client] = list
    }
    return out
  }

  const rows: CurateRow[] = []
  for (const skill of skills) {
    let u: Usage
    try {
      u = await readUsageStrict(skill, now)
    } catch (e) {
      rows.push({ skill, usage: emptyUsage(now), idleDays: 0, offerIdleDays: 0, verdict: skill.createdBy !== 'skillmine' ? 'human' : brokenVerdict(e), error: skill.createdBy === 'skillmine' ? errorText(e) : undefined })
      continue
    }
    const mineSkill = skill.createdBy === 'skillmine'
    const stamps = await usesFor(skill)
    const createdAt = created.get(skill.realpath) ?? created.get(skill.name) ?? u.first_seen_at
    const judge = (x: Usage) => {
      const idleDays = Math.floor((now - lastActivity(x, createdAt)) / DAY)
      const offerIdleDays = Math.floor((now - Math.max(x.last_offered_at ?? 0, createdAt, x.first_seen_at)) / DAY)
      const verdict = verdictFor(skill, x, idleDays, staleDays, archiveDays, maturity, { offerIdleDays, maxDays: probationMaxDays })
      return { idleDays, offerIdleDays, verdict }
    }
    const statusOf = (v: Verdict) => (v === 'stale' || v === 'archive' ? 'stale' : 'active')
    let usage: Usage = structuredClone(u)
    let counted = applyScan(usage, stamps, watermarks, seenSessions, mineSkill)
    let j = judge(usage)
    if (mineSkill) {
      usage.status = statusOf(j.verdict)
      if (!readOnly) {
        let lockedJudge = j
        let lockedCount = 0
        const saved = await updateUsage(
          skill,
          (cur) => {
            const moved = cur.use_count !== u.use_count || cur.last_used_at !== u.last_used_at
            lockedCount = applyScan(cur, stamps, watermarks, seenSessions, true)
            lockedJudge = judge(cur)
            if (moved && lockedJudge.verdict === 'archive') lockedJudge = { ...lockedJudge, verdict: 'active' }
            cur.status = statusOf(lockedJudge.verdict)
          },
          now,
        ).then(
          (x) => ({ ok: x }),
          (e: unknown) => ({ err: e }),
        )
        if ('err' in saved) {
          rows.push({ skill, usage: emptyUsage(now), idleDays: 0, offerIdleDays: 0, verdict: brokenVerdict(saved.err), error: errorText(saved.err) })
          continue
        }
        usage = saved.ok
        j = lockedJudge
        counted = lockedCount
      }
    }
    scanned.uses += counted
    rows.push({ skill, usage, idleDays: j.idleDays, offerIdleDays: j.offerIdleDays, verdict: j.verdict })
  }

  const result: CurateResult = { rows, scanned, archived: [], rejected: [], readOnly, scanErrors }
  const missing = CLIENTS.filter((c) => !opts.readers?.[c])
  if (!readOnly && scanErrors.length) result.archiveDisabled = `scan incomplete for ${scanErrors.join(', ')}: nothing was archived this run`
  else if (!readOnly && missing.length) result.archiveDisabled = `no scan for ${missing.join(', ')}: nothing was archived this run`
  let toArchive = readOnly || result.archiveDisabled ? [] : rows.filter((r) => r.verdict === 'archive')
  const stillIdle: CurateRow[] = []
  for (const r of toArchive) {
    try {
      const fresh = await readUsageStrict(r.skill, now)
      if (fresh.use_count === r.usage.use_count && fresh.last_used_at === r.usage.last_used_at && fresh.pinned === r.usage.pinned) stillIdle.push(r)
      else r.verdict = 'active'
    } catch (e) {
      r.verdict = brokenVerdict(e)
      r.error = errorText(e)
    }
  }
  toArchive = stillIdle
  if (toArchive.length) {
    const run = opts.store.newId('run')
    const edits: ArchiveEdit[] = toArchive.map((r) => ({
      action: 'archive',
      name: r.skill.name,
      path: r.skill.realpath,
      reason: archiveReason(r, maturity, archiveDays, probationMaxDays),
      sources: [],
    }))
    const res = await applyEdits(edits, { store: opts.store, layout: opts.layout, project: opts.project ?? '', run, catalog: skills, now: () => now })
    result.run = run
    result.archived = res.applied
    result.rejected = res.rejected
  }
  return result
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200)
}

function brokenVerdict(e: unknown): Verdict {
  return e instanceof LockTimeoutError ? 'locked' : 'unreadable'
}

type Stamp = { ts: number; session?: string; turn?: string }

function applyScan(u: Usage, stamps: Record<string, Stamp[]>, watermarks: Record<string, number>, seenSessions: Record<string, Set<string>>, mineSkill: boolean): number {
  if (u.scanned_until && 'batch' in u.scanned_until) {
    const legacy = u.scanned_until.batch ?? 0
    const next: Partial<Record<string, number>> = { ...u.scanned_until }
    delete next.batch
    for (const c of CLIENTS) if (next[c] === undefined) next[c] = legacy
    u.scanned_until = next
  }
  let counted = 0
  const count = (fresh: number[]) => {
    if (!fresh.length) return
    u.use_count += fresh.length
    u.last_used_at = Math.max(u.last_used_at ?? 0, ...fresh)
    counted += fresh.length
  }
  const clients = new Set([...Object.keys(stamps), ...Object.keys(u.scanned_uses ?? {}).filter((c) => seenSessions[c])])
  for (const client of clients) {
    const list = stamps[client] ?? []
    const mark = u.scanned_until?.[client] ?? 0
    count(list.filter((s) => s.session === undefined && s.ts > mark).map((s) => s.ts))
    const bySession = new Map<string, Stamp[]>()
    for (const s of list) if (s.session !== undefined) bySession.set(s.session, [...(bySession.get(s.session) ?? []), s])
    const progress: Record<string, number> = { ...u.scanned_uses?.[client] }
    const turnIds: Record<string, string[]> = { ...u.scanned_turns?.[client] }
    for (const [session, items] of bySession) {
      const done = Object.hasOwn(progress, session) ? progress[session]! : undefined
      const seen = Object.hasOwn(turnIds, session) ? new Set(turnIds[session]) : undefined
      let fresh: Stamp[]
      if (done === undefined) fresh = items.filter((s) => s.ts > mark)
      else if (seen && items.every((s) => s.turn !== undefined)) fresh = items.filter((s) => !seen.has(s.turn!))
      else fresh = items.length < done ? [] : items.slice(done)
      count(fresh.map((s) => s.ts))
      if (mineSkill) {
        progress[session] = items.length
        if (items.every((s) => s.turn !== undefined)) turnIds[session] = items.map((s) => s.turn!)
        else delete turnIds[session]
      }
    }
    if (!mineSkill) continue
    for (const session of Object.keys(progress)) {
      if (bySession.has(session) || !seenSessions[client]?.has(session)) continue
      progress[session] = 0
      delete turnIds[session]
    }
    if (Object.keys(progress).length) u.scanned_uses = { ...u.scanned_uses, [client]: progress }
    if (Object.keys(turnIds).length) u.scanned_turns = { ...u.scanned_turns, [client]: turnIds }
  }
  if (mineSkill && Object.keys(watermarks).length) {
    const next: Partial<Record<string, number>> = { ...u.scanned_until }
    for (const [c, ts] of Object.entries(watermarks)) next[c] = Math.max(next[c] ?? 0, ts)
    u.scanned_until = next
  }
  return counted
}

function archiveReason(r: CurateRow, maturity: number, archiveDays: number, probationMaxDays: number): string {
  const u = r.usage
  if (u.offered_count > 0 && u.use_count === 0) {
    if (u.offered_count >= maturity) return `curate: offered ${u.offered_count} times (maturity ${maturity}) and never used`
    if (r.offerIdleDays >= probationMaxDays) return `curate: on probation with no offer for ${r.offerIdleDays} days (limit ${probationMaxDays}) and never used`
  }
  return `curate: no use for ${r.idleDays} days (archive after ${archiveDays})`
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
