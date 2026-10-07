import { describe, expect, test } from 'bun:test'
import { buildJevRequest, haikuPrompt } from '../src/classify/questions.ts'
import { JevClassifier, interpretAnswers } from '../src/classify/jev.ts'
import { HaikuClassifier, parseHaikuOutput } from '../src/classify/haiku.ts'
import { passes } from '../src/classify/types.ts'

const input = { digest: 'user: no, the lock is in redis\nassistant: Right, BullMQ owns it.', catalog: [{ name: 'redis-locks', description: 'Locking patterns with Redis.' }] }

describe('jev request', () => {
  test('asks knowledge, kind, novelty and target when a catalog exists', () => {
    const req = buildJevRequest(input)
    expect(Object.keys(req.questions)).toEqual(['knowledge', 'kind', 'novelty', 'target'])
    expect(req.questions.knowledge!.type).toBe('noul')
    const target = req.questions.target!
    expect(target.type === 'choice' && Object.keys(target.criteria)).toEqual(['redis-locks', 'none'])
    expect(req.state.window).toBe(input.digest)
  })
  test('skips novelty and target without a catalog', () => {
    const req = buildJevRequest({ digest: 'x', catalog: [] })
    expect(Object.keys(req.questions)).toEqual(['knowledge', 'kind'])
  })
})

describe('jev classifier', () => {
  test('sends bearer auth and interprets answers', async () => {
    let captured: { url: string; auth: string | undefined; body: unknown } | undefined
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      captured = { url, auth: (init?.headers as Record<string, string>).authorization, body: JSON.parse(String(init?.body)) }
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            knowledge: { type: 'noul', noul: 0.81 },
            kind: { type: 'choice', choice: 'correction', confidence: 0.9 },
            novelty: { type: 'choice', choice: 'update', confidence: 0.7 },
            target: { type: 'choice', choice: 'redis-locks', confidence: 0.8 },
          },
        }),
      )
    }) as unknown as typeof fetch
    const c = new JevClassifier({ fetch: fakeFetch, apiKey: 'k', baseUrl: 'http://laya.local/' })
    const v = await c.classify(input)
    expect(captured!.url).toBe('http://laya.local/v1/systemone')
    expect(captured!.auth).toBe('Bearer k')
    expect(v).toMatchObject({ knowledge: 0.81, kind: 'correction', novelty: 'update', target: 'redis-locks', backend: 'jev' })
    expect(v.confidence).toBeCloseTo(0.8)
    expect(passes(v)).toBe(true)
  })
  test('interpretAnswers tolerates missing or unknown answers', () => {
    const v = interpretAnswers({ knowledge: { type: 'noul', noul: 0.2 }, kind: { type: 'choice', choice: 'weird' } }, 'laya')
    expect(v).toMatchObject({ knowledge: 0.2, kind: 'none', novelty: 'new', backend: 'laya' })
    expect(v.target).toBeUndefined()
    expect(passes(v)).toBe(false)
  })
  test('surfaces HTTP errors', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(new JevClassifier({ fetch: fakeFetch }).classify(input)).rejects.toThrow('HTTP 401')
  })
})

describe('haiku classifier', () => {
  test('prompt lists skills and window', () => {
    const p = haikuPrompt(input)
    expect(p).toContain('- redis-locks: Locking patterns with Redis.')
    expect(p).toContain('<window>')
  })
  test('parses claude -p json envelope with fenced result', () => {
    const stdout = JSON.stringify({ type: 'result', result: '```json\n{"knowledge":0.7,"kind":"gotcha","novelty":"new","target":null,"topics":["redis","bullmq"]}\n```' })
    const v = parseHaikuOutput(stdout)
    expect(v).toMatchObject({ knowledge: 0.7, kind: 'gotcha', novelty: 'new', topics: ['redis', 'bullmq'], backend: 'haiku' })
    expect(v.target).toBeUndefined()
  })
  test('parses bare json and rejects garbage', () => {
    expect(parseHaikuOutput('{"knowledge":1,"kind":"fact","novelty":"duplicate"}').novelty).toBe('duplicate')
    expect(() => parseHaikuOutput('no json here')).toThrow()
  })
  test('runs the configured command', async () => {
    const c = new HaikuClassifier({
      command: ['fake'],
      cwd: '/tmp',
      runner: async (argv, stdin) => ({ exitCode: 0, stdout: JSON.stringify({ result: `{"knowledge":0.9,"kind":"procedure","novelty":"new","topics":[]}` }), stderr: argv[0]! + stdin.length }),
    })
    const v = await c.classify(input)
    expect(v.kind).toBe('procedure')
  })
})

describe('passes', () => {
  test('duplicate fails unless it is a correction', () => {
    const base = { knowledge: 0.9, topics: [], confidence: 1, backend: 'x' as const }
    expect(passes({ ...base, kind: 'fact', novelty: 'duplicate' })).toBe(false)
    expect(passes({ ...base, kind: 'correction', novelty: 'duplicate' })).toBe(true)
    expect(passes({ ...base, kind: 'fact', novelty: 'new', knowledge: 0.5 })).toBe(false)
  })
})
