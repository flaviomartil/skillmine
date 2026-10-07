import { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Reader, SessionRef, Turn, DiscoverOptions } from '../types.ts'
import { protoStrings, longestAt, longest } from '../util/proto.ts'
import { toMillis, cut } from '../util/jsonl.ts'

export const STEP_USER = 14
export const STEP_ASSISTANT = 15
export const STEP_EVENT = 17
export const STEP_CONTEXT = 90

const USER_TEXT = [19, 2]
const ASSISTANT_TEXT = [20, 1]
const EVENT_TEXT = [24, 3, 2]

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

export class AntigravityReader implements Reader {
  readonly client = 'antigravity' as const
  constructor(private root: string) {}

  async discover(opts: DiscoverOptions): Promise<SessionRef[]> {
    const out: SessionRef[] = []
    const summaries = join(this.root, 'conversation_summaries.db')
    try {
      await stat(summaries)
    } catch {
      return out
    }
    let db: Database
    try {
      db = new Database(summaries, { readonly: true })
    } catch {
      return out
    }
    try {
      const rows = db
        .query<{ conversation_id: string; workspace_uris: string; last_modified_time: string; parent_conversation_id: string }, []>(
          "select conversation_id, workspace_uris, last_modified_time, parent_conversation_id from conversation_summaries where parent_conversation_id = ''",
        )
        .all()
      for (const r of rows) {
        const mtime = toMillis(r.last_modified_time)
        if (mtime < opts.since) continue
        const path = join(this.root, 'conversations', `${r.conversation_id}.db`)
        try {
          await stat(path)
        } catch {
          continue
        }
        out.push({ client: 'antigravity', id: r.conversation_id, path, project: workspaceFromUris(r.workspace_uris), mtime })
      }
    } catch {
      return out
    } finally {
      db.close()
    }
    return out
  }

  async read(ref: SessionRef): Promise<Turn[]> {
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
    role,
    text,
    tools: [],
    sidechain: false,
  }
}
