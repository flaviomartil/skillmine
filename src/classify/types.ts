export type Kind = 'procedure' | 'fact' | 'correction' | 'gotcha' | 'tradeoff' | 'none'
export type Novelty = 'new' | 'update' | 'duplicate'

export type Verdict = {
  knowledge: number
  kind: Kind
  novelty: Novelty
  target?: string
  topics: string[]
  confidence: number
  backend: string
}

export type ClassifyInput = {
  digest: string
  catalog: { name: string; description: string }[]
}

export interface Classifier {
  readonly name: string
  classify(input: ClassifyInput): Promise<Verdict>
}

export type ClassifierBackend = 'jev' | 'laya' | 'haiku' | 'none'

export const KNOWLEDGE_THRESHOLD = 0.6

export function passes(v: Verdict, threshold = KNOWLEDGE_THRESHOLD): boolean {
  if (v.knowledge < threshold || v.kind === 'none') return false
  if (v.novelty === 'duplicate' && v.kind !== 'correction') return false
  return true
}
