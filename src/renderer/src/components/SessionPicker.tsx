import { Plus, Search, Server } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { sessionConnection, useAppStore } from '../state/store'
import { connectInTab } from '../lib/sessionActions'

function statusColor(status: string): string {
  if (status === 'connected') return 'bg-ok'
  if (status === 'connecting') return 'bg-warn pulse-dot'
  if (status === 'error') return 'bg-err'
  return 'bg-faint'
}

/** The body of a "new session" tab: pick a server, then become its terminal. */
export function SessionPicker({ tabId }: { tabId: string }) {
  const sessions = useAppStore((s) => s.sessions)
  const connections = useAppStore((s) => s.connections)
  const openSessionEditor = useAppStore((s) => s.openSessionEditor)
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase()
    const matched = term
      ? sessions.filter((session) =>
          [session.name, session.host, session.username, session.group]
            .join(' ')
            .toLowerCase()
            .includes(term)
        )
      : sessions
    const map = new Map<string, Session[]>()
    for (const session of matched) {
      const group = session.group || '默认'
      const list = map.get(group) ?? []
      list.push(session)
      map.set(group, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [sessions, search])

  const firstMatch = groups[0]?.[1][0]

  const choose = (session: Session): void => {
    void connectInTab(tabId, session)
  }

  return (
    <div className="flex h-full justify-center overflow-y-auto bg-base px-6 py-8">
      <div className="w-full max-w-xl">
        <div className="mb-1 text-sm font-medium text-ink">选择服务器</div>
        <div className="mb-4 text-[11px] text-faint">
          选中后该标签页会变成终端并自动连接。需要新的服务器时先创建连接。
        </div>

        <div className="relative mb-4">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            className="input py-2 pl-8 text-xs"
            placeholder="搜索连接、主机、用户…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && firstMatch) choose(firstMatch)
            }}
          />
        </div>

        {sessions.length === 0 && (
          <div className="rounded-xl border border-dashed border-line-2 px-4 py-10 text-center text-xs text-faint">
            还没有连接。先添加一台服务器。
          </div>
        )}

        {sessions.length > 0 && groups.length === 0 && (
          <div className="rounded-xl border border-dashed border-line-2 px-4 py-10 text-center text-xs text-faint">
            没有匹配的连接
          </div>
        )}

        <div className="space-y-4">
          {groups.map(([group, items]) => (
            <div key={group}>
              <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                {group}
              </div>
              <div className="space-y-1">
                {items.map((session) => {
                  const status =
                    sessionConnection(connections, session.id)?.status ?? 'disconnected'
                  return (
                    <button
                      key={session.id}
                      className="flex w-full items-center gap-3 rounded-lg border border-line-2 bg-panel-2/60 px-3 py-2.5 text-left transition hover:bg-panel-3"
                      onClick={() => choose(session)}
                    >
                      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-panel-3 text-dim">
                        <Server size={14} />
                        <span
                          className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${statusColor(status)}`}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-ink">
                          {session.name}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-faint">
                          {session.username}@{session.host}:{session.port}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <button
          className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-2 py-2.5 text-xs text-dim transition hover:border-accent/40 hover:text-ink"
          onClick={() => openSessionEditor()}
        >
          <Plus size={13} />
          新建连接
        </button>
      </div>
    </div>
  )
}
