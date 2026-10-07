import type { Client, Reader, SessionRef, Window, Signal } from './types.ts'
import { CLIENTS } from './types.ts'
import { sliceSession, windowScore, dropAutomated } from './windows.ts'

export type MineOptions = {
  days: number
  clients: Client[]
  project?: string
  now?: number
  concurrency?: number
  automatedMinSessions?: number
  onProgress?: (done: number, total: number) => void
}

export type ClientStats = {
  sessions: number
  turns: number
  windows: number
  errors: number
}

export type MineResult = {
  since: number
  windows: Window[]
  automated: number
  perClient: Record<Client, ClientStats>
  signals: Record<Signal, number>
  projects: Record<string, number>
}

export function parseClients(spec: string | undefined): Client[] {
  if (!spec || spec === 'all') return [...CLIENTS]
  const out: Client[] = []
  for (const raw of spec.split(',')) {
    const c = raw.trim() as Client
    if (c === ('agy' as string)) out.push('antigravity')
    else if ((CLIENTS as readonly string[]).includes(c)) out.push(c)
    else throw new Error(`unknown client: ${raw}`)
  }
  return out
}

function emptyStats(): ClientStats {
  return { sessions: 0, turns: 0, windows: 0, errors: 0 }
}

export async function mine(readers: Record<Client, Reader>, opts: MineOptions): Promise<MineResult> {
  const now = opts.now ?? Date.now()
  const since = now - opts.days * 86_400_000
  const perClient = Object.fromEntries(CLIENTS.map((c) => [c, emptyStats()])) as Record<Client, ClientStats>
  const signals: Record<Signal, number> = { correction: 0, 'fail-then-pass': 0, explanation: 0, decision: 0 }
  const projects: Record<string, number> = {}
  const collected: Window[] = []

  const refs: SessionRef[] = []
  for (const client of opts.clients) {
    const found = await readers[client].discover({ since, project: opts.project })
    refs.push(...found)
  }
  let done = 0
  const limit = opts.concurrency ?? 8
  const queue = [...refs]
  const worker = async () => {
    for (;;) {
      const ref = queue.shift()
      if (!ref) return
      const stats = perClient[ref.client]
      try {
        const turns = await readers[ref.client].read(ref)
        const project = turns[0]?.project ?? ref.project
        if (opts.project && project && !project.startsWith(opts.project)) continue
        stats.sessions++
        stats.turns += turns.length
        for (const w of sliceSession(turns)) collected.push(w)
      } catch {
        stats.errors++
      } finally {
        done++
        opts.onProgress?.(done, refs.length)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length || 1) }, worker))
  const { kept: windows, dropped: automated } = dropAutomated(collected, opts.automatedMinSessions)
  for (const w of windows) {
    perClient[w.client].windows++
    for (const s of w.signals) signals[s]++
    const key = w.project || '(unknown)'
    projects[key] = (projects[key] ?? 0) + 1
  }
  windows.sort((a, b) => windowScore(b.signals) - windowScore(a.signals) || b.end - a.end)
  return { since, windows, automated, perClient, signals, projects }
}
