import type { Window } from './types.ts'
import type { Embedder } from './embed/types.ts'
import type { Classifier, Verdict } from './classify/types.ts'
import { passes } from './classify/types.ts'
import { discoverSkills, embedCatalog, matchCatalog, type SkillVec, type Skill } from './catalog.ts'
import { clusterWindows, embedWindows, classifyDigest, DEFAULT_SIM, type Cluster } from './cluster.ts'
import { windowScore } from './windows.ts'

export type AnalyzeOptions = {
  embedder?: Embedder
  classifier?: Classifier
  skills?: Skill[]
  home?: string
  project?: string
  similarity?: number
  maxCalls?: number
  concurrency?: number
  onPhase?: (phase: string, done: number, total: number) => void
}

export type Analysis = {
  clusters: Cluster[]
  verdicts: Map<string, Verdict>
  errors: { cluster: string; error: string }[]
  stats: {
    windows: number
    clusters: number
    skills: number
    calls: number
    passed: number
    byKind: Record<string, number>
    byNovelty: Record<string, number>
  }
}

export async function analyze(windows: Window[], opts: AnalyzeOptions): Promise<Analysis> {
  const sim = opts.similarity ?? DEFAULT_SIM
  let catalog: SkillVec[] = []
  let vecs: Float32Array[] | undefined
  const skills = opts.skills ?? (await discoverSkills({ home: opts.home, project: opts.project }))
  if (opts.embedder) {
    catalog = await embedCatalog(skills, opts.embedder, (d, t) => opts.onPhase?.('embedding skills', d, t))
    vecs = await embedWindows(windows, opts.embedder, 64, (d, t) => opts.onPhase?.('embedding windows', d, t))
  }
  const clusters = clusterWindows(windows, vecs, sim)
  if (vecs) for (const c of clusters) if (c.vec) c.matches = matchCatalog(c.vec, catalog)

  const verdicts = new Map<string, Verdict>()
  const errors: { cluster: string; error: string }[] = []
  const byKind: Record<string, number> = {}
  const byNovelty: Record<string, number> = {}
  let calls = 0
  let passed = 0
  if (opts.classifier) {
    const limit = opts.maxCalls ?? Infinity
    const ranked = [...clusters].sort((a, b) => windowScore(b.rep.signals) - windowScore(a.rep.signals) || b.members.length - a.members.length || b.rep.end - a.rep.end)
    const todo = ranked.slice(0, Math.min(limit, ranked.length))
    const queue = [...todo]
    let done = 0
    const worker = async () => {
      for (;;) {
        const c = queue.shift()
        if (!c) return
        try {
          const v = await opts.classifier!.classify({ digest: classifyDigest(c), catalog: c.matches.map((m) => ({ name: m.name, description: m.description })) })
          verdicts.set(c.id, v)
          byKind[v.kind] = (byKind[v.kind] ?? 0) + 1
          byNovelty[v.novelty] = (byNovelty[v.novelty] ?? 0) + 1
          if (passes(v)) passed++
        } catch (e) {
          errors.push({ cluster: c.id, error: e instanceof Error ? e.message : String(e) })
        } finally {
          calls++
          done++
          opts.onPhase?.('classifying', done, todo.length)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, todo.length || 1) }, worker))
  }
  return {
    clusters,
    verdicts,
    errors,
    stats: { windows: windows.length, clusters: clusters.length, skills: skills.length, calls, passed, byKind, byNovelty },
  }
}
