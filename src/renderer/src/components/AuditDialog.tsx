import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  Loader2,
  Power,
  RefreshCw,
  ShieldX,
  SquareTerminal,
  XCircle
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuditCall, AuditEntry, AuditNote, AuditQuery, AuditStatus } from '@shared/types'
import { useAppStore } from '../state/store'
import { formatBytes } from '../lib/format'
import { Modal } from './Modal'

type Range = 'today' | '7d' | '30d' | '90d' | 'custom'

const RANGES: Array<{ value: Range; label: string; days?: number }> = [
  { value: 'today', label: '今天', days: 0 },
  { value: '7d', label: '近 7 天', days: 6 },
  { value: '30d', label: '近 30 天', days: 29 },
  { value: '90d', label: '近 90 天', days: 89 },
  { value: 'custom', label: '自定义' }
]

const STATUSES: Array<{ value: '' | AuditStatus; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'unfinished', label: '未完成' },
  { value: 'error', label: '失败 / 非零退出' },
  { value: 'denied', label: '被拒绝' },
  { value: 'success', label: '成功' },
  { value: 'running', label: '执行中' }
]

const PAGE = 500

function shiftDate(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d - days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatStamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function callPreview(call: AuditCall): string {
  const args = call.args ?? {}
  for (const key of ['command', 'path', 'remote_path', 'from', 'local_path']) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function isFailed(call: AuditCall): boolean {
  return call.status === 'error' || (typeof call.exitCode === 'number' && call.exitCode !== 0)
}

function CallIcon({ call }: { call: AuditCall }) {
  if (call.status === 'unfinished') return <AlertTriangle size={12} className="text-warn" />
  if (call.status === 'running') return <Loader2 size={12} className="animate-spin text-accent" />
  if (call.status === 'denied') return <ShieldX size={12} className="text-faint" />
  if (isFailed(call)) return <XCircle size={12} className="text-err" />
  return <CheckCircle2 size={12} className="text-ok" />
}

const NOTE_LABEL: Record<string, string> = {
  'agent:launch': '启动 Agent',
  'agent:stop': '停止 Agent',
  'agent:exit': 'Agent 进程退出',
  'agent:app_quit': '应用退出，Agent 结束',
  'shell:open': '打开持久 shell',
  'shell:close': '关闭持久 shell',
  'snapshot:agent_launch': '现场快照 · Agent 启动时',
  'snapshot:before_dangerous': '现场快照 · 高危命令执行前',
  'bash:local_bash': '本机命令（未经 MCP）'
}

const SHELL_CLOSE_REASON: Record<string, string> = {
  agent: 'Agent 关闭',
  user: '用户关闭',
  idle: '空闲超时',
  disconnected: '连接断开',
  exited: 'shell 退出',
  init_failed: '初始化失败'
}

function noteTitle(note: AuditNote): string {
  return NOTE_LABEL[`${note.kind}:${note.action ?? ''}`] ?? `${note.kind} ${note.action ?? ''}`
}

function snapshotSummary(payload: Record<string, unknown> | undefined): string {
  if (!payload) return ''
  const parts: string[] = []
  const load = payload.load as number[] | undefined
  const cpus = payload.cpus
  if (load?.length) {
    // Load alone says little without the core count: 8 on 4 cores is critical.
    const perCore = typeof cpus === 'number' ? ` / ${(load[0] / cpus).toFixed(2)} 核` : ''
    parts.push(`负载 ${load.join(' / ')}${perCore}`)
  }
  if (typeof payload.memUsedPct === 'number') parts.push(`内存 ${payload.memUsedPct}%`)
  if (typeof payload.swapUsedPct === 'number') parts.push(`Swap ${payload.swapUsedPct}%`)
  const disks = payload.disks as Array<{ mount: string; usePct: number }> | undefined
  if (disks?.length) {
    const worst = disks.reduce((a, b) => (b.usePct > a.usePct ? b : a))
    parts.push(`磁盘 ${worst.mount} ${worst.usePct}%`)
  }
  if (typeof payload.procCount === 'number') parts.push(`进程 ${payload.procCount}`)
  return parts.join(' · ')
}

function snapshotAlarming(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  const disks = (payload.disks as Array<{ usePct: number }> | undefined) ?? []
  const load = payload.load as number[] | undefined
  return (
    disks.some((disk) => disk.usePct >= 90) ||
    (typeof payload.cpus === 'number' &&
      (load?.[0] ?? 0) >= payload.cpus * 2) ||
    (typeof payload.memUsedPct === 'number' && payload.memUsedPct >= 90) ||
    (typeof payload.swapUsedPct === 'number' && payload.swapUsedPct >= 50)
  )
}

function Block({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-base px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink/85">
        {value}
      </pre>
    </div>
  )
}

function CallDetail({ call }: { call: AuditCall }) {
  const out = call.output ?? {}
  const text = (key: string): string => (typeof out[key] === 'string' ? (out[key] as string) : '')
  const meta: string[] = []
  if (call.dangerous) meta.push('高危命令')
  if (call.crossSession) meta.push('跨会话操作')
  // Legacy entries from builds that had an approval prompt.
  if (call.decision) {
    const label: Record<string, string> = {
      allow: '允许一次',
      always: '本会话始终允许',
      deny: '拒绝',
      timeout: '超时自动拒绝',
      cancelled: '已取消'
    }
    meta.push(`审批：${label[call.decision] ?? call.decision}`)
  }
  if (call.durationMs !== undefined) meta.push(`耗时 ${call.durationMs} ms`)
  if (typeof out.stdoutBytes === 'number') meta.push(`stdout ${formatBytes(out.stdoutBytes)}`)
  if (typeof out.outputBytes === 'number') meta.push(`输出 ${formatBytes(out.outputBytes)}`)
  if (typeof out.cwd === 'string') meta.push(`cwd ${out.cwd}`)
  // The result record only exists once the call settles, so a timed-out
  // `shell_run` shows `running` but was not still running when it ended.
  if (out.running && call.status !== 'success') meta.push('返回时仍在运行')
  if (out.timedOut) meta.push('等待超时')
  if (out.interrupted) meta.push('已发送 Ctrl+C')
  if (call.agentSessionId) meta.push(`Agent 实例 ${call.agentSessionId.slice(0, 8)}`)

  return (
    <div className="ml-[42px] mt-2 space-y-2 pb-1">
      {call.status === 'unfinished' && (
        <div className="rounded border border-warn/30 bg-warn/5 px-2 py-1.5 text-[10px] text-warn">
          只有执行意图、没有结果记录：命令发出后应用退出、崩溃或连接中断，服务器上的实际结果未知。
        </div>
      )}
      <Block label="参数" value={JSON.stringify(call.args, null, 2)} />
      <Block label="stdout" value={text('stdout')} />
      <Block label="stderr" value={text('stderr')} />
      <Block label="输出" value={text('output')} />
      {call.error && <div className="text-[10px] text-err">{call.error}</div>}
      {meta.length > 0 && <div className="text-[10px] text-faint">{meta.join(' · ')}</div>}
    </div>
  )
}

function NoteRow({ note }: { note: AuditNote }) {
  const [open, setOpen] = useState(false)
  const icon =
    note.kind === 'snapshot' ? (
      <Camera size={12} className={snapshotAlarming(note.payload) ? 'text-warn' : 'text-dim'} />
    ) : note.kind === 'bash' ? (
      <SquareTerminal size={12} className="text-warn" />
    ) : note.kind === 'shell' ? (
      <SquareTerminal size={12} className="text-accent-2" />
    ) : (
      <Power size={12} className="text-dim" />
    )
  let detail = ''
  if (note.kind === 'snapshot') detail = snapshotSummary(note.payload)
  else if (note.kind === 'bash') detail = String(note.payload?.command ?? '')
  else if (note.kind === 'shell' && note.reason) detail = SHELL_CLOSE_REASON[note.reason] ?? note.reason
  else if (note.kind === 'agent' && note.payload?.exitCode !== undefined) {
    detail = `退出码 ${String(note.payload.exitCode)}`
  }

  return (
    <div
      className="cursor-pointer border-b border-line/50 bg-panel-2/30 px-3 py-1.5 hover:bg-panel-2/70"
      onClick={() => setOpen(!open)}
    >
      <div className="flex items-center gap-2">
        {open ? (
          <ChevronDown size={10} className="shrink-0 text-faint" />
        ) : (
          <ChevronRight size={10} className="shrink-0 text-faint" />
        )}
        {icon}
        <span className="w-[104px] shrink-0 font-mono text-[10px] text-faint">
          {formatStamp(note.ts)}
        </span>
        <span className="w-[120px] shrink-0 truncate text-[10px] text-dim">
          {note.sessionName ?? note.sessionId}
        </span>
        <span className="shrink-0 text-[11px] text-dim">{noteTitle(note)}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-faint">{detail}</span>
        {note.profileId && <span className="chip shrink-0">{note.profileId}</span>}
      </div>
      {open && note.payload && (
        <div className="ml-[42px] mt-2">
          <Block label="详情" value={JSON.stringify(note.payload, null, 2)} />
        </div>
      )}
    </div>
  )
}

function CallRow({ call }: { call: AuditCall }) {
  const [open, setOpen] = useState(false)
  const preview = callPreview(call)
  const exit =
    call.exitCode === undefined || call.exitCode === null ? null : `exit ${call.exitCode}`

  return (
    <div
      className={`cursor-pointer border-b border-line/50 px-3 py-1.5 hover:bg-panel-2/60 ${
        call.status === 'unfinished' ? 'bg-warn/5' : ''
      }`}
      onClick={() => setOpen(!open)}
    >
      <div className="flex items-center gap-2">
        {open ? (
          <ChevronDown size={10} className="shrink-0 text-faint" />
        ) : (
          <ChevronRight size={10} className="shrink-0 text-faint" />
        )}
        <CallIcon call={call} />
        <span className="w-[104px] shrink-0 font-mono text-[10px] text-faint">
          {formatStamp(call.ts)}
        </span>
        <span
          className="w-[120px] shrink-0 truncate text-[10px] text-dim"
          title={`${call.username}@${call.host}`}
        >
          {call.sessionName || call.host}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-accent/90">{call.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink/80" title={preview}>
          {preview}
        </span>
        {call.dangerous && <span className="chip shrink-0 border-err/30 text-err">高危</span>}
        {call.status === 'unfinished' && (
          <span className="chip shrink-0 border-warn/30 text-warn">未完成</span>
        )}
        {exit && (
          <span
            className={`shrink-0 font-mono text-[10px] ${call.exitCode === 0 ? 'text-faint' : 'text-err'}`}
          >
            {exit}
          </span>
        )}
        {call.profileId && <span className="chip shrink-0">{call.profileId}</span>}
      </div>
      {open && <CallDetail call={call} />}
    </div>
  )
}

export function AuditDialog() {
  const open = useAppStore((s) => s.auditOpen)
  const setOpen = useAppStore((s) => s.setAuditOpen)
  const sessions = useAppStore((s) => s.sessions)
  const pushToast = useAppStore((s) => s.pushToast)

  const [today, setToday] = useState('')
  const [range, setRange] = useState<Range>('7d')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [status, setStatus] = useState<'' | AuditStatus>('')
  const [text, setText] = useState('')
  const [showNotes, setShowNotes] = useState(true)
  const [limit, setLimit] = useState(PAGE)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState<{ totalBytes: number; fileCount: number; retentionDays: number } | null>(null)

  useEffect(() => {
    if (!open) return
    void window.aishell.audit.today().then((key) => {
      setToday(key)
      setFrom((value) => value || shiftDate(key, 6))
      setTo((value) => value || key)
    })
    void window.aishell.audit.info().then(setInfo).catch(() => setInfo(null))
  }, [open])

  const bounds = useMemo((): { from: string; to: string } | null => {
    if (!today) return null
    const preset = RANGES.find((item) => item.value === range)
    if (preset?.days !== undefined) return { from: shiftDate(today, preset.days), to: today }
    if (!from || !to) return null
    return from <= to ? { from, to } : { from: to, to: from }
  }, [today, range, from, to])

  const query = useMemo((): AuditQuery | null => {
    if (!bounds) return null
    return {
      ...bounds,
      sessionId: sessionId || undefined,
      status: status || undefined,
      text: text.trim() || undefined,
      limit
    }
  }, [bounds, sessionId, status, text, limit])

  const load = useCallback(async (): Promise<void> => {
    if (!query) return
    setLoading(true)
    try {
      const result = await window.aishell.audit.query(query)
      setEntries(result.entries)
      setHasMore(result.hasMore)
    } catch (err) {
      pushToast('error', `读取审计日志失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [query, pushToast])

  useEffect(() => {
    if (!open || !query) return
    const timer = setTimeout(() => void load(), text ? 250 : 0)
    return () => clearTimeout(timer)
  }, [open, query, load, text])

  useEffect(() => {
    setLimit(PAGE)
  }, [range, from, to, sessionId, status, text])

  const visible = useMemo(
    () => (showNotes && !status ? entries : entries.filter((entry) => entry.kind === 'call')),
    [entries, showNotes, status]
  )

  const counts = useMemo(() => {
    const calls = entries.filter((entry): entry is AuditCall => entry.kind === 'call')
    return {
      calls: calls.length,
      unfinished: calls.filter((call) => call.status === 'unfinished').length,
      failed: calls.filter(isFailed).length,
      denied: calls.filter((call) => call.status === 'denied').length
    }
  }, [entries])

  // Sessions that only exist in the log (deleted since) still need a filter entry.
  const sessionOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, session.name)
    for (const entry of entries) {
      if (entry.sessionId && !map.has(entry.sessionId)) {
        map.set(entry.sessionId, `${entry.sessionName || entry.sessionId}（已删除）`)
      }
    }
    return Array.from(map.entries())
  }, [sessions, entries])

  const exportAs = async (format: 'jsonl' | 'csv'): Promise<void> => {
    if (!query) return
    try {
      const result = await window.aishell.audit.export({ ...query, limit: undefined }, format)
      if (result) pushToast('info', `已导出 ${result.count} 条记录到 ${result.path}`)
    } catch (err) {
      pushToast('error', `导出失败：${(err as Error).message}`)
    }
  }

  return (
    <Modal
      open={open}
      title="审计记录"
      subtitle="Agent 通过 AIShell 执行的每一次操作。命令在发出前就已写入本机磁盘，应用或服务器崩溃后仍可查。"
      onClose={() => setOpen(false)}
      width="max-w-5xl"
      bodyClass="p-0 flex flex-col"
      footer={
        <>
          <span className="mr-auto text-[10px] text-faint">
            {info
              ? `${info.fileCount} 个日志文件 · ${formatBytes(info.totalBytes)} · ${
                  info.retentionDays > 0 ? `保留 ${info.retentionDays} 天` : '永久保留'
                }`
              : ''}
          </span>
          <button className="btn-secondary" onClick={() => void window.aishell.audit.openDir()}>
            <FolderOpen size={13} />
            打开目录
          </button>
          <button className="btn-secondary" onClick={() => void exportAs('csv')} disabled={!query}>
            <Download size={13} />
            导出 CSV
          </button>
          <button className="btn-secondary" onClick={() => void exportAs('jsonl')} disabled={!query}>
            <Download size={13} />
            导出 JSONL
          </button>
        </>
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <select
          className="input h-7 w-auto py-0 text-[11px]"
          value={range}
          onChange={(event) => setRange(event.target.value as Range)}
        >
          {RANGES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        {range === 'custom' && (
          <>
            <input
              type="date"
              className="input h-7 w-auto py-0 text-[11px]"
              value={from}
              max={today}
              onChange={(event) => setFrom(event.target.value)}
            />
            <span className="text-[11px] text-faint">至</span>
            <input
              type="date"
              className="input h-7 w-auto py-0 text-[11px]"
              value={to}
              max={today}
              onChange={(event) => setTo(event.target.value)}
            />
          </>
        )}
        <select
          className="input h-7 w-auto max-w-[180px] py-0 text-[11px]"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
        >
          <option value="">全部会话</option>
          {sessionOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="input h-7 w-auto py-0 text-[11px]"
          value={status}
          onChange={(event) => setStatus(event.target.value as '' | AuditStatus)}
        >
          {STATUSES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <input
          className="input h-7 min-w-[160px] flex-1 py-0 text-[11px]"
          placeholder="搜索命令、路径、输出…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <label className="flex items-center gap-1.5 text-[11px] text-dim">
          <input
            type="checkbox"
            className="accent-cyan-400"
            checked={showNotes}
            disabled={Boolean(status)}
            onChange={(event) => setShowNotes(event.target.checked)}
          />
          显示快照与生命周期
        </label>
        <button className="icon-btn h-7 w-7" title="刷新" onClick={() => void load()}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-panel-2/40 px-4 py-1.5 text-[10px] text-faint">
        <span>{counts.calls} 次调用</span>
        {counts.unfinished > 0 && <span className="text-warn">{counts.unfinished} 次未完成</span>}
        {counts.failed > 0 && <span className="text-err">{counts.failed} 次失败</span>}
        {counts.denied > 0 && <span>{counts.denied} 次被拒绝</span>}
        {hasMore && <span className="ml-auto">只显示最近 {limit} 条</span>}
      </div>

      <div className="min-h-[360px] flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-[360px] items-center justify-center text-[11px] text-faint">
            {loading ? '正在读取…' : '该范围内没有审计记录'}
          </div>
        ) : (
          visible.map((entry) =>
            entry.kind === 'call' ? (
              <CallRow key={entry.id} call={entry} />
            ) : (
              <NoteRow key={entry.id} note={entry} />
            )
          )
        )}
        {hasMore && (
          <div className="flex justify-center py-3">
            <button
              className="btn-secondary h-7 text-[11px]"
              onClick={() => setLimit((value) => value + PAGE)}
            >
              加载更多
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
