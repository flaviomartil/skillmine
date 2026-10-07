import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Embedder } from './embed/types.ts'
import { chunkText, cosine } from './embed/math.ts'

export type Skill = {
  name: string
  description: string
  path: string
  realpath: string
  scope: 'global' | 'local'
  createdBy?: string
  body: string
}

export type SkillVec = { skill: Skill; vecs: Float32Array[] }

export type CatalogMatch = { name: string; description: string; sim: number; scope: 'global' | 'local' }

export function globalSkillDirs(home = homedir()): string[] {
  return [
    join(home, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.kimi', 'skills'),
    join(home, '.kimi-code', 'skills'),
    join(home, '.gemini', 'config', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
  ]
}

export function localSkillDirs(project: string): string[] {
  return [join(project, '.agents', 'skills'), join(project, '.claude', 'skills')]
}

export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    fields[kv[1]!] = v
  }
  return { fields, body: m[2] ?? '' }
}

export async function discoverSkills(opts: { home?: string; project?: string; dirs?: { path: string; scope: 'global' | 'local' }[] } = {}): Promise<Skill[]> {
  const dirs =
    opts.dirs ??
    [
      ...globalSkillDirs(opts.home).map((path) => ({ path, scope: 'global' as const })),
      ...(opts.project ? localSkillDirs(opts.project).map((path) => ({ path, scope: 'local' as const })) : []),
    ]
  const seen = new Set<string>()
  const out: Skill[] = []
  for (const { path: dir, scope } of dirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const path = join(dir, e, 'SKILL.md')
      let real: string
      try {
        real = await realpath(path)
        if (!(await stat(real)).isFile()) continue
      } catch {
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      let text: string
      try {
        text = await readFile(real, 'utf8')
      } catch {
        continue
      }
      const { fields, body } = parseFrontmatter(text)
      out.push({
        name: fields.name ?? e,
        description: fields.description ?? '',
        path,
        realpath: real,
        scope,
        createdBy: fields.created_by,
        body,
      })
    }
  }
  return out
}

export function skillChunks(skill: Skill, maxChunks = 6): string[] {
  const head = `${skill.name}: ${skill.description}`.trim()
  return [head, ...chunkText(skill.body, 1500, 100).slice(0, maxChunks - 1)]
}

export async function embedCatalog(skills: Skill[], embedder: Embedder, onProgress?: (done: number, total: number) => void): Promise<SkillVec[]> {
  const out: SkillVec[] = []
  let done = 0
  for (const skill of skills) {
    const chunks = skillChunks(skill)
    const vecs = chunks.length ? await embedder.embed(chunks) : []
    out.push({ skill, vecs })
    done++
    onProgress?.(done, skills.length)
  }
  return out
}

export function matchCatalog(vec: Float32Array, catalog: SkillVec[], k = 3, minSim = 0.5): CatalogMatch[] {
  const scored: CatalogMatch[] = []
  for (const { skill, vecs } of catalog) {
    let best = -1
    for (const v of vecs) best = Math.max(best, cosine(vec, v))
    if (best >= minSim) scored.push({ name: skill.name, description: skill.description, sim: best, scope: skill.scope })
  }
  return scored.sort((a, b) => b.sim - a.sim).slice(0, k)
}
