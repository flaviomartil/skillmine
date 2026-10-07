import type { Planner, PlannerBackend } from './types.ts'
import { CommandPlanner, preset, PROMPT } from './command.ts'

export type { Planner, PlannerBackend, PlanInput, PlanOutput, Edit, CreateEdit, UpdateEdit, AddReferenceEdit, ArchiveEdit, TargetSkill, Scope, ArtifactKind } from './types.ts'
export { plannerPrompt, parsePlanOutput, PLANNER_RULES } from './prompt.ts'
export { CommandPlanner, preset, PROMPT } from './command.ts'

export function parsePlannerBackend(spec: string | undefined, fallback: PlannerBackend = 'claude'): PlannerBackend {
  if (!spec) return fallback
  if (spec === 'claude' || spec === 'codex' || spec === 'agy' || spec === 'kimi' || spec === 'opencode' || spec === 'none') return spec
  throw new Error(`unknown planner: ${spec}`)
}

export function createPlanner(backend: PlannerBackend, model?: string): Planner | undefined {
  if (backend === 'none') return undefined
  const custom = process.env.SKILLMINE_PLANNER_COMMAND
  if (custom) {
    const argv = custom.split(' ')
    return new CommandPlanner({ name: 'custom', argv, stdin: !argv.includes(PROMPT) })
  }
  const p = preset(backend, model ?? process.env.SKILLMINE_PLANNER_MODEL)
  return new CommandPlanner({ name: backend, argv: p.argv, stdin: p.stdin })
}
