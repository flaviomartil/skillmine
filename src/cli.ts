#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { stat } from 'node:fs/promises'
import { createReaders, defaultPaths } from './readers/index.ts'
import { mine, parseClients } from './mine.ts'
import { dryReport } from './report.ts'

const HELP = `skillmine — mine coding-agent sessions into skills

usage:
  skillmine mine [--days 30] [--clients all|claude,codex,kimi,opencode,agy] [--project <path>] --dry [--json] [--samples 5]
  skillmine doctor

phase 1: only --dry is implemented. The planner and apply steps come in phase 3.`

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return 0
  }
  if (cmd === 'doctor') return doctor()
  if (cmd === 'mine') return mineCmd(rest)
  console.error(`unknown command: ${cmd}\n\n${HELP}`)
  return 2
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
    },
    strict: true,
  })
  if (!values.dry) {
    console.error('phase 1 implements only --dry. Re-run with --dry.')
    return 2
  }
  const days = Number(values.days)
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days must be a positive number')
    return 2
  }
  const clients = parseClients(values.clients)
  const readers = createReaders()
  let lastShown = -1
  const result = await mine(readers, {
    days,
    clients,
    project: values.project,
    onProgress: (done, total) => {
      if (values.quiet || values.json || !process.stderr.isTTY) return
      const pct = Math.floor((done / total) * 20)
      if (pct !== lastShown) {
        lastShown = pct
        process.stderr.write(`\rreading sessions ${done}/${total}`)
        if (done === total) process.stderr.write('\n')
      }
    },
  })
  if (values.json) {
    const { windows, ...rest } = result
    console.log(
      JSON.stringify(
        {
          ...rest,
          windows: windows.map((w) => ({ id: w.id, client: w.client, project: w.project, signals: w.signals, start: w.start, end: w.end, chars: w.digest.length })),
        },
        null,
        2,
      ),
    )
  } else {
    console.log(dryReport(result, Number(values.samples) || 5))
  }
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
  return rows.some(([, , ok]) => ok) ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
