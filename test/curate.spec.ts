import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Turn, Reader, SessionRef } from '../src/types.ts'
import { skillUsesIn, scanUsage, readUsage, recordUse, writeUsage, emptyUsage } from '../src/curate/usage.ts'
import { curate, verdictFor, DAY } from '../src/curate/index.ts'
import { Store } from '../src/apply/store.ts'
import { applyEdits } from '../src/apply/writer.ts'
import { defaultLayout } from '../src/apply/paths.ts'
import { discoverSkills } from '../src/catalog.ts'
import { installThinSkill } from '../src/install.ts'

function turn(role: 'user' | 'assistant', text: string, extra: Partial<Turn> = {}): Turn {
  return { ref: 'claude:s:1', client: 'claude', session: 's', project: '/p', ts: 1000, role, text, tools: [], sidechain: false, ...extra }
}

const names = new Set(['redis-locks', 'gh-accounts'])

describe('skillUsesIn', () => {
  test('Skill tool call by name', () => {
    expect(skillUsesIn(turn('assistant', '', { tools: [{ name: 'Skill', arg: 'redis-locks' }] }), names)).toEqual(['redis-locks'])
  })
  test('reading a SKILL.md path', () => {
    expect(skillUsesIn(turn('assistant', '', { tools: [{ name: 'Read', arg: '/home/x/.agents/skills/gh-accounts/SKILL.md' }] }), names)).toEqual(['gh-accounts'])
  })
  test('slash command in a user prompt', () => {
    expect(skillUsesIn(turn('user', '/redis-locks please'), names)).toEqual(['redis-locks'])
    expect(skillUsesIn(turn('user', 'talk about /redis-locks'), names)).toEqual([])
  })
  test('unknown skills are ignored', () => {
    expect(skillUsesIn(turn('assistant', '', { tools: [{ name: 'Skill', arg: 'other' }] }), names)).toEqual([])
  })
})

describe('scanUsage', () => {
  test('collects timestamps per skill', () => {
    const scan = scanUsage([turn('user', '/gh-accounts', { ts: 5 }), turn('assistant', '', { ts: 9, tools: [{ name: 'Skill', arg: 'gh-accounts' }] })], names)
    expect(scan.turns).toBe(2)
    expect(scan.uses.get('gh-accounts')).toEqual([5, 9])
  })
})

describe('verdictFor', () => {
  const skill = { name: 'x', description: '', path: '', realpath: '', scope: 'global' as const, body: '', createdBy: 'skillmine' }
  test('human skills are exempt', () => {
    expect(verdictFor({ ...skill, createdBy: undefined }, emptyUsage(0), 400, 14, 30)).toBe('human')
  })
  test('pinned beats idle', () => {
    expect(verdictFor(skill, { ...emptyUsage(0), pinned: true }, 400, 14, 30)).toBe('pinned')
  })
  test('thresholds', () => {
    expect(verdictFor(skill, emptyUsage(0), 3, 14, 30)).toBe('fresh')
    expect(verdictFor(skill, { ...emptyUsage(0), use_count: 2 }, 3, 14, 30)).toBe('active')
    expect(verdictFor(skill, emptyUsage(0), 14, 14, 30)).toBe('stale')
    expect(verdictFor(skill, emptyUsage(0), 30, 14, 30)).toBe('archive')
  })
})

describe('curate', () => {
  let home: string
  let store: Store
  const now = 100 * DAY

  async function seed(name: string, createdBy: string | undefined, ageDays: number, lastUsedDays?: number, pinned = false) {
    const dir = join(home, '.agents', 'skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n${createdBy ? `created_by: ${createdBy}\n` : ''}---\nbody\n`)
    const skill = { realpath: join(dir, 'SKILL.md') }
    await writeUsage(skill, { ...emptyUsage(now - ageDays * DAY), last_used_at: lastUsedDays === undefined ? null : now - lastUsedDays * DAY, use_count: lastUsedDays === undefined ? 0 : 1, pinned })
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'skillmine-curate-'))
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    store = new Store(join(home, '.skillmine'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test('dry run classifies without touching disk', async () => {
    await seed('old-unused', 'skillmine', 45)
    await seed('recent', 'skillmine', 3)
    await seed('used', 'skillmine', 45, 2)
    await seed('pinned-old', 'skillmine', 60, undefined, true)
    await seed('human', undefined, 400)
    const res = await curate({ store, home, dry: true, now })
    const v = Object.fromEntries(res.rows.map((r) => [r.skill.name, r.verdict]))
    expect(v).toEqual({ 'old-unused': 'archive', recent: 'fresh', used: 'active', 'pinned-old': 'pinned', human: 'human' })
    expect(res.archived).toEqual([])
    await lstat(join(home, '.agents', 'skills', 'old-unused', 'SKILL.md'))
  })

  test('archives idle mined skills through the ledger and undo restores them', async () => {
    await seed('old-unused', 'skillmine', 45)
    const res = await curate({ store, home, now, layout: defaultLayout(home) })
    expect(res.archived.map((a) => a.name)).toEqual(['old-unused'])
    await lstat(join(home, '.agents', 'skills', '.archive', 'old-unused', 'SKILL.md'))
    await expect(lstat(join(home, '.agents', 'skills', 'old-unused'))).rejects.toThrow()
    const { undo } = await import('../src/apply/undo.ts')
    const u = await undo(store, { run: res.run! })
    expect(u.undone.length).toBe(1)
    await lstat(join(home, '.agents', 'skills', 'old-unused', 'SKILL.md'))
  })

  test('batch scan records uses from session turns and resets idleness', async () => {
    await seed('old-unused', 'skillmine', 45)
    const ref: SessionRef = { client: 'codex', id: 's', path: '', project: '/p', mtime: now }
    const reader: Reader = {
      client: 'codex',
      discover: async () => [ref],
      read: async () => [turn('assistant', '', { client: 'codex', ts: now - DAY, tools: [{ name: 'Skill', arg: 'old-unused' }] })],
    }
    const res = await curate({ store, home, now, readers: { codex: reader } })
    expect(res.scanned.uses).toBe(1)
    expect(res.rows[0]!.verdict).toBe('active')
    const u = await readUsage({ realpath: join(home, '.agents', 'skills', 'old-unused', 'SKILL.md') })
    expect(u.use_count).toBe(1)
    expect(u.last_used_at).toBe(now - DAY)
    const again = await curate({ store, home, now, readers: { codex: reader } })
    expect(again.scanned.uses).toBe(0)
  })

  test('patches bump patch_count but not use_count', async () => {
    await seed('owned', 'skillmine', 1)
    const skills = await discoverSkills({ home })
    await applyEdits([{ action: 'add_reference', name: 'owned', file: 'note.md', content: '# note\n\nA reusable note about something.', reason: 'r', sources: [] }], { store, layout: defaultLayout(home), project: '', catalog: skills, backup: false })
    const u = await readUsage(skills[0]!)
    expect(u.patch_count).toBe(1)
    expect(u.use_count).toBe(0)
  })

  test('recordUse increments and stamps', async () => {
    await seed('owned', 'skillmine', 1)
    const skill = { realpath: join(home, '.agents', 'skills', 'owned', 'SKILL.md') }
    await recordUse(skill, 123)
    const u = await recordUse(skill, 456)
    expect(u.use_count).toBe(2)
    expect(u.last_used_at).toBe(456)
    expect(JSON.parse(await readFile(join(home, '.agents', 'skills', 'owned', '.usage.json'), 'utf8')).use_count).toBe(2)
  })
})

describe('installThinSkill', () => {
  test('links into existing client dirs and skips missing ones', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skillmine-install-'))
    const src = join(home, 'repo', 'clients', 'skillmine')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'SKILL.md'), '---\nname: skillmine\n---\n')
    await mkdir(join(home, '.codex', 'skills'), { recursive: true })
    const res = await installThinSkill({ from: src, targets: [join(home, '.codex', 'skills'), join(home, '.kimi', 'skills')] })
    expect(res.linked).toEqual([join(home, '.codex', 'skills', 'skillmine')])
    expect(res.skipped.map((s) => s.reason)).toEqual(['client not installed'])
    const again = await installThinSkill({ from: src, targets: [join(home, '.codex', 'skills')] })
    expect(again.linked.length).toBe(1)
    await rm(home, { recursive: true, force: true })
  })
})
