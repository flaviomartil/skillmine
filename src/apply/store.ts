import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { appendFile, readFile, writeFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
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

export function defaultStoreRoot(home = homedir()): string {
  return process.env.SKILLMINE_HOME ?? join(home, '.skillmine')
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
    await appendFile(this.ledgerPath, JSON.stringify(entry) + '\n')
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
    const proc = Bun.spawn(['tar', '-czf', out, '-C', dirname(dir), basename(dir)], { stdout: 'ignore', stderr: 'pipe' })
    const code = await proc.exited
    if (code !== 0) throw new Error(`backup of ${dir} failed: ${await new Response(proc.stderr).text()}`)
    const siblings = readdirSync(this.backupsDir)
      .filter((f) => f.startsWith(label + '.') && f.endsWith('.tar.gz'))
      .sort()
    for (const old of siblings.slice(0, Math.max(0, siblings.length - keep))) unlinkSync(join(this.backupsDir, old))
    return out
  }
}

function slugPath(p: string): string {
  return p.replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 80)
}
