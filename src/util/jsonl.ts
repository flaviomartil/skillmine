import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export async function* readJsonl<T = unknown>(path: string): AsyncGenerator<T> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      yield JSON.parse(trimmed) as T
    } catch {
      continue
    }
  }
}

export function firstStringArg(input: unknown, max = 60): string {
  if (typeof input === 'string') return cut(input, max)
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return cut(v, max)
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return cut(v, max)
  }
  return ''
}

export function cut(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

export function parseJsonSafe(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

export function toMillis(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
    const f = Number(v)
    if (!Number.isNaN(f)) return f < 1e12 ? f * 1000 : f
  }
  return 0
}
