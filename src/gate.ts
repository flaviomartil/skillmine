import { mkdir, readFile, writeFile, rename, unlink, appendFile, readdir, stat, rm, open } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Client, Reader, SessionRef, Turn } from './types.ts'
import { digestTurn, MAX_DIGEST_CHARS } from './windows.ts'
import { prepare, type Prepared } from './prepare.ts'
import type { Classifier } from './classify/types.ts'
import type { Embedder } from './embed/types.ts'
import type { Planner, PlanOutput } from './plan/types.ts'
import { Store, type LedgerEntry } from './apply/store.ts'
import { applyEdits } from './apply/writer.ts'
import type { Layout } from './apply/paths.ts'

export const DAY = 86_400_000
export const GATE_STATE_MAX_AGE_MS = 7 * DAY
export const GATE_LOG_TRIM_ABOVE = 2 * 1024 * 1024
export const GATE_LOG_KEEP = 1024 * 1024

export type GateState = { stops: number; gatedTurns: number; lastPlanned: number; updated: number }

export type GateStatus = 'skipped' | 'locked' | 'not-found' | 'nothing' | 'rejected' | 'cooldown' | 'applied' | 'empty'

export type GateOptions = {
  client: Client
  session: string
  project?: string
  readers: Partial<Record<Client, Reader>>
  store: Store
  layout?: Layout
  home?: string
  stateDir?: string
  every?: number
  cooldownMs?: number
  lookbackDays?: number
  force?: boolean
  classifier?: Classifier
  embedder?: Embedder
  planner?: Planner
  now?: number
  minDigest?: number
}

export type GateResult = {
  status: GateStatus
  reason?: string
  stops: number
  freshTurns: number
  verdict?: Prepared['verdict']
  plan?: PlanOutput
  applied: LedgerEntry[]
  rejected: LedgerEntry[]
  run?: string
}

export function gateStateDir(store: Store): string {
  return join(store.root, 'gate')
}

function stateFile(dir: string, client: Client, session: string): string {
  const safe = session.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
  return join(dir, `${client}-${safe}.json`)
}

export async function readGateState(path: string): Promise<GateState> {
  try {
    return { stops: 0, gatedTurns: 0, lastPlanned: 0, updated: 0, ...(JSON.parse(await readFile(path, 'utf8')) as Partial<GateState>) }
  } catch {
    return { stops: 0, gatedTurns: 0, lastPlanned: 0, updated: 0 }
  }
}

async function writeGateState(path: string, state: GateState): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n')
  await rename(tmp, path)
}

export function matchesSession(ref: SessionRef, id: string): boolean {
  const bare = id.replace(/^session_/, '')
  return (
    ref.id === id ||
    ref.id === bare ||
    (Boolean(ref.id) && id.endsWith(ref.id)) ||
    ref.id.endsWith(id) ||
    (Boolean(bare) && ref.id.endsWith(bare)) ||
    ref.id.endsWith(`-${id}`) ||
    (Boolean(bare) && ref.id.endsWith(`-${bare}`)) ||
    ref.path.includes(id) ||
    (Boolean(bare) && ref.path.includes(bare))
  )
}

export async function cleanupGateState(home: string | Store = homedir(), now = Date.now(), extraStateDir?: string): Promise<void> {
  const roots = typeof home === 'string' ? Array.from(new Set([join(home, '.skillmine'), home])) : [home.root]
  const gateDirs = Array.from(new Set([...roots.map((r) => join(r, 'gate')), ...(extraStateDir ? [extraStateDir] : [])]))
  for (const dir of gateDirs) {
    try {
      for (const f of await readdir(dir)) {
        if (!/\.(json|lock)$/.test(f)) continue
        const p = join(dir, f)
        try {
          if (now - (await stat(p)).mtimeMs > GATE_STATE_MAX_AGE_MS) await rm(p, { force: true })
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }
  for (const r of roots) {
    const log = join(r, 'gate.log')
    try {
      const st = await stat(log)
      if (st.size > GATE_LOG_TRIM_ABOVE) {
        const cleaned = (await readFile(log, 'utf8')).replace(/\x00+/g, '')
        const tail = Buffer.from(cleaned, 'utf8')
        const sliced = tail.subarray(Math.max(0, tail.length - GATE_LOG_KEEP))
        const handle = await open(log, 'w')
        try {
          await handle.write(sliced)
        } finally {
          await handle.close()
        }
      } else if (st.size > 0) {
        const raw = await readFile(log, 'utf8')
        if (raw.includes('\x00')) await writeFile(log, raw.replace(/\x00+/g, ''))
      }
    } catch {
      continue
    }
  }
}

export function freshDigest(turns: Turn[], from: number, max = MAX_DIGEST_CHARS): string {
  const lines = turns
    .slice(from)
    .filter((t) => !t.sidechain)
    .map(digestTurn)
    .filter(Boolean)
  let out = lines.join('\n')
  if (out.length > max) out = out.slice(out.length - max)
  return out
}

async function acquireLock(path: string, now: number, staleMs = 15 * 60_000): Promise<boolean> {
  const lock = `${path}.lock`
  if (existsSync(lock)) {
    try {
      const { ts } = JSON.parse(readFileSync(lock, 'utf8')) as { ts?: number }
      if (ts && now - ts < staleMs) return false
    } catch {
      /* corrupt lock, take it */
    }
  }
  await mkdir(join(lock, '..'), { recursive: true })
  await writeFile(lock, JSON.stringify({ pid: process.pid, ts: now }))
  return true
}

async function releaseLock(path: string): Promise<void> {
  await unlink(`${path}.lock`).catch(() => undefined)
}

export async function gate(opts: GateOptions): Promise<GateResult> {
  const now = opts.now ?? Date.now()
  const every = Math.max(1, opts.every ?? 3)
  const cooldownMs = opts.cooldownMs ?? 20 * 60_000
  const dir = opts.stateDir ?? gateStateDir(opts.store)
  await cleanupGateState(opts.home ?? opts.store, now, dir)
  const file = stateFile(dir, opts.client, opts.session)
  const state = await readGateState(file)
  state.stops += 1
  state.updated = now
  await writeGateState(file, state)
  const base = { stops: state.stops, freshTurns: 0, applied: [] as LedgerEntry[], rejected: [] as LedgerEntry[] }

  if (!opts.force && state.stops % every !== 0) return { ...base, status: 'skipped', reason: `stop ${state.stops} of every ${every}` }
  if (!(await acquireLock(file, now))) return { ...base, status: 'locked', reason: 'another gate is running for this session' }
  try {
    const reader = opts.readers[opts.client]
    if (!reader) return { ...base, status: 'not-found', reason: `no reader for ${opts.client}` }
    const since = now - (opts.lookbackDays ?? 30) * DAY
    const refs = await reader.discover({ since }).catch(() => [] as SessionRef[])
    const ref = refs.find((r) => matchesSession(r, opts.session))
    if (!ref) return { ...base, status: 'not-found', reason: `session ${opts.session} not found for ${opts.client}` }
    const turns = await reader.read(ref)
    const from = Math.min(state.gatedTurns, turns.length)
    const fresh = turns.slice(from)
    state.gatedTurns = turns.length
    await writeGateState(file, state)
    const project = opts.project || ref.project || ''
    const digest = freshDigest(fresh, 0)
    const result: GateResult = { ...base, status: 'empty', freshTurns: fresh.length }
    if (digest.length < (opts.minDigest ?? 200)) return { ...result, status: 'empty', reason: 'not enough new conversation' }

    const sources = fresh.filter((t) => !t.sidechain).slice(-5).map((t) => t.ref)
    const prepared = await prepare(digest, { project, sources, classifier: opts.classifier, embedder: opts.embedder, store: opts.store, home: opts.home })
    result.verdict = prepared.verdict
    if (!prepared.passed) return { ...result, status: 'rejected', reason: 'classifier saw no reusable knowledge' }
    if (!opts.force && now - state.lastPlanned < cooldownMs) {
      state.gatedTurns = from
      await writeGateState(file, state)
      return { ...result, status: 'cooldown', reason: `last plan ${Math.round((now - state.lastPlanned) / 60_000)} min ago` }
    }
    if (!opts.planner) {
      state.gatedTurns = from
      await writeGateState(file, state)
      return { ...result, status: 'nothing', reason: 'no planner configured' }
    }

    state.lastPlanned = now
    await writeGateState(file, state)
    const plan = await opts.planner.plan(prepared.input)
    result.plan = plan
    if (!plan.edits.length) return { ...result, status: 'nothing', reason: 'planner chose no edits' }
    const run = opts.store.newId('run')
    const res = await applyEdits(plan.edits, { store: opts.store, layout: opts.layout, project, run, expectedSha: new Map(Object.entries(prepared.expected)), now: () => now })
    return { ...result, status: res.applied.length ? 'applied' : 'nothing', run, applied: res.applied, rejected: res.rejected, reason: res.applied.length ? undefined : 'every edit was rejected' }
  } finally {
    await releaseLock(file)
  }
}

export async function logGate(store: Store, client: Client, session: string, result: GateResult): Promise<void> {
  const line = { ts: new Date().toISOString(), client, session, status: result.status, reason: result.reason, stops: result.stops, fresh: result.freshTurns, applied: result.applied.map((a) => `${a.action} ${a.name}`), rejected: result.rejected.length, run: result.run }
  await appendFile(join(store.root, 'gate.log'), JSON.stringify(line) + '\n').catch(() => undefined)
}
