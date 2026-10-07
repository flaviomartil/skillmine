import type { PlanInput, Edit } from './types.ts'

export const PLANNER_RULES = `You are Skillmine's planner. You read a window of a coding-agent conversation that a classifier marked as reusable knowledge, and you decide what to write into the user's skill library. You answer with one JSON object and nothing else.

Preference order, highest first:
1. UPDATE the target skill when one is given and the knowledge belongs to it. Edit the misleading sentence in place; never append "UPDATE: actually".
2. UPDATE another listed skill that covers the same class of problem.
3. ADD_REFERENCE: a short reference file under an existing skill when the point is narrower than the skill but worth keeping.
4. CREATE a new skill only when no listed skill covers this class of situations. The name describes a class of situations in kebab-case, never a ticket, PR, error string, project codename or date.

Content rules:
- Lessons, not logs. A pitfall is one generalizable rule plus one clause of why. No narrative of what happened.
- The same lesson learned twice is one rule.
- No PR or issue numbers, no dates, no ticket IDs, no quoted user text as content.
- Never write secret values. Write where a secret lives, not what it is.
- Do not capture: environment-dependent failures, negative claims about tools ("X is broken"), transient errors that resolved themselves, unresolved attempts written up as a workflow, anything only one codebase needs unless scope is local.
- Prefer an empty edits array over a speculative edit. An empty array is a good answer.
- Skill body is Markdown without frontmatter. Keep it under 300 lines. Start with what the skill is for, then rules, then commands or steps if any.
- For update, "content" is the complete new body of the skill (not a diff). Keep everything that is still true.
- For add_reference, "file" is a kebab-case name ending in .md and "content" is the reference body.

Output shape:
{"summary": "one line", "edits": [
  {"action": "create", "kind": "skill|runbook|agent", "name": "kebab-case", "scope": "local|global", "description": "one sentence, under 250 chars", "content": "markdown body", "reason": "why", "sources": ["ref", ...]},
  {"action": "update", "name": "existing-skill", "content": "complete new body", "reason": "why", "sources": [...]},
  {"action": "add_reference", "name": "existing-skill", "file": "topic.md", "content": "markdown", "reason": "why", "sources": [...]},
  {"action": "archive", "name": "existing-skill", "reason": "why"}
]}`

export function plannerPrompt(input: PlanInput): string {
  const parts: string[] = [PLANNER_RULES, '']
  parts.push(`Scope for new skills: ${input.scope}${input.scope === 'local' ? ` (project ${input.project})` : ' (seen in more than one project)'}.`)
  if (input.verdict) parts.push(`Classifier verdict: kind=${input.verdict.kind}, novelty=${input.verdict.novelty}${input.verdict.target ? `, suggested target=${input.verdict.target}` : ''}.`)
  parts.push('')
  parts.push('Listed skills (name: description):')
  parts.push(input.catalog.length ? input.catalog.map((s) => `- ${s.name}: ${s.description}`).join('\n') : '(none match)')
  parts.push('')
  if (input.target) {
    parts.push(`Target skill "${input.target.name}" (${input.target.createdBy === 'skillmine' ? 'created by skillmine, may be updated' : 'written by a human: you may only add_reference to it'}), current body:`)
    parts.push('<skill>')
    parts.push(input.target.body.slice(0, 20_000))
    parts.push('</skill>')
    parts.push('')
  }
  if (input.recent.length) {
    parts.push('Recent Skillmine edits (do not repeat them):')
    parts.push(input.recent.map((r) => `- ${r}`).join('\n'))
    parts.push('')
  }
  parts.push(`Use these as "sources": ${JSON.stringify(input.sources.slice(0, 8))}`)
  parts.push('')
  parts.push('Conversation window:')
  parts.push('<window>')
  parts.push(input.digest)
  parts.push('</window>')
  return parts.join('\n')
}

const ACTIONS = new Set(['create', 'update', 'add_reference', 'archive'])
const KINDS = new Set(['skill', 'runbook', 'agent'])

export function parsePlanOutput(text: string): { summary: string; edits: Edit[] } {
  const obj = extractObject(text)
  if (!obj) throw new Error('planner returned no JSON object')
  const o = obj as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary : ''
  const rawEdits = Array.isArray(o.edits) ? o.edits : []
  const edits: Edit[] = []
  for (const raw of rawEdits) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (!ACTIONS.has(String(e.action))) continue
    const base = { reason: str(e.reason), sources: Array.isArray(e.sources) ? e.sources.filter((s): s is string => typeof s === 'string') : [] }
    const name = str(e.name)
    if (e.action === 'create') {
      edits.push({
        action: 'create',
        kind: KINDS.has(String(e.kind)) ? (e.kind as 'skill' | 'runbook' | 'agent') : 'skill',
        name,
        scope: e.scope === 'global' ? 'global' : 'local',
        description: str(e.description),
        content: str(e.content),
        ...base,
      })
    } else if (e.action === 'update') edits.push({ action: 'update', name, content: str(e.content), ...base })
    else if (e.action === 'add_reference') edits.push({ action: 'add_reference', name, file: str(e.file), content: str(e.content), ...base })
    else edits.push({ action: 'archive', name, ...base })
  }
  return { summary, edits }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function extractObject(text: string): unknown {
  const direct = tryJson(text)
  if (direct && typeof direct === 'object') {
    const d = direct as Record<string, unknown>
    if (Array.isArray(d.edits)) return d
    if (typeof d.result === 'string') return extractObject(d.result)
  }
  const stripped = text.replace(/```(?:json)?/g, '')
  let start = stripped.indexOf('{')
  while (start >= 0) {
    const end = stripped.lastIndexOf('}')
    if (end <= start) return undefined
    const candidate = tryJson(stripped.slice(start, end + 1))
    if (candidate && typeof candidate === 'object' && Array.isArray((candidate as Record<string, unknown>).edits)) return candidate
    start = stripped.indexOf('{', start + 1)
  }
  return undefined
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
