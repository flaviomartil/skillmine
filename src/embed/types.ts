export interface Embedder {
  readonly model: string
  embed(texts: string[]): Promise<Float32Array[]>
}

export type EmbedBackend = 'ollama' | 'openai' | 'none'
