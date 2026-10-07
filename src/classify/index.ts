import type { Classifier, ClassifierBackend } from './types.ts'
import { JevClassifier } from './jev.ts'
import { HaikuClassifier } from './haiku.ts'

export type { Classifier, ClassifierBackend, ClassifyInput, Verdict, Kind, Novelty } from './types.ts'
export { passes, KNOWLEDGE_THRESHOLD } from './types.ts'
export { JevClassifier, interpretAnswers } from './jev.ts'
export { HaikuClassifier, parseHaikuOutput } from './haiku.ts'
export { buildJevRequest, haikuPrompt } from './questions.ts'

export function parseClassifierBackend(spec: string | undefined, fallback: ClassifierBackend = 'none'): ClassifierBackend {
  if (!spec) return fallback
  if (spec === 'jev' || spec === 'laya' || spec === 'haiku' || spec === 'none') return spec
  throw new Error(`unknown classifier: ${spec}`)
}

export function createClassifier(backend: ClassifierBackend): Classifier | undefined {
  if (backend === 'none') return undefined
  if (backend === 'jev') return new JevClassifier({ name: 'jev' })
  if (backend === 'laya') {
    const baseUrl = process.env.SKILLMINE_LAYA_URL ?? process.env.LAYA_URL ?? 'http://localhost:8000'
    return new JevClassifier({ name: 'laya', baseUrl, apiKey: process.env.SKILLMINE_LAYA_API_KEY ?? process.env.LAYA_API_KEY ?? 'dummy' })
  }
  return new HaikuClassifier()
}
