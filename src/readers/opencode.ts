import { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import type { Reader, SessionRef, Turn, DiscoverOptions, ToolCall } from '../types.ts'
import { firstStringArg, parseJsonSafe } from '../util/jsonl.ts'

type MessageData = { role?: string; path?: { cwd?: string }; time?: { created?: number } }
type PartData = {
  type?: string
  text?: string
  tool?: string
  name?: string
  state?: { status?: string; input?: unknown; time?: { start?: number; end?: number } }
}
type V2MessageData = {
  time?: { created?: number; completed?: number }
  text?: string
  content?: PartData[]
}

function tableNames(db: Database): Set<string> {
  const rows = db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all()
  return new Set(rows.map((r) => r.name))
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
      const tables = tableNames(db)
      // Current OpenCode stores sessions in `session_v2`; older releases used `session`.
      const source = tables.has('session_v2') ? 'session_v2' : tables.has('session') ? 'session' : ''
      if (!source) return out
      const rows = db
        .query<{ id: string; directory: string | null; time_updated: number | null; time_created: number }, [number]>(
          `select id, directory, time_updated, time_created from ${source} where parent_id is null and coalesce(time_updated, time_created) >= ?`,
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
    const db = this.open()
    if (!db) return []
    try {
      const tables = tableNames(db)
      if (tables.has('session_message')) return this.readV2(db, ref)
      return this.readLegacy(db, ref)
    } catch {
      return []
    } finally {
      db.close()
    }
  }

  private readV2(db: Database, ref: SessionRef): Turn[] {
    const turns: Turn[] = []
    const rows = db
      .query<{ id: string; type: string; data: string }, [string]>(
        'select id, type, data from session_message where session_id = ? order by seq, time_created',
      )
      .all(ref.id)
    for (const row of rows) {
      const role = row.type === 'user' ? 'user' : row.type === 'assistant' ? 'assistant' : undefined
      if (!role) continue
      const data = (parseJsonSafe(row.data) ?? {}) as V2MessageData
      const texts: string[] = []
      const tools: ToolCall[] = []
      let ts = data.time?.created ?? 0
      if (typeof data.text === 'string' && data.text.trim()) texts.push(data.text)
      for (const part of data.content ?? []) {
        if (part.type === 'text' && part.text) texts.push(part.text)
        else if (part.type === 'tool') {
          const at = part.state?.time?.end ?? part.state?.time?.start
          if (typeof at === 'number' && Number.isFinite(at) && at > ts) ts = at
          tools.push({
            name: part.name ?? part.tool ?? 'tool',
            arg: firstStringArg(part.state?.input),
            failed: part.state?.status === 'error' ? true : undefined,
          })
        }
      }
      const text = texts.join('\n').trim()
      if (!text && tools.length === 0) continue
      turns.push({
        ref: `opencode:${ref.id}:${row.id}`,
        client: 'opencode',
        session: ref.id,
        project: ref.project,
        ts,
        approxTs: true,
        turnId: row.id,
        role,
        text,
        tools,
        sidechain: false,
      })
    }
    return turns
  }

  private readLegacy(db: Database, ref: SessionRef): Turn[] {
    const turns: Turn[] = []
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
      let ts = data.time?.created ?? m.time_created
      for (const p of partsStmt.all(m.id)) {
        const part = (parseJsonSafe(p.data) ?? {}) as PartData
        if (part.type === 'text' && part.text) texts.push(part.text)
        else if (part.type === 'tool') {
          const at = part.state?.time?.end ?? part.state?.time?.start
          if (typeof at === 'number' && Number.isFinite(at) && at > ts) ts = at
          tools.push({
            name: part.name ?? part.tool ?? 'tool',
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
        ts,
        approxTs: true,
        turnId: m.id,
        role,
        text,
        tools,
        sidechain: false,
      })
    }
    for (const t of turns) t.project = project
    return turns
  }
}
