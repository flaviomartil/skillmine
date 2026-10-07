import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { Reader, SessionRef, Turn, DiscoverOptions, ToolCall } from '../types.ts'
import { readJsonl, firstStringArg, toMillis } from '../util/jsonl.ts'

type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; is_error?: boolean }

type Line = {
  type: string
  uuid?: string
  sessionId?: string
  cwd?: string
  timestamp?: string | number
  isSidechain?: boolean
  agentId?: string
  message?: { role?: string; content?: string | Block[] }
}

export function stripInjected(text: string): string {
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<local-command-[\s\S]*?<\/local-command-[a-z-]+>/g, '')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/\[SYSTEM NOTIFICATION[^\]]*\][^\n]*\n?/g, '')
    .replace(/\[Image(?::| #\d+)[^\]]*\]/g, '')
    .trim()
  if (/^<[a-z_-]+>[\s\S]*<\/[a-z_-]+>$/i.test(cleaned)) return ''
  return cleaned
}

export class ClaudeReader implements Reader {
  readonly client = 'claude' as const
  constructor(private root: string) {}

  async discover(opts: DiscoverOptions): Promise<SessionRef[]> {
    const out: SessionRef[] = []
    let dirs: string[]
    try {
      dirs = await readdir(this.root)
    } catch {
      return out
    }
    for (const d of dirs) {
      const dir = join(this.root, d)
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const path = join(dir, f)
        let st
        try {
          st = await stat(path)
        } catch {
          continue
        }
        if (!st.isFile() || st.mtimeMs < opts.since) continue
        out.push({ client: 'claude', id: basename(f, '.jsonl'), path, project: '', mtime: st.mtimeMs })
      }
    }
    return out
  }

  async read(ref: SessionRef): Promise<Turn[]> {
    const turns: Turn[] = []
    const pendingTools = new Map<string, ToolCall>()
    let project = ref.project
    for await (const line of readJsonl<Line>(ref.path)) {
      if (line.type !== 'user' && line.type !== 'assistant') continue
      if (!project && line.cwd) project = line.cwd
      const content = line.message?.content
      const sidechain = Boolean(line.isSidechain || line.agentId)
      const ts = toMillis(line.timestamp)
      const tools: ToolCall[] = []
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') text += (text ? '\n' : '') + b.text
          else if (b.type === 'tool_use') {
            const call: ToolCall = { name: b.name, arg: firstStringArg(b.input) }
            tools.push(call)
            pendingTools.set(b.id, call)
          } else if (b.type === 'tool_result') {
            const call = pendingTools.get(b.tool_use_id)
            if (call && b.is_error) call.failed = true
          }
        }
      }
      if (line.type === 'user') text = stripInjected(text)
      if (/^\[Historical tool_(call|result)/.test(text)) text = ''
      if (!text && tools.length === 0) continue
      turns.push({
        ref: `claude:${ref.id}:${line.uuid ?? turns.length}`,
        client: 'claude',
        session: ref.id,
        project,
        ts,
        role: line.type,
        text,
        tools,
        sidechain,
      })
    }
    for (const t of turns) t.project = project
    return turns
  }
}
