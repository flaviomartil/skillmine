export type Client = 'claude' | 'codex' | 'kimi' | 'opencode' | 'antigravity'

export const CLIENTS: readonly Client[] = ['claude', 'codex', 'kimi', 'opencode', 'antigravity']

export type ToolCall = {
  name: string
  arg: string
  failed?: boolean
}

export type Turn = {
  ref: string
  client: Client
  session: string
  project: string
  ts: number
  role: 'user' | 'assistant'
  text: string
  tools: ToolCall[]
  sidechain: boolean
}

export type SessionRef = {
  client: Client
  id: string
  path: string
  project: string
  mtime: number
}

export type DiscoverOptions = {
  since: number
  project?: string
}

export interface Reader {
  readonly client: Client
  discover(opts: DiscoverOptions): Promise<SessionRef[]>
  read(ref: SessionRef): Promise<Turn[]>
}

export type Signal = 'correction' | 'fail-then-pass' | 'explanation' | 'decision'

export type Window = {
  id: string
  client: Client
  session: string
  project: string
  turns: Turn[]
  digest: string
  signals: Signal[]
  start: number
  end: number
}
