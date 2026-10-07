import { readFile } from 'node:fs/promises'
import type { Analysis } from './analyze.ts'
import type { Cluster } from './cluster.ts'
import { clusterDigest } from './cluster.ts'
import { passes, type Verdict } from './classify/types.ts'
import type { Planner, PlanInput, PlanOutput, Edit, Scope } from './plan/types.ts'
import { discoverSkills, type Skill } from './catalog.ts'
import { Store, sha256, type LedgerEntry } from './apply/store.ts'
import { applyEdits } from './apply/writer.ts'
import type { Layout } from './apply/paths.ts'

export type RunOptions = {
  planner: Planner
  store: Store
  layout?: Layout
  home?: string
  project?: string
  concurrency?: number
  allowHumanEdits?: boolean
  onPhase?: (phase: string, done: number, total: number) => void
}

export type PlannedCluster = {
  cluster: Cluster
  input: PlanInput
  plan?: PlanOutput
  applied: LedgerEntry[]
  rejected: LedgerEntry[]
  error?: string
}

export type RunResult = {
  run: string
  planned: PlannedCluster[]
  totals: { clusters: number; plannerCalls: number; edits: number; applied: number; rejected: number; errors: number }
}

export function scopeFor(c: Cluster): Scope {
  const real = new Set(c.projects.filter((p) => p && !p.startsWith('/tmp')))
  return real.size >= 2 ? 'global' : 'local'
}

export function projectFor(c: Cluster): string {
  return c.rep.project && !c.rep.project.startsWith('/tmp') ? c.rep.project : ''
}

export function sourcesFor(c: Cluster, max = 8): string[] {
  const refs: string[] = []
  for (const m of c.members) {
    const first = m.turns.find((t) => t.role === 'user') ?? m.turns[0]
    if (first) refs.push(first.ref)
    if (refs.length >= max) break
  }
  return refs
}

export async function buildPlanInput(c: Cluster, verdict: Verdict | undefined, skills: Map<string, Skill>, recent: string[], expectedSha: Map<string, string>): Promise<PlanInput> {
  const targetName = verdict?.target ?? c.matches[0]?.name
  let target: PlanInput['target']
  if (targetName) {
    const s = skills.get(targetName)
    if (s) {
      const text = await readFile(s.realpath, 'utf8')
      const sha = sha256(text)
      expectedSha.set(s.name, sha)
      target = { name: s.name, description: s.description, body: s.body, sha, createdBy: s.createdBy, scope: s.scope }
    }
  }
  return {
    digest: clusterDigest(c),
    verdict,
    scope: scopeFor(c),
    project: projectFor(c),
    catalog: c.matches.map((m) => ({ name: m.name, description: m.description })),
    target,
    recent,
    sources: sourcesFor(c),
  }
}

export async function runPlans(analysis: Analysis, opts: RunOptions): Promise<RunResult> {
  const run = opts.store.newId('run')
  const skillsList = await discoverSkills({ home: opts.home, project: opts.project })
  const skills = new Map(skillsList.map((s) => [s.name, s]))
  const recent = await opts.store.recentSummaries(20)
  const expectedSha = new Map<string, string>()
  const targets = analysis.clusters.filter((c) => {
    const v = analysis.verdicts.get(c.id)
    return v && passes(v)
  })
  const planned: PlannedCluster[] = []
  const queue = [...targets]
  let done = 0
  const worker = async () => {
    for (;;) {
      const c = queue.shift()
      if (!c) return
      const verdict = analysis.verdicts.get(c.id)
      const input = await buildPlanInput(c, verdict, skills, recent, expectedSha)
      const item: PlannedCluster = { cluster: c, input, applied: [], rejected: [] }
      try {
        item.plan = await opts.planner.plan(input)
      } catch (e) {
        item.error = e instanceof Error ? e.message : String(e)
      }
      planned.push(item)
      done++
      opts.onPhase?.('planning', done, targets.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 2, targets.length || 1) }, worker))

  let i = 0
  for (const item of planned) {
    i++
    if (!item.plan?.edits.length) continue
    const edits: Edit[] = item.plan.edits.map((e) => (e.action === 'create' ? { ...e, scope: item.input.scope } : e))
    const res = await applyEdits(edits, {
      store: opts.store,
      layout: opts.layout,
      project: item.input.project || opts.project || '',
      run,
      catalog: skillsList,
      expectedSha,
      allowHumanEdits: opts.allowHumanEdits,
    })
    item.applied = res.applied
    item.rejected = res.rejected
    for (const a of res.applied) {
      if (a.action === 'create') {
        const refreshed = await discoverSkills({ home: opts.home, project: opts.project })
        skillsList.splice(0, skillsList.length, ...refreshed)
        for (const s of refreshed) skills.set(s.name, s)
        break
      }
    }
    opts.onPhase?.('applying', i, planned.length)
  }
  const totals = {
    clusters: targets.length,
    plannerCalls: planned.filter((p) => p.plan || p.error).length,
    edits: planned.reduce((n, p) => n + (p.plan?.edits.length ?? 0), 0),
    applied: planned.reduce((n, p) => n + p.applied.length, 0),
    rejected: planned.reduce((n, p) => n + p.rejected.length, 0),
    errors: planned.filter((p) => p.error).length,
  }
  return { run, planned, totals }
}
