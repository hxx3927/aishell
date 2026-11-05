import { app } from 'electron'
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  promises as fsp,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AuditCall,
  AuditEntry,
  AuditInfo,
  AuditNote,
  AuditQuery,
  AuditQueryResult
} from '@shared/types'
import { redactText, redactValue } from './redact'

const OVERSIZE_BYTES = 200 * 1024 * 1024
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 5000
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY_MS = 86_400_000
const UTF8_BOM = String.fromCharCode(0xfeff)
/** How long an intent may lack a result before it counts as a crash. */
const CRASH_GRACE_MS = 60_000
/** How long a day file must go unwritten before its loose intents count as crashed. */

interface AuditFile {
  key: string
  path: string
  size: number
}

export interface IntentInput {
  sessionId: string
  sessionName: string
  host: string
  username: string
  agentSessionId?: string
  profileId?: string
  tool: string
  args: Record<string, unknown>
  /** The call targeted a session other than the one the agent is bound to. */
  crossSession?: boolean
  dangerous: boolean
}

export interface ResultInput {
  status: 'success' | 'error'
  durationMs: number
  exitCode?: number | null
  summary?: string
  error?: string
  output?: Record<string, unknown>
}

export type NoteInput = Omit<AuditNote, 'id' | 'ts'>

export interface BashInput {
  sessionId: string
  sessionName?: string
  host?: string
  agentSessionId?: string
  profileId?: string
  command: string
  cwd?: string
  transport?: string
  hookSessionId?: string
}

/** Local calendar date, YYYY-MM-DD. */
export function dateKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Append-only audit log of everything agents do through MCP, one JSONL file
 * per local day.
 *
 * A tool call is written as separate records: `intent` before anything
 * touches the server, then `result` (and, in older logs, a legacy `decision`).
 * If the server or the app dies mid-command, the intent survives without a
 * result, which is exactly the evidence needed afterwards.
 */
export class AuditStore {
  readonly dir: string
  private current: { key: string; fd: number } | null = null
  /** Calls whose result has not been written yet, keyed by audit id. */
  private pending = new Map<string, { key: string }>()
  private warned = false

  constructor(
    private readonly getRetentionDays: () => number,
    private readonly notify: (message: string) => void
  ) {
    // The override lets the store be exercised without starting Electron.
    this.dir = join(process.env.AISHELL_AUDIT_TEST_DIR ?? app.getPath('userData'), 'audit')
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * Writes the intent synchronously. `durable` also flushes it to disk; use it
   * for calls that can change the server. Throws when the record cannot be
   * written so callers can refuse to run unaudited commands.
   */
  recordIntent(input: IntentInput, options: { durable: boolean }): string {
    const id = randomUUID()
    const ts = Date.now()
    const key = dateKey(ts)
    const record = { v: 1, type: 'intent', id, ts, ...input, args: redactValue(input.args) }
    this.write(key, record, options.durable)
    this.pending.set(id, { key })
    return id
  }

  recordResult(id: string, result: ResultInput): void {
    const key = this.pending.get(id)?.key ?? dateKey(Date.now())
    this.pending.delete(id)
    this.safeWrite(key, {
      v: 1,
      type: 'result',
      id,
      ts: Date.now(),
      ...result,
      summary: result.summary === undefined ? undefined : redactText(result.summary),
      error: result.error === undefined ? undefined : redactText(result.error),
      output: result.output === undefined ? undefined : redactValue(result.output)
    })
  }

  /**
   * A command the agent ran in its *local* shell, outside MCP — typically
   * `ssh`/`scp`/`sftp` reaching a server behind AIShell's back. Recorded from
   * the Claude Code PreToolUse hook, which fires before execution, so there is
   * no result to attach; the command text is the evidence.
   */
  recordBash(input: BashInput): string {
    return this.recordNote({
      kind: 'bash',
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      host: input.host,
      agentSessionId: input.agentSessionId,
      profileId: input.profileId,
      action: 'local_bash',
      payload: {
        command: input.command,
        cwd: input.cwd,
        transport: input.transport,
        hookSessionId: input.hookSessionId
      }
    })
  }

  recordNote(note: NoteInput): string {
    const id = randomUUID()
    const ts = Date.now()
    this.safeWrite(dateKey(ts), {
      v: 1,
      type: 'note',
      id,
      ts,
      ...note,
      reason: note.reason === undefined ? undefined : redactText(note.reason),
      payload: note.payload === undefined ? undefined : redactValue(note.payload)
    })
    return id
  }

  async query(query: AuditQuery): Promise<AuditQueryResult> {
    const entries = await this.collect(query)
    entries.sort((a, b) => b.ts - a.ts)
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    return { entries: entries.slice(0, limit), hasMore: entries.length > limit }
  }

  /** Writes every matching entry, oldest first. Returns the entry count. */
  async exportTo(path: string, query: AuditQuery, format: 'jsonl' | 'csv'): Promise<number> {
    const entries = await this.collect(query)
    entries.sort((a, b) => a.ts - b.ts)
    const content =
      format === 'csv'
        ? // The BOM lets Excel detect UTF-8 so Chinese text is not garbled.
          UTF8_BOM + toCsv(entries)
        : entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '')
    await fsp.writeFile(path, content, 'utf8')
    return entries.length
  }

  async info(): Promise<AuditInfo> {
    const files = await this.listFiles()
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    return {
      dir: this.dir,
      totalBytes,
      fileCount: files.length,
      retentionDays: this.getRetentionDays(),
      oversize: totalBytes > OVERSIZE_BYTES
    }
  }

  /** Deletes day files older than the retention period. Never touches today. */
  async prune(): Promise<number> {
    const days = this.getRetentionDays()
    if (!(days > 0)) return 0
    const cutoff = dateKey(Date.now() - days * DAY_MS)
    const today = dateKey(Date.now())
    let removed = 0
    for (const file of await this.listFiles()) {
      if (file.key >= cutoff || file.key === today) continue
      try {
        await fsp.unlink(file.path)
        removed += 1
      } catch (err) {
        console.warn('[audit] failed to remove', file.path, err)
      }
    }
    return removed
  }

  dispose(): void {
    if (!this.current) return
    try {
      closeSync(this.current.fd)
    } catch {
      /* ignore */
    }
    this.current = null
  }

  private fileFor(key: string): string {
    return join(this.dir, `${key}.jsonl`)
  }

  private write(key: string, record: object, durable = false): void {
    const line = `${JSON.stringify(record)}\n`
    const today = dateKey(Date.now())
    if (key !== today) {
      // Late decision/result for a call that started before midnight: keep it
      // in the same file as its intent.
      appendFileSync(this.fileFor(key), line, 'utf8')
      return
    }
    try {
      if (!this.current || this.current.key !== today) {
        this.dispose()
        this.current = { key: today, fd: openSync(this.fileFor(today), 'a') }
      }
      writeSync(this.current.fd, line)
      if (durable) fsyncSync(this.current.fd)
    } catch (err) {
      // Drop the cached descriptor so the next write reopens the file.
      this.dispose()
      throw err
    }
  }

  private safeWrite(key: string, record: object): void {
    try {
      this.write(key, record)
    } catch (err) {
      console.error('[audit] write failed', err)
      if (!this.warned) {
        this.warned = true
        this.notify(`审计日志写入失败：${(err as Error).message}`)
      }
    }
  }

  private async listFiles(): Promise<AuditFile[]> {
    let names: string[]
    try {
      names = await fsp.readdir(this.dir)
    } catch {
      return []
    }
    const files: AuditFile[] = []
    for (const name of names) {
      const match = FILE_RE.exec(name)
      if (!match) continue
      const path = join(this.dir, name)
      try {
        const stats = await fsp.stat(path)
        files.push({ key: match[1], path, size: stats.size })
      } catch {
        /* removed meanwhile */
      }
    }
    return files.sort((a, b) => a.key.localeCompare(b.key))
  }

  private async collect(query: AuditQuery): Promise<AuditEntry[]> {
    const files = (await this.listFiles()).filter(
      (file) => file.key >= query.from && file.key <= query.to
    )
    const calls = new Map<string, AuditCall>()
    const notes: AuditNote[] = []
    const callOffset = new Map<string, number>()
    const scan = new Map<string, number>()

    for (const file of files) {
      let text: string
      try {
        text = await fsp.readFile(file.path, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      scan.set(file.key, lines.length)
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue
        let record: Record<string, unknown>
        try {
          record = JSON.parse(line) as Record<string, unknown>
        } catch {
          // A torn last line from a crash; everything before it is still valid.
          continue
        }
        if (record.type === 'intent') callOffset.set(String(record.id), index)
        applyRecord(record, calls, notes)
      }
    }

    // A record with no result after CRASH_GRACE_MS means the app died — but
    // only if this process did not write it. The scan positions were fixed
    // before the reads; anything past them appeared later in this process.
    const today = dateKey(Date.now())
    for (const call of calls.values()) {
      if (call.status !== 'running') continue
      const key = this.pending.get(call.id)?.key ?? dateKey(call.ts)
      const position = callOffset.get(call.id) ?? Number.POSITIVE_INFINITY
      if (this.pending.has(call.id) && position >= (scan.get(key) ?? 0)) continue
      if (key < today || Date.now() - call.ts > CRASH_GRACE_MS) call.status = 'unfinished'
    }

    const needle = query.text?.trim().toLowerCase()
    const entries: AuditEntry[] = [...calls.values(), ...notes]
    return entries.filter((entry) => {
      if (query.sessionId && entry.sessionId !== query.sessionId) return false
      if (query.status) {
        if (entry.kind !== 'call') return false
        if (!matchesStatus(entry, query.status)) return false
      }
      if (needle && !JSON.stringify(entry).toLowerCase().includes(needle)) return false
      return true
    })
  }
}

function isRefusal(decision: string | undefined): boolean {
  return decision !== undefined && decision !== 'allow' && decision !== 'always'
}

function matchesStatus(call: AuditCall, status: AuditQuery['status']): boolean {
  if (status === 'error') {
    return (
      call.status === 'error' || (typeof call.exitCode === 'number' && call.exitCode !== 0)
    )
  }
  return call.status === status
}

function applyRecord(
  record: Record<string, unknown>,
  calls: Map<string, AuditCall>,
  notes: AuditNote[]
): void {
  const id = String(record.id ?? '')
  const ts = Number(record.ts ?? 0)
  if (!id) return

  switch (record.type) {
    case 'intent':
      calls.set(id, {
        kind: 'call',
        id,
        ts,
        sessionId: String(record.sessionId ?? ''),
        sessionName: String(record.sessionName ?? ''),
        host: String(record.host ?? ''),
        username: String(record.username ?? ''),
        agentSessionId: optionalString(record.agentSessionId),
        profileId: optionalString(record.profileId),
        tool: String(record.tool ?? ''),
        args: (record.args as Record<string, unknown>) ?? {},
        crossSession: record.crossSession === true ? true : undefined,
        dangerous: Boolean(record.dangerous),
        status: 'running'
      })
      return
    case 'decision': {
      // Older logs carry approval decisions. Kept so those entries still
      // read correctly; nothing writes this record any more.
      const call = calls.get(id)
      if (!call) return
      call.decision = String(record.decision ?? '')
      if (isRefusal(call.decision)) call.status = 'denied'
      return
    }
    case 'result': {
      const call = calls.get(id)
      if (!call) return
      call.status = isRefusal(call.decision)
        ? 'denied'
        : record.status === 'error'
          ? 'error'
          : 'success'
      call.endedAt = ts
      call.durationMs = typeof record.durationMs === 'number' ? record.durationMs : undefined
      call.exitCode =
        typeof record.exitCode === 'number' || record.exitCode === null
          ? (record.exitCode as number | null)
          : undefined
      call.summary = optionalString(record.summary)
      call.error = optionalString(record.error)
      call.output = (record.output as Record<string, unknown>) ?? undefined
      return
    }
    case 'note': {
      const kind = record.kind
      if (kind !== 'snapshot' && kind !== 'agent' && kind !== 'shell') return
      notes.push({
        kind,
        id,
        ts,
        sessionId: String(record.sessionId ?? ''),
        sessionName: optionalString(record.sessionName),
        host: optionalString(record.host),
        agentSessionId: optionalString(record.agentSessionId),
        profileId: optionalString(record.profileId),
        action: optionalString(record.action),
        reason: optionalString(record.reason),
        relatedId: optionalString(record.relatedId),
        payload: (record.payload as Record<string, unknown>) ?? undefined
      })
      return
    }
    default:
      return
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

const CSV_COLUMNS = [
  '时间',
  '类型',
  '会话',
  '主机',
  '用户',
  'Agent',
  '工具',
  '参数',
  '状态',
  '审批',
  '退出码',
  '耗时(ms)',
  '摘要',
  '错误'
]

function toCsv(entries: AuditEntry[]): string {
  const rows = [CSV_COLUMNS]
  for (const entry of entries) {
    const time = new Date(entry.ts).toISOString()
    if (entry.kind === 'call') {
      rows.push([
        time,
        'call',
        entry.sessionName,
        entry.host,
        entry.username,
        entry.profileId ?? '',
        entry.tool,
        JSON.stringify(entry.args),
        entry.status,
        entry.decision ?? '',
        entry.exitCode === undefined || entry.exitCode === null ? '' : String(entry.exitCode),
        entry.durationMs === undefined ? '' : String(entry.durationMs),
        entry.summary ?? '',
        entry.error ?? ''
      ])
    } else {
      rows.push([
        time,
        entry.kind,
        entry.sessionName ?? '',
        entry.host ?? '',
        '',
        entry.profileId ?? '',
        entry.action ?? '',
        entry.payload ? JSON.stringify(entry.payload) : '',
        '',
        '',
        '',
        '',
        entry.reason ?? '',
        ''
      ])
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function csvCell(value: string): string {
  // Leading = + - @ would be evaluated as formulas by spreadsheet apps.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
