import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Lesson, LessonAction } from '../types'
import { plannerPrompt, parsePlanOutput } from '../src/plan/prompt.ts'
import type { Edit, PlanInput } from '../src/plan/types.ts'
import { cut, firstStringArg } from '../src/util/text.ts'

const GATE_CHARS = 6000
const MARK = /\[skillmine:([a-z0-9_]+)\]/
const MAX_LESSONS = 200

const expanded = atom({ plugin: 'skillmine', key: 'expanded' } as const, [])
const lessons = atom({ plugin: 'skillmine', key: 'lessons' } as const, [])
const busy = atom({ plugin: 'skillmine', key: 'busy' } as const, null)

type LedgerEntry = { id: string; run: string; ts: number; status: string; action: LessonAction; name: string; path: string; reason: string; error?: string }
type Prepared = { passed: boolean; input: PlanInput; expected: Record<string, string> }
type ApplyResult = { applied: LedgerEntry[]; rejected: LedgerEntry[] }

const config = { cliArgv: ['skillmine'], classifier: 'jev', every: 3, cooldownMs: 20 * 60_000 }
let turns = 0
let gatedRows = 0
let lastPlanned = 0
let cwd = ''
let sessionId = ''

export function digestRows(rows: readonly SessionMessage[], max = GATE_CHARS): string {
  const lines: string[] = []
  for (const r of rows) {
    const text = cut(r.text ?? '', 1200)
    const tools = r.toolUses.length ? ` [tools: ${r.toolUses.map((t) => `${t.tool}(${firstStringArg(t.input)})${t.isError ? ' FAILED' : ''}`).join(', ')}]` : ''
    if (!text && !tools) continue
    lines.push(`${r.role}: ${text}${tools}`)
  }
  let out = lines.join('\n')
  if (out.length > max) out = out.slice(out.length - max)
  return out
}

export function verb(action: LessonAction): string {
  switch (action) {
    case 'create':
      return 'learned a new skill'
    case 'update':
      return 'updated a skill'
    case 'add_reference':
      return 'added a reference to'
    case 'archive':
      return 'archived'
  }
}

export function rowText(l: Lesson): string {
  return `🧠 Skillmine ${verb(l.action)}: ${l.name}${l.summary ? ` — ${cut(l.summary, 160)}` : ''} [skillmine:${l.id}]`
}

async function runCli($: EngineInterface, args: string[], stdin?: string, timeoutMs = 300_000) {
  const [bin, ...rest] = config.cliArgv
  return $.process.run([bin!, ...rest, ...args], { cwd: cwd || undefined, stdin, timeoutMs })
}

async function remember($: EngineInterface, lesson: Lesson): Promise<void> {
  const list = await update($, lessons, (all) => [...all, lesson].slice(-MAX_LESSONS))
  await $.store.set('lessons', list)
  const mine = list.filter((l) => l.run === lesson.run).length
  $.ui.status(`🧠 ${mine} ${mine === 1 ? 'lesson' : 'lessons'}`)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: rowText(lesson) }] } })
}

async function lessonFrom($: EngineInterface, entry: LedgerEntry, summary: string, edit: Edit | undefined, source: Lesson['source']): Promise<Lesson> {
  let body = ''
  if (edit && 'content' in edit) body = edit.content
  else {
    try {
      body = await $.fs.read(entry.path)
    } catch {
      body = ''
    }
  }
  return {
    id: entry.id,
    run: entry.run,
    ts: entry.ts,
    action: entry.action,
    name: entry.name,
    path: entry.path,
    summary,
    reason: edit?.reason ?? entry.reason ?? '',
    body: body.slice(0, 4000),
    source,
  }
}

async function settle($: EngineInterface): Promise<void> {
  await update($, busy, () => null)
  const dayAgo = (await $.clock.now()) - 86_400_000
  const n = (await read($, lessons)).filter((l) => l.ts > dayAgo).length
  $.ui.status(n ? `🧠 ${n} ${n === 1 ? 'lesson' : 'lessons'} today` : undefined)
}

async function check($: EngineInterface): Promise<void> {
  const rows = await $.session.messages()
  const fresh = rows.slice(gatedRows)
  gatedRows = rows.length
  const digest = digestRows(fresh)
  if (digest.length < 200) return
  await update($, busy, () => 'checking')
  $.ui.status('🧠 checking the chat…')
  try {
    const prep = await runCli($, ['prepare', '--digest', '-', '--project', cwd, '--classify', config.classifier, '--source', `claude:${sessionId}:live`], digest, 180_000)
    if (prep.exitCode !== 0) throw new Error(prep.stderr.slice(0, 300) || `prepare exited ${prep.exitCode}`)
    const prepared = JSON.parse(prep.stdout) as Prepared
    if (!prepared.passed) return
    lastPlanned = await $.clock.now()
    $.ui.status('🧠 planning…')
    const prompt = plannerPrompt(prepared.input)
    let text: string | undefined
    const fork = await $.model.fork({ prompt })
    if (fork.isAnswered) text = fork.text
    else {
      const c = await $.model.complete({ model: 'sonnet', prompt, maxTokens: 6000, timeoutMs: 180_000 })
      if (c.isAnswered) text = c.text
    }
    if (!text) return
    const plan = parsePlanOutput(text)
    if (!plan.edits.length) return
    const expect = Object.entries(prepared.expected).flatMap(([n, s]) => ['--expect', `${n}=${s}`])
    const res = await runCli($, ['apply', '--edits', '-', '--project', cwd, '--json', ...expect], JSON.stringify(plan))
    if (res.exitCode !== 0 && !res.stdout.trim()) throw new Error(res.stderr.slice(0, 300) || `apply exited ${res.exitCode}`)
    const out = JSON.parse(res.stdout) as ApplyResult
    for (const a of out.applied) {
      const edit = plan.edits.find((e) => e.name === a.name)
      await remember($, await lessonFrom($, a, plan.summary, edit, 'live'))
    }
    for (const r of out.rejected) $.ui.log(`skillmine: ${r.action} ${r.name} ${r.status}: ${r.error ?? ''}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`skillmine: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  } finally {
    await settle($)
  }
}

async function mineDays($: EngineInterface, days: number): Promise<void> {
  await update($, busy, () => 'mining')
  $.ui.status(`🧠 mining the last ${days} day(s)…`)
  try {
    const [bin, ...rest] = config.cliArgv
    const stream = $.process.spawn({ argv: [bin!, ...rest, 'mine', '--days', String(days), '--classify', config.classifier, '--planner', 'claude', '--quiet', '--json'], cwd: cwd || undefined })
    let stdout = ''
    let stderr = ''
    for await (const chunk of stream) {
      if (chunk.stream === 'stdout') stdout += chunk.text
      else stderr += chunk.text
    }
    const result = await stream.result
    if (result.code !== 0) throw new Error(stderr.slice(-400) || `mine exited ${result.code}`)
    const summary = JSON.parse(stdout) as { run?: { id: string; applied: number; rejected: number; clusters: number } }
    if (!summary.run) return
    const led = await runCli($, ['ledger', '--run', summary.run.id, '--json'])
    const entries = (JSON.parse(led.stdout) as LedgerEntry[]).filter((e) => e.status === 'applied')
    for (const e of entries) await remember($, await lessonFrom($, e, e.reason, undefined, 'mine'))
    $.ui.toast(`🧠 mined ${days} day(s): ${summary.run.clusters} clusters planned, ${entries.length} ${entries.length === 1 ? 'lesson' : 'lessons'} written${summary.run.rejected ? `, ${summary.run.rejected} rejected` : ''}`)
  } catch (err) {
    $.ui.toast(`skillmine: mining failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await settle($)
  }
}

async function undoLesson($: EngineInterface, lesson: Lesson): Promise<void> {
  const res = await runCli($, ['undo', '--id', lesson.id])
  const line = (res.stdout + res.stderr).trim().split('\n')[0] ?? ''
  $.ui.toast(line || (res.exitCode === 0 ? `undid ${lesson.name}` : `undo failed (${res.exitCode})`))
  if (res.exitCode === 0 && /^undone/.test(line)) {
    const list = await update($, lessons, (all) => all.filter((l) => l.id !== lesson.id))
    await $.store.set('lessons', list)
  }
}

export const register: Register = (on, options) => {
  config.cliArgv = String(options.cli ?? 'skillmine').split(' ').filter(Boolean)
  config.classifier = String(options.classifier ?? 'jev')
  config.every = Math.max(1, Number(options.every ?? 3) || 3)
  config.cooldownMs = Math.max(0, Number(options.cooldownMinutes ?? 20) || 20) * 60_000

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    sessionId = await $.session.id()
    await $.command.register({
      name: 'skillmine',
      description: 'Mine sessions into skills. /skillmine 30 mines the last 30 days, /skillmine undo reverts the last edit, /skillmine lists what was learned.',
      argumentHint: '[days | undo | status]',
    })
    const stored = await $.store.get('lessons')
    if (Array.isArray(stored)) await update($, lessons, () => (stored as Lesson[]).slice(-MAX_LESSONS))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted) return result
    turns += 1
    if (turns % config.every !== 0) return result
    if ((await read($, busy)) !== null) return result
    if ((await $.clock.now()) - lastPlanned < config.cooldownMs) return result
    $.clock.after(0, () => {
      void check($)
    })
    return result
  })

  on('command.run', { command: 'skillmine' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'undo') {
      const res = await runCli($, ['undo', '--last'])
      return { text: (res.stdout + res.stderr).trim() || `undo exited ${res.exitCode}` }
    }
    if (arg === '' || arg === 'status') {
      const all = await read($, lessons)
      if (!all.length) return { text: '🧠 Skillmine has not written anything yet. It checks the chat every few turns; /skillmine 30 mines the last 30 days.' }
      const lines = all.slice(-15).map((l) => `${new Date(l.ts).toISOString().slice(0, 10)}  ${verb(l.action)} ${l.name}  (${l.path})`)
      return { text: `🧠 ${all.length} lessons so far, newest last:\n${lines.join('\n')}` }
    }
    const days = Number(arg)
    if (!Number.isFinite(days) || days <= 0) return { text: 'usage: /skillmine [days | undo | status]' }
    if ((await read($, busy)) !== null) return { text: '🧠 Skillmine is already working; try again when the status line clears.' }
    $.clock.after(0, () => {
      void mineDays($, days)
    })
    return { text: `🧠 Mining the last ${days} day(s) of Claude, Codex, Kimi, OpenCode and Antigravity sessions in the background. Each lesson appears here as it lands.` }
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin', name: 'skillmine' } } }, async ($, e, next) => {
    const id = MARK.exec(e.props.text)?.[1]
    if (!id || e.props.isExpanded) return next(e)
    const lesson = (await read($, lessons)).find((l) => l.id === id)
    if (!lesson) return next(e)
    const open = (await read($, expanded)).includes(id)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const toggle = () => update($, expanded, (list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text>🧠</Text>
          <Text bold>{verb(lesson.action)}</Text>
          <Text>{lesson.name}</Text>
          {lesson.summary ? <Text dimColor>· {cut(lesson.summary, 90)}</Text> : null}
          <Button key={`sm-toggle-${id}`} label={open ? 'hide' : 'show'} onPress={toggle} />
        </Box>
        {open ? (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
            <Text dimColor>{lesson.path}</Text>
            {lesson.reason ? (
              <Text dimColor wrap="wrap">
                why: {lesson.reason}
              </Text>
            ) : null}
            <Markdown text={lesson.body || '(empty)'} />
            <Box gap={1}>
              <Button key={`sm-undo-${id}`} label="undo this" onPress={() => undoLesson($, lesson)} />
              <Button key={`sm-hide-${id}`} label="hide" onPress={toggle} />
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })
}
