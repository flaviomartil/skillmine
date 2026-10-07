import type { Embedder } from './types.ts'

export type OpenAIEmbedOptions = {
  baseUrl?: string
  apiKey?: string
  model?: string
  batch?: number
  fetch?: typeof fetch
}

export class OpenAIEmbedder implements Embedder {
  readonly model: string
  private baseUrl: string
  private apiKey: string
  private batch: number
  private fetchFn: typeof fetch

  constructor(opts: OpenAIEmbedOptions = {}) {
    this.model = opts.model ?? process.env.SKILLMINE_EMBED_MODEL ?? 'text-embedding-3-small'
    this.baseUrl = (opts.baseUrl ?? process.env.SKILLMINE_EMBED_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '')
    this.apiKey = opts.apiKey ?? process.env.SKILLMINE_EMBED_API_KEY ?? process.env.OPENAI_API_KEY ?? ''
    this.batch = opts.batch ?? 64
    this.fetchFn = opts.fetch ?? fetch
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += this.batch) {
      const slice = texts.slice(i, i + this.batch)
      const res = await this.fetchFn(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: slice }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) throw new Error(`embeddings failed: HTTP ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] }
      const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
      if (rows.length !== slice.length) throw new Error(`embeddings returned ${rows.length} vectors for ${slice.length} inputs`)
      for (const r of rows) out.push(Float32Array.from(r.embedding))
    }
    return out
  }
}
