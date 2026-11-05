import { realpath } from 'node:fs/promises'
import { discoverSkills, type Skill } from './catalog.ts'
import type { Store } from './apply/store.ts'
import { readUsage, recordOffered } from './curate/usage.ts'
import { CHILD_ENV, claimOffered, isInjected } from './reflect.ts'
import { INDEX_MARKER, isInternalProject } from './util/internal.ts'

export const INDEX_DESC_CHARS = 60
export const INDEX_MAX_CHARS = 2000
export const INDEX_MAX_ENTRIES = 40
export const INDEX_NAME_CHARS = 64
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
export const INDEX_HEADER = `${INDEX_MARKER} Skillmine skills learned from earlier sessions (read the skill when the task matches):`

export type IndexOptions = {
  store: Store
  home?: string
  project?: string
  maxChars?: number
  descChars?: number
  maxEntries?: number
  env?: Record<string, string | undefined>
  session?: string
  now?: number
}

export type IndexResult = { text: string; names: string[]; paths: string[]; suspended: boolean }

export function truncateDescription(description: string, max = INDEX_DESC_CHARS): string {
  const one = description.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

export function cleanName(name: string, max = INDEX_NAME_CHARS): string {
  return truncateDescription(name.replace(CONTROL_RE, ''), max)
}

async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

export async function selfAuthored(skills: Skill[], store: Store): Promise<Skill[]> {
  const entries = await store.entries()
  const rolledBack = new Set(entries.filter((e) => e.rollbackOf).map((e) => e.rollbackOf!))
  const trusted = new Set<string>()
  for (const e of entries) {
    if (e.status !== 'applied' || e.action !== 'create' || !e.path || rolledBack.has(e.id)) continue
    trusted.add(e.path)
    trusted.add(await resolved(e.path))
  }
  const seen = new Set<string>()
  const out: Skill[] = []
  for (const s of skills) {
    if (s.createdBy !== 'skillmine') continue
    if (!trusted.has(s.realpath) && !trusted.has(await resolved(s.realpath))) continue
    if (seen.has(s.realpath) || seen.has(s.name)) continue
    seen.add(s.realpath)
    seen.add(s.name)
    out.push(s)
  }
  return out
}

export async function buildIndex(opts: IndexOptions): Promise<IndexResult> {
  const env = opts.env ?? process.env
  if (env.SKILLMINE_INDEX_SUSPENDED === '1' || env[CHILD_ENV] || isInternalProject(opts.project)) return { text: '', names: [], paths: [], suspended: true }
  if (opts.session && (await isInjected(opts.store, opts.session))) return { text: '', names: [], paths: [], suspended: false }
  const maxChars = opts.maxChars ?? INDEX_MAX_CHARS
  const maxEntries = opts.maxEntries ?? INDEX_MAX_ENTRIES
  const now = opts.now ?? Date.now()
  const skills = await selfAuthored(await discoverSkills({ home: opts.home, project: opts.project }), opts.store)
  const ranked = await Promise.all(skills.map(async (skill) => ({ skill, uses: (await readUsage(skill, now)).use_count })))
  ranked.sort((a, b) => b.uses - a.uses || a.skill.name.localeCompare(b.skill.name))
  const lines: string[] = []
  const picked: Skill[] = []
  let size = INDEX_HEADER.length
  if (size > maxChars) return { text: '', names: [], paths: [], suspended: false }
  for (const { skill } of ranked) {
    if (picked.length >= maxEntries) break
    const line = `- ${cleanName(skill.name)}: ${truncateDescription(skill.description, opts.descChars)} (${skill.realpath.replace(CONTROL_RE, ' ')})`
    if (size + 1 + line.length > maxChars) continue
    lines.push(line)
    picked.push(skill)
    size += 1 + line.length
  }
  if (!picked.length) return { text: '', names: [], paths: [], suspended: false }
  return { text: [INDEX_HEADER, ...lines].join('\n'), names: picked.map((s) => s.name), paths: picked.map((s) => s.realpath), suspended: false }
}

export type OfferOptions = { store: Store; session: string; paths: string[]; home?: string; project?: string; env?: Record<string, string | undefined>; now?: number }

export async function recordOffers(opts: OfferOptions): Promise<string[]> {
  const env = opts.env ?? process.env
  if (env.SKILLMINE_INDEX_SUSPENDED === '1' || env[CHILD_ENV] || isInternalProject(opts.project)) return []
  const trusted = await selfAuthored(await discoverSkills({ home: opts.home, project: opts.project }), opts.store)
  const wanted = new Set<string>()
  for (const p of opts.paths) {
    wanted.add(p)
    wanted.add(await resolved(p))
  }
  const picked = trusted.filter((s) => wanted.has(s.realpath))
  if (!picked.length) return []
  if (!(await claimOffered(opts.store, opts.session, opts.now))) return []
  const done: string[] = []
  for (const s of picked) {
    try {
      await recordOffered(s, opts.now)
      done.push(s.realpath)
    } catch {
      continue
    }
  }
  return done
}
