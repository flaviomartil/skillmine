import { mkdir, readFile, writeFile, rename, rm, stat, readdir, open, lstat } from 'node:fs/promises'
import { realpathSync, openSync, closeSync, mkdirSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { spawn as spawnProcess } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import type { Store } from './apply/store.ts'
import { pidAlive } from './util/pid.ts'
import { isInternalProject } from './util/internal.ts'

export const CHILD_ENV = 'SKILLMINE_REFLECTING'
export const LOCK_TOKEN_ENV = 'SKILLMINE_REFLECT_LOCK_TOKEN'
export const LOCK_STALE_MS = 30 * 60_000
export const LOCK_SKEW_MS = 60_000
export const LOCK_REFRESH_MS = 5 * 60_000
const OWNER_FILE = 'owner.json'

export type CallCounter = { calls: number; total: number; updated: number }

export type TickStatus = 'guard' | 'idle' | 'counted' | 'locked' | 'cooldown' | 'triggered' | 'failed'

export type TickResult = { status: TickStatus; count: number; every: number; reason?: string }

export type Spawner = (argv: string[], env: Record<string, string>, cwd?: string, logPath?: string) => Promise<number | undefined>

export type TickOptions = {
  store: Store
  session: string
  calls: number
  project?: string
  every?: number
  now?: number
  env?: Record<string, string | undefined>
  spawn?: Spawner
  command?: string[]
}

export const DEFAULT_REFLECT_COOLDOWN_MS = 15 * 60_000

export function reflectCooldownMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SKILLMINE_REFLECT_COOLDOWN_MS
  if (raw === undefined || raw === '') return DEFAULT_REFLECT_COOLDOWN_MS
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_REFLECT_COOLDOWN_MS
}

export function reflectLogFile(store: Store): string {
  return join(store.root, 'reflect.log')
}

function triggerFile(store: Store): string {
  return join(store.root, 'reflect-trigger.json')
}

async function readLastTrigger(store: Store): Promise<number> {
  try {
    const v = (JSON.parse(await readFile(triggerFile(store), 'utf8')) as { at?: unknown } | null)?.at
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

export function reflectEvery(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SKILLMINE_REFLECT_EVERY_N)
  return Number.isInteger(n) && n > 0 ? n : 50
}

export function reflectStateFile(store: Store): string {
  return join(store.root, 'reflect.json')
}

export function projectKey(project: string | undefined): string {
  return createHash('sha256').update(project ? resolve(project) : '').digest('hex').slice(0, 16)
}

async function readReflectState(store: Store): Promise<Record<string, number>> {
  try {
    const raw = (JSON.parse(await readFile(reflectStateFile(store), 'utf8')) as { projects?: unknown } | null)?.projects
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter((kv): kv is [string, number] => typeof kv[1] === 'number' && Number.isFinite(kv[1]) && kv[1] > 0))
  } catch {
    return {}
  }
}

export function resolveReflectProject(project?: string): string | undefined {
  return project ? resolve(project) : undefined
}

export async function readLastReflect(store: Store, project?: string): Promise<number | undefined> {
  return (await readReflectState(store))[projectKey(project)]
}

export async function writeLastReflect(store: Store, project: string | undefined, at: number): Promise<void> {
  const projects = await readReflectState(store)
  projects[projectKey(project)] = at
  await atomicJson(reflectStateFile(store), { projects })
}

export function counterFile(store: Store, session: string): string {
  const safe = session.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
  return join(store.root, 'counters', `${safe}.json`)
}

export function lockFile(store: Store): string {
  return join(store.root, 'reflect.lock')
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

export async function readCounter(path: string): Promise<CallCounter> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> | null
    const o = raw && typeof raw === 'object' ? raw : {}
    return { calls: count(o.calls), total: count(o.total), updated: count(o.updated) }
  } catch {
    return { calls: 0, total: 0, updated: 0 }
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(value) + '\n')
  await rename(tmp, path)
}

async function writeCounter(path: string, counter: CallCounter): Promise<void> {
  await atomicJson(path, counter)
}

export function injectedFile(store: Store, session: string): string {
  return counterFile(store, session).replace(/\.json$/, '.injected')
}

export async function isInjected(store: Store, session: string): Promise<boolean> {
  try {
    await stat(injectedFile(store, session))
    return true
  } catch {
    return false
  }
}

async function claimMarker(file: string, now: number): Promise<boolean> {
  await mkdir(join(file, '..'), { recursive: true })
  try {
    await writeFile(file, String(now), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

export async function claimInjection(store: Store, session: string, now = Date.now()): Promise<boolean> {
  return claimMarker(injectedFile(store, session), now)
}

export async function claimOffered(store: Store, session: string, now = Date.now()): Promise<boolean> {
  return claimMarker(counterFile(store, session).replace(/\.json$/, '.offered'), now)
}

export const STATE_MAX_AGE_MS = 7 * 86_400_000
export const LOG_TRIM_ABOVE = 2 * 1024 * 1024
export const LOG_KEEP = 1024 * 1024

export async function cleanupState(store: Store, now = Date.now()): Promise<void> {
  try {
    const dir = join(store.root, 'counters')
    for (const f of await readdir(dir)) {
      if (!/\.(json|injected|offered)$/.test(f)) continue
      const path = join(dir, f)
      try {
        if (now - (await stat(path)).mtimeMs > STATE_MAX_AGE_MS) await rm(path, { force: true })
      } catch {
        continue
      }
    }
  } catch {
  }
  try {
    const log = reflectLogFile(store)
    if ((await stat(log)).size > LOG_TRIM_ABOVE) {
      const text = await readFile(log)
      const tail = text.subarray(Math.max(0, text.length - LOG_KEEP))
      const handle = await open(log, 'a')
      try {
        await handle.truncate(0)
        await handle.write(tail)
      } finally {
        await handle.close()
      }
    }
  } catch {
  }
}

type Owner = { token?: unknown; pid?: unknown; ts?: unknown }

export { pidAlive }

export function lockStale(raw: string, mtime: number, now: number): boolean {
  let owner: Owner = {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') owner = parsed as Owner
  } catch {
    owner = {}
  }
  const ts = typeof owner.ts === 'number' && Number.isFinite(owner.ts) ? owner.ts : undefined
  if (ts !== undefined && ts > now + LOCK_SKEW_MS) return true
  const age = now - (ts ?? mtime)
  if (typeof owner.pid === 'number') {
    if (!pidAlive(owner.pid)) return true
    return age >= LOCK_STALE_MS * 3
  }
  return age >= LOCK_STALE_MS
}

async function readOwnerRaw(path: string): Promise<string> {
  try {
    return await readFile(join(path, OWNER_FILE), 'utf8')
  } catch {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return ''
    }
  }
}

function parseOwner(raw: string): Owner {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Owner) : {}
  } catch {
    return {}
  }
}

async function claimLock(path: string, token: string, now: number): Promise<boolean> {
  try {
    await mkdir(path)
  } catch {
    return false
  }
  try {
    await atomicJson(join(path, OWNER_FILE), { token, pid: process.pid, ts: now })
  } catch {
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    return false
  }
  return parseOwner(await readOwnerRaw(path)).token === token
}

export type AcquireHooks = { beforeSteal?: () => Promise<void>; afterSteal?: () => Promise<void> }

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function putBack(moved: string, path: string): Promise<void> {
  if (!(await exists(path))) {
    try {
      await rename(moved, path)
      return
    } catch {
    }
  }
  await rm(moved, { recursive: true, force: true }).catch(() => undefined)
}

export async function acquireReflectLock(store: Store, now = Date.now(), hooks: AcquireHooks = {}): Promise<string | undefined> {
  const path = lockFile(store)
  await mkdir(store.root, { recursive: true })
  const token = randomUUID()
  if (await claimLock(path, token, now)) return token
  let mtime: number
  try {
    mtime = (await stat(path)).mtimeMs
  } catch {
    return (await claimLock(path, token, now)) ? token : undefined
  }
  const raw = await readOwnerRaw(path)
  if (!lockStale(raw, mtime, now)) return undefined
  if ((await readOwnerRaw(path)) !== raw) return undefined
  await hooks.beforeSteal?.()
  const moved = `${path}.stale-${randomUUID()}`
  try {
    await rename(path, moved)
  } catch {
    return undefined
  }
  await hooks.afterSteal?.()
  if ((await readOwnerRaw(moved)) !== raw) {
    await putBack(moved, path)
    return undefined
  }
  await rm(moved, { recursive: true, force: true }).catch(() => undefined)
  return (await claimLock(path, token, now)) ? token : undefined
}

export async function updateLockOwner(store: Store, token: string | undefined, patch: { pid?: number; ts?: number }): Promise<boolean> {
  if (!token) return false
  const path = lockFile(store)
  const owner = parseOwner(await readOwnerRaw(path))
  if (owner.token !== token) return false
  const target = join(path, OWNER_FILE)
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify({ ...owner, ...patch }) + '\n')
    if (parseOwner(await readOwnerRaw(path)).token !== token) {
      await rm(tmp, { force: true }).catch(() => undefined)
      return false
    }
    await rename(tmp, target)
    return true
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined)
    return false
  }
}

export type LockRefresh = { stop: () => Promise<void>; lost: () => boolean }

export function startLockRefresh(store: Store, token: string | undefined, intervalMs = LOCK_REFRESH_MS): LockRefresh {
  let lost = false
  let inflight: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    inflight = inflight.then(async () => {
      if (!(await updateLockOwner(store, token, { pid: process.pid, ts: Date.now() }))) lost = true
    })
  }, intervalMs)
  timer.unref()
  return {
    stop: async () => {
      clearInterval(timer)
      await inflight.catch(() => undefined)
    },
    lost: () => lost,
  }
}

export async function releaseReflectLock(store: Store, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const path = lockFile(store)
  if (parseOwner(await readOwnerRaw(path)).token !== token) return false
  const moved = `${path}.release-${randomUUID()}`
  try {
    await rename(path, moved)
  } catch {
    return false
  }
  if (parseOwner(await readOwnerRaw(moved)).token !== token) {
    await putBack(moved, path)
    return false
  }
  try {
    await rm(moved, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export function reflectCommand(env: Record<string, string | undefined> = process.env): string[] {
  const override = env.SKILLMINE_REFLECT_CMD?.split(' ').filter(Boolean)
  if (override?.length) return override
  const main = Bun.main
  if (!main || main.startsWith('/$bunfs') || main.startsWith('B:/~BUN')) return [process.execPath]
  let real = main
  try {
    real = realpathSync(main)
  } catch {
    real = main
  }
  return [process.execPath, real]
}

export const detachedSpawn: Spawner = (argv, env, cwd, logPath) =>
  new Promise<number | undefined>((resolvePid, reject) => {
    const [bin, ...args] = argv
    let fd: number | undefined
    try {
      if (logPath) {
        mkdirSync(dirname(logPath), { recursive: true })
        fd = openSync(logPath, 'a')
      }
    } catch (e) {
      reject(e)
      return
    }
    const done = () => {
      if (fd === undefined) return
      const open = fd
      fd = undefined
      closeSync(open)
    }
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess(bin!, args, { detached: true, stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd], env, cwd })
    } catch (e) {
      done()
      reject(e)
      return
    }
    child.once('error', (e) => {
      done()
      reject(e)
    })
    child.once('spawn', () => {
      done()
      child.unref()
      resolvePid(child.pid)
    })
  })

export async function tick(opts: TickOptions): Promise<TickResult> {
  const env = opts.env ?? process.env
  const every = Math.max(1, opts.every ?? reflectEvery(env))
  if (env[CHILD_ENV]) return { status: 'guard', count: 0, every, reason: 'reflection child session' }
  if (!opts.session || !(opts.calls > 0)) return { status: 'idle', count: 0, every }
  if (isInternalProject(opts.project)) return { status: 'guard', count: 0, every, reason: 'helper session' }
  const now = opts.now ?? Date.now()
  await cleanupState(opts.store, now)
  const file = counterFile(opts.store, opts.session)
  const counter = await readCounter(file)
  counter.calls += Math.floor(opts.calls)
  counter.total += Math.floor(opts.calls)
  counter.updated = now
  if (counter.calls < every) {
    await writeCounter(file, counter)
    return { status: 'counted', count: counter.calls, every }
  }
  const cooldown = reflectCooldownMs(env)
  if (cooldown > 0 && now - (await readLastTrigger(opts.store)) < cooldown) {
    counter.calls = 0
    await writeCounter(file, counter)
    return { status: 'cooldown', count: 0, every, reason: 'a reflection was started recently' }
  }
  const token = await acquireReflectLock(opts.store, now)
  if (!token) {
    counter.calls = 0
    await writeCounter(file, counter)
    return { status: 'locked', count: 0, every, reason: 'another reflection is running' }
  }
  try {
    const argv = [...(opts.command ?? reflectCommand(env)), 'reflect', ...(opts.project ? ['--project', opts.project] : [])]
    const childEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((kv): kv is [string, string] => kv[1] !== undefined))
    childEnv[CHILD_ENV] = '1'
    childEnv[LOCK_TOKEN_ENV] = token
    const pid = await (opts.spawn ?? detachedSpawn)(argv, childEnv, opts.project || undefined, reflectLogFile(opts.store))
    if (pid) await updateLockOwner(opts.store, token, { pid })
  } catch (e) {
    await releaseReflectLock(opts.store, token)
    await writeCounter(file, counter)
    return { status: 'failed', count: counter.calls, every, reason: e instanceof Error ? e.message : String(e) }
  }
  counter.calls = 0
  await writeCounter(file, counter)
  await atomicJson(triggerFile(opts.store), { at: now }).catch(() => undefined)
  return { status: 'triggered', count: 0, every }
}
