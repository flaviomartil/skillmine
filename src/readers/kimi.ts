import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Reader, SessionRef, Turn, DiscoverOptions, ToolCall } from '../types.ts'
import { readJsonl, firstStringArg, parseJsonSafe, cut } from '../util/jsonl.ts'

type Part = { type?: string; text?: string }
type Line = {
  role: string
  content?: string | Part[]
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
  tool_call_id?: string
}

export function kimiDirFor(path: string): string {
  return createHash('md5').update(path).digest('hex')
}

export function kimiToolFailed(text: string): boolean {
  const head = text.slice(0, 300)
  if (/<system>[^<]*(failed|exited with code [1-9]|error)/i.test(head)) return true
  return /<system>/.test(head) ? !/successfully/i.test(head) : false
}

export class KimiReader implements Reader {
  readonly client = 'kimi' as const
  constructor(private root: string, private configPath: string) {}

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
    const projects = await this.projects()
    let dirs: string[]
    try {
      dirs = await readdir(this.root)
    } catch {
      return out
    }
    for (const d of dirs) {
      const project = projects.get(d) ?? ''
      let sessions: string[]
      try {
        sessions = await readdir(join(this.root, d))
      } catch {
        continue
      }
      for (const s of sessions) {
        const path = join(this.root, d, s, 'context.jsonl')
        let st
        try {
          st = await stat(path)
        } catch {
          continue
        }
        if (st.mtimeMs < opts.since) continue
        out.push({ client: 'kimi', id: s, path, project, mtime: st.mtimeMs })
      }
    }
    return out
  }

  async read(ref: SessionRef): Promise<Turn[]> {
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
