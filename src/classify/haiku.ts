import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Classifier, ClassifyInput, Verdict, Kind, Novelty } from './types.ts'
import { haikuPrompt } from './questions.ts'

export type Runner = (argv: string[], stdin: string, cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type HaikuOptions = {
  command?: string[]
  cwd?: string
  runner?: Runner
}

const KINDS = new Set<Kind>(['procedure', 'fact', 'correction', 'gotcha', 'tradeoff', 'none'])
const NOVELTIES = new Set<Novelty>(['new', 'update', 'duplicate'])

export const defaultRunner: Runner = async (argv, stdin, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

export class HaikuClassifier implements Classifier {
  readonly name = 'haiku'
  private command: string[]
  private cwd: string
  private runner: Runner

  constructor(opts: HaikuOptions = {}) {
    this.command = opts.command ?? (process.env.SKILLMINE_HAIKU_COMMAND ? process.env.SKILLMINE_HAIKU_COMMAND.split(' ') : ['claude', '-p', '--model', 'haiku', '--output-format', 'json'])
    this.cwd = opts.cwd ?? process.env.SKILLMINE_HAIKU_CWD ?? join(homedir(), '.skillmine', 'empty')
    this.runner = opts.runner ?? defaultRunner
  }

  async classify(input: ClassifyInput): Promise<Verdict> {
    await mkdir(this.cwd, { recursive: true }).catch(() => undefined)
    const { exitCode, stdout, stderr } = await this.runner(this.command, haikuPrompt(input), this.cwd)
    if (exitCode !== 0) throw new Error(`haiku classify failed (exit ${exitCode}): ${stderr.slice(0, 300)}`)
    return parseHaikuOutput(stdout)
  }
}

export function parseHaikuOutput(stdout: string): Verdict {
  let text = stdout
  const wrapped = tryJson(stdout)
  if (wrapped && typeof wrapped === 'object' && typeof (wrapped as { result?: unknown }).result === 'string') text = (wrapped as { result: string }).result
  const obj = extractJson(text)
  if (!obj) throw new Error('haiku returned no JSON object')
  const o = obj as Record<string, unknown>
  const knowledge = typeof o.knowledge === 'number' ? Math.min(1, Math.max(0, o.knowledge)) : 0
  const kind = KINDS.has(o.kind as Kind) ? (o.kind as Kind) : 'none'
  const novelty = NOVELTIES.has(o.novelty as Novelty) ? (o.novelty as Novelty) : 'new'
  const target = typeof o.target === 'string' && o.target && o.target !== 'none' ? o.target : undefined
  const topics = Array.isArray(o.topics) ? o.topics.filter((t): t is string => typeof t === 'string').slice(0, 5) : []
  return { knowledge, kind, novelty, target, topics, confidence: 1, backend: 'haiku' }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  return tryJson(text.slice(start, end + 1))
}
