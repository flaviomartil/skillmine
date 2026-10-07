import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Planner, PlanInput, PlanOutput, PlannerBackend } from './types.ts'
import { plannerPrompt, parsePlanOutput } from './prompt.ts'

export type Runner = (argv: string[], stdin: string, cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export const defaultRunner: Runner = async (argv, stdin, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

export const PROMPT = '{prompt}'

export type Preset = { argv: string[]; stdin: boolean }

export function preset(backend: Exclude<PlannerBackend, 'none'>, model?: string): Preset {
  switch (backend) {
    case 'claude':
      return { argv: ['claude', '-p', '--model', model ?? 'sonnet', '--output-format', 'json'], stdin: true }
    case 'codex':
      return { argv: ['codex', 'exec', '--skip-git-repo-check', ...(model ? ['-m', model] : []), PROMPT], stdin: false }
    case 'agy':
      return { argv: ['agy', '-p', PROMPT, '--output-format', 'json', ...(model ? ['--model', model] : [])], stdin: false }
    case 'kimi':
      return { argv: ['kimi', '-p', PROMPT, '--output-format', 'text'], stdin: false }
    case 'opencode':
      return { argv: ['opencode', 'run', ...(model ? ['-m', model] : []), PROMPT], stdin: false }
  }
}

export type CommandPlannerOptions = {
  name: string
  argv: string[]
  stdin?: boolean
  cwd?: string
  runner?: Runner
  timeoutMs?: number
}

export class CommandPlanner implements Planner {
  readonly name: string
  private argv: string[]
  private useStdin: boolean
  private cwd: string
  private runner: Runner

  constructor(opts: CommandPlannerOptions) {
    this.name = opts.name
    this.argv = opts.argv
    this.useStdin = opts.stdin ?? !opts.argv.includes(PROMPT)
    this.cwd = opts.cwd ?? process.env.SKILLMINE_PLANNER_CWD ?? join(homedir(), '.skillmine', 'empty')
    this.runner = opts.runner ?? defaultRunner
  }

  async plan(input: PlanInput): Promise<PlanOutput> {
    await mkdir(this.cwd, { recursive: true }).catch(() => undefined)
    const prompt = plannerPrompt(input)
    const argv = this.argv.map((a) => (a === PROMPT ? prompt : a))
    const { exitCode, stdout, stderr } = await this.runner(argv, this.useStdin ? prompt : '', this.cwd)
    if (exitCode !== 0) throw new Error(`${this.name} planner failed (exit ${exitCode}): ${stderr.slice(0, 400) || stdout.slice(0, 400)}`)
    const parsed = parsePlanOutput(stdout)
    return { ...parsed, raw: stdout }
  }
}
