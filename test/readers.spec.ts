import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { createReaders, type ReaderPaths } from '../src/readers/index.ts'
import { kimiDirFor, kimiToolFailed } from '../src/readers/kimi.ts'
import { looksInjected, toolFailed } from '../src/readers/codex.ts'
import { stripInjected } from '../src/readers/claude.ts'
import { STEP_USER, STEP_ASSISTANT, STEP_EVENT, STEP_CONTEXT, workspaceFromUris } from '../src/readers/antigravity.ts'
import { field, concat } from './proto-helpers.ts'
import { mine } from '../src/mine.ts'

let home: string
let paths: ReaderPaths
const NOW = Date.parse('2026-10-07T12:00:00Z')
const RECENT = new Date(NOW - 3600_000)
const OLD = new Date(NOW - 90 * 86_400_000)

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'skillmine-'))
  paths = {
    claude: join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
    kimi: join(home, '.kimi', 'sessions'),
    kimiConfig: join(home, '.kimi', 'kimi.json'),
    opencode: join(home, '.local', 'share', 'opencode', 'opencode.db'),
    antigravity: join(home, '.gemini', 'antigravity-cli'),
  }

  const cdir = join(paths.claude, '-home-u-proj')
  await mkdir(join(cdir, 'sess1', 'subagents'), { recursive: true })
  const claudeRows = [
    { type: 'summary', summary: 'x' },
    { type: 'user', uuid: 'u1', sessionId: 'sess1', cwd: '/home/u/proj', timestamp: RECENT.toISOString(), message: { role: 'user', content: 'Why does the worker hang? <system-reminder>ignore</system-reminder>' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'sess1', cwd: '/home/u/proj', timestamp: RECENT.toISOString(), message: { role: 'assistant', content: [{ type: 'thinking' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }] } },
    { type: 'user', uuid: 'u2', sessionId: 'sess1', timestamp: RECENT.toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } },
    { type: 'assistant', uuid: 'a2', sessionId: 'sess1', timestamp: RECENT.toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm test' } }] } },
    { type: 'user', uuid: 'u3', sessionId: 'sess1', timestamp: RECENT.toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2' }] } },
    { type: 'assistant', uuid: 'a3', sessionId: 'sess1', timestamp: RECENT.toISOString(), isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain text' }] } },
    { type: 'assistant', uuid: 'a4', sessionId: 'sess1', timestamp: RECENT.toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'The first run failed because the lock file was stale; removing it let the second run pass.' }] } },
    { type: 'assistant', uuid: 'a5', sessionId: 'sess1', timestamp: RECENT.toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '[Historical tool_call; kimi; 2026-02-13T14:12:59Z] {"tool":"WriteFile"}' }] } },
  ]
  await writeFile(join(cdir, 'sess1.jsonl'), jsonl(claudeRows))
  await writeFile(join(cdir, 'old.jsonl'), jsonl(claudeRows))
  await utimes(join(cdir, 'old.jsonl'), OLD, OLD)
  await writeFile(join(cdir, 'sess1', 'subagents', 'agent-1.jsonl'), jsonl(claudeRows))

  const xdir = join(paths.codex, '2026', '10', '07')
  await mkdir(xdir, { recursive: true })
  const ts = RECENT.toISOString()
  await writeFile(
    join(xdir, 'rollout-2026-10-07-abc.jsonl'),
    jsonl([
      { timestamp: ts, type: 'session_meta', payload: { id: 'cx1', cwd: '/home/u/proj' } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/x</environment_context>' }] } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the flaky test' }] } },
      { timestamp: ts, type: 'response_item', payload: { type: 'reasoning', summary: [] } },
      { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'pytest'] }) } },
      { timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"exit_code": 1, "output": "FAILED"}' } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The test fails because the fixture is shared.' }] } },
    ]),
  )

  const kproj = '/home/u/kimiproj'
  const kdir = join(paths.kimi, kimiDirFor(kproj), 'ks1')
  await mkdir(kdir, { recursive: true })
  await writeFile(paths.kimiConfig, JSON.stringify({ work_dirs: [{ path: kproj }] }))
  await writeFile(
    join(kdir, 'context.jsonl'),
    jsonl([
      { role: '_system_prompt', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'List the files' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Listing.' }], tool_calls: [{ id: 'k1', type: 'function', function: { name: 'Shell', arguments: JSON.stringify({ command: 'ls' }) } }] },
      { role: 'tool', tool_call_id: 'k1', content: [{ type: 'text', text: '<system>Command failed with exit code 2.</system>' }] },
      { role: '_usage', content: null },
      { role: 'assistant', content: [{ type: 'text', text: 'It failed because the directory moved.' }] },
    ]),
  )
  await writeFile(join(kdir, 'context_sub_1.jsonl'), jsonl([{ role: 'user', content: 'sub' }]))

  await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true })
  const db = new Database(paths.opencode)
  db.run('create table session (id text primary key, parent_id text, directory text, time_created integer, time_updated integer)')
  db.run('create table message (id text primary key, session_id text, time_created integer, data text)')
  db.run('create table part (id text primary key, message_id text, session_id text, data text)')
  db.run("insert into session values ('os1', null, '/home/u/oc', ?, ?)", [NOW - 1000, NOW - 500])
  db.run("insert into session values ('os2', 'os1', '/home/u/oc', ?, ?)", [NOW - 1000, NOW - 500])
  db.run("insert into message values ('m1', 'os1', ?, ?)", [NOW - 900, JSON.stringify({ role: 'user', path: { cwd: '/home/u/oc' }, time: { created: NOW - 900 } })])
  db.run("insert into message values ('m2', 'os1', ?, ?)", [NOW - 800, JSON.stringify({ role: 'assistant', time: { created: NOW - 800 } })])
  db.run("insert into part values ('p1', 'm1', 'os1', ?)", [JSON.stringify({ type: 'text', text: 'Deploy it' })])
  db.run("insert into part values ('p2', 'm2', 'os1', ?)", [JSON.stringify({ type: 'reasoning', text: 'hmm' })])
  db.run("insert into part values ('p3', 'm2', 'os1', ?)", [JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'docker compose up' } } })])
  db.run("insert into part values ('p4', 'm2', 'os1', ?)", [JSON.stringify({ type: 'text', text: 'Compose failed; port in use.' })])
  db.close()

  await mkdir(join(paths.antigravity, 'conversations'), { recursive: true })
  const sdb = new Database(join(paths.antigravity, 'conversation_summaries.db'))
  sdb.run('create table conversation_summaries (conversation_id text primary key, workspace_uris text, last_modified_time text, parent_conversation_id text)')
  sdb.run("insert into conversation_summaries values ('ag1', '[\"file:///home/u/ag\"]', ?, '')", [RECENT.toISOString()])
  sdb.run("insert into conversation_summaries values ('ag2', '[\"file:///home/u/ag\"]', ?, 'ag1')", [RECENT.toISOString()])
  sdb.close()
  const cdb = new Database(join(paths.antigravity, 'conversations', 'ag1.db'))
  cdb.run('create table steps (idx integer, step_type integer, status integer, step_payload blob, step_format integer)')
  const userPayload = concat(field(5, field(12, 'd4ecdc44-f990-46a3-86de-2d2691ac6bc7')), field(19, field(2, 'Why does the harness reload twice on startup?')))
  const ctxPayload = field(103, field(1, 'AI Harness active for antigravity. Load RULES.md first.'))
  const eventPayload = field(24, field(3, field(2, 'API error (attempt 1): UNAVAILABLE (code 503): No capacity')))
  const botPayload = field(20, field(1, 'It reloads twice because the watcher fires on the symlink and the target.'))
  const ins = cdb.prepare('insert into steps values (?, ?, 3, ?, 0)')
  ins.run(0, STEP_USER, userPayload)
  ins.run(1, STEP_CONTEXT, ctxPayload)
  ins.run(2, STEP_EVENT, eventPayload)
  ins.run(3, STEP_ASSISTANT, botPayload)
  cdb.close()
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('claude reader', () => {
  test('discovers only recent top-level sessions', async () => {
    const refs = await createReaders(paths).claude.discover({ since: NOW - 86_400_000 })
    expect(refs.map((r) => r.id)).toEqual(['sess1'])
  })
  test('reads turns, strips injected text, marks failed tools and sidechains', async () => {
    const r = createReaders(paths).claude
    const [ref] = await r.discover({ since: NOW - 86_400_000 })
    const turns = await r.read(ref!)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'assistant'])
    expect(turns[0]!.text).toBe('Why does the worker hang?')
    expect(turns[0]!.project).toBe('/home/u/proj')
    expect(turns[1]!.tools[0]).toEqual({ name: 'Bash', arg: 'pnpm test', failed: true })
    expect(turns[2]!.tools[0]!.failed).toBeUndefined()
    expect(turns[3]!.sidechain).toBe(true)
  })
  test('stripInjected removes reminder blocks, notifications and image placeholders', () => {
    expect(stripInjected('a <system-reminder>b</system-reminder> c')).toBe('a  c')
    expect(stripInjected('<task-notification><task-id>x</task-id><result>No human input</result></task-notification>')).toBe('')
    expect(stripInjected('[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is automated.\n<task-notification>y</task-notification>')).toBe('This is automated.')
    expect(stripInjected('[Image: source: /mnt/c/x.png]')).toBe('')
    expect(stripInjected('<environment_context>\ncwd=/x\n</environment_context>')).toBe('')
    expect(stripInjected('não, veja [Image #1] a tela')).toBe('não, veja  a tela')
  })
})

describe('codex reader', () => {
  test('reads messages and attaches tool calls with failure', async () => {
    const r = createReaders(paths).codex
    const refs = await r.discover({ since: NOW - 86_400_000 })
    expect(refs).toHaveLength(1)
    const turns = await r.read(refs[0]!)
    expect(turns[0]!.session).toBe('cx1')
    expect(turns[0]!.project).toBe('/home/u/proj')
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(turns[0]!.text).toBe('Fix the flaky test')
    expect(turns[1]!.tools[0]).toMatchObject({ name: 'shell', failed: true })
    expect(turns[2]!.text).toContain('fixture is shared')
  })
  test('helpers', () => {
    expect(looksInjected('<user_instructions>\nx\n</user_instructions>')).toBe(true)
    expect(looksInjected('Fix <b> this')).toBe(false)
    expect(toolFailed('{"exit_code": 0}')).toBe(false)
    expect(toolFailed('Traceback (most recent call last)')).toBe(true)
  })
})

describe('kimi reader', () => {
  test('maps the md5 dir to the project and reads tool failures', async () => {
    const r = createReaders(paths).kimi
    const refs = await r.discover({ since: NOW - 86_400_000 })
    expect(refs).toHaveLength(1)
    expect(refs[0]!.project).toBe('/home/u/kimiproj')
    const turns = await r.read(refs[0]!)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(turns[1]!.tools[0]).toEqual({ name: 'Shell', arg: 'ls', failed: true })
  })
  test('failure heuristic', () => {
    expect(kimiToolFailed('<system>Command executed successfully.</system>\nout')).toBe(false)
    expect(kimiToolFailed('<system>Command exited with code 1</system>')).toBe(true)
    expect(kimiToolFailed('plain output')).toBe(false)
  })
})

describe('opencode reader', () => {
  test('skips child sessions and merges parts', async () => {
    const r = createReaders(paths).opencode
    const refs = await r.discover({ since: NOW - 86_400_000 })
    expect(refs.map((x) => x.id)).toEqual(['os1'])
    const turns = await r.read(refs[0]!)
    expect(turns).toHaveLength(2)
    expect(turns[0]!.text).toBe('Deploy it')
    expect(turns[1]!.text).toBe('Compose failed; port in use.')
    expect(turns[1]!.tools[0]).toEqual({ name: 'bash', arg: 'docker compose up', failed: true })
    expect(turns[1]!.project).toBe('/home/u/oc')
  })
})

describe('antigravity reader', () => {
  test('reads user, assistant and event steps from protobuf payloads', async () => {
    const r = createReaders(paths).antigravity
    const refs = await r.discover({ since: NOW - 86_400_000 })
    expect(refs.map((x) => x.id)).toEqual(['ag1'])
    expect(refs[0]!.project).toBe('/home/u/ag')
    const turns = await r.read(refs[0]!)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(turns[0]!.text).toBe('Why does the harness reload twice on startup?')
    expect(turns[1]!.tools[0]).toMatchObject({ name: 'event', failed: true })
    expect(turns[2]!.text).toContain('symlink')
  })
  test('workspaceFromUris', () => {
    expect(workspaceFromUris('["file:///tmp/a%20b"]')).toBe('/tmp/a b')
    expect(workspaceFromUris('nope')).toBe('')
  })
})

describe('mine', () => {
  test('aggregates across clients and filters by project', async () => {
    const all = await mine(createReaders(paths), { days: 1, clients: ['claude', 'codex', 'kimi', 'opencode', 'antigravity'], now: NOW })
    expect(all.perClient.claude.sessions).toBe(1)
    expect(all.perClient.codex.sessions).toBe(1)
    expect(all.perClient.kimi.sessions).toBe(1)
    expect(all.perClient.opencode.sessions).toBe(1)
    expect(all.perClient.antigravity.sessions).toBe(1)
    expect(all.windows.length).toBeGreaterThan(0)
    const only = await mine(createReaders(paths), { days: 1, clients: ['claude', 'codex'], project: '/home/u/kimi', now: NOW })
    expect(only.perClient.claude.sessions).toBe(0)
  })
})
