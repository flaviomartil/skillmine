import type { Edit } from '../plan/types.ts'
import type { Skill } from '../catalog.ts'

export const NAME_RE = /^[a-z0-9][a-z0-9-]{2,60}$/
const TICKET_NAME_RE = /(^|-)(pr|issue|ticket|card|bug|fix|task)-?\d+|-\d{3,}(-|$)/
const REFERENCE_FILE_RE = /^[a-z0-9][a-z0-9-]{1,60}\.md$/
export const MAX_BODY = 24_000
export const MAX_DESCRIPTION = 250

const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9._-]{24,}|\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9+/._-]{12,})/i
const LOG_RE = /\b20\d{2}-\d{2}-\d{2}\b|\bPR\s*#?\d{2,}\b|#\d{3,}\b|\b(issue|ticket|card)\s+#?\d{2,}\b/i

export type Validation = { ok: true; edit: Edit; downgraded?: string } | { ok: false; edit: Edit; reason: string }

export function validateEdit(edit: Edit, catalog: Map<string, Skill>, opts: { allowHumanEdits?: boolean } = {}): Validation {
  if (!NAME_RE.test(edit.name)) return fail(edit, `invalid name "${edit.name}"`)
  if (TICKET_NAME_RE.test(edit.name)) return fail(edit, `name looks like a ticket or one-off: "${edit.name}"`)
  const existing = catalog.get(edit.name)
  if (edit.action === 'create') {
    if (existing) return fail(edit, `skill "${edit.name}" already exists; use update or add_reference`)
    if (!edit.description.trim() || edit.description.length > MAX_DESCRIPTION) return fail(edit, 'description missing or over 250 chars')
    return checkContent(edit, edit.content)
  }
  if (!existing) return fail(edit, `skill "${edit.name}" does not exist`)
  const owned = existing.createdBy === 'skillmine' || opts.allowHumanEdits
  if (edit.action === 'archive') return owned ? { ok: true, edit } : fail(edit, 'cannot archive a human-authored skill')
  if (edit.action === 'add_reference') {
    if (!REFERENCE_FILE_RE.test(edit.file)) return fail(edit, `invalid reference file name "${edit.file}"`)
    return checkContent(edit, edit.content)
  }
  if (!owned) {
    const downgraded: Edit = { action: 'add_reference', name: edit.name, file: `skillmine-${slug(edit.reason) || 'note'}.md`, content: edit.content, reason: edit.reason, sources: edit.sources }
    const v = checkContent(downgraded, downgraded.content)
    return v.ok ? { ok: true, edit: downgraded, downgraded: 'human-authored skill: update became add_reference' } : v
  }
  return checkContent(edit, edit.content)
}

function checkContent(edit: Edit, content: string): Validation {
  const trimmed = content.trim()
  if (!trimmed) return fail(edit, 'empty content')
  if (trimmed.length > MAX_BODY) return fail(edit, `content over ${MAX_BODY} chars`)
  if (/^---\r?\n/.test(trimmed)) return fail(edit, 'content must not include frontmatter')
  const secret = SECRET_RE.exec(trimmed)
  if (secret) return fail(edit, `content looks like it contains a secret (${secret[0].slice(0, 12)}…)`)
  const log = LOG_RE.exec(trimmed)
  if (log) return fail(edit, `content contains a date or ticket reference ("${log[0]}"): lessons, not logs`)
  return { ok: true, edit }
}

function fail(edit: Edit, reason: string): Validation {
  return { ok: false, edit, reason }
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
