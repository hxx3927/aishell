import {
  Activity as ActivityIcon,
  Bot,
  Loader2,
  Play,
  RotateCcw,
  ScrollText,
  Sparkles,
  Square,
  SquareTerminal,
  Terminal as TerminalIcon,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { sessionConnection, useAppStore } from '../state/store'
import { ActivityFeed } from './ActivityFeed'
import { AgentTerminal } from './AgentTerminal'

interface AgentPanelProps {
  sessionId: string
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const settings = useAppStore((s) => s.settings)
  const connection = useAppStore((s) => sessionConnection(s.connections, sessionId))
  const runtime = useAppStore((s) => s.agentRuntimes[sessionId])
  const mcpPort = useAppStore((s) => s.mcpPort)
  const activities = useAppStore((s) => s.activities)
  const applyAgentState = useAppStore((s) => s.applyAgentState)
  const clearAgentRuntime = useAppStore((s) => s.clearAgentRuntime)
  const pushToast = useAppStore((s) => s.pushToast)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const shellOpen = useAppStore((s) => Boolean(s.agentShells[sessionId]))
  const setAuditOpen = useAppStore((s) => s.setAuditOpen)

  const profiles = useMemo(
    () => settings.agentProfiles.filter((profile) => profile.enabled),
    [settings.agentProfiles]
  )
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? 'claude')
  const [tab, setTab] = useState<'terminal' | 'activity'>('terminal')
  const [busy, setBusy] = useState(false)

  const connected = connection?.status === 'connected'
  const running = runtime?.status === 'running' || runtime?.status === 'starting'
  const activeProfile = profiles.find((profile) => profile.id === profileId) ?? profiles[0]

  useEffect(() => {
    if (!profiles.some((profile) => profile.id === profileId)) {
      setProfileId(profiles[0]?.id ?? 'claude')
    }
  }, [profiles, profileId])

  const activityCount = useMemo(
    () => activities.filter((event) => event.sessionId === sessionId).length,
    [activities, sessionId]
  )

  const launch = async (): Promise<void> => {
    if (!activeProfile) return
    if (!connected) {
      pushToast('warn', '请先连接服务器，再启动 Agent')
      return
    }
    setBusy(true)
    setTab('terminal')
    try {
      const result = await window.aishell.agent.launch(sessionId, activeProfile.id)
      applyAgentState(result)
    } catch (err) {
      pushToast('error', `启动 Agent 失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!runtime) return
    setBusy(true)
    try {
      await window.aishell.agent.stop(runtime.agentSessionId)
      clearAgentRuntime(sessionId)
    } catch (err) {
      pushToast('error', `停止 Agent 失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const restart = async (): Promise<void> => {
    if (!runtime) return
    setBusy(true)
    try {
      await window.aishell.agent.stop(runtime.agentSessionId)
      clearAgentRuntime(sessionId)
      const result = await window.aishell.agent.launch(sessionId, runtime.profileId)
      applyAgentState(result)
      setTab('terminal')
    } catch (err) {
      pushToast('error', `重新启动失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const closeShell = async (): Promise<void> => {
    try {
      await window.aishell.agentShell.close(sessionId)
    } catch (err) {
      pushToast('error', `关闭持久 shell 失败：${(err as Error).message}`)
    }
  }

  const shellBar = shellOpen && (
    <div className="flex shrink-0 items-center gap-2 border-b border-accent-2/25 bg-accent-2/10 px-3 py-1.5 text-[10px] text-accent-2">
      <SquareTerminal size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title="命令之间保留工作目录和环境变量；空闲 30 分钟自动关闭">
        持久 shell 已开启
      </span>
      <button
        className="flex h-5 items-center gap-1 rounded px-1.5 text-accent-2/90 transition hover:bg-accent-2/15 hover:text-accent-2"
        title="关闭持久 shell"
        onClick={() => void closeShell()}
      >
        <X size={11} />
        关闭
      </button>
    </div>
  )

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel/70">
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
          <TerminalIcon size={12} className="rotate-90" />
        </button>
      </div>

      {shellBar}

      {!runtime ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-3 overflow-y-auto px-3 py-3">
            <div className="text-[11px] leading-relaxed text-dim">
              在本机启动 CLI Agent，通过 AIShell MCP 直接操作当前服务器。
              Agent 的每条远程操作都会进入活动流。
            </div>

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

            {!connected && (
              <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-[11px] text-warn">
                请先连接服务器。Agent 需要绑定一个已连接的 SSH 会话来提供远程工具。
              </div>
            )}

            <button
              className="btn-primary w-full"
              disabled={!connected || busy || !activeProfile}
              onClick={() => void launch()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              启动 {activeProfile?.label ?? 'Agent'}
            </button>

            <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2 text-[10px] leading-relaxed text-faint">
              启动后会为该会话生成独立工作区，并写入包含主机、系统和可用工具说明的
              CLAUDE.md / AGENTS.md。所有操作会记入审计日志。
            </div>
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
          <div className="flex shrink-0 items-center gap-2 border-b border-line/70 bg-panel-2/40 px-3 py-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                runtime.status === 'running'
                  ? 'bg-ok'
                  : runtime.status === 'starting'
                    ? 'bg-warn pulse-dot'
                    : runtime.status === 'error'
                      ? 'bg-err'
                      : 'bg-faint'
              }`}
            />
            <div className="min-w-0">
              <div className="truncate text-[11px] text-ink">{runtime.profileLabel}</div>
              <div className="truncate text-[9px] text-faint" title={runtime.workspace}>
                {runtime.status === 'running'
                  ? '运行中'
                  : runtime.status === 'starting'
                    ? '启动中'
                    : runtime.status === 'error'
                      ? runtime.error ?? '启动失败'
                      : '已退出'}
                {runtime.workspace ? ` · ${runtime.workspace.split(/[\\/]/).pop()}` : ''}
              </div>
            </div>
            <div className="flex-1" />
            {running ? (
              <button
                className="btn-ghost h-6 px-2 text-[10px]"
                disabled={busy}
                onClick={() => void stop()}
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Square size={10} />}
                停止
              </button>
            ) : (
              <button
                className="btn-ghost h-6 px-2 text-[10px]"
                disabled={busy}
                onClick={() => void restart()}
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                重新启动
              </button>
            )}
          </div>

          <div className="relative min-h-0 flex-1 bg-panel">
            <div className={`absolute inset-0 ${tab === 'terminal' ? '' : 'hidden'}`}>
              <AgentTerminal
                key={runtime.agentSessionId}
                runtime={runtime}
                visible={tab === 'terminal'}
              />
            </div>
            {tab === 'activity' && (
              <div className="absolute inset-0">
                <ActivityFeed sessionId={sessionId} />
              </div>
            )}
          </div>

          <div className="flex h-8 shrink-0 items-center gap-1 border-t border-line bg-panel-2/60 px-1.5">
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
  )
}
