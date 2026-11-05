import { Database } from 'bun:sqlite'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Reader, SessionRef, Turn, DiscoverOptions, ToolCall } from '../types.ts'
import { protoStrings, longestAt, longest } from '../util/proto.ts'
import { readJsonl, firstStringArg, parseJsonSafe, toMillis, cut } from '../util/jsonl.ts'

export const STEP_USER = 14
export const STEP_ASSISTANT = 15
export const STEP_EVENT = 17
export const STEP_CONTEXT = 90

const USER_TEXT = [19, 2]
const ASSISTANT_TEXT = [20, 1]
const EVENT_TEXT = [24, 3, 2]

type TranscriptLine = {
  role?: string
  source?: string
  author?: string
  type?: string
  content?: unknown
  created_at?: unknown
  timestamp?: unknown
  is_error?: boolean
  error?: unknown
  tool_calls?: {
    id?: string
    name?: string
    args?: unknown
    arguments?: unknown
    input?: unknown
  }[]
}

export function workspaceFromUris(uris: string): string {
  try {
    const list = JSON.parse(uris) as string[]
    const first = list[0]
    if (!first) return ''
    return first.startsWith('file://') ? decodeURIComponent(first.slice('file://'.length)) : first
  } catch {
    return ''
  }
}

function transcriptPath(root: string, id: string): string {
  return join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => {
      if (typeof p === 'string') return p
      if (p && typeof p === 'object') {
        const o = p as { type?: string; text?: string }
        if (!o.type || o.type === 'text' || o.type === 'input_text' || o.type === 'output_text') {
          return typeof o.text === 'string' ? o.text : ''
        }
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function transcriptOutputFailed(output: string): boolean {
  const head = output.slice(0, 400)
  return /"exit_code":\s*[1-9]|exit code:?\s*[1-9]|exited with code [1-9]|^\s*error\b|command failed|traceback/im.test(head)
}

export class AntigravityReader implements Reader {
  readonly client = 'antigravity' as const
  constructor(private root: string) {}

  async discover(opts: DiscoverOptions): Promise<SessionRef[]> {
    const out: SessionRef[] = []
    const seen = new Set<string>()
    const childIds = new Set<string>()
    const summaries = join(this.root, 'conversation_summaries.db')
    let hasSummaries = false
    try {
      await stat(summaries)
      hasSummaries = true
    } catch {
      hasSummaries = false
    }
    if (hasSummaries) {
      let db: Database | undefined
      try {
        db = new Database(summaries, { readonly: true })
        const rows = db
          .query<{ conversation_id: string; workspace_uris: string; last_modified_time: string; parent_conversation_id: string }, []>(
            'select conversation_id, workspace_uris, last_modified_time, parent_conversation_id from conversation_summaries',
          )
          .all()
        for (const r of rows) {
          if (r.parent_conversation_id) {
            childIds.add(r.conversation_id)
            continue
          }
          const mtime = toMillis(r.last_modified_time)
          const dbPath = join(this.root, 'conversations', `${r.conversation_id}.db`)
          let hasDb = false
          try {
            await stat(dbPath)
            hasDb = true
          } catch {
            hasDb = false
          }
          if (hasDb) {
            seen.add(r.conversation_id)
            if (mtime >= opts.since) {
              out.push({ client: 'antigravity', id: r.conversation_id, path: dbPath, project: workspaceFromUris(r.workspace_uris), mtime })
            }
            continue
          }
          const tPath = transcriptPath(this.root, r.conversation_id)
          try {
            const st = await stat(tPath)
            seen.add(r.conversation_id)
            const eff = mtime > 0 ? mtime : st.mtimeMs
            if (eff >= opts.since) {
              out.push({ client: 'antigravity', id: r.conversation_id, path: tPath, project: workspaceFromUris(r.workspace_uris), mtime: eff })
            }
          } catch {}
        }
      } catch {
      } finally {
        db?.close()
      }
    }

    let brainDirs: string[] = []
    try {
      brainDirs = await readdir(join(this.root, 'brain'))
    } catch {
      brainDirs = []
    }
    for (const id of brainDirs) {
      if (seen.has(id) || childIds.has(id)) continue
      const tPath = transcriptPath(this.root, id)
      try {
        const st = await stat(tPath)
        if (st.mtimeMs < opts.since) continue
        seen.add(id)
        out.push({ client: 'antigravity', id, path: tPath, project: '', mtime: st.mtimeMs })
      } catch {
        continue
      }
    }
    return out
  }

  async read(ref: SessionRef): Promise<Turn[]> {
    if (ref.path.endsWith('.jsonl')) return this.readTranscript(ref)
    return this.readDb(ref)
  }

  private async readTranscript(ref: SessionRef): Promise<Turn[]> {
    const turns: Turn[] = []
    let project = ref.project
    let lastCall: ToolCall | undefined
    let n = 0
    for await (const line of readJsonl<TranscriptLine>(ref.path)) {
      const idx = n++
      const who = String(line.role ?? line.type ?? line.source ?? line.author ?? '').toLowerCase()
      const text = contentText(line.content)
      const rawTs = toMillis(line.created_at ?? line.timestamp)
      const ts = rawTs > 0 ? rawTs : ref.mtime
      const approxTs = !(rawTs > 0)
      if (who === 'tool' || who === 'tool_result' || who === 'function') {
        if (lastCall) {
          const failed = line.is_error === true || (line.error !== undefined && line.error !== null) || transcriptOutputFailed(text)
          if (failed) lastCall.failed = true
        }
        continue
      }
      const role: 'user' | 'assistant' = who === 'user' || who === 'human' || who === 'user_input' || who === 'user_explicit' ? 'user' : 'assistant'
      const tools: ToolCall[] = []
      for (const tc of line.tool_calls ?? []) {
        const args = tc.args ?? tc.arguments ?? tc.input
        if (!project && args && typeof args === 'object') {
          const o = args as Record<string, unknown>
          const cwd = o.Cwd ?? o.cwd
          if (typeof cwd === 'string' && cwd) project = cwd
        }
        const parsed = typeof args === 'string' ? parseJsonSafe(args) : args
        const call: ToolCall = {
          name: tc.name ?? 'tool',
          arg: parsed === undefined ? cut(String(args ?? ''), 60) : firstStringArg(parsed),
        }
        tools.push(call)
      }
      if (!text && tools.length === 0) continue
      if (tools.length > 0) lastCall = tools[tools.length - 1]
      turns.push({
        ref: `antigravity:${ref.id}:${idx}`,
        client: 'antigravity',
        session: ref.id,
        project,
        ts,
        approxTs,
        role,
        text,
        tools,
        sidechain: false,
      })
    }
    if (project && !ref.project) {
      for (const t of turns) if (!t.project) t.project = project
    }
    return turns
  }

  private async readDb(ref: SessionRef): Promise<Turn[]> {
    const turns: Turn[] = []
    let db: Database
    try {
      db = new Database(ref.path, { readonly: true })
    } catch {
      return turns
    }
    try {
      const rows = db
        .query<{ idx: number; step_type: number; step_payload: Uint8Array | null }, []>(
          'select idx, step_type, step_payload from steps order by idx',
        )
        .all()
      let lastAssistant: Turn | undefined
      for (const r of rows) {
        if (!r.step_payload) continue
        const strings = protoStrings(new Uint8Array(r.step_payload))
        if (r.step_type === STEP_USER) {
          const text = (longestAt(strings, USER_TEXT) ?? longest(strings) ?? '').trim()
          if (!text) continue
          turns.push(turn(ref, r.idx, 'user', text))
          lastAssistant = undefined
        } else if (r.step_type === STEP_ASSISTANT) {
          const text = (longestAt(strings, ASSISTANT_TEXT) ?? longest(strings) ?? '').trim()
          if (!text) continue
          lastAssistant = turn(ref, r.idx, 'assistant', text)
          turns.push(lastAssistant)
        } else if (r.step_type === STEP_EVENT) {
          const text = longestAt(strings, EVENT_TEXT) ?? longest(strings) ?? ''
          if (!text) continue
          if (!lastAssistant) {
            lastAssistant = turn(ref, r.idx, 'assistant', '')
            turns.push(lastAssistant)
          }
          lastAssistant.tools.push({ name: 'event', arg: cut(text, 60), failed: /error|fail/i.test(text) ? true : undefined })
        }
      }
    } catch {
      return turns
    } finally {
      db.close()
    }
    return turns
  }
}

function turn(ref: SessionRef, idx: number, role: 'user' | 'assistant', text: string): Turn {
  return {
    ref: `antigravity:${ref.id}:${idx}`,
    client: 'antigravity',
    session: ref.id,
    project: ref.project,
    ts: ref.mtime,
    approxTs: true,
    role,
    text,
    tools: [],
    sidechain: false,
  }
}
