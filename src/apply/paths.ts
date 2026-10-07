import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Scope } from '../plan/types.ts'

export type Layout = {
  home: string
  globalRoot: string
  globalFanout: string[]
  localRoot: (project: string) => string
  localFanout: (project: string) => string[]
}

export function defaultLayout(home = homedir()): Layout {
  return {
    home,
    globalRoot: process.env.SKILLMINE_GLOBAL_SKILLS ?? join(home, '.agents', 'skills'),
    globalFanout: [join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), join(home, '.kimi', 'skills'), join(home, '.kimi-code', 'skills'), join(home, '.gemini', 'config', 'skills'), join(home, '.config', 'opencode', 'skills')],
    localRoot: (project) => join(project, '.agents', 'skills'),
    localFanout: (project) => [join(project, '.claude', 'skills')],
  }
}

export function rootFor(layout: Layout, scope: Scope, project: string): string {
  return scope === 'local' && project ? layout.localRoot(project) : layout.globalRoot
}

export function fanoutFor(layout: Layout, scope: Scope, project: string): string[] {
  return scope === 'local' && project ? layout.localFanout(project) : layout.globalFanout
}
