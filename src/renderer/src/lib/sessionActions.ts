import type { Session } from '@shared/types'
import { sessionConnection, useAppStore } from '../state/store'

/** Connects one instance. A failure is reported unless a state event did. */
async function connectConn(connId: string, session: Session): Promise<void> {
  const store = useAppStore.getState()
  const status = store.connections[connId]?.status
  if (status === 'connected' || status === 'connecting') return
  try {
    await window.aishell.ssh.connect(connId, session.id)
  } catch (err) {
    const current = useAppStore.getState()
    // ssh:state already raised a toast for main-process failures; only speak
    // up here when no state event explained the failure.
    if (current.connections[connId]?.status !== 'error') {
      current.pushToast('error', `连接 ${session.name} 失败：${(err as Error).message}`)
    }
  }
}

/**
 * Opens (or focuses) the session's terminal tab. Sidebar and welcome-list
 * clicks land on the existing tab; use `connectConn` from the picker to get
 * an extra independent one.
 */
export async function connectSession(session: Session): Promise<void> {
  const connId = useAppStore.getState().openSessionTab(session)
  await connectConn(connId, session)
}

/** Opens a new independent terminal for `session` in place of `tabId`. */
export async function connectInTab(tabId: string, session: Session): Promise<void> {
  const connId = useAppStore.getState().pickSessionForTab(tabId, session)
  await connectConn(connId, session)
}

export async function disconnectSession(session: Session): Promise<void> {
  const store = useAppStore.getState()
  // Each agent window owns a connection, so stop every one of them.
  const agents = Object.values(store.agentSessions).filter(
    (agent) => agent.sessionId === session.id
  )
  await Promise.all(
    agents.map((agent) =>
      window.aishell.agent.stop(agent.agentSessionId).catch(() => undefined)
    )
  )
  await window.aishell.ssh.disconnect(session.id)
  // Disconnecting tears down the session, so its tabs no longer have a
  // backing connection — close them along with it.
  const current = useAppStore.getState()
  current.removeSessionTabs(session.id)
  const removed = new Set(agents.map((agent) => agent.agentSessionId))
  useAppStore.setState((state) => {
    const agentSessions = { ...state.agentSessions }
    const agentShells = { ...state.agentShells }
    const connections = { ...state.connections }
    for (const agent of agents) {
      delete agentSessions[agent.agentSessionId]
      delete agentShells[agent.connId]
      delete connections[agent.connId]
    }
    const activeAgentId = { ...state.activeAgentId }
    delete activeAgentId[session.id]
    return {
      agentSessions,
      agentShells,
      connections,
      activeAgentId,
      agentOrder: state.agentOrder.filter((id) => !removed.has(id))
    }
  })
}

export async function deleteSession(session: Session): Promise<void> {
  const store = useAppStore.getState()
  const confirmed = await store.confirm({
    title: '删除连接',
    message: `确定删除「${session.name}」吗？\n保存的密码和私钥口令也会一并删除。`,
    confirmText: '删除',
    danger: true
  })
  if (!confirmed) return
  await disconnectSession(session).catch(() => undefined)
  await window.aishell.sessions.remove(session.id)
  const current = useAppStore.getState()
  current.removeSessionTabs(session.id)
  await current.refreshSessions()
  current.pushToast('info', `已删除连接「${session.name}」`)
}

export async function copyAddress(session: Session): Promise<void> {
  const text = `${session.username}@${session.host}:${session.port}`
  await window.aishell.clipboard.writeText(text)
  useAppStore.getState().pushToast('info', `已复制 ${text}`)
}

/** Connection state for components bound to a server rather than a tab. */
export function useSessionConnection(sessionId: string): ReturnType<typeof sessionConnection> {
  return useAppStore((s) => sessionConnection(s.connections, sessionId))
}
