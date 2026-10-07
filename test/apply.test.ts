import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateEdit } from '../src/apply/validate.ts'
import { Store, sha256 } from '../src/apply/store.ts'
import { applyEdits, renderSkill } from '../src/apply/writer.ts'
import { undo } from '../src/apply/undo.ts'
import { discoverSkills, type Skill } from '../src/catalog.ts'
import { defaultLayout } from '../src/apply/paths.ts'
import type { Edit } from '../src/plan/types.ts'

let home: string
let project: string
let store: Store
const layout = () => defaultLayout(home)

async function seedSkill(dir: string, name: string, frontmatter: string, body: string) {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n${frontmatter}\n---\n${body}\n`)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'skillmine-apply-'))
  project = join(home, 'proj')
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await mkdir(join(home, '.codex', 'skills'), { recursive: true })
  await mkdir(project, { recursive: true })
  await seedSkill(join(home, '.agents', 'skills'), 'mine-owned', 'description: Owned by skillmine.\ncreated_by: skillmine\nscope: global', '# owned\nold body')
  await seedSkill(join(home, '.agents', 'skills'), 'human-skill', 'description: Written by a human.', '# human\nkeep me')
  store = new Store(join(home, '.skillmine'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function catalogMap(): Promise<Map<string, Skill>> {
  const skills = await discoverSkills({ home, project })
  return new Map(skills.map((s) => [s.name, s]))
}

describe('validateEdit', () => {
  const base = { reason: 'because', sources: ['claude:s:1'] }
  test('rejects bad names, ticket names, secrets and log content', async () => {
    const cat = await catalogMap()
    expect(validateEdit({ action: 'create', kind: 'skill', name: 'Bad Name', scope: 'local', description: 'd', content: 'c', ...base }, cat).ok).toBe(false)
    expect(validateEdit({ action: 'create', kind: 'skill', name: 'fix-1234', scope: 'local', description: 'd', content: 'c', ...base }, cat).ok).toBe(false)
    const secret = validateEdit({ action: 'create', kind: 'skill', name: 'tokens', scope: 'local', description: 'd', content: 'use token=abcdefghijklmnop123456', ...base }, cat)
    expect(secret.ok).toBe(false)
    expect(!secret.ok && secret.reason).toContain('secret')
    const log = validateEdit({ action: 'create', kind: 'skill', name: 'logs', scope: 'local', description: 'd', content: 'On 2026-10-07 we fixed PR #123', ...base }, cat)
    expect(!log.ok && log.reason).toContain('lessons, not logs')
    expect(validateEdit({ action: 'create', kind: 'skill', name: 'mine-owned', scope: 'local', description: 'd', content: 'c', ...base }, cat).ok).toBe(false)
  })
  test('downgrades updates of human skills to add_reference and allows owned updates', async () => {
    const cat = await catalogMap()
    const human = validateEdit({ action: 'update', name: 'human-skill', content: 'new body', ...base }, cat)
    expect(human.ok && human.edit.action).toBe('add_reference')
    expect(human.ok && human.edit.action === 'add_reference' && human.edit.file).toBe('skillmine-because.md')
    const owned = validateEdit({ action: 'update', name: 'mine-owned', content: 'new body', ...base }, cat)
    expect(owned.ok && owned.edit.action).toBe('update')
    expect(validateEdit({ action: 'archive', name: 'human-skill', ...base }, cat).ok).toBe(false)
    expect(validateEdit({ action: 'archive', name: 'human-skill', ...base }, cat, { allowHumanEdits: true }).ok).toBe(true)
    expect(validateEdit({ action: 'update', name: 'missing', content: 'x', ...base }, cat).ok).toBe(false)
  })
})

describe('renderSkill', () => {
  test('quotes risky values and renders lists', () => {
    const out = renderSkill({ name: 'a', description: 'Has: colon', sources: ['x:y:z'], empty: [] }, 'body')
    expect(out).toBe('---\nname: a\ndescription: "Has: colon"\nsources:\n  - x:y:z\n---\n\nbody\n')
  })
})

describe('applyEdits and undo', () => {
  const base = { reason: 'learned it', sources: ['claude:s:u1'] }

  test('create writes a local skill with provenance, fans out a symlink, and undo removes it', async () => {
    const edits: Edit[] = [{ action: 'create', kind: 'skill', name: 'pnpm-workspace-gotchas', scope: 'local', description: 'Pitfalls in pnpm monorepos.', content: '# pnpm\nRun filters from the workspace root.', ...base }]
    const res = await applyEdits(edits, { store, layout: layout(), project, backup: false })
    expect(res.rejected).toEqual([])
    expect(res.applied).toHaveLength(1)
    const path = join(project, '.agents', 'skills', 'pnpm-workspace-gotchas', 'SKILL.md')
    const text = await readFile(path, 'utf8')
    expect(text).toContain('created_by: skillmine')
    expect(text).toContain('scope: local')
    expect(text).toContain('  - claude:s:u1')
    expect(text).toContain('Run filters from the workspace root.')
    const link = join(project, '.claude', 'skills', 'pnpm-workspace-gotchas')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(join(project, '.agents', 'skills', 'pnpm-workspace-gotchas'))
    expect(res.applied[0]!.after).toBe(sha256(text))

    const u = await undo(store, { last: true })
    expect(u.undone).toHaveLength(1)
    await expect(lstat(path)).rejects.toThrow()
    await expect(lstat(link)).rejects.toThrow()
    const entries = await store.entries()
    expect(entries.at(-1)!.status).toBe('rolled_back')
    expect(entries.at(-1)!.rollbackOf).toBe(res.applied[0]!.id)
    expect((await undo(store, { last: true })).undone).toEqual([])
  })

  test('global create fans out to every existing client dir', async () => {
    const edits: Edit[] = [{ action: 'create', kind: 'runbook', name: 'deploy-checklist', scope: 'global', description: 'Steps before a deploy.', content: '1. backup\n2. migrate', ...base }]
    const res = await applyEdits(edits, { store, layout: layout(), project, backup: false })
    expect(res.applied[0]!.symlinks!.sort()).toEqual([join(home, '.claude', 'skills', 'deploy-checklist'), join(home, '.codex', 'skills', 'deploy-checklist')])
    expect(await readFile(join(home, '.agents', 'skills', 'deploy-checklist', 'SKILL.md'), 'utf8')).toContain('kind: runbook')
  })

  test('update keeps frontmatter, merges sources, refuses stale writes, undo restores', async () => {
    const path = join(home, '.agents', 'skills', 'mine-owned', 'SKILL.md')
    const original = await readFile(path, 'utf8')
    const expectedSha = new Map([['mine-owned', sha256(original)]])
    const res = await applyEdits([{ action: 'update', name: 'mine-owned', content: '# owned\nnew body', ...base }], { store, layout: layout(), project, backup: false, expectedSha })
    expect(res.applied).toHaveLength(1)
    const updated = await readFile(path, 'utf8')
    expect(updated).toContain('created_by: skillmine')
    expect(updated).toContain('new body')
    expect(updated).toContain('  - claude:s:u1')
    expect(updated).toMatch(/updated_at: \d{4}-\d{2}-\d{2}/)
    expect(res.applied[0]!.before).toBe(sha256(original))

    const stale = await applyEdits([{ action: 'update', name: 'mine-owned', content: 'again', ...base }], { store, layout: layout(), project, backup: false, expectedSha })
    expect(stale.rejected[0]!.status).toBe('failed')
    expect(stale.rejected[0]!.error).toContain('changed since it was read')

    const u = await undo(store, { id: res.applied[0]!.id })
    expect(u.undone).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  test('human skill update becomes a reference file; undo deletes it', async () => {
    const res = await applyEdits([{ action: 'update', name: 'human-skill', content: 'Use gh auth switch.', ...base }], { store, layout: layout(), project, backup: false })
    expect(res.applied[0]!.action).toBe('add_reference')
    const ref = join(home, '.agents', 'skills', 'human-skill', 'references', 'skillmine-learned-it.md')
    expect(await readFile(ref, 'utf8')).toContain('Use gh auth switch.')
    expect(await readFile(join(home, '.agents', 'skills', 'human-skill', 'SKILL.md'), 'utf8')).toContain('keep me')
    await undo(store, { run: res.applied[0]!.run })
    await expect(lstat(ref)).rejects.toThrow()
  })

  test('archive moves an owned skill aside and undo brings it back', async () => {
    const res = await applyEdits([{ action: 'archive', name: 'mine-owned', ...base }], { store, layout: layout(), project, backup: false })
    expect(res.applied[0]!.archivedTo).toBe(join(home, '.agents', 'skills', '.archive', 'mine-owned'))
    await expect(lstat(join(home, '.agents', 'skills', 'mine-owned'))).rejects.toThrow()
    await undo(store, { last: true })
    expect(await readFile(join(home, '.agents', 'skills', 'mine-owned', 'SKILL.md'), 'utf8')).toContain('old body')
  })

  test('undo fails closed when the file changed after the write', async () => {
    const res = await applyEdits([{ action: 'create', kind: 'skill', name: 'tmp-skill', scope: 'global', description: 'd', content: 'c', ...base }], { store, layout: layout(), project, backup: false })
    await writeFile(res.applied[0]!.path, 'edited by a human')
    const u = await undo(store, { last: true })
    expect(u.undone).toEqual([])
    expect(u.skipped[0]!.reason).toContain('changed after Skillmine wrote it')
  })

  test('rejected edits are recorded in the ledger', async () => {
    const res = await applyEdits([{ action: 'create', kind: 'skill', name: 'Nope', scope: 'local', description: 'd', content: 'c', ...base }], { store, layout: layout(), project, backup: false })
    expect(res.rejected[0]!.status).toBe('rejected')
    expect((await store.entries())[0]!.error).toContain('invalid name')
  })

  test('backup snapshots the skills tree and keeps two', async () => {
    const dir = join(home, '.agents', 'skills')
    for (const r of ['run1', 'run2', 'run3']) await store.backup(dir, r)
    const files = (await readdir(store.backupsDir)).sort()
    expect(files).toHaveLength(2)
    expect(files[1]).toContain('run3')
  })
})
