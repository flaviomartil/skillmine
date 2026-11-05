#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { createReaders, defaultPaths } from './readers/index.ts'
import { mine, parseClients } from './mine.ts'
import { dryReport, analysisReport, runReport, ledgerReport, curateReport } from './report.ts'
import { analyze } from './analyze.ts'
import { createEmbedder, parseEmbedBackend, OllamaEmbedder } from './embed/index.ts'
import { createClassifier, parseClassifierBackend, passes } from './classify/index.ts'
import { clusterDigest } from './cluster.ts'
import { createPlanner, parsePlannerBackend, parsePlanOutput } from './plan/index.ts'
import { Store } from './apply/store.ts'
import { applyEdits } from './apply/writer.ts'
import { undo } from './apply/undo.ts'
import { runPlans, type RunResult } from './run.ts'
import { prepare } from './prepare.ts'
import { curate } from './curate/index.ts'
import { gate, logGate } from './gate.ts'
import type { Client } from './types.ts'
import { recordTouch, setPinned } from './curate/usage.ts'
import { discoverSkills } from './catalog.ts'
import { installThinSkill, uninstallThinSkill } from './install.ts'
import { tick, acquireReflectLock, releaseReflectLock, updateLockOwner, startLockRefresh, readLastReflect, writeLastReflect, resolveReflectProject, claimInjection, CHILD_ENV, LOCK_TOKEN_ENV } from './reflect.ts'
import { buildIndex, recordOffers } from './index-inject.ts'

const HELP = `skillmine — mine coding-agent sessions into skills

usage:
  skillmine mine [--days 30 | --since <ms|iso>] [--clients all|claude,codex,kimi,opencode,agy] [--project <path>]
                 [--embed ollama|openai|none] [--embed-model <name>] [--sim 0.9]
                 [--classify jev|laya|haiku] [--max-calls 50]
                 [--planner claude|codex|agy|kimi|opencode] [--planner-model <name>] [--allow-human-edits]
                 [--dry] [--out clusters.jsonl] [--json] [--samples 5] [--quiet]
  skillmine prepare --digest <file|-> [--project <path>] [--classify jev|laya|haiku] [--embed ollama|none] [--source ref ...]
  skillmine apply --edits <file|-> [--project <path>] [--expect name=sha ...] [--allow-human-edits]
  skillmine undo [--last | --id <edit-id> | --run <run-id>]
  skillmine ledger [--limit 30] [--run <run-id>]
  skillmine classify --digest <file|-> [--classify jev|laya|haiku] [--skill name=description ...]
  skillmine curate [--dry] [--stale-days 14] [--archive-days 30] [--maturity 300] [--probation-max-days 180] [--clients all|...] [--project <path>] [--json]
  skillmine pin <skill> | skillmine unpin <skill>
  skillmine touch <skill>                   # stamp last_used_at (the mod calls this; uses are counted by curate)
  skillmine install-skill [--from <dir>] [--remove]   # link the thin /skillmine skill into Codex, Kimi, OpenCode and Antigravity
  skillmine tick --session <id> --calls <n> [--project <path>] [--every 50]   # count tool calls, spawn a background reflection every N
  skillmine reflect [--project <path>]      # background reflection: mine since the last reflection, then curate
  skillmine index [--project <path>] [--session <id>] [--json]   # compact index of self-authored skills; with --session also prints a #offered line
  skillmine offered --session <id> --paths <file|-> [--project <path>]   # mark the session injected and count the offers once the index reached it
  skillmine doctor

Without --dry, passed clusters go to the planner and its edits are applied with a ledger,
backups and undo. --classify defaults to jev when not --dry.`

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return 0
  }
  switch (cmd) {
    case 'doctor':
      return doctor()
    case 'mine':
      return mineCmd(rest)
    case 'classify':
      return classifyCmd(rest)
    case 'prepare':
      return prepareCmd(rest)
    case 'apply':
      return applyCmd(rest)
    case 'undo':
      return undoCmd(rest)
    case 'ledger':
      return ledgerCmd(rest)
    case 'curate':
      return curateCmd(rest)
    case 'pin':
      return pinCmd(rest, true)
    case 'unpin':
      return pinCmd(rest, false)
    case 'touch':
      return touchCmd(rest)
    case 'install-skill':
      return installSkillCmd(rest)
    case 'gate':
      return gateCmd(rest)
    case 'tick':
      return tickCmd(rest)
    case 'reflect':
      return reflectCmd(rest)
    case 'index':
      return indexCmd(rest)
    case 'offered':
      return offeredCmd(rest)
  }
  console.error(`unknown command: ${cmd}\n\n${HELP}`)
  return 2
}

function progress(quiet: boolean) {
  let last = ''
  return (phase: string, done: number, total: number) => {
    if (quiet || !process.stderr.isTTY) return
    const line = `${phase} ${done}/${total}`
    if (line === last) return
    last = line
    process.stderr.write(`\r${line.padEnd(60)}`)
    if (done === total) process.stderr.write('\n')
  }
}

const MINE_PARTIAL = 3

async function mineCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      days: { type: 'string', default: '30' },
      since: { type: 'string' },
      clients: { type: 'string', default: 'all' },
      project: { type: 'string' },
      dry: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      samples: { type: 'string', default: '5' },
      quiet: { type: 'boolean', default: false },
      embed: { type: 'string', default: 'ollama' },
      'embed-model': { type: 'string' },
      sim: { type: 'string', default: '0.9' },
      classify: { type: 'string' },
      'max-calls': { type: 'string', default: '50' },
      planner: { type: 'string', default: 'claude' },
      'planner-model': { type: 'string' },
      'allow-human-edits': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
    strict: true,
  })
  const days = Number(values.days)
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days must be a positive number')
    return 2
  }
  let since: number | undefined
  if (values.since !== undefined) {
    since = /^\d{13,}$/.test(values.since) ? Number(values.since) : /^\d+$/.test(values.since) ? Number.NaN : Date.parse(values.since)
    if (!Number.isFinite(since) || since <= 0) {
      console.error('--since must be an ISO date or epoch milliseconds (at least 13 digits)')
      return 2
    }
  }
  const quiet = values.quiet || values.json
  const report = progress(quiet)
  const clients = parseClients(values.clients)
  const result = await mine(createReaders(), { days, since, clients, project: values.project, onProgress: (d, t) => report('reading sessions', d, t) })

  let embed
  try {
    embed = await createEmbedder(parseEmbedBackend(values.embed), { model: values['embed-model'] })
  } catch (e) {
    console.error(`warning: ${e instanceof Error ? e.message : e}; continuing without embeddings`)
  }
  const classifier = createClassifier(parseClassifierBackend(values.classify, values.dry ? 'none' : 'jev'))
  if (!values.dry && !classifier) {
    console.error('a classifier is required to mine; pass --classify jev|laya|haiku or use --dry')
    return 2
  }
  const analysis = await analyze(result.windows, {
    embedder: embed?.embedder,
    classifier,
    project: values.project,
    similarity: Number(values.sim) || 0.9,
    maxCalls: Number(values['max-calls']) || 50,
    onPhase: report,
  })
  embed?.cache.close()

  let run: RunResult | undefined
  if (!values.dry) {
    const planner = createPlanner(parsePlannerBackend(values.planner), values['planner-model'])
    if (!planner) {
      console.error('a planner is required to mine; pass --planner claude|codex|agy|kimi|opencode')
      return 2
    }
    run = await runPlans(analysis, { planner, store: new Store(), project: values.project, allowHumanEdits: values['allow-human-edits'], onPhase: report })
  }

  if (values.out) {
    const lines = analysis.clusters.map((c) => {
      const v = analysis.verdicts.get(c.id)
      const p = run?.planned.find((x) => x.cluster.id === c.id)
      return JSON.stringify({ id: c.id, client: c.rep.client, project: c.rep.project, members: c.members.length, projects: c.projects, signals: c.rep.signals, matches: c.matches, verdict: v, passed: v ? passes(v) : undefined, plan: p?.plan ? { summary: p.plan.summary, edits: p.plan.edits.map((e) => ({ action: e.action, name: e.name, reason: e.reason })) } : undefined, applied: p?.applied.map((a) => a.id), rejected: p?.rejected.map((r) => r.error), digest: clusterDigest(c) })
    })
    await writeFile(values.out, lines.join('\n') + '\n')
  }
  if (values.json) {
    const { windows, ...rest } = result
    console.log(JSON.stringify({ ...rest, windows: windows.length, analysis: { ...analysis.stats, errors: analysis.errors.length }, run: run ? { id: run.run, ...run.totals } : undefined }, null, 2))
  } else {
    const samples = Number(values.samples) || 5
    console.log(dryReport(result, embed || classifier ? 0 : samples))
    console.log('')
    console.log(analysisReport(analysis, run ? 0 : samples))
    if (run) {
      console.log('')
      console.log(runReport(run))
    }
  }
  if (analysis.errors.length && analysis.errors.length === analysis.stats.calls) return 1
  const failedPlans = run?.planned.filter((p) => p.error).map((p) => p.cluster.id) ?? []
  if (analysis.errors.length || failedPlans.length) {
    const ids = [...analysis.errors.map((e) => e.cluster), ...failedPlans]
    const t = run?.totals
    console.error(`mine: classifier errors ${analysis.errors.length}/${analysis.stats.calls}, planner errors ${t?.errors ?? 0}/${t?.plannerCalls ?? 0}, applied ${t?.applied ?? 0}, rejected ${t?.rejected ?? 0}`)
    console.error(`mine: ${ids.length} clusters failed and were not retried: ${ids.join(', ')}`)
    if (t && t.errors > 0 && t.errors === t.plannerCalls && t.applied === 0) return 1
    return MINE_PARTIAL
  }
  return 0
}

async function classifyCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      digest: { type: 'string' },
      classify: { type: 'string', default: 'jev' },
      skill: { type: 'string', multiple: true, default: [] },
    },
    strict: true,
  })
  if (!values.digest) {
    console.error('--digest <file|-> is required')
    return 2
  }
  const digest = await readInput(values.digest)
  const classifier = createClassifier(parseClassifierBackend(values.classify, 'jev'))
  if (!classifier) {
    console.error('--classify must be jev, laya or haiku')
    return 2
  }
  const catalog = (values.skill as string[]).map((s) => {
    const i = s.indexOf('=')
    return i < 0 ? { name: s, description: '' } : { name: s.slice(0, i), description: s.slice(i + 1) }
  })
  const v = await classifier.classify({ digest: digest.trim(), catalog })
  console.log(JSON.stringify({ ...v, passed: passes(v) }, null, 2))
  return 0
}

async function prepareCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      digest: { type: 'string' },
      project: { type: 'string', default: process.cwd() },
      classify: { type: 'string', default: 'jev' },
      embed: { type: 'string', default: 'ollama' },
      source: { type: 'string', multiple: true, default: [] },
    },
    strict: true,
  })
  if (!values.digest) {
    console.error('--digest <file|-> is required')
    return 2
  }
  const digest = (await readInput(values.digest)).trim()
  if (!digest) {
    console.error('empty digest')
    return 2
  }
  let embed
  try {
    embed = await createEmbedder(parseEmbedBackend(values.embed))
  } catch {
    embed = undefined
  }
  const classifier = createClassifier(parseClassifierBackend(values.classify, 'jev'))
  const out = await prepare(digest, { project: values.project ?? '', sources: values.source as string[], classifier, embedder: embed?.embedder, store: new Store() })
  embed?.cache.close()
  console.log(JSON.stringify(out))
  return 0
}

async function applyCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      edits: { type: 'string' },
      project: { type: 'string', default: process.cwd() },
      expect: { type: 'string', multiple: true, default: [] },
      'allow-human-edits': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (!values.edits) {
    console.error('--edits <file|-> is required')
    return 2
  }
  const text = await readInput(values.edits)
  const { edits } = parsePlanOutput(text)
  if (!edits.length) {
    console.log(values.json ? JSON.stringify({ applied: [], rejected: [] }) : 'no edits')
    return 0
  }
  const store = new Store()
  const expectedSha = new Map<string, string>()
  for (const pair of values.expect as string[]) {
    const i = pair.indexOf('=')
    if (i > 0) expectedSha.set(pair.slice(0, i), pair.slice(i + 1))
  }
  const res = await applyEdits(edits, { store, project: values.project ?? '', expectedSha: expectedSha.size ? expectedSha : undefined, allowHumanEdits: values['allow-human-edits'] })
  if (values.json) console.log(JSON.stringify(res, null, 2))
  else {
    for (const a of res.applied) console.log(`applied   ${a.action.padEnd(13)} ${a.name}  ${a.path}  (${a.id})`)
    for (const r of res.rejected) console.log(`${r.status.padEnd(9)} ${r.action.padEnd(13)} ${r.name}  ${r.error}`)
  }
  return res.applied.length || !res.rejected.length ? 0 : 1
}

async function undoCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { last: { type: 'boolean', default: false }, id: { type: 'string' }, run: { type: 'string' } },
    strict: true,
  })
  const target = values.id ? { id: values.id } : values.run ? { run: values.run } : { last: true as const }
  const res = await undo(new Store(), target)
  for (const u of res.undone) console.log(`undone    ${u.action.padEnd(13)} ${u.name}  ${u.path}`)
  for (const s of res.skipped) console.log(`skipped   ${s.entry.action.padEnd(13)} ${s.entry.name}  ${s.reason}`)
  if (!res.undone.length && !res.skipped.length) console.log('nothing to undo')
  return res.skipped.length && !res.undone.length ? 1 : 0
}

async function ledgerCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: 'string', default: '30' }, run: { type: 'string' }, json: { type: 'boolean', default: false } },
    strict: true,
  })
  const all = await new Store().entries()
  const filtered = (values.run ? all.filter((e) => e.run === values.run) : all).slice(-(Number(values.limit) || 30))
  console.log(values.json ? JSON.stringify(filtered, null, 2) : ledgerReport(filtered))
  return 0
}

async function curateCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dry: { type: 'boolean', default: false },
      'stale-days': { type: 'string', default: '14' },
      'archive-days': { type: 'string', default: '30' },
      maturity: { type: 'string' },
      'probation-max-days': { type: 'string' },
      clients: { type: 'string', default: 'all' },
      project: { type: 'string' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
    },
    strict: true,
  })
  const report = progress(values.quiet || values.json)
  const all = createReaders()
  const readers = Object.fromEntries(parseClients(values.clients).map((c) => [c, all[c]]))
  const res = await curate({
    store: new Store(),
    readers,
    project: values.project,
    staleDays: Number(values['stale-days']) || 14,
    archiveDays: Number(values['archive-days']) || 30,
    maturity: Number(values.maturity) || undefined,
    probationMaxDays: Number(values['probation-max-days']) || undefined,
    dry: values.dry,
    onPhase: report,
  })
  if (values.json) {
    console.log(JSON.stringify({ run: res.run, readOnly: res.readOnly, scanErrors: res.scanErrors, archiveDisabled: res.archiveDisabled, scanned: res.scanned, rows: res.rows.map((r) => ({ name: r.skill.name, path: r.skill.realpath, verdict: r.verdict, idleDays: r.idleDays, error: r.error, usage: r.usage })), archived: res.archived.map((a) => a.id), rejected: res.rejected.map((a) => a.error) }, null, 2))
  } else console.log(curateReport(res, values.dry))
  return 0
}

async function gateCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      client: { type: 'string' },
      session: { type: 'string' },
      project: { type: 'string', default: process.env.AI_HARNESS_PROJECT_DIR ?? process.cwd() },
      every: { type: 'string', default: process.env.SKILLMINE_GATE_EVERY ?? '3' },
      cooldown: { type: 'string', default: process.env.SKILLMINE_GATE_COOLDOWN_MIN ?? '20' },
      classify: { type: 'string', default: process.env.SKILLMINE_CLASSIFIER ?? 'jev' },
      planner: { type: 'string', default: process.env.SKILLMINE_PLANNER ?? 'claude' },
      'planner-model': { type: 'string' },
      embed: { type: 'string', default: process.env.SKILLMINE_EMBED ?? 'ollama' },
      force: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  })
  const client = (values.client === 'agy' ? 'antigravity' : values.client) as Client | undefined
  if (!client || !values.session) {
    console.error('--client and --session are required')
    return 2
  }
  const store = new Store()
  const readers = createReaders()
  if (!(client in readers)) {
    console.error(`unknown client: ${values.client}`)
    return 2
  }
  let embed
  try {
    embed = await createEmbedder(parseEmbedBackend(values.embed))
  } catch {
    embed = undefined
  }
  const res = await gate({
    client,
    session: values.session,
    project: values.project,
    readers,
    store,
    every: Number(values.every) || 3,
    cooldownMs: (Number(values.cooldown) || 20) * 60_000,
    force: values.force,
    classifier: createClassifier(parseClassifierBackend(values.classify, 'jev')),
    embedder: embed?.embedder,
    planner: createPlanner(parsePlannerBackend(values.planner), values['planner-model']),
  })
  embed?.cache.close()
  await logGate(store, client, values.session, res)
  if (values.json) console.log(JSON.stringify({ ...res, applied: res.applied.map((a) => ({ id: a.id, action: a.action, name: a.name, path: a.path })), rejected: res.rejected.map((r) => r.error) }, null, 2))
  else {
    console.log(`gate ${client}:${values.session} -> ${res.status}${res.reason ? ` (${res.reason})` : ''}`)
    for (const a of res.applied) console.log(`  ${a.action.padEnd(13)} ${a.name}  ${a.path}`)
  }
  return 0
}

async function tickCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      calls: { type: 'string', default: '1' },
      project: { type: 'string' },
      every: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (!values.session) {
    console.error('--session is required')
    return 2
  }
  let every: number | undefined
  if (values.every !== undefined) {
    every = Number(values.every)
    if (!Number.isInteger(every) || every <= 0) {
      console.error('--every must be a positive integer')
      return 2
    }
  }
  const res = await tick({ store: new Store(), session: values.session, calls: Number(values.calls) || 0, project: values.project ? resolve(values.project) : undefined, every })
  console.log(values.json ? JSON.stringify(res) : `tick ${res.status} ${res.count}/${res.every}${res.reason ? ` (${res.reason})` : ''}`)
  return res.status === 'failed' ? 1 : 0
}

async function reflectCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { project: { type: 'string' } }, strict: true })
  const store = new Store()
  let token = process.env[LOCK_TOKEN_ENV]
  delete process.env[LOCK_TOKEN_ENV]
  if (process.env[CHILD_ENV]) {
    if (!token) {
      console.error('nested reflection: skipped')
      return 0
    }
    if (!(await updateLockOwner(store, token, { pid: process.pid, ts: Date.now() }))) {
      console.error('nested reflection: lock token does not match; skipped')
      return 0
    }
  } else {
    token = await acquireReflectLock(store)
    if (!token) {
      console.error('another reflection is running')
      return 0
    }
    process.env[CHILD_ENV] = '1'
  }
  const refresh = startLockRefresh(store, token)
  try {
    const startedAt = Date.now()
    const target = resolveReflectProject(values.project)
    const project = target ? ['--project', target] : []
    const last = await readLastReflect(store, target)
    const since = Math.max(last ?? 0, startedAt - 7 * 86_400_000)
    const window = last ? ['--since', String(since)] : ['--days', '1']
    const mined = await mineCmd([...window, '--quiet', ...project])
    if (refresh.lost()) {
      console.error('lock lost')
      return 1
    }
    if (mined === 0 || mined === MINE_PARTIAL) await writeLastReflect(store, target, startedAt)
    const curated = await curateCmd(['--quiet'])
    if (refresh.lost()) {
      console.error('lock lost')
      return 1
    }
    return mined || curated
  } finally {
    await refresh.stop()
    if (!refresh.lost()) await releaseReflectLock(store, token)
  }
}

const OFFERED_PREFIX = '#offered '

async function indexCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { project: { type: 'string' }, session: { type: 'string' }, json: { type: 'boolean', default: false } }, strict: true })
  const store = new Store()
  const res = await buildIndex({ store, project: values.project, session: values.session })
  if (values.json) console.log(JSON.stringify(res))
  else if (res.text) {
    console.log(res.text)
    if (values.session) console.log(OFFERED_PREFIX + JSON.stringify(res.paths))
  }
  return 0
}

async function offeredCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { session: { type: 'string' }, paths: { type: 'string' }, project: { type: 'string' } }, strict: true })
  if (!values.session || !values.paths) {
    console.error('--session and --paths <file|-> are required')
    return 2
  }
  let paths: unknown
  try {
    paths = JSON.parse(await readInput(values.paths))
  } catch {
    console.error('--paths must hold a JSON array of skill paths')
    return 2
  }
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) {
    console.error('--paths must hold a JSON array of skill paths')
    return 2
  }
  const store = new Store()
  if (!(await claimInjection(store, values.session))) {
    console.log('offered 0')
    return 0
  }
  const done = await recordOffers({ store, session: values.session, paths: paths as string[], project: values.project })
  console.log(`offered ${done.length}`)
  return 0
}

async function skillByName(name: string, project?: string) {
  const skills = await discoverSkills({ project })
  return skills.find((s) => s.name === name)
}

async function pinCmd(argv: string[], pinned: boolean): Promise<number> {
  const name = argv[0]
  if (!name) {
    console.error('usage: skillmine pin|unpin <skill>')
    return 2
  }
  const skill = await skillByName(name, process.cwd())
  if (!skill) {
    console.error(`skill "${name}" not found`)
    return 1
  }
  try {
    const u = await setPinned(skill, pinned)
    console.log(`${pinned ? 'pinned' : 'unpinned'} ${name} (${u.use_count} uses)`)
    return 0
  } catch (e) {
    console.error(`cannot ${pinned ? 'pin' : 'unpin'} "${name}": ${e instanceof Error ? e.message : String(e)}; fix or remove its .usage.json first`)
    return 1
  }
}

async function touchCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: { project: { type: 'string', default: process.cwd() } }, strict: true, allowPositionals: true })
  const name = positionals[0]
  if (!name) {
    console.error('usage: skillmine touch <skill>')
    return 2
  }
  const skill = await skillByName(name, values.project)
  if (!skill || skill.createdBy !== 'skillmine') return 0
  try {
    await recordTouch(skill)
  } catch (e) {
    console.error(`skipped use of "${name}": ${e instanceof Error ? e.message : String(e)}`)
  }
  return 0
}

async function installSkillCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { from: { type: 'string' }, remove: { type: 'boolean', default: false } }, strict: true })
  if (values.remove) {
    const removed = await uninstallThinSkill()
    for (const r of removed) console.log(`removed   ${r}`)
    if (!removed.length) console.log('nothing to remove')
    return 0
  }
  const res = await installThinSkill({ from: values.from })
  for (const l of res.linked) console.log(`linked    ${l}`)
  for (const s of res.skipped) console.log(`skipped   ${s.dir}  ${s.reason}`)
  if (!res.linked.length && !res.skipped.length) console.log('no client skill directories found')
  return res.linked.length || res.skipped.length ? 0 : 1
}

async function readInput(spec: string): Promise<string> {
  return spec === '-' ? await new Response(Bun.stdin.stream()).text() : await readFile(spec, 'utf8')
}

async function doctor(): Promise<number> {
  const paths = defaultPaths()
  const rows: [string, string, boolean][] = []
  for (const [k, p] of Object.entries(paths)) {
    let ok = false
    try {
      await stat(p)
      ok = true
    } catch {
      ok = false
    }
    rows.push([k, p, ok])
  }
  for (const [k, p, ok] of rows) console.log(`${ok ? 'ok     ' : 'missing'} ${k.padEnd(12)} ${p}`)
  const ollama = new OllamaEmbedder()
  console.log(`${(await ollama.available()) ? 'ok     ' : 'missing'} ${'embeddings'.padEnd(12)} ollama ${ollama.model}`)
  console.log(`${process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || process.env.SKILLMINE_CLASSIFIER_API_KEY ? 'ok     ' : 'missing'} ${'jev key'.padEnd(12)} TYPESAFE_API_KEY / JEV_API_KEY`)
  for (const bin of ['claude', 'codex', 'agy', 'kimi', 'opencode']) {
    const found = Bun.which(bin)
    console.log(`${found ? 'ok     ' : 'missing'} ${('planner:' + bin).padEnd(12)} ${found ?? ''}`)
  }
  console.log(`store        ${new Store().root}`)
  return rows.some(([, , ok]) => ok) ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
