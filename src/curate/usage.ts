import { readFile, writeFile, rename, access, unlink, stat, link } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Skill } from '../catalog.ts'
import type { Turn } from '../types.ts'
import { pidAlive } from '../util/pid.ts'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

export const USAGE_FILE = '.usage.json'

export type Usage = {
  use_count: number
  last_used_at: number | null
  patch_count: number
  offered_count: number
  last_offered_at: number | null
  reject_count: number
  pinned: boolean
  first_seen_at: number
  status?: 'active' | 'stale'
  scanned_until?: Partial<Record<string, number>>
  scanned_uses?: Partial<Record<string, Record<string, number>>>
  scanned_turns?: Partial<Record<string, Record<string, string[]>>>
}

export function emptyUsage(now: number): Usage {
  return { use_count: 0, last_used_at: null, patch_count: 0, offered_count: 0, last_offered_at: null, reject_count: 0, pinned: false, first_seen_at: now }
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

export async function readUsageStrict(skill: Pick<Skill, 'realpath'>, now = Date.now()): Promise<Usage> {
  let text: string
  try {
    text = await readFile(usagePath(skill), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyUsage(now)
    throw e
  }
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`unreadable usage sidecar at ${usagePath(skill)}`)
  const o = parsed as Record<string, unknown>
  const num = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v))
  const ok =
    ['use_count', 'patch_count', 'offered_count', 'reject_count', 'first_seen_at'].every((k) => num(o[k])) &&
    ['last_used_at', 'last_offered_at'].every((k) => o[k] === undefined || o[k] === null || (typeof o[k] === 'number' && Number.isFinite(o[k]))) &&
    (o.pinned === undefined || typeof o.pinned === 'boolean') &&
    (o.scanned_until === undefined || (typeof o.scanned_until === 'object' && o.scanned_until !== null && !Array.isArray(o.scanned_until) && Object.values(o.scanned_until).every((v) => typeof v === 'number' && Number.isFinite(v)))) &&
    (o.scanned_uses === undefined ||
      (typeof o.scanned_uses === 'object' &&
        o.scanned_uses !== null &&
        !Array.isArray(o.scanned_uses) &&
        Object.values(o.scanned_uses).every((per) => typeof per === 'object' && per !== null && !Array.isArray(per) && Object.values(per).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)))) &&
    (o.scanned_turns === undefined ||
      (typeof o.scanned_turns === 'object' &&
        o.scanned_turns !== null &&
        !Array.isArray(o.scanned_turns) &&
        Object.values(o.scanned_turns).every((per) => typeof per === 'object' && per !== null && !Array.isArray(per) && Object.values(per).every((v) => Array.isArray(v) && v.every((id) => typeof id === 'string')))))
  if (!ok) throw new Error(`unreadable usage sidecar at ${usagePath(skill)}`)
  return { ...emptyUsage(now), ...(o as Partial<Usage>) }
}

export async function writeUsage(skill: Pick<Skill, 'realpath'>, usage: Usage): Promise<void> {
  const path = usagePath(skill)
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(usage, null, 2) + '\n')
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}

export const USAGE_LOCK = '.usage.lock'
export const USAGE_LOCK_STALE_MS = 10_000
export const USAGE_LOCK_LIVE_MS = 60_000

export class LockTimeoutError extends Error {}
export const USAGE_LOCK_WAIT_MS = 2_000

export function judgeUsageLock(raw: string, mtime: number): boolean {
  let ts = mtime
  let pid: number | undefined
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown } | null
    if (typeof parsed?.ts === 'number' && Number.isFinite(parsed.ts)) ts = parsed.ts
    if (typeof parsed?.pid === 'number') pid = parsed.pid
  } catch {
    ts = mtime
  }
  const age = Date.now() - ts
  if (pid === undefined) return age > USAGE_LOCK_STALE_MS
  if (!pidAlive(pid)) return true
  return age > USAGE_LOCK_LIVE_MS
}

async function breakStaleUsageLock(lock: string): Promise<boolean> {
  let raw: string
  let mtime: number
  try {
    raw = await readFile(lock, 'utf8')
    mtime = (await stat(lock)).mtimeMs
  } catch {
    return false
  }
  if (!judgeUsageLock(raw, mtime)) return false
  if ((await readFile(lock, 'utf8').catch(() => undefined)) !== raw) return false
  return takeOverUsageLock(lock, raw)
}

export async function takeOverUsageLock(lock: string, raw: string): Promise<boolean> {
  const taken = `${lock}.${process.pid}.${randomUUID()}.stale`
  try {
    await rename(lock, taken)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
  if ((await readFile(taken, 'utf8').catch(() => undefined)) === raw) {
    await unlink(taken).catch(() => undefined)
    return true
  }
  await link(taken, lock).catch(() => undefined)
  await unlink(taken).catch(() => undefined)
  return false
}

async function ownsUsageLock(lock: string, token: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(lock, 'utf8')) as { token?: unknown } | null)?.token === token
  } catch {
    return false
  }
}

export async function withUsageLock<T>(skill: Pick<Skill, 'realpath'>, fn: () => Promise<T>): Promise<T> {
  const lock = join(dirname(skill.realpath), USAGE_LOCK)
  const token = randomUUID()
  const deadline = Date.now() + USAGE_LOCK_WAIT_MS
  let delay = 5
  const tryCreate = async (): Promise<boolean> => {
    try {
      await writeFile(lock, JSON.stringify({ pid: process.pid, ts: Date.now(), token }), { flag: 'wx' })
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      return false
    }
  }
  for (;;) {
    if (await tryCreate()) break
    if ((await breakStaleUsageLock(lock)) && (await tryCreate())) break
    if (Date.now() >= deadline) throw new LockTimeoutError(`usage sidecar is locked: ${lock}`)
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 50)
  }
  try {
    return await fn()
  } finally {
    if (await ownsUsageLock(lock, token)) await unlink(lock).catch(() => undefined)
  }
}

export async function updateUsage(skill: Pick<Skill, 'realpath'>, mutate: (u: Usage) => void, at = Date.now()): Promise<Usage> {
  return withUsageLock(skill, async () => {
    const u = await readUsageStrict(skill, at)
    mutate(u)
    await writeUsage(skill, u)
    return u
  })
}

export async function recordUse(skill: Pick<Skill, 'realpath'>, at = Date.now()): Promise<Usage> {
  return updateUsage(
    skill,
    (u) => {
      u.use_count += 1
      u.last_used_at = Math.max(u.last_used_at ?? 0, at)
      u.status = 'active'
    },
    at,
  )
}

export async function recordTouch(skill: Pick<Skill, 'realpath'>, at = Date.now()): Promise<Usage> {
  return updateUsage(
    skill,
    (u) => {
      u.last_used_at = Math.max(u.last_used_at ?? 0, at)
    },
    at,
  )
}

export async function recordOffered(skill: Pick<Skill, 'realpath'>, at = Date.now()): Promise<Usage> {
  await access(skill.realpath)
  return updateUsage(
    skill,
    (u) => {
      u.offered_count += 1
      u.last_offered_at = at
    },
    at,
  )
}

export async function recordReject(skill: Pick<Skill, 'realpath'>, at = Date.now()): Promise<Usage> {
  await access(skill.realpath)
  return updateUsage(
    skill,
    (u) => {
      u.reject_count += 1
    },
    at,
  )
}

export async function setPinned(skill: Pick<Skill, 'realpath'>, pinned: boolean): Promise<Usage> {
  return updateUsage(skill, (u) => {
    u.pinned = pinned
  })
}

const SKILL_TOOLS = new Set(['skill', 'skills', 'use_skill', 'load_skill', 'read_skill'])

export type UseHit = { name: string; path?: string }

const SKILL_PATH_RE = /((?:[^\s'"]*\/)?([A-Za-z0-9._-]+)\/SKILL\.md)/

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  const m = /^\$\{?HOME\}?(\/.*)?$/.exec(path)
  return m ? join(home, m[1] ?? '') : path
}

export function skillUseHitsIn(turn: Turn, names: Set<string>, anyPath = false): UseHit[] {
  const hits: UseHit[] = []
  const seen = new Set<string>()
  const add = (hit: UseHit) => {
    const key = `${hit.name}\u0000${hit.path ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push(hit)
  }
  for (const t of turn.tools) {
    const tool = t.name.toLowerCase()
    if (SKILL_TOOLS.has(tool)) {
      const arg = t.arg.trim().replace(/^\//, '').split(/[\s:]/)[0] ?? ''
      if (names.has(arg)) add({ name: arg })
      continue
    }
    const m = SKILL_PATH_RE.exec(t.arg)
    if (m && (anyPath || names.has(m[2]!))) add({ name: m[2]!, path: resolve(turn.project || '/', expandHome(m[1]!)) })
  }
  if (turn.role === 'user') {
    const m = /^\s*\/([A-Za-z0-9._-]+)(?:\s|$)/.exec(turn.text)
    if (m && names.has(m[1]!)) add({ name: m[1]! })
  }
  return hits
}

export function skillUsesIn(turn: Turn, names: Set<string>): string[] {
  return [...new Set(skillUseHitsIn(turn, names).map((h) => h.name))]
}

export type UsageScan = { uses: Map<string, number[]>; turns: number }
export type UseDetail = { ts: number; path?: string; session?: string; turn?: string }
export type UsageScanDetail = { uses: Map<string, UseDetail[]>; turns: number }

export function scanUsageDetailed(turns: Iterable<Turn>, names: Set<string>, anyPath = false): UsageScanDetail {
  const uses = new Map<string, UseDetail[]>()
  let n = 0
  for (const turn of turns) {
    n++
    for (const hit of skillUseHitsIn(turn, names, anyPath)) {
      const list = uses.get(hit.name) ?? []
      list.push({ ts: turn.ts, path: hit.path, session: turn.approxTs ? turn.session : undefined, turn: turn.approxTs ? turn.turnId : undefined })
      uses.set(hit.name, list)
    }
  }
  return { uses, turns: n }
}

export function scanUsage(turns: Iterable<Turn>, names: Set<string>): UsageScan {
  const detail = scanUsageDetailed(turns, names)
  const uses = new Map<string, number[]>()
  for (const [name, list] of detail.uses) uses.set(name, list.map((e) => e.ts))
  return { uses, turns: detail.turns }
}
