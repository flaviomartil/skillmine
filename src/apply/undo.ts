import { readFile, unlink, lstat, rename, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Store, sha256, type LedgerEntry } from './store.ts'
import { atomicWrite, removeDir } from './writer.ts'

export type UndoTarget = { last: true } | { id: string } | { run: string }

export type UndoResult = { undone: LedgerEntry[]; skipped: { entry: LedgerEntry; reason: string }[] }

export async function undo(store: Store, target: UndoTarget): Promise<UndoResult> {
  const all = await store.entries()
  const rolledBack = new Set(all.filter((e) => e.rollbackOf).map((e) => e.rollbackOf!))
  let picked: LedgerEntry[]
  if ('last' in target) {
    const candidate = [...all].reverse().find((e) => e.status === 'applied' && !rolledBack.has(e.id))
    picked = candidate ? [candidate] : []
  } else if ('id' in target) picked = all.filter((e) => e.id === target.id && e.status === 'applied' && !rolledBack.has(e.id))
  else picked = all.filter((e) => e.run === target.run && e.status === 'applied' && !rolledBack.has(e.id)).reverse()

  const undone: LedgerEntry[] = []
  const skipped: { entry: LedgerEntry; reason: string }[] = []
  for (const entry of picked) {
    try {
      await revert(store, entry)
      const record: LedgerEntry = { ...entry, id: store.newId(), ts: Date.now(), status: 'rolled_back', rollbackOf: entry.id, before: entry.after, after: entry.before }
      await store.append(record)
      undone.push(entry)
    } catch (e) {
      skipped.push({ entry, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { undone, skipped }
}

async function currentSha(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function revert(store: Store, entry: LedgerEntry): Promise<void> {
  if (entry.action === 'archive') {
    if (!entry.archivedTo) throw new Error('archive entry has no archivedTo')
    const dest = dirname(entry.path)
    try {
      await lstat(dest)
      throw new Error(`"${dest}" exists again; refusing to restore over it`)
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('"')) throw e
    }
    await mkdir(dirname(dest), { recursive: true })
    await rename(entry.archivedTo, dest)
    return
  }
  const now = await currentSha(entry.path)
  if (now !== entry.after) throw new Error(`"${entry.path}" changed after Skillmine wrote it; refusing to undo`)
  if (entry.action === 'create') {
    for (const link of entry.symlinks ?? []) {
      try {
        if ((await lstat(link)).isSymbolicLink()) await unlink(link)
      } catch {
        continue
      }
    }
    const dir = dirname(entry.path)
    const extras = (await readdir(dir)).filter((f) => f !== 'SKILL.md' && f !== 'references')
    if (extras.length) throw new Error(`"${dir}" has files Skillmine did not write (${extras.join(', ')}); refusing to delete`)
    await removeDir(dir)
    return
  }
  if (entry.before === null) {
    await unlink(entry.path)
    return
  }
  const text = await store.getBlob(entry.before)
  if (text === undefined) throw new Error(`blob ${entry.before.slice(0, 12)} missing from store`)
  await atomicWrite(entry.path, text)
}
