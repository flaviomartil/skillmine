import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Turn, Reader, SessionRef } from '../src/types.ts'
import type { Classifier, Verdict } from '../src/classify/types.ts'
import type { Planner, PlanOutput } from '../src/plan/types.ts'
import { gate, matchesSession, freshDigest, readGateState } from '../src/gate.ts'
import { Store } from '../src/apply/store.ts'
import { defaultLayout } from '../src/apply/paths.ts'

function turn(role: 'user' | 'assistant', text: string, extra: Partial<Turn> = {}): Turn {
  return { ref: `codex:s1:${Math.random().toString(36).slice(2)}`, client: 'codex', session: 's1', project: '/p', ts: 1, role, text, tools: [], sidechain: false, ...extra }
}

const long = (s: string) => s.repeat(12)

describe('matchesSession', () => {
  const ref: SessionRef = { client: 'codex', id: 'rollout-2026-10-07T05-14-54-01a1156e-0754-7f52-8c7a-724eb94e4923', path: '/x/rollout-2026-10-07T05-14-54-01a1156e-0754-7f52-8c7a-724eb94e4923.jsonl', project: '', mtime: 0 }
  test('matches the thread uuid inside a codex rollout name', () => {
    expect(matchesSession(ref, '01a1156e-0754-7f52-8c7a-724eb94e4923')).toBe(true)
    expect(matchesSession(ref, 'deadbeef')).toBe(false)
  })
})

describe('freshDigest', () => {
  test('skips sidechains and trims from the front', () => {
    const d = freshDigest([turn('user', 'a'), turn('assistant', 'side', { sidechain: true }), turn('assistant', 'b')], 0, 40)
    expect(d).not.toContain('side')
    expect(d.length).toBeLessThanOrEqual(40)
  })
})

describe('gate', () => {
  let home: string
  let store: Store
  let turns: Turn[]
  let planned: number
  let classified: number
  const reader = (): Reader => ({
    client: 'codex',
    discover: async () => [{ client: 'codex', id: 'rollout-x-abc', path: '/x/rollout-x-abc.jsonl', project: join(home, 'proj'), mtime: Date.now() }],
    read: async () => turns,
  })
  const classifier = (knowledge: number): Classifier => ({
    name: 'fake',
    classify: async () => {
      classified++
      return { knowledge, kind: 'gotcha', novelty: 'new', topics: ['x'] } as Verdict
    },
  })
  const planner = (edits: PlanOutput['edits']): Planner => ({
    name: 'fake',
    plan: async () => {
      planned++
      return { summary: 'learned', edits }
    },
  })
  const edit = { action: 'create' as const, kind: 'skill' as const, name: 'codex-gate-lesson', scope: 'local' as const, description: 'Lesson learned through the gate.', reason: 'r', sources: [], content: '# Lesson\n\nWhen the gate runs, write the lesson here with enough body to pass validation.' }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'skillmine-gate-'))
    await mkdir(join(home, 'proj'), { recursive: true })
    store = new Store(join(home, '.skillmine'))
    turns = [turn('user', long('how do redis locks expire? ')), turn('assistant', long('the TTL is set with PX and renewed by a watchdog. '))]
    planned = 0
    classified = 0
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const run = (over: Partial<Parameters<typeof gate>[0]> = {}) =>
    gate({ client: 'codex', session: 'abc', project: join(home, 'proj'), readers: { codex: reader() }, store, layout: defaultLayout(home), home, every: 3, cooldownMs: 1000, classifier: classifier(0.9), planner: planner([edit]), now: 10_000, ...over })

  test('only the every-Nth stop reaches the classifier', async () => {
    expect((await run()).status).toBe('skipped')
    expect((await run()).status).toBe('skipped')
    const third = await run()
    expect(third.status).toBe('applied')
    expect(third.stops).toBe(3)
    expect(classified).toBe(1)
    expect(planned).toBe(1)
    await readFile(join(home, 'proj', '.agents', 'skills', 'codex-gate-lesson', 'SKILL.md'), 'utf8')
  })

  test('rejected verdict never plans, and fresh turns are not re-gated', async () => {
    const r = await run({ force: true, classifier: classifier(0.1) })
    expect(r.status).toBe('rejected')
    expect(planned).toBe(0)
    const again = await run({ force: true })
    expect(again.status).toBe('empty')
    expect(again.freshTurns).toBe(0)
    turns = [...turns, turn('user', long('new question about postgres vacuum ')), turn('assistant', long('autovacuum thresholds are per table. '))]
    const third = await run({ force: true })
    expect(third.freshTurns).toBe(2)
    expect(third.status).toBe('applied')
  })

  test('cooldown blocks a second plan', async () => {
    expect((await run({ every: 1 })).status).toBe('applied')
    turns = [...turns, turn('user', long('another lesson about docker networks ')), turn('assistant', long('bridge networks isolate by default. '))]
    const r = await run({ every: 1, now: 10_500 })
    expect(r.status).toBe('cooldown')
    const later = await run({ every: 1, now: 20_000, planner: planner([{ ...edit, name: 'docker-gate-lesson' }]) })
    expect(later.status).toBe('applied')
  })

  test('unknown session is reported, state still counts the stop', async () => {
    const r = await run({ force: true, session: 'nope' })
    expect(r.status).toBe('not-found')
    const state = await readGateState(join(store.root, 'gate', 'codex-nope.json'))
    expect(state.stops).toBe(1)
  })
})
