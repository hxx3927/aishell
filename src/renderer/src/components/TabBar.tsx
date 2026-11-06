import { Activity, FileCode2, Plus, Server, Terminal as TerminalIcon, X } from 'lucide-react'
import { useAppStore } from '../state/store'

export function TabBar() {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const openPickerTab = useAppStore((s) => s.openPickerTab)
  const sessions = useAppStore((s) => s.sessions)

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-line bg-panel/50 px-1.5">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const session = sessions.find((s) => s.id === tab.sessionId)
        // Several terminals of one server get an ordinal so they are
        // distinguishable; the numbering follows the session's real name.
        const siblings =
          tab.kind === 'terminal'
            ? tabs.filter((t) => t.kind === 'terminal' && t.sessionId === tab.sessionId)
            : []
        const label =
          tab.kind === 'file'
            ? tab.title
            : tab.kind === 'monitor'
              ? `${session?.name ?? tab.title} · 监控`
              : (session?.name ?? tab.title) +
                (siblings.length > 1 ? ` (${siblings.findIndex((t) => t.id === tab.id) + 1})` : '')
        return (
          <div
            key={tab.id}
            className={`group relative flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 self-center rounded-md px-2.5 py-1 text-xs transition ${
              active
                ? 'bg-panel-3 text-ink'
                : 'text-dim hover:bg-panel-2 hover:text-ink'
            }`}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(event) => {
              if (event.button === 1) closeTab(tab.id)
            }}
            title={tab.kind === 'file' ? tab.path : label}
          >
            {tab.kind === 'terminal' ? (
              <TerminalIcon size={12} className={active ? 'text-accent' : ''} />
            ) : tab.kind === 'file' ? (
              <FileCode2 size={12} className={active ? 'text-accent-2' : ''} />
            ) : tab.kind === 'monitor' ? (
              <Activity size={12} className={active ? 'text-accent' : ''} />
            ) : (
              <Server size={12} className={active ? 'text-accent' : ''} />
            )}
            <span className="truncate">{label}</span>
            {tab.dirty && <span className="h-1.5 w-1.5 rounded-full bg-warn" />}
            <button
              className="ml-0.5 rounded p-0.5 text-faint opacity-0 transition hover:bg-line-2 hover:text-ink group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.id)
              }}
              title="关闭标签"
            >
              <X size={11} />
            </button>
            {active && (
              <span className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-accent/70" />
            )}
          </div>
        )
      })}
      <button
        className="my-auto ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim transition hover:bg-panel-2 hover:text-ink"
        title="新建会话"
        aria-label="新建会话"
        onClick={openPickerTab}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
