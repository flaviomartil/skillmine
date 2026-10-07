import { readFile } from 'node:fs/promises'
import type { Embedder } from './embed/types.ts'
import type { Classifier, Verdict } from './classify/types.ts'
import { passes } from './classify/types.ts'
import { discoverSkills, embedCatalog, matchCatalog, type Skill, type CatalogMatch } from './catalog.ts'
import type { PlanInput, Scope } from './plan/types.ts'
import { Store, sha256 } from './apply/store.ts'

export type PlanInputParts = {
  digest: string
  verdict?: Verdict
  scope: Scope
  project: string
  matches: CatalogMatch[]
  sources: string[]
  skills: Map<string, Skill>
  recent: string[]
  expectedSha: Map<string, string>
}

export async function planInputFor(p: PlanInputParts): Promise<PlanInput> {
  const targetName = p.verdict?.target ?? p.matches[0]?.name
  let target: PlanInput['target']
  if (targetName) {
    const s = p.skills.get(targetName)
    if (s) {
      const text = await readFile(s.realpath, 'utf8')
      const sha = sha256(text)
      p.expectedSha.set(s.name, sha)
      target = { name: s.name, description: s.description, body: s.body, sha, createdBy: s.createdBy, scope: s.scope }
    }
  }
  return {
    digest: p.digest,
    verdict: p.verdict,
    scope: p.scope,
    project: p.project,
    catalog: p.matches.map((m) => ({ name: m.name, description: m.description })),
    target,
    recent: p.recent,
    sources: p.sources,
  }
}

export type PrepareOptions = {
  project: string
  sources?: string[]
  classifier?: Classifier
  embedder?: Embedder
  store?: Store
  home?: string
}

export type Prepared = {
  verdict?: Verdict
  passed: boolean
  input: PlanInput
  expected: Record<string, string>
}

export async function prepare(digest: string, opts: PrepareOptions): Promise<Prepared> {
  const skillsList = await discoverSkills({ home: opts.home, project: opts.project || undefined })
  const skills = new Map(skillsList.map((s) => [s.name, s]))
  let matches: CatalogMatch[] = []
  if (opts.embedder && skillsList.length) {
    const catalog = await embedCatalog(skillsList, opts.embedder)
    const [vec] = await opts.embedder.embed([digest.slice(0, 1500)])
    if (vec) matches = matchCatalog(vec, catalog)
  }
  let verdict: Verdict | undefined
  if (opts.classifier) verdict = await opts.classifier.classify({ digest, catalog: matches.map((m) => ({ name: m.name, description: m.description })) })
  const recent = opts.store ? await opts.store.recentSummaries(20) : []
  const expectedSha = new Map<string, string>()
  const input = await planInputFor({ digest, verdict, scope: 'local', project: opts.project, matches, sources: opts.sources ?? [], skills, recent, expectedSha })
  return { verdict, passed: verdict ? passes(verdict) : true, input, expected: Object.fromEntries(expectedSha) }
}
