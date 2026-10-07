import type { Window } from './types.ts'
import type { Embedder } from './embed/types.ts'
import { cosine } from './embed/math.ts'
import { windowScore } from './windows.ts'
import { cut } from './util/jsonl.ts'
import type { CatalogMatch } from './catalog.ts'

export type Cluster = {
  id: string
  rep: Window
  members: Window[]
  vec?: Float32Array
  matches: CatalogMatch[]
  projects: string[]
}

export const DEFAULT_SIM = 0.9

export function lessonText(w: Window, max = 1500): string {
  const parts: string[] = []
  for (const t of w.turns) {
    if (!t.text) continue
    parts.push(`${t.role}: ${cut(t.text, 500)}`)
  }
  const joined = parts.join('\n')
  return joined.length > max ? joined.slice(0, max) : joined
}

export async function embedWindows(windows: Window[], embedder: Embedder, batch = 64, onProgress?: (done: number, total: number) => void): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (let i = 0; i < windows.length; i += batch) {
    const slice = windows.slice(i, i + batch)
    const vecs = await embedder.embed(slice.map((w) => lessonText(w)))
    out.push(...vecs)
    onProgress?.(Math.min(i + batch, windows.length), windows.length)
  }
  return out
}

export function clusterWindows(windows: Window[], vecs?: Float32Array[], threshold = DEFAULT_SIM): Cluster[] {
  const order = windows.map((w, i) => i).sort((a, b) => windowScore(windows[b]!.signals) - windowScore(windows[a]!.signals) || windows[b]!.end - windows[a]!.end)
  const clusters: Cluster[] = []
  for (const i of order) {
    const w = windows[i]!
    const v = vecs?.[i]
    let home: Cluster | undefined
    if (v) {
      for (const c of clusters) {
        if (c.vec && cosine(c.vec, v) >= threshold) {
          home = c
          break
        }
      }
    }
    if (home) {
      home.members.push(w)
      if (!home.projects.includes(w.project)) home.projects.push(w.project)
    } else {
      clusters.push({ id: w.id, rep: w, members: [w], vec: v, matches: [], projects: [w.project] })
    }
  }
  return clusters
}

export function classifyDigest(c: Cluster, max = 3000): string {
  const lines: string[] = []
  const failures: string[] = []
  const recovered: string[] = []
  const failedNames = new Set<string>()
  for (const t of c.rep.turns) {
    if (t.text) lines.push(`${t.role}: ${cut(t.text, 700)}`)
    for (const tool of t.tools) {
      if (tool.failed) {
        failedNames.add(tool.name)
        if (failures.length < 3) failures.push(`${tool.name}(${tool.arg})`)
      } else if (failedNames.has(tool.name) && recovered.length < 3) recovered.push(`${tool.name}(${tool.arg})`)
    }
  }
  if (failures.length) lines.push(`[tools that failed: ${failures.join(', ')}${recovered.length ? `; later succeeded: ${recovered.join(', ')}` : ''}]`)
  if (c.members.length > 1) lines.push(`[seen in ${c.members.length} similar windows across ${c.projects.length} project(s)]`)
  const text = lines.join('\n')
  return text.length > max ? text.slice(0, max) : text
}

export function clusterDigest(c: Cluster, maxExtra = 2): string {
  const lines = [c.rep.digest]
  const extra = c.members.filter((m) => m !== c.rep).slice(0, maxExtra)
  for (const m of extra) lines.push(`\n--- another session (${m.client}, ${m.project}) ---\n${lessonText(m, 800)}`)
  if (c.members.length > 1 + extra.length) lines.push(`\n(${c.members.length - 1 - extra.length} more similar windows omitted)`)
  return lines.join('\n')
}
