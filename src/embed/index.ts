import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Embedder, EmbedBackend } from './types.ts'
import { OllamaEmbedder } from './ollama.ts'
import { OpenAIEmbedder } from './openai.ts'
import { EmbeddingCache, CachedEmbedder } from './cache.ts'

export type { Embedder, EmbedBackend } from './types.ts'
export { OllamaEmbedder } from './ollama.ts'
export { OpenAIEmbedder } from './openai.ts'
export { EmbeddingCache, CachedEmbedder } from './cache.ts'
export { cosine, normalize, mean, chunkText } from './math.ts'

export function defaultCachePath(home = homedir()): string {
  return process.env.SKILLMINE_CACHE ?? join(home, '.skillmine', 'cache', 'embeddings.sqlite')
}

export function parseEmbedBackend(spec: string | undefined): EmbedBackend {
  if (!spec || spec === 'ollama') return 'ollama'
  if (spec === 'openai' || spec === 'none') return spec
  throw new Error(`unknown embed backend: ${spec}`)
}

export async function createEmbedder(backend: EmbedBackend, opts: { model?: string; cachePath?: string } = {}): Promise<{ embedder: Embedder; cache: EmbeddingCache } | undefined> {
  if (backend === 'none') return undefined
  let inner: Embedder
  if (backend === 'ollama') {
    const o = new OllamaEmbedder({ model: opts.model })
    if (!(await o.available())) throw new Error(`ollama model "${o.model}" is not available; run: ollama pull ${o.model}  (or use --embed none)`)
    inner = o
  } else inner = new OpenAIEmbedder({ model: opts.model })
  const cache = new EmbeddingCache(opts.cachePath ?? defaultCachePath())
  return { embedder: new CachedEmbedder(inner, cache), cache }
}
