#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { createReaders, defaultPaths } from './readers/index.ts'
import { mine, parseClients } from './mine.ts'
import { dryReport, analysisReport } from './report.ts'
import { analyze } from './analyze.ts'
import { createEmbedder, parseEmbedBackend, OllamaEmbedder } from './embed/index.ts'
import { createClassifier, parseClassifierBackend, passes } from './classify/index.ts'
import { clusterDigest } from './cluster.ts'

const HELP = `skillmine — mine coding-agent sessions into skills

usage:
  skillmine mine [--days 30] [--clients all|claude,codex,kimi,opencode,agy] [--project <path>] --dry
                 [--embed ollama|openai|none] [--embed-model <name>] [--sim 0.9]
                 [--classify jev|laya|haiku] [--max-calls 50] [--out windows.jsonl] [--json] [--samples 5]
  skillmine classify --digest <file|-> [--classify jev|laya|haiku] [--skill name=description ...]
  skillmine doctor

phase 2: --dry reads, embeds, clusters and (with --classify) classifies. Nothing is written to skills yet.`

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return 0
  }
  if (cmd === 'doctor') return doctor()
  if (cmd === 'mine') return mineCmd(rest)
  if (cmd === 'classify') return classifyCmd(rest)
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
      out: { type: 'string' },
    },
    strict: true,
  })
  if (!values.dry) {
    console.error('phase 2 implements only --dry. Re-run with --dry.')
    return 2
  }
  const days = Number(values.days)
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days must be a positive number')
    return 2
  }
  const quiet = values.quiet || values.json
  const report = progress(quiet)
  const clients = parseClients(values.clients)
  const result = await mine(createReaders(), { days, clients, project: values.project, onProgress: (d, t) => report('reading sessions', d, t) })

  const embedBackend = parseEmbedBackend(values.embed)
  let embed
  try {
    embed = await createEmbedder(embedBackend, { model: values['embed-model'] })
  } catch (e) {
    console.error(`warning: ${e instanceof Error ? e.message : e}; continuing without embeddings`)
  }
  const classifier = createClassifier(parseClassifierBackend(values.classify))
  const analysis = await analyze(result.windows, {
    embedder: embed?.embedder,
    classifier,
    project: values.project,
    similarity: Number(values.sim) || 0.9,
    maxCalls: Number(values['max-calls']) || 50,
    onPhase: report,
  })
  embed?.cache.close()

  if (values.out) {
    const lines = analysis.clusters.map((c) => {
      const v = analysis.verdicts.get(c.id)
      return JSON.stringify({ id: c.id, client: c.rep.client, project: c.rep.project, members: c.members.length, projects: c.projects, signals: c.rep.signals, matches: c.matches, verdict: v, passed: v ? passes(v) : undefined, digest: clusterDigest(c) })
    })
    await writeFile(values.out, lines.join('\n') + '\n')
  }
  if (values.json) {
    const { windows, ...rest } = result
    console.log(JSON.stringify({ ...rest, windows: windows.length, analysis: { ...analysis.stats, errors: analysis.errors.length } }, null, 2))
  } else {
    const samples = Number(values.samples) || 5
    console.log(dryReport(result, embed || classifier ? 0 : samples))
    console.log('')
    console.log(analysisReport(analysis, samples))
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
  const digest = values.digest === '-' ? await new Response(Bun.stdin.stream()).text() : await readFile(values.digest, 'utf8')
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
  return rows.some(([, , ok]) => ok) ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
