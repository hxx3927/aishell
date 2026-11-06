import {
  Activity,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderPlus,
  Moon,
  Pencil,
  Plug,
  Plus,
  Search,
  Server,
  Settings,
  Sun,
  Trash2
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Session } from '@shared/types'
import { sessionConnection, useAppStore } from '../state/store'
import {
  connectSession,
  copyAddress,
  deleteSession,
  disconnectSession
} from '../lib/sessionActions'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { LinkLogo } from './LinkLogo'

function statusColor(status: string): string {
  if (status === 'connected') return 'bg-ok'
  if (status === 'connecting') return 'bg-warn pulse-dot'
  if (status === 'error') return 'bg-err'
  return 'bg-faint'
}

export function Sidebar() {
  const sessions = useAppStore((s) => s.sessions)
  const connections = useAppStore((s) => s.connections)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const theme = useAppStore((s) => s.settings.theme)
  const openSessionEditor = useAppStore((s) => s.openSessionEditor)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const persistedGroups = useAppStore((s) => s.settings.groups)
  const createGroup = useAppStore((s) => s.createGroup)
  const renameGroup = useAppStore((s) => s.renameGroup)
  const deleteGroup = useAppStore((s) => s.deleteGroup)
  const prompt = useAppStore((s) => s.prompt)
  const confirm = useAppStore((s) => s.confirm)
  const pushToast = useAppStore((s) => s.pushToast)
  const openMonitorTab = useAppStore((s) => s.openMonitorTab)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; session: Session } | null>(null)

  const activeSessionId = tabs.find((t) => t.id === activeTabId)?.sessionId

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return sessions
    return sessions.filter((session) =>
      [session.name, session.host, session.username, session.group]
        .join(' ')
        .toLowerCase()
        .includes(term)
    )
  }, [sessions, search])

  const groups = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const session of filtered) {
      const group = session.group || '默认'
      const list = map.get(group) ?? []
      list.push(session)
      map.set(group, list)
    }
    // Empty groups only have their persisted name, so keep them visible
    // unless a search is narrowing the list down.
    if (!search.trim()) {
      for (const group of persistedGroups ?? []) {
        if (!map.has(group)) map.set(group, [])
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [filtered, persistedGroups, search])

  const createGroupFlow = async (): Promise<void> => {
    const name = await prompt({
      title: '新建分组',
      message: '分组用于归置连接，之后可以随时重命名。',
      placeholder: '例如：生产环境'
    })
    const group = name?.trim()
    if (!group) return
    try {
      await createGroup(group)
      pushToast('info', `已创建分组「${group}」`)
    } catch (err) {
      pushToast('error', (err as Error).message)
    }
  }

  const renameGroupFlow = async (group: string): Promise<void> => {
    const name = await prompt({
      title: '重命名分组',
      message: `「${group}」中的连接会一起改到新分组。`,
      value: group
    })
    const target = name?.trim()
    if (!target || target === group) return
    try {
      await renameGroup(group, target)
      pushToast('info', `分组已重命名为「${target}」`)
    } catch (err) {
      pushToast('error', (err as Error).message)
    }
  }

  const deleteGroupFlow = async (group: string): Promise<void> => {
    const ok = await confirm({
      title: '删除分组',
      message: `「${group}」中的连接会被移动到「默认」，连接本身不会删除。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await deleteGroup(group)
      pushToast('info', `已删除分组「${group}」`)
    } catch (err) {
      pushToast('error', (err as Error).message)
    }
  }

  const menuSessionStatus = menu
    ? (sessionConnection(connections, menu.session.id)?.status ?? 'disconnected')
    : 'disconnected'
  const menuItems: MenuItem[] = menu
    ? [
        {
          label: menuSessionStatus === 'connected' ? '断开连接' : '连接',
          icon: <Plug size={13} />,
          disabled: menuSessionStatus === 'connecting',
          onClick: () => {
            if (menuSessionStatus === 'connected') {
              void disconnectSession(menu.session)
            } else {
              void connectSession(menu.session)
            }
          }
        },
        {
          label: '资源监控',
          icon: <Activity size={13} />,
          onClick: () => openMonitorTab(menu.session)
        },
        {
          label: '编辑连接',
          icon: <Pencil size={13} />,
          onClick: () => openSessionEditor(menu.session)
        },
        {
          label: '复制连接地址',
          icon: <Copy size={13} />,
          onClick: () => void copyAddress(menu.session)
        },
        { separator: true },
        {
          label: '删除连接',
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => void deleteSession(menu.session)
        }
      ]
    : []

  return (
    <aside className="flex w-[252px] shrink-0 flex-col border-r border-line bg-panel/80">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <LinkLogo className="h-[22px] w-auto shrink-0 text-ink" />
        <div className="flex items-center gap-1.5">
          <button
            className="icon-btn h-7 w-7"
            title="新建分组"
            onClick={() => void createGroupFlow()}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="btn-primary h-7 px-2.5 py-0 text-[11px]"
            onClick={() => openSessionEditor()}
          >
            <Plus size={13} />
            新建
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            className="input py-1.5 pl-7 text-[11px]"
            placeholder="搜索连接、主机、用户…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 && (
          <div className="px-3 py-10 text-center text-xs text-faint">
            {sessions.length === 0 ? (
              <>
                <Server size={22} className="mx-auto mb-2 opacity-50" />
                还没有连接
                <div className="mt-2">
                  <button
                    className="text-accent hover:underline"
                    onClick={() => openSessionEditor()}
                  >
                    创建第一个连接
                  </button>
                </div>
              </>
            ) : (
              '没有匹配的连接'
            )}
          </div>
        )}

        {groups.map(([group, items]) => {
          const isCollapsed = collapsed[group]
          return (
            <div key={group} className="mb-1">
              <div
                role="button"
                tabIndex={0}
                title={group}
                className="group/grp flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint hover:text-dim"
                onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))
                  }
                }}
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="flex-1 truncate text-left">{group}</span>
                <span className="text-[10px] font-normal group-hover/grp:hidden">
                  {items.length}
                </span>
                <span className="hidden items-center gap-0.5 group-hover/grp:flex">
                  <button
                    className="rounded p-0.5 hover:bg-line-2 hover:text-ink"
                    title="在此分组新建连接"
                    onClick={(event) => {
                      event.stopPropagation()
                      openSessionEditor(undefined, group)
                    }}
                  >
                    <Plus size={11} />
                  </button>
                  <button
                    className="rounded p-0.5 hover:bg-line-2 hover:text-ink"
                    title="重命名分组"
                    onClick={(event) => {
                      event.stopPropagation()
                      void renameGroupFlow(group)
                    }}
                  >
                    <Pencil size={10} />
                  </button>
                  {group !== '默认' && (
                    <button
                      className="rounded p-0.5 hover:bg-line-2 hover:text-err"
                      title="删除分组"
                      onClick={(event) => {
                        event.stopPropagation()
                        void deleteGroupFlow(group)
                      }}
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </span>
              </div>

              {!isCollapsed &&
                items.map((session) => {
                  const status =
                    sessionConnection(connections, session.id)?.status ?? 'disconnected'
                  const active = activeSessionId === session.id
                  return (
                    <div
                      key={session.id}
                      className={`group mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition ${
                        active
                          ? 'bg-accent/10 ring-1 ring-inset ring-accent/25'
                          : 'hover:bg-panel-2'
                      }`}
                      onClick={() => {
                        // Prefer the terminal; a server whose only window is
                        // the monitor tab still gets focused from here.
                        const tab =
                          tabs.find(
                            (t) => t.sessionId === session.id && t.kind === 'terminal'
                          ) ?? tabs.find((t) => t.sessionId === session.id)
                        if (tab) useAppStore.getState().setActiveTab(tab.id)
                      }}
                      onDoubleClick={() => void connectSession(session)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setMenu({ x: event.clientX, y: event.clientY, session })
                      }}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor(status)}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-ink">{session.name}</div>
                        <div className="truncate text-[10px] text-faint">
                          {session.username}@{session.host}:{session.port}
                        </div>
                      </div>
                      <button
                        className="hidden shrink-0 rounded p-1 text-dim hover:bg-panel-3 hover:text-ink group-hover:block"
                        title="资源监控"
                        onClick={(event) => {
                          event.stopPropagation()
                          openMonitorTab(session)
                        }}
                      >
                        <Activity size={12} />
                      </button>
                      <button
                        className="hidden shrink-0 rounded p-1 text-dim hover:bg-panel-3 hover:text-ink group-hover:block"
                        title="编辑"
                        onClick={(event) => {
                          event.stopPropagation()
                          openSessionEditor(session)
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>

      <div className="border-t border-line px-3 py-2.5">
        <div className="mb-2 flex items-center gap-1 rounded-lg bg-panel-3 p-0.5">
          <button
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[7px] py-1.5 text-[11px] transition ${
              theme === 'light'
                ? 'bg-segment text-ink shadow-sm'
                : 'text-dim hover:text-ink'
            }`}
            aria-pressed={theme === 'light'}
            title="浅色外观"
            onClick={() => void saveSettings({ theme: 'light' })}
          >
            <Sun size={12} />
            浅色
          </button>
          <button
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[7px] py-1.5 text-[11px] transition ${
              theme === 'dark'
                ? 'bg-segment text-ink shadow-sm'
                : 'text-dim hover:text-ink'
            }`}
            aria-pressed={theme === 'dark'}
            title="深色外观"
            onClick={() => void saveSettings({ theme: 'dark' })}
          >
            <Moon size={12} />
            深色
          </button>
        </div>

        <button
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-dim transition hover:bg-panel-2 hover:text-ink"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
          <span className="flex-1 text-left">设置</span>
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  )
}
