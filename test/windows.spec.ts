import { describe, expect, test } from 'bun:test'
import type { Turn } from '../src/types.ts'
import { sliceSession, signalsOf, digestTurn, windowScore, MAX_DIGEST_CHARS } from '../src/windows.ts'

function turn(role: 'user' | 'assistant', text: string, extra: Partial<Turn> = {}): Turn {
  return {
    ref: `claude:s1:${Math.random().toString(36).slice(2)}`,
    client: 'claude',
    session: 's1',
    project: '/p',
    ts: 1,
    role,
    text,
    tools: [],
    sidechain: false,
    ...extra,
  }
}

describe('signalsOf', () => {
  test('detects a user correction', () => {
    expect(signalsOf([turn('user', 'No, use the other endpoint'), turn('assistant', 'Fixed.')])).toContain('correction')
    expect(signalsOf([turn('user', 'não, o certo é a tabela participantes'), turn('assistant', 'ok')])).toContain('correction')
  })

  test('detects fail then pass on the same tool', () => {
    const t = turn('assistant', 'retrying', {
      tools: [
        { name: 'Bash', arg: 'pnpm test', failed: true },
        { name: 'Bash', arg: 'pnpm test' },
      ],
    })
    expect(signalsOf([turn('user', 'run tests please'), t])).toContain('fail-then-pass')
  })

  test('explanation needs length and an explanatory marker', () => {
    const long = 'x'.repeat(700)
    expect(signalsOf([turn('assistant', long)])).not.toContain('explanation')
    expect(signalsOf([turn('assistant', long + ' This fails because the lock is held.')])).toContain('explanation')
  })

  test('decision marker', () => {
    expect(signalsOf([turn('assistant', 'I used a queue instead of a cron here, since the job must survive restarts and the worker already owns Redis.')])).toContain('decision')
  })
})

describe('sliceSession', () => {
  test('drops sidechains, execution-only and self-referential windows', () => {
    const turns = [
      turn('user', 'No, wrong file', { sidechain: true }),
      turn('assistant', 'ok', { sidechain: true }),
      turn('user', 'run'),
      turn('assistant', 'done'),
    ]
    expect(sliceSession(turns)).toHaveLength(0)
    const self = [turn('user', 'no, skillmine should not do that'), turn('assistant', 'Understood, because the ledger owns it. '.repeat(20))]
    expect(sliceSession(self)).toHaveLength(0)
  })

  test('keeps a window with a signal and builds the digest', () => {
    const turns = [turn('user', 'Actually the bug is in the reducer, not the view', { ts: 10 }), turn('assistant', 'You are right. '.repeat(10), { ts: 20 })]
    const [w] = sliceSession(turns)
    expect(w).toBeDefined()
    expect(w!.signals).toContain('correction')
    expect(w!.start).toBe(10)
    expect(w!.end).toBe(20)
    expect(w!.digest.split('\n')).toHaveLength(2)
  })

  test('splits long sessions by digest size', () => {
    const turns: Turn[] = []
    for (let i = 0; i < 40; i++) {
      turns.push(turn('user', `no, attempt ${i} is wrong`, { ts: i * 2 }))
      turns.push(turn('assistant', 'y'.repeat(900), { ts: i * 2 + 1 }))
    }
    const windows = sliceSession(turns)
    expect(windows.length).toBeGreaterThan(1)
    for (const w of windows) expect(w.digest.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS + 1300)
  })
})

describe('digest and score', () => {
  test('digest shows tools and failures', () => {
    const d = digestTurn(turn('assistant', 'hi', { tools: [{ name: 'Bash', arg: 'ls', failed: true }] }))
    expect(d).toBe('assistant: hi [tools: Bash(ls) FAILED]')
  })
  test('correction outweighs explanation', () => {
    expect(windowScore(['correction'])).toBeGreaterThan(windowScore(['explanation', 'decision']))
  })
})

describe('dropAutomated', () => {
  test('drops templated prompts repeated across many sessions', async () => {
    const { dropAutomated } = await import('../src/windows.ts')
    const mk = (session: string, text: string) => {
      const t = turn('user', text, { session })
      return { id: session, client: 'claude' as const, session, project: '/p', turns: [t, turn('assistant', 'ok', { session })], digest: '', signals: ['correction' as const], start: 1, end: 2 }
    }
    const windows = [
      ...Array.from({ length: 5 }, (_, i) => mk(`auto${i}`, 'Translate this README excerpt to English. Keep markdown structure and technical terms, keep code identifiers unchanged, no commentary. Excerpt: ' + i)),
      mk('human1', 'no, the lock is in redis'),
      mk('human2', 'no, the lock is in redis'),
    ]
    const { kept, dropped } = dropAutomated(windows, 5)
    expect(dropped).toBe(5)
    expect(kept.map((w) => w.session)).toEqual(['human1', 'human2'])
  })
})
