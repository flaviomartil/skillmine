import type { Classifier, ClassifyInput, Verdict, Kind, Novelty } from './types.ts'
import { buildJevRequest } from './questions.ts'

export type JevOptions = {
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }

type JevResponse = { model?: string; answers?: Record<string, Answer>; usage?: unknown }

const KINDS = new Set<Kind>(['procedure', 'fact', 'correction', 'gotcha', 'tradeoff', 'none'])
const NOVELTIES = new Set<Novelty>(['new', 'update', 'duplicate'])

export class JevClassifier implements Classifier {
  readonly name: string
  private baseUrl: string
  private apiKey: string
  private model: string
  private fetchFn: typeof fetch
  private timeoutMs: number

  constructor(opts: JevOptions = {}) {
    this.name = opts.name ?? 'jev'
    this.baseUrl = (opts.baseUrl ?? process.env.SKILLMINE_CLASSIFIER_BASE_URL ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/$/, '')
    this.apiKey = opts.apiKey ?? process.env.SKILLMINE_CLASSIFIER_API_KEY ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? ''
    this.model = opts.model ?? process.env.SKILLMINE_CLASSIFIER_MODEL ?? 'jev-latest'
    this.fetchFn = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  async classify(input: ClassifyInput): Promise<Verdict> {
    const body = buildJevRequest(input, this.model)
    const res = await this.fetchFn(`${this.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`${this.name} classify failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    const json = (await res.json()) as JevResponse
    return interpretAnswers(json.answers ?? {}, this.name)
  }
}

export function interpretAnswers(answers: Record<string, Answer>, backend: string): Verdict {
  const k = answers.knowledge
  const knowledge = k && k.type === 'noul' ? clamp(k.noul) : 0
  const kindAns = answers.kind
  const kind: Kind = kindAns && kindAns.type === 'choice' && KINDS.has(kindAns.choice as Kind) ? (kindAns.choice as Kind) : 'none'
  const novAns = answers.novelty
  const novelty: Novelty = novAns && novAns.type === 'choice' && NOVELTIES.has(novAns.choice as Novelty) ? (novAns.choice as Novelty) : 'new'
  const tgtAns = answers.target
  const target = tgtAns && tgtAns.type === 'choice' && tgtAns.choice !== 'none' ? tgtAns.choice : undefined
  const confs = [kindAns, novAns, tgtAns].filter((a): a is Extract<Answer, { type: 'choice' }> => !!a && a.type === 'choice').map((a) => a.confidence ?? 0)
  const confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0
  return { knowledge, kind, novelty, target, topics: [], confidence, backend }
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
}
