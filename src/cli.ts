#!/usr/bin/env bun
import { parseArgs } from 'node:util'
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
import { recordUse, setPinned } from './curate/usage.ts'
import { discoverSkills } from './catalog.ts'
import { installThinSkill } from './install.ts'

const HELP = `skillmine — mine coding-agent sessions into skills

usage:
  skillmine mine [--days 30] [--clients all|claude,codex,kimi,opencode,agy] [--project <path>]
                 [--embed ollama|openai|none] [--embed-model <name>] [--sim 0.9]
                 [--classify jev|laya|haiku] [--max-calls 50]
                 [--planner claude|codex|agy|kimi|opencode] [--planner-model <name>] [--allow-human-edits]
                 [--dry] [--out clusters.jsonl] [--json] [--samples 5] [--quiet]
  skillmine prepare --digest <file|-> [--project <path>] [--classify jev|laya|haiku] [--embed ollama|none] [--source ref ...]
  skillmine apply --edits <file|-> [--project <path>] [--expect name=sha ...] [--allow-human-edits]
  skillmine undo [--last | --id <edit-id> | --run <run-id>]
  skillmine ledger [--limit 30] [--run <run-id>]
  skillmine classify --digest <file|-> [--classify jev|laya|haiku] [--skill name=description ...]
  skillmine curate [--dry] [--stale-days 14] [--archive-days 30] [--clients all|...] [--project <path>] [--json]
  skillmine pin <skill> | skillmine unpin <skill>
  skillmine touch <skill>                   # record one use (the mod calls this)
  skillmine install-skill [--from <dir>]    # link the thin /skillmine skill into Codex, Kimi, OpenCode and Antigravity
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

async function mineCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      days: { type: 'string', default: '30' },
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
  const quiet = values.quiet || values.json
  const report = progress(quiet)
  const clients = parseClients(values.clients)
  const result = await mine(createReaders(), { days, clients, project: values.project, onProgress: (d, t) => report('reading sessions', d, t) })

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
  return analysis.errors.length && analysis.errors.length === analysis.stats.calls ? 1 : 0
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
  const res = await applyEdits(edits, { store, project: values.project ?? '', expectedSha, allowHumanEdits: values['allow-human-edits'] })
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
    dry: values.dry,
    onPhase: report,
  })
  if (values.json) {
    console.log(JSON.stringify({ run: res.run, scanned: res.scanned, rows: res.rows.map((r) => ({ name: r.skill.name, path: r.skill.realpath, verdict: r.verdict, idleDays: r.idleDays, usage: r.usage })), archived: res.archived.map((a) => a.id), rejected: res.rejected.map((a) => a.error) }, null, 2))
  } else console.log(curateReport(res, values.dry))
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
  const u = await setPinned(skill, pinned)
  console.log(`${pinned ? 'pinned' : 'unpinned'} ${name} (${u.use_count} uses)`)
  return 0
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
  await recordUse(skill)
  return 0
}

async function installSkillCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { from: { type: 'string' } }, strict: true })
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
