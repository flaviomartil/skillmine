import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { defaultStoreRoot } from '../apply/store.ts'

export const INDEX_MARKER = '[skillmine-index]'

export function internalRoots(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const roots = [defaultStoreRoot(home, env), join(home, '.skillmine'), env.SKILLMINE_PLANNER_CWD, env.SKILLMINE_HAIKU_CWD]
  return roots.filter((r): r is string => !!r).map((r) => resolve(r))
}

export function isInternalProject(project: string | undefined, roots: string[] = internalRoots()): boolean {
  if (!project) return false
  const p = resolve(project)
  return roots.some((r) => {
    const root = resolve(r)
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
  })
}

export function isInjectedIndex(role: string, text: string): boolean {
  return role === 'user' && text.trimStart().startsWith(INDEX_MARKER)
}
