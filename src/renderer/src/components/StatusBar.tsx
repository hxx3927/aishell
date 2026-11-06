import { Activity, Check, Copy, Cpu, Lock, Radio, Settings, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { sessionConnection, useAppStore } from '../state/store'

export function StatusBar() {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const backgroundSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const connections = useAppStore((s) => s.connections)
  const agentSessions = useAppStore((s) => s.agentSessions)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const mcpPort = useAppStore((s) => s.mcpPort)
  const encryptionAvailable = useAppStore((s) => s.encryptionAvailable)
  const versions = useAppStore((s) => s.versions)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const monitors = useAppStore((s) => s.monitors)
  const openMonitorTab = useAppStore((s) => s.openMonitorTab)

  const [mcpOpen, setMcpOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyMcpUrl = async (): Promise<void> => {
    if (!mcpPort) return
    await window.aishell.clipboard.writeText(`http://127.0.0.1:${mcpPort}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const sessionId = activeTab?.sessionId ?? backgroundSessionId
  const session = sessions.find((item) => item.id === sessionId)
  // The active terminal tab shows its own connection; anything else (file
  // tab, picker) falls back to the session's healthiest one.
  const connection =
    activeTab?.kind === 'terminal'
      ? connections[activeTab.id.slice('term-'.length)]
      : session
        ? sessionConnection(connections, session.id)
        : undefined
  // Agents belong to the server, not to a particular terminal tab.
  const sessionAgents = session
    ? Object.values(agentSessions).filter((agent) => agent.sessionId === session.id)
    : []
  const agent =
    sessionAgents.find((item) => item.agentSessionId === activeAgentId[session?.id ?? '']) ??
    sessionAgents[0]
  const runningAgents = sessionAgents.filter((item) => item.status === 'running').length

  const monitor = session ? monitors[session.id] : undefined
  const monitorSample = monitor?.samples.at(-1)
  const memPct =
    monitorSample && monitorSample.memTotalBytes
      ? (monitorSample.memUsedBytes / monitorSample.memTotalBytes) * 100
      : undefined

  const status = connection?.status ?? 'disconnected'
  const statusLabel =
    status === 'connected'
      ? '已连接'
      : status === 'connecting'
        ? '连接中'
        : status === 'error'
          ? '连接失败'
          : '待机'

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[10px] text-faint">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            status === 'connected'
              ? 'bg-ok'
              : status === 'connecting'
                ? 'bg-warn pulse-dot'
                : status === 'error'
                  ? 'bg-err'
                  : 'bg-faint'
          }`}
        />
        {statusLabel}
      </span>

      {session && (
        <>
          <span className="truncate font-mono text-dim">
            {session.username}@{session.host}:{session.port}
          </span>
          {connection?.hostInfo?.os && (
            <span className="hidden truncate xl:inline">{connection.hostInfo.os}</span>
          )}
          {typeof connection?.latency === 'number' && (
            <span className="flex items-center gap-1">
              <Radio size={10} />
              {connection.latency} ms
            </span>
          )}
        </>
      )}

      <div className="flex-1" />

      {session && monitorSample && (
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1 py-0.5 tabular-nums transition hover:bg-panel-2 hover:text-ink"
          title="回到资源监控"
          onClick={() => openMonitorTab(session)}
        >
          <Activity size={10} />
          CPU {Math.round(monitorSample.cpuPct)}%
          {memPct !== undefined && ` · MEM ${Math.round(memPct)}%`}
          {monitor?.status === 'paused' && ' · 已暂停'}
        </button>
      )}

      {agent && (
        <span
          className={`flex items-center gap-1 ${
            agent.status === 'running' ? 'text-accent-2' : ''
          }`}
          title={
            sessionAgents.length > 1
              ? `${runningAgents}/${sessionAgents.length} 个 Agent 窗口运行中`
              : undefined
          }
        >
          <Cpu size={10} />
          {agent.name}
          {agent.status === 'running'
            ? ' · 运行中'
            : agent.status === 'starting'
              ? ' · 启动中'
              : ''}
          {sessionAgents.length > 1 && ` · ${runningAgents}/${sessionAgents.length}`}
        </span>
      )}

      <div className="relative">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded px-1 py-0.5 transition hover:bg-panel-2 hover:text-ink"
          title={
            mcpPort
              ? `127.0.0.1:${mcpPort} · 仅本机可访问`
              : 'Agent MCP 服务未启动'
          }
          aria-expanded={mcpOpen}
          onClick={() => setMcpOpen((open) => !open)}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${mcpPort ? 'bg-ok' : 'bg-faint'}`}
          />
          Agent 服务
          <span className="text-faint">· {mcpPort ? '仅本机' : '未启动'}</span>
        </button>

        {mcpOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-40 cursor-default"
              aria-label="关闭详情"
              onClick={() => setMcpOpen(false)}
            />
            <div className="slide-in absolute bottom-full right-0 z-50 mb-2 w-64 rounded-xl border border-line-2 bg-panel p-3 text-left shadow-xl">
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${mcpPort ? 'bg-ok' : 'bg-faint'}`}
                />
                <span className="text-[11px] font-semibold text-ink">
                  Agent MCP 服务
                </span>
                <span className="ml-auto text-[10px] text-dim">
                  {mcpPort ? '已就绪' : '未启动'}
                </span>
              </div>

              {mcpPort ? (
                <>
                  <dl className="mt-2 space-y-1 text-[10px]">
                    <div className="flex gap-2">
                      <dt className="w-10 shrink-0 text-faint">地址</dt>
                      <dd className="font-mono text-dim">127.0.0.1:{mcpPort}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-10 shrink-0 text-faint">范围</dt>
                      <dd className="text-dim">仅本机可访问</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-10 shrink-0 text-faint">访问</dt>
                      <dd className="text-dim">需 Token，按会话隔离</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-[10px] leading-relaxed text-faint">
                    Agent 通过此地址操作当前连接的服务器，每次调用都会记录在「活动」中。
                  </p>
                  <div className="mt-2.5 flex gap-1.5">
                    <button
                      type="button"
                      className="btn-secondary h-7 flex-1 px-2 py-0 text-[10px]"
                      onClick={() => void copyMcpUrl()}
                    >
                      {copied ? <Check size={11} /> : <Copy size={11} />}
                      {copied ? '已复制' : '复制地址'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary h-7 flex-1 px-2 py-0 text-[10px]"
                      onClick={() => {
                        setMcpOpen(false)
                        setSettingsOpen(true)
                      }}
                    >
                      <Settings size={11} />
                      打开设置
                    </button>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-[10px] leading-relaxed text-dim">
                  服务尚未启动，内置 Agent 暂不可用。重启应用后会自动重新监听本机端口。
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <span
        className={`flex items-center gap-1 ${encryptionAvailable ? '' : 'text-warn'}`}
        title={encryptionAvailable ? '凭据已加密存储' : '系统安全存储不可用'}
      >
        {encryptionAvailable ? <Lock size={10} /> : <ShieldAlert size={10} />}
        {encryptionAvailable ? '凭据加密' : '仅内存'}
      </span>

      <span>v{versions.app || '0.1.0'}</span>
    </footer>
  )
}
