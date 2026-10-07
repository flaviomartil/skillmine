import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { Reader, SessionRef, Turn, DiscoverOptions, ToolCall } from '../types.ts'
import { readJsonl, firstStringArg, parseJsonSafe, toMillis, cut } from '../util/jsonl.ts'

type Line = {
  timestamp?: string
  type: string
  payload?: Record<string, unknown>
}

const FAILURE = /"exit_code":\s*[1-9]|exit code:? [1-9]|^\s*error\b|command failed|traceback/i

export function looksInjected(text: string): boolean {
  const t = text.trimStart()
  return (t.startsWith('<') && /<\/[a-z_]+>\s*$/i.test(t.trimEnd())) || t.startsWith('# AGENTS.md')
}

export function toolFailed(output: string): boolean {
  return FAILURE.test(output.slice(0, 400))
}

async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory() && depth > 0) yield* walk(p, depth - 1)
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) yield p
  }
}

export class CodexReader implements Reader {
  readonly client = 'codex' as const
  constructor(private root: string) {}

  async discover(opts: DiscoverOptions): Promise<SessionRef[]> {
    const out: SessionRef[] = []
    for await (const path of walk(this.root, 4)) {
      let st
      try {
        st = await stat(path)
      } catch {
        continue
      }
      if (st.mtimeMs < opts.since) continue
      out.push({ client: 'codex', id: basename(path, '.jsonl'), path, project: '', mtime: st.mtimeMs })
    }
    return out
  }

  async read(ref: SessionRef): Promise<Turn[]> {
    const turns: Turn[] = []
    const calls = new Map<string, ToolCall>()
    let project = ref.project
    let session = ref.id
    let lastAssistant: Turn | undefined
    let n = 0
    for await (const line of readJsonl<Line>(ref.path)) {
      const p = line.payload ?? {}
      const ts = toMillis(line.timestamp)
      if (line.type === 'session_meta') {
        if (typeof p.cwd === 'string') project = p.cwd
        if (typeof p.id === 'string') session = p.id
        continue
      }
      if (line.type !== 'response_item') continue
      const kind = p.type
      if (kind === 'message') {
        const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : undefined
        if (!role) continue
        const text = contentText(p.content)
        if (!text || (role === 'user' && looksInjected(text))) continue
        const turn: Turn = {
          ref: `codex:${session}:${n++}`,
          client: 'codex',
          session,
          project,
          ts,
          role,
          text,
          tools: [],
          sidechain: false,
        }
        turns.push(turn)
        if (role === 'assistant') lastAssistant = turn
      } else if (kind === 'function_call' || kind === 'custom_tool_call') {
        const name = typeof p.name === 'string' ? p.name : 'tool'
        const raw = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : ''
        const parsed = parseJsonSafe(raw)
        const call: ToolCall = { name, arg: parsed === undefined ? cut(raw, 60) : firstStringArg(parsed) }
        if (typeof p.call_id === 'string') calls.set(p.call_id, call)
        if (!lastAssistant || lastAssistant.ts + 10 * 60_000 < ts) {
          lastAssistant = {
            ref: `codex:${session}:${n++}`,
            client: 'codex',
            session,
            project,
            ts,
            role: 'assistant',
            text: '',
            tools: [],
            sidechain: false,
          }
          turns.push(lastAssistant)
        }
        lastAssistant.tools.push(call)
      } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const call = typeof p.call_id === 'string' ? calls.get(p.call_id) : undefined
        const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
        if (call && toolFailed(output)) call.failed = true
      }
    }
    for (const t of turns) {
      t.project = project
      t.session = session
    }
    return turns
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') parts.push((c as { text: string }).text)
  }
  return parts.join('\n').trim()
}
