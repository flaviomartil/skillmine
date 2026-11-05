import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { appendFile, readFile, writeFile, stat, rm, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename, dirname, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { Edit } from '../plan/types.ts'

export type LedgerStatus = 'applied' | 'rejected' | 'rolled_back' | 'failed'

export type LedgerEntry = {
  id: string
  run: string
  ts: number
  status: LedgerStatus
  action: Edit['action']
  name: string
  path: string
  before: string | null
  after: string | null
  owner: 'skillmine' | 'human' | null
  reason: string
  sources: string[]
  symlinks?: string[]
  archivedTo?: string
  error?: string
  rollbackOf?: string
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function defaultStoreRoot(home = homedir(), env: Record<string, string | undefined> = process.env): string {
  const configured = env.SKILLMINE_HOME?.trim()
  if (!configured) return join(home, '.skillmine')
  return isAbsolute(configured) ? configured : resolve(home, configured)
}

export class Store {
  readonly root: string
  readonly ledgerPath: string
  readonly blobsDir: string
  readonly backupsDir: string

  constructor(root = defaultStoreRoot()) {
    this.root = root
    this.ledgerPath = join(root, 'ledger.jsonl')
    this.blobsDir = join(root, 'blobs')
    this.backupsDir = join(root, 'backups')
    mkdirSync(this.blobsDir, { recursive: true })
    mkdirSync(this.backupsDir, { recursive: true })
  }

  newId(prefix = 'e'): string {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  async putBlob(text: string): Promise<string> {
    const sha = sha256(text)
    const p = join(this.blobsDir, sha)
    if (!existsSync(p)) await writeFile(p, text)
    return sha
  }

  async getBlob(sha: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.blobsDir, sha), 'utf8')
    } catch {
      return undefined
    }
  }

  async append(entry: LedgerEntry): Promise<void> {
    let prefix = ''
    try {
      const fh = await open(this.ledgerPath, 'r')
      try {
        const { size } = await fh.stat()
        if (size > 0) {
          const last = Buffer.alloc(1)
          await fh.read(last, 0, 1, size - 1)
          if (last[0] !== 10) prefix = '\n'
        }
      } finally {
        await fh.close()
      }
    } catch {
      prefix = ''
    }
    await appendFile(this.ledgerPath, prefix + JSON.stringify(entry) + '\n')
  }

  async entries(): Promise<LedgerEntry[]> {
    let text: string
    try {
      text = await readFile(this.ledgerPath, 'utf8')
    } catch {
      return []
    }
    const out: LedgerEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as LedgerEntry)
      } catch {
        continue
      }
    }
    return out
  }

  async recentSummaries(n = 20): Promise<string[]> {
    const all = await this.entries()
    return all
      .filter((e) => e.status === 'applied')
      .slice(-n)
      .map((e) => `${e.action} ${e.name}: ${e.reason.slice(0, 100)}`)
  }

  async backup(dir: string, run: string, keep = 2): Promise<string | undefined> {
    try {
      if (!(await stat(dir)).isDirectory()) return undefined
    } catch {
      return undefined
    }
    const label = slugPath(dir)
    const out = join(this.backupsDir, `${label}.${run}.tar.gz`)
    const marker = `${out}.ok`
    if (existsSync(out) && existsSync(marker)) return out
    for (const leftover of [out, marker]) await rm(leftover, { force: true })
    const proc = Bun.spawn([process.env.SKILLMINE_TAR || 'tar', '-czhf', out, '-C', dirname(dir), '--', basename(dir)], { stdout: 'ignore', stderr: 'pipe' })
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    const warned = code === 1 && (await stat(out).then((st) => st.size > 0, () => false))
    if (code !== 0 && !warned) {
      await rm(out, { force: true })
      throw new Error(`backup of ${dir} failed: ${err}`)
    }
    await writeFile(marker, String(Date.now()))
    const siblings = readdirSync(this.backupsDir)
      .filter((f) => f.startsWith(label + '.') && f.endsWith('.tar.gz'))
      .sort()
    for (const old of siblings.slice(0, Math.max(0, siblings.length - keep))) {
      await rm(join(this.backupsDir, old), { force: true })
      await rm(join(this.backupsDir, `${old}.ok`), { force: true })
    }
    return out
  }
}

function slugPath(p: string): string {
  const slug = p.replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 70)
  return `${slug}-${createHash('sha256').update(p).digest('hex').slice(0, 8)}`
}
