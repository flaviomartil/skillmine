import { describe, expect, test } from 'bun:test'
import { plannerPrompt, parsePlanOutput, extractObject } from '../src/plan/prompt.ts'
import { CommandPlanner, preset, PROMPT } from '../src/plan/command.ts'
import type { PlanInput } from '../src/plan/types.ts'

const input: PlanInput = {
  digest: 'user: no, use gh auth switch\nassistant: Right, gh supports several accounts.',
  scope: 'global',
  project: '',
  catalog: [{ name: 'github-cli', description: 'gh usage.' }],
  target: { name: 'github-cli', description: 'gh usage.', body: '# gh\nUse gh.', sha: 'abc', createdBy: 'skillmine', scope: 'global' },
  recent: ['update github-cli: added auth notes'],
  sources: ['claude:s1:u1'],
}

describe('planner prompt', () => {
  test('includes rules, target body, catalog, recent and sources', () => {
    const p = plannerPrompt(input)
    expect(p).toContain('Preference order')
    expect(p).toContain('created by skillmine, may be updated')
    expect(p).toContain('<skill>\n# gh\nUse gh.\n</skill>')
    expect(p).toContain('- github-cli: gh usage.')
    expect(p).toContain('update github-cli: added auth notes')
    expect(p).toContain('["claude:s1:u1"]')
    expect(p).toContain('seen in more than one project')
  })
  test('marks human skills as reference-only', () => {
    const p = plannerPrompt({ ...input, target: { ...input.target!, createdBy: undefined } })
    expect(p).toContain('you may only add_reference')
  })
})

describe('parsePlanOutput', () => {
  test('parses a claude -p envelope with fenced json', () => {
    const env = JSON.stringify({ type: 'result', result: 'Here you go:\n```json\n{"summary":"s","edits":[{"action":"update","name":"github-cli","content":"# gh\\nnew","reason":"r","sources":["a"]}]}\n```' })
    const out = parsePlanOutput(env)
    expect(out.summary).toBe('s')
    expect(out.edits).toEqual([{ action: 'update', name: 'github-cli', content: '# gh\nnew', reason: 'r', sources: ['a'] }])
  })
  test('normalizes create defaults and drops unknown actions', () => {
    const out = parsePlanOutput('{"edits":[{"action":"create","name":"x-y","description":"d","content":"c"},{"action":"delete","name":"z"},{"action":"archive","name":"old"}]}')
    expect(out.edits).toHaveLength(2)
    expect(out.edits[0]).toMatchObject({ action: 'create', kind: 'skill', scope: 'local', sources: [] })
    expect(out.edits[1]).toMatchObject({ action: 'archive', name: 'old' })
  })
  test('finds the edits object in surrounding text', () => {
    expect((extractObject('prefix {"a":1} then {"summary":"x","edits":[]} end') as { summary: string }).summary).toBe('x')
    expect(() => parsePlanOutput('nothing')).toThrow()
  })
})

describe('CommandPlanner', () => {
  test('substitutes the prompt into argv and parses output', async () => {
    let seen: { argv: string[]; stdin: string } | undefined
    const planner = new CommandPlanner({
      name: 't',
      argv: ['fake', PROMPT],
      cwd: '/tmp',
      runner: async (argv, stdin) => {
        seen = { argv, stdin }
        return { exitCode: 0, stdout: '{"summary":"ok","edits":[]}', stderr: '' }
      },
    })
    const out = await planner.plan(input)
    expect(out.summary).toBe('ok')
    expect(seen!.stdin).toBe('')
    expect(seen!.argv[1]).toContain('<window>')
  })
  test('uses stdin when argv has no placeholder and fails on non-zero exit', async () => {
    const planner = new CommandPlanner({ name: 't', argv: ['claude', '-p'], cwd: '/tmp', runner: async (_a, stdin) => ({ exitCode: 0, stdout: `{"edits":[]}`, stderr: String(stdin.length) }) })
    expect((await planner.plan(input)).edits).toEqual([])
    const failing = new CommandPlanner({ name: 't', argv: ['x'], cwd: '/tmp', runner: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) })
    await expect(failing.plan(input)).rejects.toThrow('boom')
  })
  test('presets', () => {
    expect(preset('claude', 'opus').argv).toEqual(['claude', '-p', '--model', 'opus', '--output-format', 'json'])
    expect(preset('codex').argv).toContain(PROMPT)
    expect(preset('agy').stdin).toBe(false)
  })
})
