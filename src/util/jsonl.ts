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

export { cut, firstStringArg, parseJsonSafe, toMillis } from './text.ts'
