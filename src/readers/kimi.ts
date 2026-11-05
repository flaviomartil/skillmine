import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Reader, SessionRef, Turn, DiscoverOptions, ToolCall } from '../types.ts'
import { readJsonl, firstStringArg, parseJsonSafe, cut, toMillis } from '../util/jsonl.ts'

type Part = { type?: string; text?: string }
type Line = {
  role?: string
  content?: string | Part[]
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
  tool_call_id?: string
  type?: string
  time?: unknown
  timestamp?: unknown
  message?: {
    role?: string
    content?: string | Part[]
    origin?: { kind?: string; trigger?: string }
    toolCalls?: { id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: string } }[]
    tool_calls?: { id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: string } }[]
    toolCallId?: string
    tool_call_id?: string
    isError?: boolean
  }
  event?: {
    type?: string
    uuid?: string
    stepUuid?: string
    part?: Part
    toolCallId?: string
    name?: string
    args?: unknown
    result?: { output?: string | Part[]; isError?: boolean }
  }
}

export function kimiDirFor(path: string): string {
  return createHash('md5').update(path).digest('hex')
}

export function kimiToolFailed(text: string): boolean {
  const head = text.slice(0, 300)
  if (/<system>[^<]*(failed|exited with code [1-9]|error)/i.test(head)) return true
  return /<system>/.test(head) ? !/successfully/i.test(head) : false
}

async function readStateMeta(sessionDir: string): Promise<{ cwd: string; updated: number }> {
  try {
    const v = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')) as { cwd?: unknown; workDir?: unknown; updatedAt?: unknown }
    const cwd = typeof v.cwd === 'string' ? v.cwd : typeof v.workDir === 'string' ? v.workDir : ''
    const updated = toMillis(v.updatedAt)
    return { cwd, updated }
  } catch {
    return { cwd: '', updated: 0 }
  }
}

export class KimiReader implements Reader {
  readonly client = 'kimi' as const
  constructor(
    private root: string,
    private configPath: string,
    private codeRoot?: string,
  ) {}

  private async projects(): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    try {
      const cfg = JSON.parse(await readFile(this.configPath, 'utf8')) as { work_dirs?: { path?: string }[] }
      for (const w of cfg.work_dirs ?? []) if (w.path) map.set(kimiDirFor(w.path), w.path)
    } catch {
      return map
    }
    return map
  }

  async discover(opts: DiscoverOptions): Promise<SessionRef[]> {
    const out: SessionRef[] = []
    const seen = new Set<string>()
    const projects = await this.projects()
    const roots = Array.from(
      new Set(
        [
          this.codeRoot,
          this.root,
          join(this.root, '..', '..', '.kimi-code', 'sessions'),
          join(this.root, '..', '..', '.kimi', 'sessions'),
        ].filter((x): x is string => Boolean(x)),
      ),
    )

    const trySessionDir = async (sessionDir: string, id: string, fallbackProject: string) => {
      const wire = join(sessionDir, 'agents', 'main', 'wire.jsonl')
      try {
        const st = await stat(wire)
        const meta = await readStateMeta(sessionDir)
        const mtime = meta.updated > 0 ? meta.updated : st.mtimeMs
        if (mtime >= opts.since && !seen.has(wire)) {
          seen.add(wire)
          out.push({ client: 'kimi', id, path: wire, project: meta.cwd || fallbackProject, mtime })
        }
        return
      } catch {}

      const ctx = join(sessionDir, 'context.jsonl')
      try {
        const st = await stat(ctx)
        if (st.mtimeMs >= opts.since && !seen.has(ctx)) {
          seen.add(ctx)
          out.push({ client: 'kimi', id, path: ctx, project: fallbackProject, mtime: st.mtimeMs })
        }
      } catch {}
    }

    for (const rootDir of roots) {
      let dirs: string[]
      try {
        dirs = await readdir(rootDir)
      } catch {
        continue
      }
      for (const d of dirs) {
        const firstDir = join(rootDir, d)
        const directWire = join(firstDir, 'agents', 'main', 'wire.jsonl')
        let isDirect = false
        try {
          await stat(directWire)
          isDirect = true
        } catch {}
        if (isDirect) {
          await trySessionDir(firstDir, d, projects.get(d) ?? '')
          continue
        }
        const project = projects.get(d) ?? ''
        let sessions: string[]
        try {
          sessions = await readdir(firstDir)
        } catch {
          continue
        }
        for (const s of sessions) {
          await trySessionDir(join(firstDir, s), s, project)
        }
      }
    }
    return out
  }

  async read(ref: SessionRef): Promise<Turn[]> {
    if (ref.path.endsWith('wire.jsonl')) return this.readWire(ref)
    return this.readLegacy(ref)
  }

  private async readWire(ref: SessionRef): Promise<Turn[]> {
    const turns: Turn[] = []
    const steps = new Map<string, Turn>()
    const calls = new Map<string, ToolCall>()
    let n = 0
    const push = (role: 'user' | 'assistant', ts: number, approxTs: boolean, text: string): Turn => {
      const t: Turn = {
        ref: `kimi:${ref.id}:${n++}`,
        client: 'kimi',
        session: ref.id,
        project: ref.project,
        ts,
        approxTs,
        role,
        text,
        tools: [],
        sidechain: false,
      }
      turns.push(t)
      return t
    }

    for await (const rec of readJsonl<Line>(ref.path)) {
      const rawTs = toMillis(rec.time ?? rec.timestamp)
      const ts = rawTs > 0 ? rawTs : ref.mtime
      const approxTs = !(rawTs > 0)
      if (rec.type === 'context.append_message') {
        const m = rec.message
        if (!m || typeof m !== 'object') continue
        if (m.role === 'user') {
          const text = partsText(m.content)
          const kind = m.origin?.kind
          const real =
            !kind ||
            kind === 'user' ||
            ((kind === 'skill_activation' || kind === 'plugin_command') && m.origin?.trigger === 'user-slash' && text.startsWith('/'))
          if (real && text) push('user', ts, approxTs, text)
        } else if (m.role === 'assistant') {
          const text = partsText(m.content)
          const turn = push('assistant', ts, approxTs, text)
          for (const tc of m.toolCalls ?? m.tool_calls ?? []) {
            const raw = tc.arguments ?? tc.function?.arguments ?? ''
            const parsed = typeof raw === 'string' ? parseJsonSafe(raw) : raw
            const call: ToolCall = {
              name: tc.name ?? tc.function?.name ?? 'tool',
              arg: parsed === undefined ? cut(String(raw), 60) : firstStringArg(parsed),
            }
            if (tc.id) calls.set(tc.id, call)
            turn.tools.push(call)
          }
        } else if (m.role === 'tool') {
          const id = m.toolCallId ?? m.tool_call_id ?? ''
          const call = calls.get(id)
          if (call) {
            const body = partsText(m.content)
            if (m.isError === true || kimiToolFailed(body)) call.failed = true
          }
        }
      } else if (rec.type === 'context.append_loop_event') {
        const e = rec.event
        if (!e || typeof e !== 'object') continue
        if (e.type === 'step.begin') {
          const turn = push('assistant', ts, approxTs, '')
          if (typeof e.uuid === 'string' && e.uuid) steps.set(e.uuid, turn)
        } else if (e.type === 'content.part') {
          const turn = typeof e.stepUuid === 'string' ? steps.get(e.stepUuid) : undefined
          if (turn && e.part?.type === 'text' && typeof e.part.text === 'string') {
            turn.text += e.part.text
          }
        } else if (e.type === 'tool.call') {
          const turn = typeof e.stepUuid === 'string' ? steps.get(e.stepUuid) : undefined
          if (!turn) continue
          const raw = e.args
          const parsed = typeof raw === 'string' ? parseJsonSafe(raw) : raw
          const call: ToolCall = {
            name: e.name ?? 'tool',
            arg: parsed === undefined ? cut(String(raw ?? ''), 60) : firstStringArg(parsed),
          }
          if (typeof e.toolCallId === 'string' && e.toolCallId) calls.set(e.toolCallId, call)
          turn.tools.push(call)
        } else if (e.type === 'tool.result') {
          const call = typeof e.toolCallId === 'string' ? calls.get(e.toolCallId) : undefined
          if (call) {
            const body = partsText(e.result?.output)
            if (e.result?.isError === true || kimiToolFailed(body)) call.failed = true
          }
        }
      }
    }

    for (const t of turns) t.text = t.text.trim()
    return turns.filter((t) => Boolean(t.text) || t.tools.length > 0)
  }

  private async readLegacy(ref: SessionRef): Promise<Turn[]> {
    const turns: Turn[] = []
    const byId = new Map<string, ToolCall>()
    const queue: ToolCall[] = []
    let n = 0
    for await (const line of readJsonl<Line>(ref.path)) {
      if (line.role === 'tool') {
        const text = partsText(line.content)
        const call = (line.tool_call_id && byId.get(line.tool_call_id)) || queue.shift()
        if (call && kimiToolFailed(text)) call.failed = true
        continue
      }
      if (line.role !== 'user' && line.role !== 'assistant') continue
      const text = partsText(line.content)
      const tools: ToolCall[] = []
      for (const tc of line.tool_calls ?? []) {
        const raw = tc.function?.arguments ?? ''
        const parsed = parseJsonSafe(raw)
        const call: ToolCall = { name: tc.function?.name ?? 'tool', arg: parsed === undefined ? cut(raw, 60) : firstStringArg(parsed) }
        tools.push(call)
        if (tc.id) byId.set(tc.id, call)
        queue.push(call)
      }
      if (!text && tools.length === 0) continue
      turns.push({
        ref: `kimi:${ref.id}:${n++}`,
        client: 'kimi',
        session: ref.id,
        project: ref.project,
        ts: ref.mtime,
        approxTs: true,
        role: line.role,
        text,
        tools,
        sidechain: false,
      })
    }
    return turns
  }
}

function partsText(content: string | Part[] | undefined): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p.type === 'text' || (p.text && !p.type))
    .map((p) => p.text ?? '')
    .join('\n')
    .trim()
}
