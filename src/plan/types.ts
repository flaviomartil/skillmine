import type { Verdict } from '../classify/types.ts'

export type ArtifactKind = 'skill' | 'runbook' | 'agent'
export type Scope = 'local' | 'global'

type EditBase = { reason: string; sources: string[] }

export type CreateEdit = EditBase & { action: 'create'; kind: ArtifactKind; name: string; scope: Scope; description: string; content: string }
export type UpdateEdit = EditBase & { action: 'update'; name: string; content: string }
export type AddReferenceEdit = EditBase & { action: 'add_reference'; name: string; file: string; content: string }
export type ArchiveEdit = EditBase & { action: 'archive'; name: string }

export type Edit = CreateEdit | UpdateEdit | AddReferenceEdit | ArchiveEdit

export type TargetSkill = {
  name: string
  description: string
  body: string
  sha: string
  createdBy?: string
  scope: Scope
}

export type PlanInput = {
  digest: string
  verdict?: Verdict
  scope: Scope
  project: string
  catalog: { name: string; description: string }[]
  target?: TargetSkill
  recent: string[]
  sources: string[]
}

export type PlanOutput = {
  summary: string
  edits: Edit[]
  raw?: string
}

export interface Planner {
  readonly name: string
  plan(input: PlanInput): Promise<PlanOutput>
}

export type PlannerBackend = 'claude' | 'codex' | 'agy' | 'kimi' | 'opencode' | 'none'
