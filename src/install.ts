import { lstat, mkdir, readlink, realpath, rm, stat, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const THIN_SKILL = 'skillmine'

export function thinSkillTargets(home = homedir()): string[] {
  return [
    join(home, '.codex', 'skills'),
    join(home, '.kimi', 'skills'),
    join(home, '.kimi-code', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
    join(home, '.gemini', 'config', 'skills'),
  ]
}

export async function locateThinSkill(from?: string): Promise<string> {
  const candidates = [from, process.env.SKILLMINE_REPO && join(process.env.SKILLMINE_REPO, 'clients', THIN_SKILL), join(import.meta.dir, '..', 'clients', THIN_SKILL)]
  try {
    const exe = await realpath(process.execPath)
    candidates.push(join(dirname(exe), '..', 'clients', THIN_SKILL))
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    if (!c) continue
    try {
      if ((await stat(join(c, 'SKILL.md'))).isFile()) return await realpath(c)
    } catch {
      continue
    }
  }
  throw new Error('thin skill not found; pass --from <dir containing SKILL.md> or set SKILLMINE_REPO')
}

export type InstallResult = { source: string; linked: string[]; skipped: { dir: string; reason: string }[] }

export async function installThinSkill(opts: { from?: string; targets?: string[]; home?: string } = {}): Promise<InstallResult> {
  const source = await locateThinSkill(opts.from)
  const out: InstallResult = { source, linked: [], skipped: [] }
  for (const dir of opts.targets ?? thinSkillTargets(opts.home)) {
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      out.skipped.push({ dir, reason: 'client not installed' })
      continue
    }
    const link = join(dir, THIN_SKILL)
    try {
      const st = await lstat(link)
      if (st.isSymbolicLink()) {
        if ((await readlink(link)) === source) {
          out.linked.push(link)
          continue
        }
        await unlink(link)
      } else {
        out.skipped.push({ dir, reason: `${link} exists and is not a symlink` })
        continue
      }
    } catch {
      /* nothing there */
    }
    await mkdir(dir, { recursive: true })
    await symlink(source, link)
    out.linked.push(link)
  }
  return out
}

export async function uninstallThinSkill(opts: { targets?: string[]; home?: string } = {}): Promise<string[]> {
  const removed: string[] = []
  for (const dir of opts.targets ?? thinSkillTargets(opts.home)) {
    const link = join(dir, THIN_SKILL)
    try {
      if ((await lstat(link)).isSymbolicLink()) {
        await rm(link)
        removed.push(link)
      }
    } catch {
      continue
    }
  }
  return removed
}
