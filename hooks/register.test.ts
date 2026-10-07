import { describe, expect, test } from 'claude-code/testing'

import type { Lesson } from '../types'
import { digestRows, rowText, verb } from './register'

const lesson: Lesson = {
  id: 'e_abc123',
  run: 'run_1',
  ts: 0,
  action: 'create',
  name: 'pnpm-workspace-gotchas',
  path: '/p/.agents/skills/pnpm-workspace-gotchas/SKILL.md',
  summary: 'Pitfalls when running scripts inside a pnpm monorepo',
  reason: 'the filter flag was misunderstood twice',
  body: '# pnpm\nRun filters from the root.',
  source: 'live',
}

describe('skillmine rows', () => {
  test('rowText carries the marker the render hook reads', async () => {
    const text = rowText(lesson)
    expect(text).toContain('🧠 Skillmine learned a new skill: pnpm-workspace-gotchas')
    expect(text).toContain('[skillmine:e_abc123]')
    expect(verb('update')).toBe('updated a skill')
    expect(verb('add_reference')).toBe('added a reference to')
  })

  test('digestRows keeps roles, tool names and failures, and trims from the front', async () => {
    const rows = [
      { role: 'user' as const, text: 'no, the lock is in redis', toolUses: [] },
      { role: 'assistant' as const, text: 'Checking.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'pnpm test' }, isError: true as const }] },
      { role: 'assistant' as const, text: 'x'.repeat(500), toolUses: [] },
    ]
    const d = digestRows(rows, 400)
    expect(d.length).toBeLessThanOrEqual(400)
    expect(d.endsWith('x')).toBe(true)
    const full = digestRows(rows)
    expect(full).toContain('user: no, the lock is in redis')
    expect(full).toContain('[tools: Bash(pnpm test) FAILED]')
  })
})
