import { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import type { Reader, SessionRef, Turn, DiscoverOptions, ToolCall } from '../types.ts'
import { firstStringArg, parseJsonSafe } from '../util/jsonl.ts'

type MessageData = { role?: string; path?: { cwd?: string }; time?: { created?: number } }
type PartData = {
  type?: string
  text?: string
  tool?: string
  state?: { status?: string; input?: unknown }
}

export class OpenCodeReader implements Reader {
  readonly client = 'opencode' as const
  constructor(private dbPath: string) {}

  private open(): Database | undefined {
    try {
      return new Database(this.dbPath, { readonly: true })
    } catch {
      return undefined
    }
  }

  async discover(opts: DiscoverOptions): Promise<SessionRef[]> {
    const out: SessionRef[] = []
    try {
      await stat(this.dbPath)
    } catch {
      return out
    }
    const db = this.open()
    if (!db) return out
    try {
      const rows = db
        .query<{ id: string; directory: string | null; time_updated: number | null; time_created: number }, [number]>(
          'select id, directory, time_updated, time_created from session where parent_id is null and coalesce(time_updated, time_created) >= ?',
        )
        .all(opts.since)
      for (const r of rows) {
        out.push({
          client: 'opencode',
          id: r.id,
          path: this.dbPath,
          project: r.directory ?? '',
          mtime: r.time_updated ?? r.time_created,
        })
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
    const db = this.open()
    if (!db) return turns
    try {
      const messages = db
        .query<{ id: string; time_created: number; data: string }, [string]>(
          'select id, time_created, data from message where session_id = ? order by time_created',
        )
        .all(ref.id)
      const partsStmt = db.query<{ data: string }, [string]>('select data from part where message_id = ? order by id')
      let project = ref.project
      for (const m of messages) {
        const data = (parseJsonSafe(m.data) ?? {}) as MessageData
        const role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : undefined
        if (!role) continue
        if (!project && data.path?.cwd) project = data.path.cwd
        const tools: ToolCall[] = []
        const texts: string[] = []
        for (const p of partsStmt.all(m.id)) {
          const part = (parseJsonSafe(p.data) ?? {}) as PartData
          if (part.type === 'text' && part.text) texts.push(part.text)
          else if (part.type === 'tool') {
            tools.push({
              name: part.tool ?? 'tool',
              arg: firstStringArg(part.state?.input),
              failed: part.state?.status === 'error' ? true : undefined,
            })
          }
        }
        const text = texts.join('\n').trim()
        if (!text && tools.length === 0) continue
        turns.push({
          ref: `opencode:${ref.id}:${m.id}`,
          client: 'opencode',
          session: ref.id,
          project,
          ts: data.time?.created ?? m.time_created,
          role,
          text,
          tools,
          sidechain: false,
        })
      }
      for (const t of turns) t.project = project
    } catch {
      return turns
    } finally {
      db.close()
    }
    return turns
  }
}
