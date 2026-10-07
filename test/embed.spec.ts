import { describe, expect, test } from 'bun:test'
import { cosine, chunkText, mean, normalize } from '../src/embed/math.ts'
import { EmbeddingCache, CachedEmbedder } from '../src/embed/cache.ts'
import { OllamaEmbedder } from '../src/embed/ollama.ts'
import type { Embedder } from '../src/embed/types.ts'

class FakeEmbedder implements Embedder {
  readonly model = 'fake'
  calls = 0
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += texts.length
    return texts.map((t) => Float32Array.from([t.length, t.includes('redis') ? 1 : 0, t.includes('postgres') ? 1 : 0]))
  }
}

describe('math', () => {
  test('cosine of identical vectors is 1 and orthogonal is 0', () => {
    const a = Float32Array.from([1, 2, 3])
    expect(cosine(a, a)).toBeCloseTo(1)
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0)
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1, 1]))).toBe(0)
  })
  test('normalize and mean', () => {
    const n = normalize(Float32Array.from([3, 4]))
    expect(n[0]).toBeCloseTo(0.6)
    const m = mean([Float32Array.from([0, 2]), Float32Array.from([2, 0])])
    expect(Array.from(m)).toEqual([1, 1])
  })
  test('chunkText splits on newlines with overlap', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n')
    const chunks = chunkText(text, 500, 50)
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500)
    expect(chunkText('short')).toEqual(['short'])
    expect(chunkText('   ')).toEqual([])
  })
})

describe('cache', () => {
  test('caches by model and text, round-trips vectors', async () => {
    const cache = new EmbeddingCache(':memory:')
    const inner = new FakeEmbedder()
    const e = new CachedEmbedder(inner, cache)
    const first = await e.embed(['uses redis lock', 'uses postgres'])
    expect(inner.calls).toBe(2)
    const second = await e.embed(['uses redis lock', 'new text'])
    expect(inner.calls).toBe(3)
    expect(Array.from(second[0]!)).toEqual(Array.from(first[0]!))
    expect(cache.count()).toBe(3)
    expect(e.hits).toBe(1)
    expect(cache.get('other-model', 'uses redis lock')).toBeUndefined()
    cache.close()
  })
})

describe('ollama embedder', () => {
  test('posts batches and parses embeddings', async () => {
    const seen: unknown[] = []
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      seen.push(body.input.length)
      return new Response(JSON.stringify({ embeddings: body.input.map((t) => [t.length, 1]) }), { status: 200 })
    }) as unknown as typeof fetch
    const e = new OllamaEmbedder({ fetch: fakeFetch, batch: 2, model: 'm' })
    const vecs = await e.embed(['a', 'bb', 'ccc'])
    expect(seen).toEqual([2, 1])
    expect(Array.from(vecs[2]!)).toEqual([3, 1])
  })
  test('available() checks the model list', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }))) as unknown as typeof fetch
    expect(await new OllamaEmbedder({ fetch: fakeFetch, model: 'nomic-embed-text' }).available()).toBe(true)
    expect(await new OllamaEmbedder({ fetch: fakeFetch, model: 'bge-m3' }).available()).toBe(false)
  })
})
