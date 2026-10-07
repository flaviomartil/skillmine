import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Window, Turn } from '../src/types.ts'
import type { Analysis } from '../src/analyze.ts'
import type { Planner, PlanInput } from '../src/plan/types.ts'
import type { Cluster } from '../src/cluster.ts'
import { Store } from '../src/apply/store.ts'
import { defaultLayout } from '../src/apply/paths.ts'
import { runPlans, scopeFor, sourcesFor } from '../src/run.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'skillmine-run-'))
  await mkdir(join(home, '.agents', 'skills', 'redis-locks'), { recursive: true })
  await writeFile(join(home, '.agents', 'skills', 'redis-locks', 'SKILL.md'), '---\nname: redis-locks\ndescription: Locks with redis.\ncreated_by: skillmine\n---\n# redis\nUse SET NX.\n')
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function win(id: string, project: string, text: string): Window {
  const turns: Turn[] = [
    { ref: `claude:${id}:u`, client: 'claude', session: id, project, ts: 1, role: 'user', text: `no, ${text}`, tools: [], sidechain: false },
    { ref: `claude:${id}:a`, client: 'claude', session: id, project, ts: 2, role: 'assistant', text: `Right, ${text}.`, tools: [], sidechain: false },
  ]
  return { id, client: 'claude', session: id, project, turns, digest: turns.map((t) => `${t.role}: ${t.text}`).join('\n'), signals: ['correction'], start: 1, end: 2 }
}

function cluster(rep: Window, members: Window[] = [rep], target?: string): Cluster {
  return { id: rep.id, rep, members, matches: target ? [{ name: target, description: 'Locks with redis.', sim: 0.9, scope: 'global' }] : [], projects: [...new Set(members.map((m) => m.project))] }
}

describe('scope and sources', () => {
  test('two real projects make the lesson global; tmp paths do not count', () => {
    const a = win('a', '/p1', 'x')
    const b = win('b', '/p2', 'x')
    const t = win('t', '/tmp/bridge', 'x')
    expect(scopeFor(cluster(a, [a, b]))).toBe('global')
    expect(scopeFor(cluster(a, [a, t]))).toBe('local')
    expect(sourcesFor(cluster(a, [a, b]))).toEqual(['claude:a:u', 'claude:b:u'])
  })
})

describe('runPlans', () => {
  test('plans passed clusters, applies edits, records target sha for read-before-write', async () => {
    const seen: PlanInput[] = []
    const planner: Planner = {
      name: 'fake',
      async plan(input) {
        seen.push(input)
        if (input.target) return { summary: 'patch redis', edits: [{ action: 'update', name: 'redis-locks', content: '# redis\nUse SET NX with a TTL.', reason: 'ttl matters', sources: input.sources }] }
        return { summary: 'new skill', edits: [{ action: 'create', kind: 'skill', name: 'docker-ports', scope: 'global', description: 'Port collisions in compose.', content: 'Check ports before up.', reason: 'r', sources: input.sources }] }
      },
    }
    const a = win('a', join(home, 'proj'), 'redis lock needs a ttl')
    const b = win('b', join(home, 'proj'), 'docker port collides')
    const c = win('c', join(home, 'proj'), 'ignored')
    const clusters = [cluster(a, [a], 'redis-locks'), cluster(b), cluster(c)]
    const analysis: Analysis = {
      clusters,
      verdicts: new Map([
        ['a', { knowledge: 0.9, kind: 'gotcha', novelty: 'update', target: 'redis-locks', topics: [], confidence: 1, backend: 'fake' }],
        ['b', { knowledge: 0.8, kind: 'procedure', novelty: 'new', topics: [], confidence: 1, backend: 'fake' }],
        ['c', { knowledge: 0.2, kind: 'none', novelty: 'new', topics: [], confidence: 1, backend: 'fake' }],
      ]),
      errors: [],
      stats: { windows: 3, clusters: 3, skills: 1, calls: 3, passed: 2, byKind: {}, byNovelty: {} },
    }
    const store = new Store(join(home, '.skillmine'))
    const res = await runPlans(analysis, { planner, store, layout: defaultLayout(home), home, project: join(home, 'proj') })
    expect(res.totals).toMatchObject({ clusters: 2, plannerCalls: 2, edits: 2, applied: 2, rejected: 0, errors: 0 })
    expect(seen.find((s) => s.target)!.target!.sha).toHaveLength(64)
    expect(await readFile(join(home, '.agents', 'skills', 'redis-locks', 'SKILL.md'), 'utf8')).toContain('with a TTL')
    const created = await readFile(join(home, 'proj', '.agents', 'skills', 'docker-ports', 'SKILL.md'), 'utf8')
    expect(created).toContain('scope: local')
    const ledger = await store.entries()
    expect(ledger.filter((e) => e.status === 'applied')).toHaveLength(2)
    expect(new Set(ledger.map((e) => e.run)).size).toBe(1)
  })

  test('planner errors are recorded without stopping the run', async () => {
    const planner: Planner = { name: 'bad', plan: async () => { throw new Error('quota') } }
    const a = win('a', '/p', 'x')
    const analysis: Analysis = { clusters: [cluster(a)], verdicts: new Map([['a', { knowledge: 0.9, kind: 'fact', novelty: 'new', topics: [], confidence: 1, backend: 'f' }]]), errors: [], stats: { windows: 1, clusters: 1, skills: 0, calls: 1, passed: 1, byKind: {}, byNovelty: {} } }
    const res = await runPlans(analysis, { planner, store: new Store(join(home, '.skillmine')), layout: defaultLayout(home), home })
    expect(res.totals.errors).toBe(1)
    expect(res.planned[0]!.error).toBe('quota')
  })
})
