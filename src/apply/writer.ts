import { mkdir, readFile, writeFile, rename, symlink, lstat, readlink, rm, unlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { Edit, CreateEdit, UpdateEdit, AddReferenceEdit, ArchiveEdit, Scope } from '../plan/types.ts'
import { parseFrontmatter, discoverSkills, type Skill } from '../catalog.ts'
import { Store, sha256, type LedgerEntry } from './store.ts'
import { validateEdit } from './validate.ts'
import { defaultLayout, rootFor, fanoutFor, type Layout } from './paths.ts'

export type ApplyContext = {
  store: Store
  layout?: Layout
  project: string
  run?: string
  catalog?: Skill[]
  expectedSha?: Map<string, string>
  allowHumanEdits?: boolean
  backup?: boolean
  now?: () => number
}

export type ApplyResult = { applied: LedgerEntry[]; rejected: LedgerEntry[] }

export async function applyEdits(edits: Edit[], ctx: ApplyContext): Promise<ApplyResult> {
  const layout = ctx.layout ?? defaultLayout()
  const run = ctx.run ?? ctx.store.newId('run')
  const now = ctx.now ?? Date.now
  const skills = ctx.catalog ?? (await discoverSkills({ home: layout.home, project: ctx.project || undefined }))
  const catalog = new Map(skills.map((s) => [s.name, s]))
  const applied: LedgerEntry[] = []
  const rejected: LedgerEntry[] = []
  const backedUp = new Set<string>()

  for (const raw of edits) {
    const v = validateEdit(raw, catalog, { allowHumanEdits: ctx.allowHumanEdits })
    const base = { id: ctx.store.newId(), run, ts: now(), action: v.edit.action, name: v.edit.name, reason: v.edit.reason, sources: v.edit.sources }
    if (!v.ok) {
      const entry: LedgerEntry = { ...base, status: 'rejected', path: '', before: null, after: null, owner: null, error: v.reason }
      await ctx.store.append(entry)
      rejected.push(entry)
      continue
    }
    const edit = v.edit
    const existing = catalog.get(edit.name)
    const root = existing ? dirname(existing.realpath) : rootFor(layout, (edit as CreateEdit).scope, ctx.project)
    if (ctx.backup !== false && !backedUp.has(root)) {
      backedUp.add(root)
      await ctx.store.backup(existing ? dirname(root) : root, run).catch(() => undefined)
    }
    try {
      let entry: LedgerEntry
      if (edit.action === 'create') entry = await doCreate(edit, { ...base, run }, ctx, layout, now)
      else if (edit.action === 'update') entry = await doUpdate(edit, existing!, { ...base, run }, ctx, now)
      else if (edit.action === 'add_reference') entry = await doAddReference(edit, existing!, { ...base, run }, ctx)
      else entry = await doArchive(edit, existing!, { ...base, run }, layout)
      if (v.downgraded) entry.reason = `${entry.reason} [${v.downgraded}]`
      await ctx.store.append(entry)
      applied.push(entry)
      if (edit.action === 'create') {
        const created = await readSkill(entry.path, (edit as CreateEdit).scope)
        if (created) catalog.set(created.name, created)
      }
    } catch (e) {
      const entry: LedgerEntry = { ...base, status: 'failed', path: '', before: null, after: null, owner: existing?.createdBy === 'skillmine' ? 'skillmine' : existing ? 'human' : null, error: e instanceof Error ? e.message : String(e) }
      await ctx.store.append(entry)
      rejected.push(entry)
    }
  }
  return { applied, rejected }
}

type Base = Omit<LedgerEntry, 'status' | 'path' | 'before' | 'after' | 'owner'>

export function renderSkill(fields: Record<string, string | string[]>, body: string): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      if (!v.length) continue
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${item}`)
    } else if (v !== undefined && v !== '') lines.push(`${k}: ${needsQuotes(v) ? JSON.stringify(v) : v}`)
  }
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

function needsQuotes(v: string): boolean {
  return /[:#"'\n]|^\s|\s$|^[-?&*!|>%@`{}[\],]/.test(v)
}

async function doCreate(edit: CreateEdit, base: Base, ctx: ApplyContext, layout: Layout, now: () => number): Promise<LedgerEntry> {
  const root = rootFor(layout, edit.scope, ctx.project)
  const dir = join(root, edit.name)
  const path = join(dir, 'SKILL.md')
  await mkdir(dir, { recursive: true })
  const date = new Date(now()).toISOString().slice(0, 10)
  const text = renderSkill(
    { name: edit.name, description: edit.description, ...(edit.kind !== 'skill' ? { kind: edit.kind } : {}), created_by: 'skillmine', scope: edit.scope, sources: edit.sources.slice(0, 10), created_at: date, updated_at: date },
    edit.content,
  )
  await atomicWrite(path, text)
  const after = await ctx.store.putBlob(text)
  const symlinks = await fanout(dir, fanoutFor(layout, edit.scope, ctx.project), edit.name)
  return { ...base, status: 'applied', path, before: null, after, owner: 'skillmine', symlinks }
}

async function doUpdate(edit: UpdateEdit, skill: Skill, base: Base, ctx: ApplyContext, now: () => number): Promise<LedgerEntry> {
  const path = skill.realpath
  const current = await readFile(path, 'utf8')
  const currentSha = sha256(current)
  const expected = ctx.expectedSha?.get(skill.name)
  if (expected && expected !== currentSha) throw new Error(`skill "${skill.name}" changed since it was read; refusing to overwrite`)
  const { fields } = parseFrontmatter(current)
  const merged: Record<string, string | string[]> = { ...fields }
  const sources = new Set([...(current.match(/^\s+-\s+(\S+:\S+:\S+)$/gm) ?? []).map((l) => l.trim().slice(2)), ...edit.sources])
  merged.sources = [...sources].slice(0, 20)
  merged.updated_at = new Date(now()).toISOString().slice(0, 10)
  const text = renderSkill(merged, edit.content)
  const before = await ctx.store.putBlob(current)
  await atomicWrite(path, text)
  const after = await ctx.store.putBlob(text)
  return { ...base, status: 'applied', path, before, after, owner: 'skillmine' }
}

async function doAddReference(edit: AddReferenceEdit, skill: Skill, base: Base, ctx: ApplyContext): Promise<LedgerEntry> {
  const dir = join(dirname(skill.realpath), 'references')
  const path = join(dir, edit.file)
  await mkdir(dir, { recursive: true })
  let before: string | null = null
  try {
    before = await ctx.store.putBlob(await readFile(path, 'utf8'))
  } catch {
    before = null
  }
  const header = `<!-- added by skillmine; sources: ${edit.sources.slice(0, 5).join(', ')} -->\n\n`
  const text = header + edit.content.trim() + '\n'
  await atomicWrite(path, text)
  const after = await ctx.store.putBlob(text)
  return { ...base, status: 'applied', path, before, after, owner: skill.createdBy === 'skillmine' ? 'skillmine' : 'human' }
}

async function doArchive(edit: ArchiveEdit, skill: Skill, base: Base, layout: Layout): Promise<LedgerEntry> {
  const dir = dirname(skill.realpath)
  const archiveDir = join(dirname(dir), '.archive')
  await mkdir(archiveDir, { recursive: true })
  const dest = join(archiveDir, skill.name)
  await rename(dir, dest)
  const removed = await removeSymlinks(skill.name, [...layout.globalFanout, ...(skill.scope === 'local' ? [] : [])], dir)
  return { ...base, status: 'applied', path: skill.realpath, before: sha256(await readFile(join(dest, 'SKILL.md'), 'utf8')), after: null, owner: 'skillmine', archivedTo: dest, symlinks: removed }
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, { mode: 0o644 })
  await rename(tmp, path)
}

async function fanout(dir: string, targets: string[], name: string): Promise<string[]> {
  const made: string[] = []
  for (const t of targets) {
    try {
      await lstat(t)
    } catch {
      if (!t.includes('.claude')) continue
      await mkdir(t, { recursive: true })
    }
    const link = join(t, name)
    try {
      await lstat(link)
      continue
    } catch {
      await symlink(dir, link)
      made.push(link)
    }
  }
  return made
}

async function removeSymlinks(name: string, dirs: string[], target: string): Promise<string[]> {
  const removed: string[] = []
  for (const d of dirs) {
    const link = join(d, name)
    try {
      const st = await lstat(link)
      if (!st.isSymbolicLink()) continue
      const to = await readlink(link)
      if (to === target || relative(to, target) === '') {
        await unlink(link)
        removed.push(link)
      }
    } catch {
      continue
    }
  }
  return removed
}

async function readSkill(path: string, scope: Scope): Promise<Skill | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    const { fields, body } = parseFrontmatter(text)
    return { name: fields.name ?? '', description: fields.description ?? '', path, realpath: path, scope, createdBy: fields.created_by, body }
  } catch {
    return undefined
  }
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
