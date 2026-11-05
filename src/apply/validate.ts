import type { Edit } from '../plan/types.ts'
import { parseFrontmatter, type Skill } from '../catalog.ts'

export const NAME_RE = /^[a-z0-9][a-z0-9-]{2,60}$/
const TICKET_NAME_RE = /(^|-)(pr|issue|ticket|card|bug|fix|task)-?\d+|-\d{3,}(-|$)/
const REFERENCE_FILE_RE = /^[a-z0-9][a-z0-9-]{1,60}\.md$/
export const MAX_BODY = 24_000
export const MAX_DESCRIPTION = 250
export function maxBodyLines(): number {
  return intEnv('SKILLMINE_BODY_MAX_LINES', 300)
}
const PLACEHOLDER_RE = /\b(TODO|FIXME|XXX):|<(?:TODO|FIXME|XXX|TBD|PLACEHOLDER|REPLACE[_ ]?ME|INSERT[_ ]?HERE|FILL[_ ]?IN)>/

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function bodyLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim()).length
}

const SECRET_RE = /(sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|(?<![A-Za-z0-9])sk[-_][A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9._-]{24,}|[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]{3,}@[^\s\/]+|(?<![A-Za-z0-9])(password|passwd|secret|token|api[_-]?key|client[_-]?secret)(?:_[A-Za-z0-9_]+)?\s*[=:]\s*['"]?(?!process\.env\.|\$)[A-Za-z0-9+/._-]{12,})/i
const LOG_RE = /\b20\d{2}-\d{2}-\d{2}\b|\bPR\s*#?\d{2,}\b|#\d{3,}\b|\b(issue|ticket|card)\s+#?\d{2,}\b/i
const ESCALATION_MARKERS = ['[[mcp]]', '[[hooks]]', '[[plugins]]', '[[mods]]', '[policy]', 'vault:', 'op://'] as const

export function forbiddenLessonText(text: string): string | undefined {
  const blob = text.toLowerCase()
  if (blob.includes('required = true') || blob.includes('required=true')) {
    return 'a lesson cannot mark items required'
  }
  for (const marker of ESCALATION_MARKERS) {
    if (blob.includes(marker)) {
      return `a lesson cannot add secrets or required runtime items (${marker})`
    }
  }
  return undefined
}

export type Validation = { ok: true; edit: Edit; downgraded?: string } | { ok: false; edit: Edit; reason: string; attributable?: boolean }

export function validateEdit(edit: Edit, catalog: Map<string, Skill>, opts: { allowHumanEdits?: boolean } = {}): Validation {
  if (!NAME_RE.test(edit.name)) return fail(edit, `invalid name "${cleanLabel(edit.name)}"`)
  if (TICKET_NAME_RE.test(edit.name)) return fail(edit, `name looks like a ticket or one-off: "${cleanLabel(edit.name)}"`)
  const badSource = edit.sources.find((src) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|-->/.test(src))
  if (badSource !== undefined) return fail(edit, 'source contains a control character, newline or "-->"')
  const reasonHit = SECRET_RE.exec(edit.reason ?? '')
  if (reasonHit) return fail(edit, `reason looks like it contains a secret (${secretLabel(reasonHit[0])})`)
  const reasonForbidden = forbiddenLessonText(edit.reason ?? '')
  if (reasonForbidden) return fail(edit, reasonForbidden)
  for (const src of edit.sources) {
    const hit = SECRET_RE.exec(src)
    if (hit) return fail(edit, `source looks like it contains a secret (${secretLabel(hit[0])})`)
  }
  const existing = catalog.get(edit.name)
  if (edit.action === 'create') {
    if (existing) return fail(edit, `skill "${cleanLabel(edit.name)}" already exists; use update or add_reference`)
    const d = checkDescription(edit.description)
    if (d) return fail(edit, d)
    return checkContent(edit, edit.content, true)
  }
  if (!existing) return fail(edit, `skill "${cleanLabel(edit.name)}" does not exist`)
  const owned = existing.createdBy === 'skillmine' || opts.allowHumanEdits
  if (edit.action === 'archive') return owned ? { ok: true, edit } : fail(edit, 'cannot archive a human-authored skill')
  if (edit.action === 'add_reference') {
    if (!REFERENCE_FILE_RE.test(edit.file)) return fail(edit, `invalid reference file name "${cleanLabel(edit.file)}"`)
    return checkContent(edit, edit.content)
  }
  if (!owned) {
    const downgraded: Edit = { action: 'add_reference', name: edit.name, file: `skillmine-${slug(edit.reason) || 'note'}.md`, content: edit.content, reason: edit.reason, sources: edit.sources }
    const v = checkContent(downgraded, downgraded.content)
    return v.ok ? { ok: true, edit: downgraded, downgraded: 'human-authored skill: update became add_reference' } : v
  }
  return checkContent(edit, edit.content, true)
}

export function cleanLabel(value: string, max = 80): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  if (SECRET_RE.test(text)) return '[redacted]'
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

export function safeReason(reason: string): string {
  return SECRET_RE.test(reason) ? '' : reason
}

export function safeSources(sources: string[]): string[] {
  return sources.filter((src) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|-->/.test(src) && !SECRET_RE.test(src))
}

export function checkDescription(description: string): string | undefined {
  const d = description.trim()
  if (!d) return 'description missing'
  if (d.length > MAX_DESCRIPTION) return `description over ${MAX_DESCRIPTION} chars`
  if (/[\r\n]/.test(d)) return 'description must be a single line'
  const secret = SECRET_RE.exec(d)
  if (secret) return `description looks like it contains a secret (${secretLabel(secret[0])})`
  const forbidden = forbiddenLessonText(d)
  if (forbidden) return forbidden
  if (PLACEHOLDER_RE.test(d)) return 'description contains a placeholder'
  return undefined
}

export function secretLabel(match: string): string {
  if (/^sk[-_]/i.test(match)) return 'sk-...'
  if (/^ghp_/.test(match)) return 'ghp_...'
  if (/^github_pat_/.test(match)) return 'github_pat_...'
  if (/^AKIA/.test(match)) return 'AKIA...'
  if (/^xox/.test(match)) return 'xox...'
  if (/^-----BEGIN/.test(match)) return 'private key'
  if (/^Bearer/i.test(match)) return 'bearer token'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match)) return 'credential_url'
  return /^(password|passwd|secret|token|api[_-]?key|client[_-]?secret)/i.exec(match)?.[1]?.toLowerCase() ?? 'secret'
}

export type Lint = { ok: true } | { ok: false; reason: string }

export function lintRendered(text: string, opts: { description?: boolean } = {}): Lint {
  const { fields, body } = parseFrontmatter(text)
  if (!/^---\r?\n/.test(text) || !Object.keys(fields).length) return { ok: false, reason: 'missing or invalid frontmatter' }
  if (!fields.name) return { ok: false, reason: 'frontmatter is missing name' }
  if (!fields.description) return { ok: false, reason: 'frontmatter is missing description' }
  if (opts.description !== false) {
    if (!NAME_RE.test(fields.name)) return { ok: false, reason: `invalid name "${fields.name}"` }
    const d = checkDescription(fields.description)
    if (d) return { ok: false, reason: d }
  }
  if (PLACEHOLDER_RE.test(fields.description)) return { ok: false, reason: 'description contains a placeholder' }
  const lines = bodyLines(body)
  if (lines > maxBodyLines()) return { ok: false, reason: `body is ${lines} non-blank lines (over ${maxBodyLines()})` }
  const secret = SECRET_RE.exec(text)
  if (secret) return { ok: false, reason: `skill text looks like it contains a secret (${secretLabel(secret[0])})` }
  const forbidden = forbiddenLessonText(body)
  if (forbidden) return { ok: false, reason: forbidden }
  if (PLACEHOLDER_RE.test(body)) return { ok: false, reason: 'body contains a TODO or placeholder' }
  return { ok: true }
}

function checkContent(edit: Edit, content: string, limitLines = false): Validation {
  const trimmed = content.trim()
  if (!trimmed) return fail(edit, 'empty content', true)
  if (trimmed.length > MAX_BODY) return fail(edit, `content over ${MAX_BODY} chars`, true)
  if (/^---\r?\n/.test(trimmed)) return fail(edit, 'content must not include frontmatter', true)
  const secret = SECRET_RE.exec(trimmed)
  if (secret) return fail(edit, `content looks like it contains a secret (${secretLabel(secret[0])})`, true)
  const forbidden = forbiddenLessonText(trimmed)
  if (forbidden) return fail(edit, forbidden, true)
  if (limitLines && bodyLines(trimmed) > maxBodyLines()) return fail(edit, `content is ${bodyLines(trimmed)} non-blank lines (over ${maxBodyLines()}); move detail into references`, true)
  if (PLACEHOLDER_RE.test(trimmed)) return fail(edit, 'content contains a TODO or placeholder', true)
  const log = LOG_RE.exec(trimmed)
  if (log) return fail(edit, `content contains a date or ticket reference ("${log[0]}"): lessons, not logs`, true)
  return { ok: true, edit }
}

function fail(edit: Edit, reason: string, attributable = false): Validation {
  return { ok: false, edit, reason, attributable }
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
