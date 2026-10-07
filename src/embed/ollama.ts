import type { Embedder } from './types.ts'

export type OllamaOptions = {
  baseUrl?: string
  model?: string
  batch?: number
  fetch?: typeof fetch
}

export class OllamaEmbedder implements Embedder {
  readonly model: string
  private baseUrl: string
  private batch: number
  private fetchFn: typeof fetch

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? process.env.SKILLMINE_EMBED_MODEL ?? 'nomic-embed-text'
    this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '')
    this.batch = opts.batch ?? 16
    this.fetchFn = opts.fetch ?? fetch
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return false
      const body = (await res.json()) as { models?: { name?: string }[] }
      return (body.models ?? []).some((m) => m.name === this.model || m.name === `${this.model}:latest`)
    } catch {
      return false
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += this.batch) {
      const slice = texts.slice(i, i + this.batch)
      const res = await this.fetchFn(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: slice, truncate: true }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) throw new Error(`ollama embed failed: HTTP ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { embeddings?: number[][] }
      const vecs = body.embeddings ?? []
      if (vecs.length !== slice.length) throw new Error(`ollama returned ${vecs.length} vectors for ${slice.length} inputs`)
      for (const v of vecs) out.push(Float32Array.from(v))
    }
    return out
  }
}
