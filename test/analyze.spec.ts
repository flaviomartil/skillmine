import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Window, Turn } from '../src/types.ts'
import type { Embedder } from '../src/embed/types.ts'
import type { Classifier, ClassifyInput, Verdict } from '../src/classify/types.ts'
import { discoverSkills, parseFrontmatter, matchCatalog, embedCatalog } from '../src/catalog.ts'
import { clusterWindows, lessonText, clusterDigest, classifyDigest } from '../src/cluster.ts'
import { analyze } from '../src/analyze.ts'

class TopicEmbedder implements Embedder {
  readonly model = 'topic'
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const l = t.toLowerCase()
      return Float32Array.from([l.includes('redis') ? 1 : 0, l.includes('postgres') ? 1 : 0, l.includes('docker') ? 1 : 0, 0.01])
    })
  }
}

function win(id: string, text: string, project = '/p', signals: Window['signals'] = ['correction']): Window {
  const turns: Turn[] = [
    { ref: `claude:s:${id}u`, client: 'claude', session: 's', project, ts: 1, role: 'user', text: `no, ${text}`, tools: [], sidechain: false },
    { ref: `claude:s:${id}a`, client: 'claude', session: 's', project, ts: 2, role: 'assistant', text: `Right. ${text} is the point here and it matters because of the lock.`, tools: [], sidechain: false },
  ]
  return { id, client: 'claude', session: 's', project, turns, digest: turns.map((t) => `${t.role}: ${t.text}`).join('\n'), signals, start: 1, end: 2 }
}

let home: string
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'skillmine-cat-'))
  const agents = join(home, '.agents', 'skills')
  const claude = join(home, '.claude', 'skills')
  await mkdir(join(agents, 'redis-locks'), { recursive: true })
  await mkdir(claude, { recursive: true })
  await writeFile(join(agents, 'redis-locks', 'SKILL.md'), '---\nname: redis-locks\ndescription: "Locking with redis."\ncreated_by: skillmine\n---\n\nUse SET NX with a TTL on redis.\n')
  await symlink(join(agents, 'redis-locks'), join(claude, 'redis-locks'))
  await mkdir(join(claude, 'docker-tips'), { recursive: true })
  await writeFile(join(claude, 'docker-tips', 'SKILL.md'), '---\nname: docker-tips\ndescription: Docker compose pitfalls.\n---\nPorts collide with docker.\n')
  await symlink(join(home, 'missing'), join(claude, 'broken'))
})
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('catalog', () => {
  test('parseFrontmatter', () => {
    const { fields, body } = parseFrontmatter('---\nname: x\ndescription: "y z"\n---\nbody')
    expect(fields).toEqual({ name: 'x', description: 'y z' })
    expect(body).toBe('body')
    expect(parseFrontmatter('plain').fields).toEqual({})
  })
  test('dedupes symlinked skills by realpath and skips broken links', async () => {
    const skills = await discoverSkills({ home })
    expect(skills.map((s) => s.name).sort()).toEqual(['docker-tips', 'redis-locks'])
    expect(skills.find((s) => s.name === 'redis-locks')!.createdBy).toBe('skillmine')
  })
  test('matchCatalog ranks by best chunk similarity', async () => {
    const skills = await discoverSkills({ home })
    const cat = await embedCatalog(skills, new TopicEmbedder())
    const [m] = matchCatalog(Float32Array.from([1, 0, 0, 0]), cat, 2)
    expect(m!.name).toBe('redis-locks')
    expect(m!.sim).toBeGreaterThan(0.9)
  })
})

describe('cluster', () => {
  test('collapses near-identical windows and tracks projects', async () => {
    const windows = [win('a', 'redis lock', '/p1'), win('b', 'redis lock again', '/p2'), win('c', 'postgres index', '/p1')]
    const vecs = await new TopicEmbedder().embed(windows.map((w) => lessonText(w)))
    const clusters = clusterWindows(windows, vecs, 0.9)
    expect(clusters).toHaveLength(2)
    const redis = clusters.find((c) => c.members.length === 2)!
    expect(redis.projects.sort()).toEqual(['/p1', '/p2'])
    expect(clusterDigest(redis)).toContain('another session')
  })
  test('classifyDigest keeps texts, summarizes tools and notes cluster size', () => {
    const w = win('a', 'redis lock', '/p1')
    w.turns[1]!.tools = [{ name: 'Bash', arg: 'pnpm test', failed: true }, { name: 'Bash', arg: 'pnpm test' }]
    const c = { id: 'a', rep: w, members: [w, win('b', 'redis lock again', '/p2')], matches: [], projects: ['/p1', '/p2'] }
    const d = classifyDigest(c)
    expect(d).toContain('user: no, redis lock')
    expect(d).toContain('[tools that failed: Bash(pnpm test); later succeeded: Bash(pnpm test)]')
    expect(d).toContain('[seen in 2 similar windows across 2 project(s)]')
    expect(d).not.toContain('[tools:')
  })
  test('without vectors every window is its own cluster', () => {
    expect(clusterWindows([win('a', 'x'), win('b', 'y')])).toHaveLength(2)
  })
})

describe('analyze', () => {
  test('embeds, clusters, matches catalog and respects maxCalls', async () => {
    const seen: ClassifyInput[] = []
    const classifier: Classifier = {
      name: 'fake',
      async classify(input) {
        seen.push(input)
        const v: Verdict = { knowledge: 0.9, kind: 'gotcha', novelty: input.catalog.length ? 'update' : 'new', target: input.catalog[0]?.name, topics: [], confidence: 1, backend: 'fake' }
        return v
      },
    }
    const windows = [win('a', 'redis lock', '/p1'), win('b', 'redis lock again', '/p2'), win('c', 'postgres index', '/p1'), win('d', 'docker ports', '/p1')]
    const a = await analyze(windows, { embedder: new TopicEmbedder(), classifier, home, maxCalls: 2 })
    expect(a.stats.windows).toBe(4)
    expect(a.stats.clusters).toBe(3)
    expect(a.stats.calls).toBe(2)
    expect(a.stats.passed).toBe(2)
    const redis = a.clusters.find((c) => c.members.length === 2)!
    expect(redis.matches[0]!.name).toBe('redis-locks')
    expect(a.verdicts.get(redis.id)!.target).toBe('redis-locks')
    expect(seen[0]!.digest).toContain('[seen in 2 similar windows')
  })
  test('works with no embedder and no classifier', async () => {
    const a = await analyze([win('a', 'x')], { home })
    expect(a.stats.clusters).toBe(1)
    expect(a.stats.calls).toBe(0)
  })
})
