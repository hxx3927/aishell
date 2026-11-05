import {
  FolderTree,
  PanelBottom,
  PanelRight,
  Plus,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  Terminal as TerminalIcon
} from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useAppStore } from './state/store'
import { connectSession } from './lib/sessionActions'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { SessionPicker } from './components/SessionPicker'
import { TerminalView } from './components/TerminalView'
import { SftpPanel } from './components/SftpPanel'
import { FileEditor } from './components/FileEditor'
import { AgentPanel } from './components/AgentPanel'
import { StatusBar } from './components/StatusBar'
import { SessionDialog } from './components/SessionDialog'
import { SettingsDialog } from './components/SettingsDialog'
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
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

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
        <button
          className="icon-btn h-7 w-7"
          onClick={() => setSettingsOpen(true)}
          title="设置 (Ctrl+,)"
        >
          <SettingsIcon size={14} />
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
  const theme = useAppStore((s) => s.settings.theme)

  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activeSessionId = activeTab?.sessionId
  const activeSession = sessions.find((session) => session.id === activeSessionId)

  useEffect(() => {
    void useAppStore.getState().init()

    const unsubs = [
      window.aishell.on('ssh:state', (event) => {
        const store = useAppStore.getState()
        store.setConnection(event.connId, event.sessionId, {
          status: event.status,
          error: event.error,
          hostInfo: event.hostInfo
        })
        if (event.status === 'connected') {
          void window.aishell.ssh
            .ping(event.sessionId)
            .then((ms) => useAppStore.getState().setLatency(event.connId, ms))
            .catch(() => undefined)
        }
        if (event.status === 'error' && event.error) {
          store.pushToast('error', event.error)
        }
      }),
      window.aishell.on('activity:event', (event) => {
        useAppStore.getState().applyActivity(event)
      }),
      window.aishell.on('agent:state', (event) => {
        useAppStore.getState().applyAgentState(event.runtime)
      }),
      window.aishell.on('agent:exit', (event) => {
        if (event.code !== 0) {
          useAppStore.getState().pushToast('warn', 'Agent 进程已退出')
        }
      }),
      window.aishell.on('agent:shell', (event) => {
        const store = useAppStore.getState()
        store.setAgentShell(event.sessionId, event.open)
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
      })
    ]

    const latencyTimer = setInterval(() => {
      const store = useAppStore.getState()
      for (const [connId, connection] of Object.entries(store.connections)) {
        if (connection.status !== 'connected') continue
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
                <Welcome />
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

        {panels.agent && activeSessionId && <AgentPanel sessionId={activeSessionId} />}
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
