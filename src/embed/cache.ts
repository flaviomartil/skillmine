import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { Embedder } from './types.ts'

export class EmbeddingCache {
  private db: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.run('pragma journal_mode = wal')
    this.db.run('create table if not exists embeddings (key text primary key, model text not null, dim integer not null, vec blob not null, created_at integer not null)')
  }

  static key(model: string, text: string): string {
    return createHash('sha256').update(model).update('\0').update(text).digest('hex')
  }

  get(model: string, text: string): Float32Array | undefined {
    const row = this.db.query<{ vec: Uint8Array; dim: number }, [string]>('select vec, dim from embeddings where key = ?').get(EmbeddingCache.key(model, text))
    if (!row) return undefined
    const buf = row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)
    return new Float32Array(buf)
  }

  set(model: string, text: string, vec: Float32Array): void {
    this.db
      .query('insert or replace into embeddings (key, model, dim, vec, created_at) values (?, ?, ?, ?, ?)')
      .run(EmbeddingCache.key(model, text), model, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), Date.now())
  }

  count(): number {
    return this.db.query<{ n: number }, []>('select count(*) as n from embeddings').get()!.n
  }

  close(): void {
    this.db.close()
  }
}

export class CachedEmbedder implements Embedder {
  readonly model: string
  misses = 0
  hits = 0

  constructor(private inner: Embedder, private cache: EmbeddingCache) {
    this.model = inner.model
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: (Float32Array | undefined)[] = texts.map((t) => this.cache.get(this.model, t))
    const missing: number[] = []
    out.forEach((v, i) => {
      if (v) this.hits++
      else missing.push(i)
    })
    if (missing.length) {
      this.misses += missing.length
      const vecs = await this.inner.embed(missing.map((i) => texts[i]!))
      missing.forEach((idx, k) => {
        const v = vecs[k]!
        out[idx] = v
        this.cache.set(this.model, texts[idx]!, v)
      })
    }
    return out as Float32Array[]
  }
}
