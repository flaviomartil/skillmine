import { mkdir, readFile, writeFile, rename, symlink, lstat, readlink, rm, rmdir, unlink, realpath, stat, chmod, link } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join, relative, resolve, basename } from 'node:path'
import type { Edit, CreateEdit, UpdateEdit, AddReferenceEdit, ArchiveEdit, Scope } from '../plan/types.ts'
import { parseFrontmatter, parseSources, discoverSkills, type Skill } from '../catalog.ts'
import { Store, sha256, type LedgerEntry } from './store.ts'
import { validateEdit, lintRendered, NAME_RE, safeSources, safeReason, cleanLabel } from './validate.ts'
import { defaultLayout, rootFor, fanoutFor, type Layout } from './paths.ts'
import { readUsageStrict, updateUsage, recordReject } from '../curate/usage.ts'

async function bumpPatchCount(skill: Skill, at: number): Promise<void> {
  await updateUsage(skill, (u) => {
    u.patch_count += 1
  }, at)
}

class RefusedError extends Error {}

export function isFlatFrontmatter(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return false
  let inSources = false
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (/^sources:\s*$/.test(line)) {
      inSources = true
      continue
    }
    if (inSources && /^\s+-\s+\S/.test(line)) continue
    inSources = false
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line)
    if (!kv) return false
    const value = (kv[2] ?? '').trim()
    if (/^[|>][+-]?\d*$/.test(value)) return false
    if (/^[[{]/.test(value)) return false
  }
  return true
}
class LintError extends RefusedError {}

async function archiveRefusal(skill: Skill, at: number): Promise<string | undefined> {
  try {
    return (await readUsageStrict(skill, at)).pinned ? 'skill is pinned' : undefined
  } catch {
    return 'usage sidecar is unreadable; refusing to archive'
  }
}

async function backupTargets(existing: Skill | undefined, edit: Edit, layout: Layout, project: string): Promise<string[]> {
  if (!existing) return [rootFor(layout, (edit as CreateEdit).scope, project)]
  return [dirname(dirname(existing.path))]
}

function lintOrThrow(text: string, description: boolean): void {
  const lint = lintRendered(text, { description })
  if (!lint.ok) throw new LintError(`lint: ${lint.reason}`)
}

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
  renameFn?: typeof rename
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
  const byPath = new Map<string, Skill>()
  for (const s of skills) byPath.set(await realish(s.realpath), s)
  const resolveTarget = async (raw: Edit): Promise<Skill | undefined | null> => {
    if (raw.action !== 'archive' || !raw.path) return undefined
    return byPath.get(await realish(raw.path)) ?? null
  }
  const NAME_MISMATCH = 'skill name does not match the skill at the given path'

  if (ctx.backup !== false) {
    try {
      for (const raw of edits) {
        const pre = await resolveTarget(raw)
        if (pre === null) continue
        if (pre && pre.name !== raw.name) continue
        const view = pre ? new Map(catalog).set(raw.name, pre) : catalog
        const check = validateEdit(raw, view, { allowHumanEdits: ctx.allowHumanEdits })
        if (!check.ok) continue
        for (const target of await backupTargets(pre ?? view.get(raw.name), check.edit, layout, ctx.project)) {
          if (backedUp.has(target)) continue
          await ctx.store.backup(target, run)
          backedUp.add(target)
        }
      }
    } catch (e) {
      const message = `backup failed: ${e instanceof Error ? e.message : String(e)}`
      for (const raw of edits) {
        const failed: LedgerEntry = { id: ctx.store.newId(), run, ts: now(), action: raw.action, name: cleanLabel(raw.name), reason: safeReason(raw.reason), sources: safeSources(raw.sources), status: 'failed', path: '', before: null, after: null, owner: null, error: message }
        await ctx.store.append(failed)
        rejected.push(failed)
      }
      return { applied, rejected }
    }
  }

  for (const raw of edits) {
    const target = await resolveTarget(raw)
    if (target === null) {
      const entry: LedgerEntry = { id: ctx.store.newId(), run, ts: now(), action: raw.action, name: cleanLabel(raw.name), reason: safeReason(raw.reason), sources: safeSources(raw.sources), status: 'rejected', path: '', before: null, after: null, owner: null, error: 'no skill at the given path' }
      await ctx.store.append(entry)
      rejected.push(entry)
      continue
    }
    if (target && target.name !== raw.name) {
      const entry: LedgerEntry = { id: ctx.store.newId(), run, ts: now(), action: raw.action, name: cleanLabel(raw.name), reason: safeReason(raw.reason), sources: safeSources(raw.sources), status: 'rejected', path: '', before: null, after: null, owner: null, error: NAME_MISMATCH }
      await ctx.store.append(entry)
      rejected.push(entry)
      continue
    }
    const view = target ? new Map(catalog).set(raw.name, target) : catalog
    const v = validateEdit(raw, view, { allowHumanEdits: ctx.allowHumanEdits })
    const base = { id: ctx.store.newId(), run, ts: now(), action: v.edit.action, name: v.edit.name, reason: v.edit.reason, sources: v.edit.sources }
    if (!v.ok) {
      const entry: LedgerEntry = { ...base, name: cleanLabel(base.name), sources: safeSources(base.sources), reason: safeReason(base.reason), status: 'rejected', path: '', before: null, after: null, owner: null, error: v.reason }
      await ctx.store.append(entry)
      rejected.push(entry)
      const target = catalog.get(raw.name)
      if (v.attributable && target?.createdBy === 'skillmine') await recordReject(target, now()).catch(() => undefined)
      continue
    }
    const edit = v.edit
    const existing = target ?? catalog.get(edit.name)
    if (edit.action === 'archive' && existing) {
      const refusal = await archiveRefusal(existing, now())
      if (refusal) {
        const entry: LedgerEntry = { ...base, status: 'rejected', path: existing.realpath, before: null, after: null, owner: existing.createdBy === 'skillmine' ? 'skillmine' : 'human', error: refusal }
        await ctx.store.append(entry)
        rejected.push(entry)
        continue
      }
    }
    let entry: LedgerEntry | undefined
    try {
      if (edit.action === 'create') entry = await doCreate(edit, { ...base, run }, ctx, layout, now)
      else if (edit.action === 'update') entry = await doUpdate(edit, existing!, { ...base, run }, ctx, now)
      else if (edit.action === 'add_reference') entry = await doAddReference(edit, existing!, { ...base, run }, ctx)
      else entry = await doArchive(edit, existing!, { ...base, run }, layout, ctx, ctx.renameFn ?? rename)
      if (v.downgraded) entry.reason = `${entry.reason} [${v.downgraded}]`
      await appendOnce(ctx.store, entry)
      applied.push(entry)
      if (edit.action === 'archive' && existing) {
        if (catalog.get(existing.name) === existing) catalog.delete(existing.name)
        byPath.delete(await realish(existing.realpath))
      }
      if ((edit.action === 'update' || edit.action === 'add_reference') && existing?.createdBy === 'skillmine') await bumpPatchCount(existing, now()).catch(() => undefined)
      if (edit.action === 'create') {
        const created = await readSkill(entry.path, (edit as CreateEdit).scope)
        if (created) catalog.set(created.name, created)
      }
    } catch (e) {
      if (entry) {
        applied.push({ ...entry, error: `ledger append failed: ${e instanceof Error ? e.message : String(e)}` })
        continue
      }
      const failed: LedgerEntry = { ...base, status: e instanceof RefusedError ? 'rejected' : 'failed', path: '', before: null, after: null, owner: existing?.createdBy === 'skillmine' ? 'skillmine' : existing ? 'human' : null, error: e instanceof Error ? e.message : String(e) }
      await ctx.store.append(failed)
      rejected.push(failed)
      if (e instanceof LintError && existing?.createdBy === 'skillmine') await recordReject(existing, now()).catch(() => undefined)
    }
  }
  return { applied, rejected }
}

async function appendOnce(store: Store, entry: LedgerEntry): Promise<void> {
  try {
    await store.append(entry)
  } catch (e) {
    if ((await store.entries()).some((x) => x.id === entry.id)) return
    await store.append(entry).catch(() => {
      throw e
    })
  }
}

type Base = Omit<LedgerEntry, 'status' | 'path' | 'before' | 'after' | 'owner'>

export function renderSkill(fields: Record<string, string | string[]>, body: string, quoted: ReadonlySet<string> = new Set()): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      if (!v.length) continue
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${JSON.stringify(item)}`)
    } else if (v !== undefined && v !== '') lines.push(`${k}: ${quoted.has(k) || needsQuotes(v) ? JSON.stringify(v) : v}`)
  }
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

const YAML_SCALAR = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i
const YAML_NUMBER = /^[-+]?(?:\d[\d_,]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$|^0x[0-9a-f]+$|^0o[0-7]+$|^[-+]?\.(?:inf|nan)$/i

function needsQuotes(v: string): boolean {
  return /[:#"'\n]|^\s|\s$|^[-?&*!|>%@`{}[\],]/.test(v) || YAML_SCALAR.test(v) || YAML_NUMBER.test(v)
}

function quotedKeys(text: string): Set<string> {
  const out = new Set<string>()
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return out
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(["'])/.exec(line)
    if (kv) out.add(kv[1]!)
  }
  return out
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function doCreate(edit: CreateEdit, base: Base, ctx: ApplyContext, layout: Layout, now: () => number): Promise<LedgerEntry> {
  const root = rootFor(layout, edit.scope, ctx.project)
  const dir = join(root, edit.name)
  const path = join(dir, 'SKILL.md')
  if (await exists(path)) throw new RefusedError(`"${path}" already exists on disk; refusing to overwrite`)
  const date = new Date(now()).toISOString().slice(0, 10)
  const text = renderSkill(
    { name: edit.name, description: edit.description, ...(edit.kind !== 'skill' ? { kind: edit.kind } : {}), created_by: 'skillmine', scope: edit.scope, sources: edit.sources.slice(0, 10), created_at: date, updated_at: date },
    edit.content,
  )
  lintOrThrow(text, true)
  const after = await ctx.store.putBlob(text)
  const dirExisted = await exists(dir)
  const links: string[] = []
  let claimed = false
  try {
    await mkdir(dir, { recursive: true })
    await claimFile(path, text)
    claimed = true
    await fanout(dir, fanoutFor(layout, edit.scope, ctx.project), edit.name, links)
  } catch (e) {
    if (!claimed) {
      if (!dirExisted && !(e instanceof RefusedError)) await rmdir(dir).catch(() => undefined)
      throw e
    }
    for (const l of links) await unlink(l).catch(() => undefined)
    await unlink(path).catch(() => undefined)
    if (!dirExisted) await rmdir(dir).catch(() => undefined)
    throw e
  }
  return { ...base, status: 'applied', path, before: null, after, owner: 'skillmine', symlinks: links }
}

async function doUpdate(edit: UpdateEdit, skill: Skill, base: Base, ctx: ApplyContext, now: () => number): Promise<LedgerEntry> {
  const path = skill.realpath
  const current = await readFile(path, 'utf8')
  const currentSha = sha256(current)
  const expected = ctx.expectedSha?.get(skill.name)
  if (ctx.expectedSha && !expected) throw new RefusedError(`update refused: planner did not read skill "${skill.name}"`)
  if (expected && expected !== currentSha) throw new Error(`skill "${skill.name}" changed since it was read; refusing to overwrite`)
  if (!isFlatFrontmatter(current)) throw new RefusedError('frontmatter not flat')
  const { fields } = parseFrontmatter(current)
  const merged: Record<string, string | string[]> = { ...fields }
  if (!merged.name) merged.name = skill.name
  const sources = new Set([...parseSources(current), ...edit.sources])
  merged.sources = [...sources].slice(-20)
  merged.updated_at = new Date(now()).toISOString().slice(0, 10)
  const text = renderSkill(merged, edit.content, quotedKeys(current))
  lintOrThrow(text, false)
  const before = await ctx.store.putBlob(current)
  const after = await ctx.store.putBlob(text)
  await atomicWrite(path, text)
  return { ...base, status: 'applied', path, before, after, owner: skill.createdBy === 'skillmine' ? 'skillmine' : 'human' }
}

async function doAddReference(edit: AddReferenceEdit, skill: Skill, base: Base, ctx: ApplyContext): Promise<LedgerEntry> {
  const dir = join(dirname(skill.realpath), 'references')
  const path = join(dir, edit.file)
  const dirExisted = await exists(dir)
  await mkdir(dir, { recursive: true })
  try {
    return await writeReference(edit, skill, base, ctx, path)
  } catch (e) {
    if (!dirExisted) await rmdir(dir).catch(() => undefined)
    throw e
  }
}

async function writeReference(edit: AddReferenceEdit, skill: Skill, base: Base, ctx: ApplyContext, path: string): Promise<LedgerEntry> {
  let before: string | null = null
  let currentText: string | null = null
  try {
    currentText = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (currentText !== null) before = await ctx.store.putBlob(currentText)
  const header = `<!-- added by skillmine; sources: ${edit.sources.slice(0, 5).join(', ')} -->\n\n`
  const text = header + edit.content.trim() + '\n'
  if (currentText !== null) {
    const currentSha = sha256(currentText)
    if (currentSha !== sha256(text)) {
      const wrote = (await ctx.store.entries()).some((e) => e.status === 'applied' && e.path === path && e.after === currentSha)
      if (!wrote) throw new RefusedError('reference file exists and was not written by skillmine')
    }
  }
  const after = await ctx.store.putBlob(text)
  await atomicWrite(path, text)
  return { ...base, status: 'applied', path, before, after, owner: skill.createdBy === 'skillmine' ? 'skillmine' : 'human' }
}

async function doArchive(edit: ArchiveEdit, skill: Skill, base: Base, layout: Layout, ctx: ApplyContext, move: typeof rename): Promise<LedgerEntry> {
  if (!NAME_RE.test(skill.name)) throw new RefusedError(`invalid skill name "${cleanLabel(skill.name)}"; refusing to archive`)
  const dir = dirname(skill.realpath)
  const linkDir = dirname(skill.path)
  const isLink = await lstat(linkDir).then((st) => st.isSymbolicLink(), () => false)
  if (isLink || (await realish(linkDir)) !== (await realish(dir))) throw new RefusedError(`"${linkDir}" is a symlink to "${dir}"; refusing to archive the real directory`)
  const archiveDir = join(dirname(dir), '.archive')
  const before = await ctx.store.putBlob(await readFile(skill.realpath, 'utf8'))
  const owner = skill.createdBy === 'skillmine' ? 'skillmine' : 'human'
  const archiveExisted = await exists(archiveDir)
  await mkdir(archiveDir, { recursive: true })
  let dest = join(archiveDir, skill.name)
  if (await exists(dest)) dest = join(archiveDir, `${skill.name}-${base.ts}`)
  const realTarget = await realish(dir)
  try {
    await move(dir, dest)
  } catch (e) {
    if (!archiveExisted) await rmdir(archiveDir).catch(() => undefined)
    throw e
  }
  const removed: RemovedLink[] = []
  try {
    await removeSymlinks(skill.name, fanoutFor(layout, skill.scope, ctx.project), dir, realTarget, removed)
    return { ...base, status: 'applied', path: skill.realpath, before, after: null, owner, archivedTo: dest, symlinks: removed.map((r) => r.link) }
  } catch (e) {
    const restored = await move(dest, dir).then(() => true, () => false)
    if (restored) {
      for (const r of removed) await symlink(r.raw, r.link).catch(() => undefined)
      throw e
    }
    const note = `post-move step failed (${e instanceof Error ? e.message : String(e)}); left in the archive`
    return { ...base, reason: `${base.reason} [${note}]`, status: 'applied', path: skill.realpath, before, after: null, owner, archivedTo: dest, symlinks: removed.map((r) => r.link) }
  }
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const mode = await stat(path).then((st) => st.mode & 0o7777, () => 0o644)
  try {
    await writeFile(tmp, text, { mode, flag: 'wx' })
    await chmod(tmp, mode)
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}

async function claimFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(tmp, text, { mode: 0o644 })
    try {
      await link(tmp, path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new RefusedError(`"${path}" already exists on disk; refusing to overwrite`)
      throw e
    }
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

async function fanout(dir: string, targets: string[], name: string, made: string[]): Promise<void> {
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
}

type RemovedLink = { link: string; raw: string }

async function realish(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}

async function removeSymlinks(name: string, dirs: string[], target: string, realTarget: string, removed: RemovedLink[]): Promise<void> {
  for (const d of dirs) {
    const link = join(d, name)
    try {
      const st = await lstat(link)
      if (!st.isSymbolicLink()) continue
      const raw = await readlink(link)
      const to = resolve(dirname(link), raw)
      if (to === target || relative(to, target) === '' || (await realish(to)) === realTarget) {
        await unlink(link)
        removed.push({ link, raw })
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw e
    }
  }
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
