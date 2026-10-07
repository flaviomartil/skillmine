import type { MineResult } from './mine.ts'
import type { Analysis } from './analyze.ts'
import { passes } from './classify/types.ts'
import { CLIENTS } from './types.ts'

export function dryReport(r: MineResult, samples: number): string {
  const lines: string[] = []
  lines.push(`since ${new Date(r.since).toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push(pad(['client', 'sessions', 'turns', 'windows', 'errors']))
  for (const c of CLIENTS) {
    const s = r.perClient[c]
    if (s.sessions === 0 && s.errors === 0) continue
    lines.push(pad([c, s.sessions, s.turns, s.windows, s.errors]))
  }
  if (r.automated) lines.push(`automated windows dropped ${r.automated}`)
  lines.push('')
  lines.push('signals')
  for (const [k, v] of Object.entries(r.signals)) lines.push(`  ${k.padEnd(16)} ${v}`)
  lines.push('')
  const top = Object.entries(r.projects)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  if (top.length) {
    lines.push('projects (windows)')
    for (const [p, n] of top) lines.push(`  ${String(n).padStart(5)}  ${p}`)
    lines.push('')
  }
  const picked = r.windows.slice(0, samples)
  if (picked.length) {
    lines.push(`samples (${picked.length} of ${r.windows.length})`)
    for (const w of picked) {
      lines.push(`--- ${w.id}  [${w.signals.join(', ')}]  ${w.project}`)
      lines.push(indent(w.digest.slice(0, 600)))
    }
  }
  return lines.join('\n')
}

export function analysisReport(a: Analysis, samples: number): string {
  const lines: string[] = []
  const s = a.stats
  lines.push('analysis')
  lines.push(`  windows ${s.windows} -> clusters ${s.clusters}  (${s.windows ? Math.round((1 - s.clusters / s.windows) * 100) : 0}% collapsed)`)
  lines.push(`  skills in catalog ${s.skills}`)
  if (s.calls) {
    lines.push(`  classifier calls ${s.calls}, passed ${s.passed}, errors ${a.errors.length}`)
    lines.push('  kind     ' + Object.entries(s.byKind).map(([k, v]) => `${k}=${v}`).join(' '))
    lines.push('  novelty  ' + Object.entries(s.byNovelty).map(([k, v]) => `${k}=${v}`).join(' '))
  }
  const withVerdict = a.clusters.filter((c) => a.verdicts.has(c.id))
  const picked = (withVerdict.length ? withVerdict.filter((c) => passes(a.verdicts.get(c.id)!)) : a.clusters).slice(0, samples)
  if (picked.length) {
    lines.push('')
    lines.push(withVerdict.length ? `passed samples (${picked.length})` : `cluster samples (${picked.length} of ${a.clusters.length})`)
    for (const c of picked) {
      const v = a.verdicts.get(c.id)
      const verdict = v ? `  knowledge=${v.knowledge.toFixed(2)} ${v.kind} ${v.novelty}${v.target ? ' -> ' + v.target : ''}` : ''
      const matches = c.matches.length ? `  matches: ${c.matches.map((m) => `${m.name}(${m.sim.toFixed(2)})`).join(', ')}` : ''
      lines.push(`--- ${c.id}  x${c.members.length}  [${c.rep.signals.join(', ')}]${verdict}`)
      if (matches) lines.push(matches)
      lines.push(indent(c.rep.digest.slice(0, 500)))
    }
  }
  if (a.errors.length) {
    lines.push('')
    lines.push(`errors (${a.errors.length})`)
    for (const e of a.errors.slice(0, 5)) lines.push(`  ${e.cluster}: ${e.error}`)
  }
  return lines.join('\n')
}

function pad(cells: (string | number)[]): string {
  const widths = [12, 9, 8, 8, 7]
  return cells.map((c, i) => String(c).padEnd(widths[i] ?? 8)).join('')
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')
}
