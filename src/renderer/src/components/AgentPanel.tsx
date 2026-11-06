import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowRightFromLine,
  Bot,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Sparkles,
  SquareTerminal,
  Terminal as TerminalIcon,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentProfile, AgentSession, AgentWindowEntry } from '@shared/types'
import { relativeTime } from '../lib/format'
import { sessionConnection, useAppStore } from '../state/store'
import { ActivityFeed } from './ActivityFeed'
import { AgentTerminal, lastAgentTerminalSize } from './AgentTerminal'
import { ResizeHandle } from './ResizeHandle'

interface AgentPanelProps {
  sessionId: string
}

const WIDTH_KEY = 'aishell.agentPanelWidth'
const MIN_WIDTH = 360
const MAX_WIDTH = 900

function clampWidth(value: number): number {
  const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.65)))
  return Math.max(MIN_WIDTH, Math.min(max, value))
}

function statusDotClass(status: AgentSession['status']): string {
  switch (status) {
    case 'running':
      return 'bg-ok'
    case 'starting':
      return 'bg-warn pulse-dot'
    case 'error':
      return 'bg-err'
    default:
      return 'bg-faint'
  }
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const settings = useAppStore((s) => s.settings)
  const connections = useAppStore((s) => s.connections)
  const agentSessions = useAppStore((s) => s.agentSessions)
  const agentOrder = useAppStore((s) => s.agentOrder)
  const activeAgentIdBySession = useAppStore((s) => s.activeAgentId)
  const activities = useAppStore((s) => s.activities)
  const agentShells = useAppStore((s) => s.agentShells)
  const mcpPort = useAppStore((s) => s.mcpPort)
  const applyAgentState = useAppStore((s) => s.applyAgentState)
  const removeAgentSession = useAppStore((s) => s.removeAgentSession)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const pushToast = useAppStore((s) => s.pushToast)
  const confirm = useAppStore((s) => s.confirm)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const setAuditOpen = useAppStore((s) => s.setAuditOpen)

  const profiles = useMemo(
    () => settings.agentProfiles.filter((profile) => profile.enabled),
    [settings.agentProfiles]
  )
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? 'claude')
  const [tab, setTab] = useState<'terminal' | 'activity'>('terminal')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<AgentWindowEntry[]>([])
  /** Conversation titles keyed by window id; the window name is the fallback. */
  const [titles, setTitles] = useState<Record<string, string>>({})
  /** The + button reopens the picker instead of launching a window directly. */
  const [showPicker, setShowPicker] = useState(false)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : 480
  })

  const connection = useMemo(
    () => sessionConnection(connections, sessionId),
    [connections, sessionId]
  )

  useEffect(() => {
    if (!profiles.some((profile) => profile.id === profileId)) {
      setProfileId(profiles[0]?.id ?? 'claude')
    }
  }, [profiles, profileId])

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])

  const activeProfile = profiles.find((profile) => profile.id === profileId) ?? profiles[0]

  const agents = useMemo(
    () =>
      agentOrder
        .map((id) => agentSessions[id])
        .filter(
          (agent): agent is AgentSession =>
            agent !== undefined && agent.sessionId === sessionId
        ),
    [agentOrder, agentSessions, sessionId]
  )

  const activeId = activeAgentIdBySession[sessionId] ?? agents[0]?.agentSessionId ?? null
  const activeAgent =
    agents.find((agent) => agent.agentSessionId === activeId) ?? agents[0]

  const activityCountByAgent = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const event of activities) {
      if (!event.agentSessionId) continue
      counts[event.agentSessionId] = (counts[event.agentSessionId] ?? 0) + 1
    }
    return counts
  }, [activities])

  const activityCount = activeAgent
    ? (activityCountByAgent[activeAgent.agentSessionId] ?? 0)
    : 0
  const shellOpen = activeAgent ? Boolean(agentShells[activeAgent.connId]) : false
  const agentConnection = activeAgent ? connections[activeAgent.connId] : undefined
  const connectionLost =
    Boolean(activeAgent) &&
    Boolean(agentConnection) &&
    agentConnection!.status !== 'connected' &&
    agentConnection!.status !== 'connecting'

  const refreshHistory = useCallback(async (): Promise<void> => {
    try {
      setHistory(await window.aishell.agent.history(sessionId))
    } catch {
      setHistory([])
    }
  }, [sessionId])

  const loadTitles = useCallback(async (): Promise<void> => {
    try {
      const map = await window.aishell.agent.titles(sessionId)
      setTitles((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [id, title] of Object.entries(map)) {
          if (next[id] !== title) {
            next[id] = title
            changed = true
          }
        }
        return changed ? next : prev
      })
    } catch {
      /* titles are cosmetic; keep the window name */
    }
  }, [sessionId])

  // History only matters in the picker, and it changes exactly when a window
  // stops, exits or is deleted.
  const pickerVisible = showPicker || !activeAgent
  useEffect(() => {
    if (pickerVisible) void refreshHistory()
  }, [pickerVisible, refreshHistory])

  // Ended windows already have their title; read it once whenever the list or
  // the picker changes.
  useEffect(() => {
    if (pickerVisible) void loadTitles()
  }, [pickerVisible, history, loadTitles])

  // A running window only gets a title after its first prompt, so check until
  // every window has one. A window that never talks keeps the interval; it
  // stops as soon as the window ends.
  const missingTitles = agents.some((agent) => !titles[agent.agentSessionId])
  useEffect(() => {
    if (!missingTitles) return
    void loadTitles()
    const timer = window.setInterval(() => void loadTitles(), 5000)
    return () => window.clearInterval(timer)
  }, [missingTitles, loadTitles])

  useEffect(() => {
    setTitles({})
  }, [sessionId])

  const launch = async (profile: AgentProfile): Promise<void> => {
    setBusy(true)
    setTab('terminal')
    setShowPicker(false)
    try {
      const size = lastAgentTerminalSize()
      const result = await window.aishell.agent.launch(
        sessionId,
        profile.id,
        undefined,
        size?.cols,
        size?.rows
      )
      applyAgentState(result)
      if (result.status === 'error') {
        pushToast('error', `${result.name} 启动失败：${result.error ?? '未知错误'}`)
      }
    } catch (err) {
      const message = (err as Error).message
      if (message !== '启动已取消') {
        pushToast('error', `启动 Agent 失败：${message}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const stop = async (agent: AgentSession): Promise<void> => {
    const ok = await confirm({
      title: '停止 Agent',
      message: `停止「${agent.name}」并关闭窗口？工作区会保留在本地。`,
      confirmText: '停止',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      await window.aishell.agent.stop(agent.agentSessionId)
      removeAgentSession(agent.agentSessionId)
    } catch (err) {
      pushToast('error', `停止 Agent 失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const retry = async (agent: AgentSession): Promise<void> => {
    const profile = profiles.find((item) => item.id === agent.profileId)
    await window.aishell.agent.stop(agent.agentSessionId).catch(() => undefined)
    removeAgentSession(agent.agentSessionId)
    if (profile) {
      await launch(profile)
    } else {
      pushToast('error', '该 Agent 配置已不可用，请到设置中重新启用')
    }
  }

  const reconnect = async (agent: AgentSession): Promise<void> => {
    setBusy(true)
    try {
      await window.aishell.agent.reconnect(agent.agentSessionId)
      pushToast('info', `${agent.name} 已重新连接`)
    } catch (err) {
      pushToast('error', `重连失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const resumeSession = async (record: AgentWindowEntry): Promise<void> => {
    setBusy(true)
    setTab('terminal')
    setShowPicker(false)
    try {
      const size = lastAgentTerminalSize()
      const result = await window.aishell.agent.resume(
        record.agentSessionId,
        size?.cols,
        size?.rows
      )
      applyAgentState(result)
      if (result.status === 'error') {
        pushToast('error', `${result.name} 恢复失败：${result.error ?? '未知错误'}`)
      }
    } catch (err) {
      pushToast('error', `恢复会话失败：${(err as Error).message}`)
      void refreshHistory()
    } finally {
      setBusy(false)
    }
  }

  const forgetSession = async (record: AgentWindowEntry): Promise<void> => {
    const ok = await confirm({
      title: '删除会话记录',
      message: `删除「${record.name}」的记录和它自己的对话历史？同一服务器上的其他窗口不受影响。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await window.aishell.agent.forget(record.agentSessionId)
      await refreshHistory()
    } catch (err) {
      pushToast('error', `删除记录失败：${(err as Error).message}`)
    }
  }

  const closeShell = async (agent: AgentSession): Promise<void> => {
    try {
      await window.aishell.agentShell.close(agent.connId)
    } catch (err) {
      pushToast('error', `关闭持久 shell 失败：${(err as Error).message}`)
    }
  }

  /** The + opens the picker so an old window can be continued or a new one started. */
  const openPicker = (): void => {
    setShowPicker(true)
    setTab('terminal')
  }

  const selectAgent = (agentSessionId: string): void => {
    setShowPicker(false)
    setActiveAgent(sessionId, agentSessionId)
  }

  /**
   * Shared by the empty state and the + view: continuing an old window and
   * starting a new one are the same choice, so both are shown together.
   */
  const pickerBody = (
    <>
      <div className="text-[11px] leading-relaxed text-dim">
        每启动一个 Agent 会新建一个独立窗口：独立 SSH 连接和 MCP
        通道，可以在同一台服务器上并行工作。同一服务器的窗口共用一个本地工作区和一份
        对话历史，每个窗口的「继续」只续自己的对话。
      </div>

      {history.length > 0 && (
        <div>
          <div className="label">上次的窗口</div>
          <div className="space-y-1.5">
            {history.map((record) => {
              const continueChat = record.kind !== 'custom' && record.resumable
              return (
                <div
                  key={record.agentSessionId}
                  className="flex items-center gap-2 rounded-lg border border-line-2 bg-panel-2 px-2.5 py-2"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      continueChat ? 'bg-ok' : 'bg-faint'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-ink">
                      {titles[record.agentSessionId] ?? record.name}
                    </div>
                    <div className="truncate text-[10px] text-faint">
                      {relativeTime(record.lastActiveAt)} ·{' '}
                      {record.kind === 'custom'
                        ? '同一工作区'
                        : continueChat
                          ? '可继续对话'
                          : '无对话记录'}
                    </div>
                  </div>
                  <button
                    className="btn-secondary h-6 shrink-0 px-2 text-[10px]"
                    disabled={busy}
                    title={
                      continueChat
                        ? '重新启动这个窗口并继续它自己的对话'
                        : '重新打开这个窗口'
                    }
                    onClick={() => void resumeSession(record)}
                  >
                    {continueChat ? '继续' : '重新打开'}
                  </button>
                  <button
                    className="icon-btn h-6 w-6 shrink-0"
                    title="删除这条记录和该窗口的对话历史"
                    onClick={() => void forgetSession(record)}
                  >
                    <X size={11} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div>
        <div className="label">选择 Agent</div>
        <div className="space-y-1.5">
          {profiles.length === 0 && (
            <div className="rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-[11px] text-faint">
              没有启用的 Agent。请到设置中启用 Claude Code、Codex 或自定义 Agent。
            </div>
          )}
          {profiles.map((profile) => {
            const selected = profile.id === activeProfile?.id
            return (
              <button
                key={profile.id}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                  selected
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-line-2 bg-panel-2 hover:bg-panel-3'
                }`}
                onClick={() => setProfileId(profile.id)}
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-md ${
                    selected ? 'bg-accent/15 text-accent' : 'bg-panel-3 text-dim'
                  }`}
                >
                  <Bot size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink">
                    {profile.label}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-faint">
                    {profile.command || '未配置命令'}
                    {profile.args?.length ? ` ${profile.args.join(' ')}` : ''}
                  </span>
                </span>
                <span className="chip">{profile.kind}</span>
              </button>
            )
          })}
        </div>
      </div>

      {!connection && (
        <div className="rounded-md border border-line-2 bg-panel-2/60 px-3 py-2 text-[11px] leading-relaxed text-faint">
          当前没有已连接的窗口。启动 Agent 时会为它建立独立连接，使用会话里保存的凭据。
        </div>
      )}

      <button
        className="btn-primary w-full"
        disabled={busy || !activeProfile}
        onClick={() => activeProfile && void launch(activeProfile)}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
        启动 {activeProfile?.label ?? 'Agent'}
      </button>

      <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2 text-[10px] leading-relaxed text-faint">
        点标签栏右侧的 + 可随时回到这里，继续之前的窗口或再开一个。同一服务器的窗口共用本地工作区，
        所有远程操作都会记入审计日志。
      </div>
    </>
  )

  const shellBar = activeAgent && shellOpen && (
    <div className="flex shrink-0 items-center gap-2 border-b border-accent-2/25 bg-accent-2/10 px-3 py-1.5 text-[10px] text-accent-2">
      <SquareTerminal size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title="命令之间保留工作目录和环境变量；空闲 30 分钟自动关闭">
        {activeAgent.name} 的持久 shell 已开启
      </span>
      <button
        className="flex h-5 items-center gap-1 rounded px-1.5 text-accent-2/90 transition hover:bg-accent-2/15 hover:text-accent-2"
        title="关闭持久 shell"
        onClick={() => void closeShell(activeAgent)}
      >
        <X size={11} />
        关闭
      </button>
    </div>
  )

  return (
    <div className="flex shrink-0">
      <ResizeHandle
        axis="x"
        onDelta={(delta) => setWidth((value) => clampWidth(value - delta))}
      />
      <aside
        className="flex shrink-0 flex-col border-l border-line bg-panel/70"
        style={{ width }}
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <Sparkles size={13} className="text-accent-2" />
          <span className="text-xs font-semibold text-ink">AI Agent</span>
          <span
            className={`chip ${mcpPort ? 'border-ok/30 text-ok' : 'border-line-2 text-faint'}`}
            title={mcpPort ? `MCP 127.0.0.1:${mcpPort}` : 'MCP 未启动'}
          >
            <span className={`h-1 w-1 rounded-full ${mcpPort ? 'bg-ok' : 'bg-faint'}`} />
            MCP {mcpPort ? '就绪' : '未启动'}
          </span>
          {agents.length > 0 && (
            <span className="chip border-line-2 text-dim">{agents.length} 个窗口</span>
          )}
          <div className="flex-1" />
          <button
            className="icon-btn h-6 w-6"
            title="审计记录"
            onClick={() => setAuditOpen(true)}
          >
            <ScrollText size={12} />
          </button>
          <button
            className="icon-btn h-6 w-6"
            title="折叠 Agent 面板"
            onClick={() => togglePanel('agent', false)}
          >
            <ArrowRightFromLine size={12} />
          </button>
        </div>

        <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-panel-2/40">
          <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-1.5">
            {agents.map((agent) => {
              const active =
                !pickerVisible && agent.agentSessionId === activeAgent?.agentSessionId
              const count = activityCountByAgent[agent.agentSessionId] ?? 0
              const label = titles[agent.agentSessionId] ?? agent.name
              return (
                <div
                  key={agent.agentSessionId}
                  role="button"
                  tabIndex={0}
                  className={`group my-auto flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition ${
                    active
                      ? 'bg-panel-3 text-ink'
                      : 'text-dim hover:bg-panel-2 hover:text-ink'
                  }`}
                  title={
                    label === agent.name
                      ? `${agent.name} · ${agent.profileLabel}`
                      : `${label} · ${agent.name} · ${agent.profileLabel}`
                  }
                  onClick={() => selectAgent(agent.agentSessionId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      selectAgent(agent.agentSessionId)
                    }
                  }}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(agent.status)}`}
                  />
                  <span className="truncate">{label}</span>
                  {count > 0 && (
                    <span className="rounded-full bg-panel-3 px-1 text-[9px] text-dim">
                      {count}
                    </span>
                  )}
                  <button
                    className={`ml-0.5 rounded p-0.5 text-faint transition hover:bg-line-2 hover:text-ink ${
                      active ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    title="停止并关闭窗口"
                    onClick={(event) => {
                      event.stopPropagation()
                      void stop(agent)
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              )
            })}
          </div>
          <button
            className={`my-auto mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-panel-2 hover:text-ink disabled:cursor-default disabled:opacity-40 ${
              showPicker && activeAgent ? 'bg-panel-3 text-ink' : 'text-faint'
            }`}
            disabled={busy}
            title="新建窗口或继续之前的窗口"
            onClick={openPicker}
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
          </button>
        </div>

        {!pickerVisible && shellBar}

        {!activeAgent ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
              {pickerBody}
            </div>

            <div className="mt-auto border-t border-line">
              <div className="flex h-7 items-center gap-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-faint">
                <ActivityIcon size={11} />
                最近活动
              </div>
              <div className="h-[180px] overflow-hidden">
                <ActivityFeed sessionId={sessionId} compact />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {!pickerVisible && connectionLost && (
              <div className="flex shrink-0 items-center gap-2 border-b border-warn/25 bg-warn/10 px-3 py-1.5 text-[10px] leading-relaxed text-warn">
                <span className="min-w-0 flex-1">
                  SSH 连接已断开，Agent 进程仍在运行。重连后 MCP 工具恢复可用，持久 shell
                  需要重新打开。
                </span>
                <button
                  className="btn-ghost h-6 shrink-0 px-2 text-[10px] text-warn"
                  disabled={busy}
                  onClick={() => void reconnect(activeAgent)}
                >
                  <RefreshCw size={11} />
                  重连
                </button>
              </div>
            )}

            {!pickerVisible && activeAgent.status === 'error' && (
              <div className="flex shrink-0 items-center gap-2 border-b border-err/25 bg-err/10 px-3 py-1.5 text-[10px] leading-relaxed text-err">
                <span className="min-w-0 flex-1 truncate" title={activeAgent.error}>
                  启动失败{activeAgent.error ? `：${activeAgent.error}` : ''}
                </span>
                <button
                  className="btn-ghost h-6 shrink-0 px-2 text-[10px]"
                  disabled={busy}
                  onClick={() => void retry(activeAgent)}
                >
                  {busy ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RotateCcw size={11} />
                  )}
                  重试
                </button>
              </div>
            )}

            <div className="relative min-h-0 flex-1 bg-panel">
              {agents.map((agent) => {
                const isActive = agent.agentSessionId === activeAgent.agentSessionId
                const show = isActive && tab === 'terminal' && !pickerVisible
                return (
                  <div
                    key={agent.agentSessionId}
                    className={`absolute inset-0 ${show ? '' : 'hidden'}`}
                  >
                    {agent.status === 'error' ? (
                      <AgentError
                        agent={agent}
                        onRetry={() => void retry(agent)}
                        onClose={() => void stop(agent)}
                      />
                    ) : (
                      <AgentTerminal runtime={agent} visible={show} />
                    )}
                  </div>
                )
              })}
              {tab === 'activity' && !pickerVisible && (
                <div className="absolute inset-0">
                  <ActivityFeed
                    sessionId={sessionId}
                    agentSessionId={activeAgent.agentSessionId}
                  />
                </div>
              )}

              {pickerVisible && (
                <div className="absolute inset-0 z-10 flex flex-col bg-panel">
                  <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
                    <Plus size={12} className="text-accent-2" />
                    <span className="text-[11px] font-semibold text-ink">新建窗口</span>
                    <span className="min-w-0 truncate text-[10px] text-faint">
                      继续之前的窗口，或启动一个新的 Agent
                    </span>
                    <div className="flex-1" />
                    <button
                      className="btn-ghost h-6 px-2 text-[10px]"
                      onClick={() => setShowPicker(false)}
                    >
                      返回
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
                    {pickerBody}
                  </div>
                </div>
              )}
            </div>

            <div
              className={`h-8 shrink-0 items-center gap-1 border-t border-line bg-panel-2/60 px-1.5 ${
                pickerVisible ? 'hidden' : 'flex'
              }`}
            >
              <button
                className={`flex h-7 items-center gap-1.5 rounded px-2 text-[11px] transition ${
                  tab === 'terminal' ? 'bg-panel-3 text-ink' : 'text-faint hover:text-dim'
                }`}
                onClick={() => setTab('terminal')}
              >
                <TerminalIcon size={12} />
                终端
              </button>
              <button
                className={`flex h-7 items-center gap-1.5 rounded px-2 text-[11px] transition ${
                  tab === 'activity' ? 'bg-panel-3 text-ink' : 'text-faint hover:text-dim'
                }`}
                onClick={() => setTab('activity')}
              >
                <ActivityIcon size={12} />
                活动
                {activityCount > 0 && (
                  <span className="rounded-full bg-panel-3 px-1.5 text-[9px] text-dim">
                    {activityCount}
                  </span>
                )}
              </button>
              <div className="flex-1" />
              <span className="px-2 text-[9px] text-faint">Ctrl+Shift+C 复制</span>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

function AgentError({
  agent,
  onRetry,
  onClose
}: {
  agent: AgentSession
  onRetry: () => void
  onClose: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangle size={22} className="text-err/70" />
      <div className="text-xs font-medium text-ink">启动失败</div>
      <div className="max-w-[300px] text-[11px] leading-relaxed text-faint">
        {agent.error || '未知错误'}
      </div>
      <div className="flex gap-2">
        <button className="btn-secondary h-7 px-3 text-[11px]" onClick={onRetry}>
          重试
        </button>
        <button className="btn-ghost h-7 px-3 text-[11px]" onClick={onClose}>
          关闭窗口
        </button>
      </div>
    </div>
  )
}
