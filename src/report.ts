import type { MineResult } from './mine.ts'
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
