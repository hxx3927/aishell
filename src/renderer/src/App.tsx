import {
  Activity,
  FolderTree,
  PanelBottom,
  PanelRight,
  Plus,
  Server,
  Sparkles,
  Terminal as TerminalIcon
} from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import type { Session } from '@shared/types'
import { isMonitorConn } from '@shared/monitor'
import { resolveTheme, useAppStore } from './state/store'
import { connectSession } from './lib/sessionActions'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { SessionPicker } from './components/SessionPicker'
import { MonitorView } from './components/MonitorView'
import { TerminalView } from './components/TerminalView'
import { SftpPanel } from './components/SftpPanel'
import { FileEditor } from './components/FileEditor'
import { AgentPanel } from './components/AgentPanel'
import { StatusBar } from './components/StatusBar'
import { SessionDialog } from './components/SessionDialog'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { AuditDialog } from './components/AuditDialog'
import { AppDialog } from './components/AppDialog'
import { LinkMark } from './components/LinkMark'
import { ToastHost } from './components/ToastHost'
import { relativeTime } from './lib/format'

function Welcome() {
  const sessions = useAppStore((s) => s.sessions)
  const openSessionEditor = useAppStore((s) => s.openSessionEditor)
  const recent = sessions.slice(0, 6)

  return (
    <div className="flex h-full items-center justify-center overflow-auto px-8 py-10">
      <div className="w-full max-w-[620px]">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/15">
            <LinkMark className="w-[32px]" />
          </div>
          <div>
            <div className="text-lg font-semibold text-ink">AIShell</div>
            <div className="text-xs text-dim">终端 · 文件管理 · 本机 AI Agent</div>
          </div>
        </div>

        <div className="mt-7 grid grid-cols-3 gap-2.5">
          <Feature icon={<TerminalIcon size={15} />} title="SSH 终端" text="xterm.js 多会话，支持搜索与复制粘贴" />
          <Feature icon={<FolderTree size={15} />} title="双栏文件" text="SFTP 上传下载与在线编辑" />
          <Feature icon={<Sparkles size={15} />} title="Agent 工作台" text="Claude Code / Codex 通过 MCP 操作服务器" />
        </div>

        <div className="mt-7 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-faint">
            最近连接
          </div>
          <button className="btn-primary h-8 px-3 text-xs" onClick={() => openSessionEditor()}>
            <Plus size={13} />
            新建连接
          </button>
        </div>

        <div className="mt-2 space-y-1.5">
          {recent.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center text-xs text-faint">
              还没有连接。先添加一台服务器开始使用。
            </div>
          ) : (
            recent.map((session) => (
              <button
                key={session.id}
                className="flex w-full items-center gap-3 rounded-lg border border-line-2 bg-panel-2/60 px-3 py-2.5 text-left transition hover:border-line-2 hover:bg-panel-3"
                onClick={() => void connectSession(session)}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-panel-3 text-dim">
                  <Server size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-ink">
                    {session.name}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-faint">
                    {session.username}@{session.host}:{session.port}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-faint">
                  {session.lastUsedAt ? relativeTime(session.lastUsedAt) : ''}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** The server has no tabs left, but its agent windows are still running. */
function AgentOnlyWorkspace({ session }: { session: Session }) {
  const count = useAppStore(
    (state) =>
      state.agentOrder.filter((id) => state.agentSessions[id]?.sessionId === session.id).length
  )

  return (
    <div className="flex h-full items-center justify-center px-8 text-center">
      <div className="max-w-[420px]">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white">
          <Sparkles size={18} />
        </div>
        <div className="mt-3 text-sm font-medium text-ink">{session.name}</div>
        <div className="mt-1 text-xs text-dim">
          该服务器还有 {count} 个 Agent 窗口，在右侧面板继续操作。
        </div>
        <div className="mt-2 text-[11px] leading-relaxed text-faint">
          关闭全部 Agent 窗口后这里会回到欢迎页；需要终端时从左侧连接栏重新打开。
        </div>
      </div>
    </div>
  )
}

function Feature({
  icon,
  title,
  text
}: {
  icon: ReactNode
  title: string
  text: string
}) {
  return (
    <div className="rounded-xl border border-line-2 bg-panel-2/50 px-3 py-3">
      <div className="flex items-center gap-1.5 text-accent">{icon}</div>
      <div className="mt-2 text-xs font-medium text-ink">{title}</div>
      <div className="mt-0.5 text-[10px] leading-relaxed text-faint">{text}</div>
    </div>
  )
}

function TitleBar() {
  const platform = useAppStore((s) => s.platform)
  const panels = useAppStore((s) => s.panels)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const sessions = useAppStore((s) => s.sessions)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const backgroundSessionId = useAppStore((s) => s.activeSessionId)
  const openMonitorTab = useAppStore((s) => s.openMonitorTab)

  const activeSessionId = tabs.find((tab) => tab.id === activeTabId)?.sessionId ?? backgroundSessionId
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const monitorOpen = tabs.some(
    (tab) => tab.kind === 'monitor' && tab.sessionId === activeSessionId
  )

  const rightPad = platform === 'win32' ? 'pr-[148px]' : 'pr-3'
  const leftPad = platform === 'darwin' ? 'pl-[84px]' : 'pl-3'

  return (
    <header
      className={`drag-region flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel/85 ${leftPad} ${rightPad}`}
    >
      <div className="flex select-none items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent to-accent-2 text-white">
          <LinkMark className="w-[17px]" />
        </div>
        <span className="text-xs font-semibold tracking-wide text-ink">AIShell</span>
      </div>

      <div className="flex-1" />

      <div className="no-drag flex items-center gap-0.5">
        <button
          className={`icon-btn h-7 w-7 ${monitorOpen ? 'text-accent' : ''}`}
          disabled={!activeSession}
          onClick={() => activeSession && openMonitorTab(activeSession)}
          title="资源监控 (Ctrl+Shift+M)"
        >
          <Activity size={14} />
        </button>
        <button
          className={`icon-btn h-7 w-7 ${panels.sidebar ? 'text-accent' : ''}`}
          onClick={() => togglePanel('sidebar')}
          title="切换连接栏 (Ctrl+Shift+B)"
        >
          <FolderTree size={14} />
        </button>
        <button
          className={`icon-btn h-7 w-7 ${panels.files ? 'text-accent' : ''}`}
          onClick={() => togglePanel('files')}
          title="切换文件面板 (Ctrl+Shift+J)"
        >
          <PanelBottom size={14} />
        </button>
        <button
          className={`icon-btn h-7 w-7 ${panels.agent ? 'text-accent-2' : ''}`}
          onClick={() => togglePanel('agent')}
          title="切换 Agent 面板 (Ctrl+Shift+A)"
        >
          <PanelRight size={14} />
        </button>
      </div>
    </header>
  )
}

export default function App() {
  const ready = useAppStore((s) => s.ready)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const panels = useAppStore((s) => s.panels)
  const sessions = useAppStore((s) => s.sessions)
  const theme = useAppStore((s) => s.resolvedTheme)

  const backgroundSessionId = useAppStore((s) => s.activeSessionId)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  // The focused tab wins; with no tabs, an agent-only server keeps its panel.
  const activeSessionId = activeTab?.sessionId ?? backgroundSessionId ?? undefined
  const activeSession = sessions.find((session) => session.id === activeSessionId)

  useEffect(() => {
    void useAppStore.getState().init()

    // Paint the most likely theme before the main process's state arrives so
    // `system` users do not see a dark flash.
    useAppStore.getState().setInitialTheme(
      resolveTheme(useAppStore.getState().settings.theme)
    )

    const unsubs = [
      window.aishell.on('ssh:state', (event) => {
        const store = useAppStore.getState()
        // A stopped agent tears down its connection; ignore the trailing
        // disconnect so it does not resurrect a stale entry.
        if (
          event.connId.startsWith('agent:') &&
          event.status === 'disconnected' &&
          !Object.values(store.agentSessions).some(
            (agent) => agent.connId === event.connId
          )
        ) {
          return
        }
        store.setConnection(event.connId, event.sessionId, {
          status: event.status,
          error: event.error,
          hostInfo: event.hostInfo
        })
        // The monitor's connection is a background poller; it needs neither a
        // latency probe nor an error toast — its tab shows the failure.
        if (
          event.status === 'connected' &&
          !event.connId.startsWith('agent:') &&
          !isMonitorConn(event.connId)
        ) {
          void window.aishell.ssh
            .ping(event.sessionId)
            .then((ms) => useAppStore.getState().setLatency(event.connId, ms))
            .catch(() => undefined)
        }
        if (event.status === 'error' && event.error && !isMonitorConn(event.connId)) {
          store.pushToast('error', event.error)
        }
      }),
      window.aishell.on('monitor:sample', (event) => {
        useAppStore.getState().applyMonitorEvent(event)
      }),
      window.aishell.on('activity:event', (event) => {
        useAppStore.getState().applyActivity(event)
      }),
      window.aishell.on('agent:state', (event) => {
        useAppStore.getState().applyAgentState(event.runtime)
      }),
      window.aishell.on('agent:exit', (event) => {
        const store = useAppStore.getState()
        const agent = store.agentSessions[event.agentSessionId]
        store.removeAgentSession(event.agentSessionId)
        if (event.reason !== 'exit') return
        if (event.code !== 0) {
          store.pushToast('warn', `${agent?.name ?? 'Agent'} 已退出（代码 ${event.code}）`)
        } else if (agent) {
          store.pushToast('info', `${agent.name} 已结束`)
        }
      }),
      window.aishell.on('agent:shell', (event) => {
        const store = useAppStore.getState()
        store.setAgentShell(event.connId, event.open)
        if (!event.open && event.reason === 'idle') {
          store.pushToast('info', 'Agent 持久 shell 空闲 30 分钟，已自动关闭')
        }
      }),
      window.aishell.on('sftp:transfer', (transfer) => {
        // Completed transfers stay in the list until the user clears them.
        useAppStore.getState().applyTransfer(transfer)
      }),
      window.aishell.on('app:notice', (notice) => {
        useAppStore.getState().pushToast(notice.level, notice.message)
      }),
      window.aishell.on('theme:changed', ({ resolved }) => {
        useAppStore.getState().setResolvedTheme(resolved)
      })
    ]

    const latencyTimer = setInterval(() => {
      const store = useAppStore.getState()
      for (const [connId, connection] of Object.entries(store.connections)) {
        if (connection.status !== 'connected') continue
        // Agent windows and the monitor poller do not need a latency probe;
        // the server's terminal connection already covers it.
        if (connId.startsWith('agent:') || isMonitorConn(connId)) continue
        void window.aishell.ssh
          .ping(connection.sessionId)
          .then((ms) => useAppStore.getState().setLatency(connId, ms))
          .catch(() => undefined)
      }
    }, 15000)

    const keyHandler = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      if (event.key === ',') {
        event.preventDefault()
        useAppStore.getState().setSettingsOpen(true)
        return
      }
      if (!event.shiftKey) return
      const store = useAppStore.getState()
      switch (event.key.toLowerCase()) {
        case 'n':
          event.preventDefault()
          store.openSessionEditor()
          break
        case 'b':
          event.preventDefault()
          store.togglePanel('sidebar')
          break
        case 'j':
          event.preventDefault()
          store.togglePanel('files')
          break
        case 'a':
          event.preventDefault()
          store.togglePanel('agent')
          break
        case 'm': {
          event.preventDefault()
          const sessionId =
            store.tabs.find((tab) => tab.id === store.activeTabId)?.sessionId ??
            store.activeSessionId
          const session = store.sessions.find((item) => item.id === sessionId)
          if (session) store.openMonitorTab(session)
          break
        }
        default:
          break
      }
    }
    window.addEventListener('keydown', keyHandler, true)

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe())
      clearInterval(latencyTimer)
      window.removeEventListener('keydown', keyHandler, true)
    }
  }, [])

  useEffect(() => {
    document.title = activeSession ? `${activeSession.name} — AIShell` : 'AIShell'
  }, [activeSession])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-base text-xs text-dim">
        正在加载 AIShell…
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-base text-ink">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        {panels.sidebar && <Sidebar />}

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {tabs.length === 0 ? (
                activeSession ? (
                  <AgentOnlyWorkspace session={activeSession} />
                ) : (
                  <Welcome />
                )
              ) : (
                tabs.map((tab) => {
                  if (tab.kind === 'terminal' && tab.sessionId) {
                    return (
                      <TerminalView
                        key={tab.id}
                        connId={tab.id.slice('term-'.length)}
                        sessionId={tab.sessionId}
                        session={sessions.find((session) => session.id === tab.sessionId)}
                        visible={tab.id === activeTabId}
                      />
                    )
                  }
                  if (tab.kind === 'file') {
                    return (
                      <FileEditor key={tab.id} tab={tab} visible={tab.id === activeTabId} />
                    )
                  }
                  if (tab.kind === 'monitor' && tab.sessionId) {
                    return (
                      <MonitorView
                        key={tab.id}
                        sessionId={tab.sessionId}
                        session={sessions.find((session) => session.id === tab.sessionId)}
                        visible={tab.id === activeTabId}
                      />
                    )
                  }
                  return (
                    <div
                      key={tab.id}
                      className={tab.id === activeTabId ? 'h-full' : 'hidden'}
                    >
                      <SessionPicker tabId={tab.id} />
                    </div>
                  )
                })
              )}
            </div>

            {activeSessionId && (
              // Keep the panel mounted while hidden so local/remote paths and
              // selections survive Ctrl+Shift+J.
              <div className={panels.files ? 'contents' : 'hidden'}>
                <SftpPanel key={activeSessionId} sessionId={activeSessionId} />
              </div>
            )}
          </div>
        </main>

        {activeSessionId && (
          // Stay mounted while collapsed so agent terminals keep their
          // scrollback; AgentTerminal ignores the zero-sized fit.
          <div className={panels.agent ? 'contents' : 'hidden'}>
            <AgentPanel key={activeSessionId} sessionId={activeSessionId} />
          </div>
        )}
      </div>

      <StatusBar />

      <SessionDialog />
      <SettingsDialog />
      <AuditDialog />
      <AppDialog />
      <ToastHost />
    </div>
  )
}
