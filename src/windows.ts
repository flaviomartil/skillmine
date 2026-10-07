import type { Turn, Window, Signal } from './types.ts'
import { cut } from './util/jsonl.ts'

export const MAX_DIGEST_CHARS = 6000
const MIN_TURNS = 2

const CORRECTION = /^(no|nope|não|nao|wrong|errado|actually|na verdade|instead|isso não|that's not|that is not|not that)\b|\b(you're wrong|está errado|ta errado|não é isso|not what i)/i
const DECISION = /\b(instead of|trade-?offs?|rather than|em vez de|ao invés de|the reason (is|was)|decided to|decidi|opt(ed)? for|we chose|escolhi)\b/i
const EXPLANATION = /\b(because|why|means that|works by|the cause|root cause|porque|significa|funciona|a causa|gotcha|pitfall|caveat|note that|keep in mind|lesson)\b/i
const SELF = /\bskillmine\b/i

export const SIGNAL_WEIGHT: Record<Signal, number> = { correction: 4, 'fail-then-pass': 3, decision: 2, explanation: 1 }

export function windowScore(signals: Signal[]): number {
  return signals.reduce((n, s) => n + SIGNAL_WEIGHT[s], 0)
}

export function digestTurn(t: Turn): string {
  const tools = t.tools.length ? ` [tools: ${t.tools.map((c) => `${c.name}(${c.arg})${c.failed ? ' FAILED' : ''}`).join(', ')}]` : ''
  return `${t.role}: ${cut(t.text, 1200)}${tools}`
}

export function signalsOf(turns: Turn[]): Signal[] {
  const out = new Set<Signal>()
  const failed = new Set<string>()
  for (const t of turns) {
    if (t.role === 'user' && CORRECTION.test(t.text.trim())) out.add('correction')
    if (t.role === 'assistant') {
      if (t.text.length > 600 && t.tools.length === 0 && EXPLANATION.test(t.text)) out.add('explanation')
      if (t.text.length > 80 && DECISION.test(t.text)) out.add('decision')
      for (const c of t.tools) {
        if (c.failed) failed.add(c.name)
        else if (failed.has(c.name)) out.add('fail-then-pass')
      }
    }
  }
  return [...out]
}

export function userPrefix(w: Window, len = 120): string | undefined {
  const first = w.turns.find((t) => t.role === 'user' && t.text)
  return first ? first.text.replace(/\s+/g, ' ').slice(0, len).toLowerCase() : undefined
}

export function dropAutomated(windows: Window[], minSessions = 5): { kept: Window[]; dropped: number } {
  const sessionsByPrefix = new Map<string, Set<string>>()
  for (const w of windows) {
    const p = userPrefix(w)
    if (!p) continue
    let set = sessionsByPrefix.get(p)
    if (!set) sessionsByPrefix.set(p, (set = new Set()))
    set.add(w.session)
  }
  const kept: Window[] = []
  let dropped = 0
  for (const w of windows) {
    const p = userPrefix(w)
    if (p && (sessionsByPrefix.get(p)?.size ?? 0) >= minSessions) dropped++
    else kept.push(w)
  }
  return { kept, dropped }
}

export function isExecutionOnly(turns: Turn[]): boolean {
  return turns.every((t) => t.role === 'user' ? t.text.length < 40 : t.text.length < 80)
}

export function sliceSession(turns: Turn[]): Window[] {
  const main = turns.filter((t) => !t.sidechain).sort((a, b) => a.ts - b.ts)
  const windows: Window[] = []
  let buf: Turn[] = []
  let size = 0
  const flush = () => {
    if (buf.length >= MIN_TURNS) {
      const w = toWindow(buf)
      if (w) windows.push(w)
    }
    buf = []
    size = 0
  }
  for (const t of main) {
    const d = digestTurn(t)
    if (size + d.length > MAX_DIGEST_CHARS && buf.length) flush()
    buf.push(t)
    size += d.length + 1
  }
  flush()
  return windows
}

function toWindow(turns: Turn[]): Window | undefined {
  if (turns.some((t) => t.role === 'user' && SELF.test(t.text))) return undefined
  if (isExecutionOnly(turns)) return undefined
  const signals = signalsOf(turns)
  if (signals.length === 0) return undefined
  const first = turns[0]!
  const last = turns[turns.length - 1]!
  return {
    id: `${first.client}:${first.session}:${first.ref.split(':').pop()}`,
    client: first.client,
    session: first.session,
    project: first.project,
    turns,
    digest: turns.map(digestTurn).join('\n'),
    signals,
    start: first.ts,
    end: last.ts,
  }
}
