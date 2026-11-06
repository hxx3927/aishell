import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Loader2,
  ShieldX,
  XCircle
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ActivityEvent, ActivityStatus } from '@shared/types'
import { useAppStore } from '../state/store'
import { formatClock } from '../lib/format'

interface ActivityFeedProps {
  sessionId?: string
  /** Narrows the feed to one agent instance (several may share a server). */
  agentSessionId?: string
  compact?: boolean
}

function StatusIcon({ status }: { status: ActivityStatus }) {
  if (status === 'running') {
    return <Loader2 size={11} className="animate-spin text-accent" />
  }
  if (status === 'success') return <CheckCircle2 size={11} className="text-ok" />
  if (status === 'error') return <XCircle size={11} className="text-err" />
  if (status === 'denied') return <ShieldX size={11} className="text-faint" />
  return <Clock3 size={11} className="text-warn" />
}

function argsPreview(event: ActivityEvent): string {
  const args = event.args ?? {}
  const keys = ['command', 'path', 'remote_path', 'local_path', 'from', 'to', 'name']
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value) {
      return value.length > 120 ? `${value.slice(0, 120)}…` : value
    }
  }
  const first = Object.values(args).find((value) => typeof value === 'string')
  return typeof first === 'string' ? first : ''
}

export function ActivityFeed({ sessionId, agentSessionId, compact }: ActivityFeedProps) {
  const activities = useAppStore((s) => s.activities)
  const sessions = useAppStore((s) => s.sessions)
  const [expanded, setExpanded] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const list = activities.filter((event) => {
      if (sessionId && event.sessionId !== sessionId) return false
      if (agentSessionId && event.agentSessionId !== agentSessionId) return false
      return true
    })
    return list.slice(0, compact ? 80 : 300)
  }, [activities, sessionId, agentSessionId, compact])

  if (filtered.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-faint">
        <Clock3 size={18} className="opacity-50" />
        <div>还没有 Agent 操作记录</div>
        <div className="leading-relaxed">
          启动 Agent 后，它通过 AIShell 执行的每一条命令、每一次文件修改都会显示在这里。
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      {filtered.map((event) => {
        const open = expanded === event.id
        const duration =
          event.endedAt && event.startedAt ? event.endedAt - event.startedAt : undefined
        const host = sessions.find((s) => s.id === event.sessionId)
        return (
          <div
            key={event.id}
            className="cursor-pointer border-b border-line/50 px-2.5 py-1.5 hover:bg-panel-2/60"
            onClick={() => setExpanded(open ? null : event.id)}
          >
            <div className="flex items-center gap-1.5">
              {open ? (
                <ChevronDown size={10} className="shrink-0 text-faint" />
              ) : (
                <ChevronRight size={10} className="shrink-0 text-faint" />
              )}
              <StatusIcon status={event.status} />
              <span className="shrink-0 font-mono text-[11px] text-accent/90">{event.tool}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-dim">
                {argsPreview(event)}
              </span>
              <span className="shrink-0 text-[9px] text-faint">
                {duration !== undefined ? `${duration} ms` : formatClock(event.startedAt)}
              </span>
            </div>

            {!sessionId && (
              <div className="ml-[34px] mt-0.5 text-[9px] text-faint">
                {host ? `${host.name} · ${host.username}@${host.host}` : event.sessionId}
              </div>
            )}

            {event.error && !open && (
              <div className="ml-[34px] mt-0.5 truncate text-[10px] text-err">{event.error}</div>
            )}

            {open && (
              <div className="ml-[34px] mt-1.5 space-y-1.5">
                <pre className="max-h-40 overflow-auto rounded border border-line bg-base px-2 py-1.5 font-mono text-[10px] leading-relaxed text-dim">
                  {JSON.stringify(event.args ?? {}, null, 2)}
                </pre>
                {event.summary && (
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-line bg-base px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink/85">
                    {event.summary}
                  </pre>
                )}
                {event.error && <div className="text-[10px] text-err">{event.error}</div>}
                <div className="text-[9px] text-faint">
                  {host ? `${host.name} · ` : ''}
                  {formatClock(event.startedAt)}
                  {event.endedAt ? ` → ${formatClock(event.endedAt)}` : ''}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
