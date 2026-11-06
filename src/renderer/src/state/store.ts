import { create } from 'zustand'
import type {
  ActivityEvent,
  AgentSession,
  ConnectionStatus,
  HostInfo,
  KnownHost,
  Session,
  Settings,
  TransferProgress
} from '@shared/types'

export interface Tab {
  id: string
  kind: 'terminal' | 'file' | 'picker'
  /** Absent for the picker tab, which has no server until one is chosen. */
  sessionId?: string
  title: string
  path?: string
  dirty?: boolean
}

/** State of one connection instance, keyed by connId. */
export interface ConnectionState {
  sessionId: string
  status: ConnectionStatus
  error?: string
  hostInfo?: HostInfo
  latency?: number
}

const STATUS_RANK: Record<ConnectionStatus, number> = {
  connected: 3,
  connecting: 2,
  error: 1,
  disconnected: 0
}

/** The most alive connection of a server, for components bound to a session. */
export function sessionConnection(
  connections: Record<string, ConnectionState>,
  sessionId: string
): ConnectionState | undefined {
  let best: ConnectionState | undefined
  for (const connection of Object.values(connections)) {
    if (connection.sessionId !== sessionId) continue
    if (!best || STATUS_RANK[connection.status] > STATUS_RANK[best.status]) best = connection
  }
  return best
}

export interface Toast {
  id: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export type DialogState =
  | {
      kind: 'confirm'
      title: string
      message: string
      confirmText?: string
      danger?: boolean
      resolve: (value: boolean) => void
    }
  | {
      kind: 'prompt'
      title: string
      message?: string
      value: string
      placeholder?: string
      validate?: (value: string) => string | null
      resolve: (value: string | null) => void
    }

interface AppStore {
  ready: boolean
  sessions: Session[]
  settings: Settings
  knownHosts: KnownHost[]
  mcpPort: number | null
  platform: string
  versions: { app: string; electron: string; node: string }
  userDataPath: string
  encryptionAvailable: boolean

  connections: Record<string, ConnectionState>
  tabs: Tab[]
  activeTabId: string | null
  /** Server context that survives closing every tab while agents still run. */
  activeSessionId: string | null
  panels: { sidebar: boolean; files: boolean; agent: boolean }
  /** Agent windows, keyed by agentSessionId (not by connection). */
  agentSessions: Record<string, AgentSession>
  agentOrder: string[]
  /** Which agent window each server's panel is showing. */
  activeAgentId: Record<string, string | null>
  activities: ActivityEvent[]
  transfers: Record<string, TransferProgress>
  /** Connection instances whose agent currently holds a persistent shell. */
  agentShells: Record<string, boolean>
  auditOpen: boolean
  toasts: Toast[]
  dialog: DialogState | null
  settingsOpen: boolean
  sessionEditor: { open: boolean; session?: Session; group?: string }

  init: () => Promise<void>
  refreshSessions: () => Promise<void>
  setSettings: (settings: Settings) => void
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  removeKnownHost: (key: string) => Promise<void>
  createGroup: (name: string) => Promise<void>
  renameGroup: (from: string, to: string) => Promise<void>
  deleteGroup: (name: string) => Promise<void>

  setConnection: (connId: string, sessionId: string, patch: Partial<ConnectionState>) => void
  setLatency: (connId: string, latency: number) => void

  /** Focuses the session's terminal tab, opening the primary one if needed. */
  openSessionTab: (session: Session) => string
  /** Adds the single reusable "choose a server" tab and focuses it. */
  openPickerTab: () => void
  /**
   * Turns a picker tab into a terminal tab for `session`. Always a new
   * connection instance, even when the server already has tabs open.
   * Returns the new connection id.
   */
  pickSessionForTab: (tabId: string, session: Session) => string
  openFileTab: (sessionId: string, path: string, title?: string) => void
  closeTab: (tabId: string) => void
  removeSessionTabs: (sessionId: string) => void
  setActiveTab: (tabId: string) => void
  updateTab: (tabId: string, patch: Partial<Tab>) => void

  togglePanel: (panel: 'sidebar' | 'files' | 'agent', value?: boolean) => void
  setSettingsOpen: (open: boolean) => void
  openSessionEditor: (session?: Session, group?: string) => void
  closeSessionEditor: () => void

  applyAgentState: (agent: AgentSession) => void
  /** Drops one agent window after it stops or crashes. */
  removeAgentSession: (agentSessionId: string) => void
  setActiveAgent: (sessionId: string, agentSessionId: string | null) => void
  applyActivity: (event: ActivityEvent) => void
  applyTransfer: (transfer: TransferProgress) => void
  removeTransfer: (id: string) => void
  setAgentShell: (connId: string, open: boolean) => void
  setAuditOpen: (open: boolean) => void

  pushToast: (level: Toast['level'], message: string) => void
  dismissToast: (id: string) => void

  confirm: (options: {
    title: string
    message: string
    confirmText?: string
    danger?: boolean
  }) => Promise<boolean>
  prompt: (options: {
    title: string
    message?: string
    value?: string
    placeholder?: string
    validate?: (value: string) => string | null
  }) => Promise<string | null>
  closeDialog: () => void
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const emptySettings: Settings = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  theme: 'dark',
  agentProfiles: []
}

async function endSessionConnection(sessionId: string): Promise<void> {
  const agents = Object.values(useAppStore.getState().agentSessions).filter(
    (agent) => agent.sessionId === sessionId
  )
  await Promise.all(
    agents.map((agent) =>
      window.aishell.agent.stop(agent.agentSessionId).catch(() => undefined)
    )
  )
  await window.aishell.ssh.disconnect(sessionId).catch(() => undefined)
  const removed = new Set(agents.map((agent) => agent.agentSessionId))
  useAppStore.setState((state) => {
    const connections = { ...state.connections }
    const agentSessions = { ...state.agentSessions }
    const agentShells = { ...state.agentShells }
    for (const [connId, connection] of Object.entries(connections)) {
      if (connection.sessionId === sessionId) delete connections[connId]
    }
    for (const agent of agents) {
      delete agentSessions[agent.agentSessionId]
      delete agentShells[agent.connId]
    }
    const activeAgentId = { ...state.activeAgentId }
    delete activeAgentId[sessionId]
    return {
      connections,
      agentSessions,
      agentShells,
      activeAgentId,
      agentOrder: state.agentOrder.filter((id) => !removed.has(id))
    }
  })
}

/** Terminal tabs (one per connection instance) belonging to a session. */
function terminalTabsOf(tabs: Tab[], sessionId: string): Tab[] {
  return tabs.filter((t) => t.kind === 'terminal' && t.sessionId === sessionId)
}

/** Closes a tab without asking about unsaved edits. */
function closeTabNow(tabId: string): void {
  const state = useAppStore.getState()
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) return
  if (tab.kind === 'terminal' && tab.sessionId) {
    const connId = tab.id.slice('term-'.length)
    const sessionId = tab.sessionId
    void window.aishell.ssh.disconnectConn(connId).catch(() => undefined)

    const remainingTabs = state.tabs.filter((t) => t.id !== tabId)
    const otherTerminals = remainingTabs.filter(
      (t) => t.kind === 'terminal' && t.sessionId === sessionId
    )
    const hasAgents = Object.values(state.agentSessions).some(
      (agent) => agent.sessionId === sessionId
    )
    if (!otherTerminals.length && !hasAgents) {
      // Last window of the server: its file tabs lose their connection too.
      void endSessionConnection(sessionId)
      state.removeSessionTabs(sessionId)
      return
    }
    // Agents are independent windows; closing a terminal never stops them.
    const tabs = remainingTabs
    const index = state.tabs.findIndex((t) => t.id === tabId)
    const activeTabId =
      state.activeTabId === tabId
        ? (tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? null)
        : state.activeTabId
    // Closing the focused terminal leaves its server as the panel context when
    // agent windows are still open there.
    const nextActive = tabs.find((t) => t.id === activeTabId)
    const activeSessionId =
      state.activeTabId === tabId ? (nextActive?.sessionId ?? sessionId) : state.activeSessionId
    useAppStore.setState((s) => {
      const connections = { ...s.connections }
      delete connections[connId]
      return { tabs, activeTabId, activeSessionId, connections }
    })
    return
  }
  const tabs = state.tabs.filter((t) => t.id !== tabId)
  let activeTabId = state.activeTabId
  if (activeTabId === tabId) {
    const index = state.tabs.findIndex((t) => t.id === tabId)
    activeTabId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? null
  }
  const nextActive = tabs.find((t) => t.id === activeTabId)
  const hasAgents =
    Boolean(tab.sessionId) &&
    Object.values(state.agentSessions).some((agent) => agent.sessionId === tab.sessionId)
  const activeSessionId =
    nextActive?.sessionId ?? (hasAgents ? (tab.sessionId ?? null) : null)
  useAppStore.setState({ tabs, activeTabId, activeSessionId })
}

export const useAppStore = create<AppStore>()((set, get) => ({
  ready: false,
  sessions: [],
  settings: emptySettings,
  knownHosts: [],
  mcpPort: null,
  platform: 'win32',
  versions: { app: '', electron: '', node: '' },
  userDataPath: '',
  encryptionAvailable: false,

  connections: {},
  tabs: [],
  activeTabId: null,
  activeSessionId: null,
  panels: { sidebar: true, files: true, agent: true },
  agentSessions: {},
  agentOrder: [],
  activeAgentId: {},
  activities: [],
  transfers: {},
  agentShells: {},
  auditOpen: false,
  toasts: [],
  dialog: null,
  settingsOpen: false,
  sessionEditor: { open: false },

  async init() {
    const state = await window.aishell.getState()
    const agentSessions = Object.fromEntries(
      state.agents.map((agent) => [agent.agentSessionId, agent])
    )
    const activeAgentId: Record<string, string | null> = {}
    for (const agent of state.agents) {
      if (!(agent.sessionId in activeAgentId)) {
        activeAgentId[agent.sessionId] = agent.agentSessionId
      }
    }
    set({
      ready: true,
      sessions: state.sessions,
      settings: state.settings,
      knownHosts: state.knownHosts,
      mcpPort: state.mcpPort,
      platform: state.platform,
      versions: state.versions,
      userDataPath: state.userDataPath,
      encryptionAvailable: state.encryptionAvailable,
      agentShells: Object.fromEntries(state.agentShells.map((id) => [id, true])),
      agentSessions,
      agentOrder: state.agents.map((agent) => agent.agentSessionId),
      activeAgentId,
      // After a renderer reload there are no tabs yet; keep running agents
      // reachable by opening their server's panel context.
      activeSessionId: state.agents[0]?.sessionId ?? null
    })
    const activities = await window.aishell.activity.list()
    set({ activities })
  },

  async refreshSessions() {
    const state = await window.aishell.getState()
    set({
      sessions: state.sessions,
      settings: state.settings,
      knownHosts: state.knownHosts,
      mcpPort: state.mcpPort
    })
  },

  setSettings(settings) {
    set({ settings })
  },

  async saveSettings(patch) {
    const settings = await window.aishell.settings.save(patch)
    set({ settings })
  },

  async removeKnownHost(key) {
    await window.aishell.hosts.remove(key)
    set((state) => ({ knownHosts: state.knownHosts.filter((h) => h.key !== key) }))
  },

  async createGroup(name) {
    const groups = await window.aishell.groups.create(name)
    set((state) => ({ settings: { ...state.settings, groups } }))
  },

  async renameGroup(from, to) {
    const result = await window.aishell.groups.rename(from, to)
    set((state) => ({
      sessions: result.sessions,
      settings: { ...state.settings, groups: result.groups }
    }))
  },

  async deleteGroup(name) {
    const result = await window.aishell.groups.remove(name)
    set((state) => ({
      sessions: result.sessions,
      settings: { ...state.settings, groups: result.groups }
    }))
  },

  setConnection(connId, sessionId, patch) {
    set((state) => ({
      connections: {
        ...state.connections,
        [connId]: {
          ...(state.connections[connId] ?? { sessionId, status: 'disconnected' }),
          sessionId,
          ...patch
        }
      }
    }))
  },

  setLatency(connId, latency) {
    set((state) => {
      const existing = state.connections[connId]
      if (!existing) return state
      return { connections: { ...state.connections, [connId]: { ...existing, latency } } }
    })
  },

  openSessionTab(session) {
    const state = get()
    const existing = terminalTabsOf(state.tabs, session.id)[0]
    if (existing) {
      set({ activeTabId: existing.id, activeSessionId: session.id })
      return existing.id
    }
    // First tab of this server: it takes the primary connection id, which is
    // the session id itself.
    const id = `term-${session.id}`
    set((s) => ({
      tabs: [...s.tabs, { id, kind: 'terminal', sessionId: session.id, title: session.name }],
      activeTabId: id,
      activeSessionId: session.id
    }))
    return session.id
  },

  openPickerTab() {
    const id = 'tab-picker'
    set((state) => ({
      tabs: state.tabs.some((t) => t.id === id)
        ? state.tabs
        : [...state.tabs, { id, kind: 'picker', title: '选择服务器' }],
      activeTabId: id,
      activeSessionId: null
    }))
  },

  pickSessionForTab(tabId, session) {
    // The picker always opens an independent terminal, so the same server can
    // be worked on in several windows at once.
    const connId = terminalTabsOf(get().tabs, session.id).length
      ? `${session.id}#${uid()}`
      : session.id
    const termId = `term-${connId}`
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { id: termId, kind: 'terminal' as const, sessionId: session.id, title: session.name }
          : t
      ),
      activeTabId: termId,
      activeSessionId: session.id
    }))
    return connId
  },

  openFileTab(sessionId, path, title) {
    const id = `file-${sessionId}-${path}`
    const existing = get().tabs.find((t) => t.id === id)
    if (!existing) {
      set((state) => ({
        tabs: [
          ...state.tabs,
          {
            id,
            kind: 'file',
            sessionId,
            path,
            title: title ?? path.split('/').pop() ?? path
          }
        ],
        activeTabId: id,
        activeSessionId: sessionId
      }))
    } else {
      set({ activeTabId: id, activeSessionId: sessionId })
    }
  },

  closeTab(tabId) {
    const state = get()
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab) return

    // Closing the last window of a server also closes its file tabs. Agents
    // are independent windows and keep the server alive on their own.
    const lastWindow =
      tab.kind === 'terminal' &&
      terminalTabsOf(state.tabs, tab.sessionId!).length === 1 &&
      !Object.values(state.agentSessions).some((agent) => agent.sessionId === tab.sessionId)
    const dirtyTabs =
      lastWindow
        ? state.tabs.filter(
            (t) => t.sessionId === tab.sessionId && t.kind === 'file' && t.dirty
          )
        : tab.dirty
          ? [tab]
          : []
    if (!dirtyTabs.length) {
      closeTabNow(tabId)
      return
    }

    const closingTerminal = tab.kind === 'terminal'
    void state
      .confirm({
        title: closingTerminal ? '关闭终端' : '关闭文件',
        message: closingTerminal
          ? `该会话还有 ${dirtyTabs.length} 个文件未保存，关闭最后一个窗口会一并关闭它们。`
          : '文件有未保存的修改，确定关闭吗？',
        confirmText: '关闭',
        danger: true
      })
      .then((ok) => {
        if (ok) closeTabNow(tabId)
      })
  },

  removeSessionTabs(sessionId) {
    set((state) => {
      const index = state.tabs.findIndex((t) => t.sessionId === sessionId)
      if (index === -1) {
        // The server may have had only agent windows; drop its panel context.
        return state.activeSessionId === sessionId ? { activeSessionId: null } : {}
      }
      const tabs = state.tabs.filter((t) => t.sessionId !== sessionId)
      const activeRemoved =
        state.activeTabId !== null && !tabs.some((t) => t.id === state.activeTabId)
      const activeTabId = activeRemoved
        ? (tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? null)
        : state.activeTabId
      const nextActive = tabs.find((t) => t.id === activeTabId)
      return { tabs, activeTabId, activeSessionId: nextActive?.sessionId ?? null }
    })
  },

  setActiveTab(tabId) {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      return { activeTabId: tabId, activeSessionId: tab?.sessionId ?? null }
    })
  },

  updateTab(tabId, patch) {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
    }))
  },

  togglePanel(panel, value) {
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: value === undefined ? !state.panels[panel] : value
      }
    }))
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open })
  },

  openSessionEditor(session, group) {
    set({ sessionEditor: { open: true, session, group } })
  },

  closeSessionEditor() {
    set({ sessionEditor: { open: false } })
  },

  applyAgentState(agent) {
    set((state) => {
      const exists = state.agentSessions[agent.agentSessionId]
      const agentSessions = {
        ...state.agentSessions,
        [agent.agentSessionId]: agent
      }
      const agentOrder = exists
        ? state.agentOrder
        : [...state.agentOrder, agent.agentSessionId]
      // A newly launched window takes focus; otherwise keep the user's pick.
      const current = state.activeAgentId[agent.sessionId]
      const currentExists = Boolean(current && agentSessions[current!])
      const shouldFocus = agent.status === 'starting' || !currentExists
      const activeAgentId = shouldFocus
        ? { ...state.activeAgentId, [agent.sessionId]: agent.agentSessionId }
        : state.activeAgentId
      return { agentSessions, agentOrder, activeAgentId }
    })
  },

  removeAgentSession(agentSessionId) {
    set((state) => {
      const agent = state.agentSessions[agentSessionId]
      if (!agent) return {}
      const agentSessions = { ...state.agentSessions }
      delete agentSessions[agentSessionId]
      const agentOrder = state.agentOrder.filter((id) => id !== agentSessionId)
      const agentShells = { ...state.agentShells }
      delete agentShells[agent.connId]
      const connections = { ...state.connections }
      delete connections[agent.connId]
      let activeAgentId = state.activeAgentId
      if (state.activeAgentId[agent.sessionId] === agentSessionId) {
        const next =
          agentOrder.find((id) => agentSessions[id]?.sessionId === agent.sessionId) ?? null
        activeAgentId = { ...state.activeAgentId, [agent.sessionId]: next }
      }
      // The last window of this server just closed: keep its panel context only
      // while some tab (a terminal or file editor) still belongs to it.
      let activeSessionId = state.activeSessionId
      if (activeSessionId === agent.sessionId) {
        const hasTerminal = state.tabs.some(
          (tab) => tab.kind === 'terminal' && tab.sessionId === agent.sessionId
        )
        const hasAgentsLeft = agentOrder.some(
          (id) => agentSessions[id]?.sessionId === agent.sessionId
        )
        if (!hasTerminal && !hasAgentsLeft) {
          activeSessionId = state.tabs.find((tab) => tab.id === state.activeTabId)?.sessionId ?? null
        }
      }
      return {
        agentSessions,
        agentOrder,
        agentShells,
        connections,
        activeAgentId,
        activeSessionId
      }
    })
  },

  setActiveAgent(sessionId, agentSessionId) {
    set((state) => ({
      activeAgentId: { ...state.activeAgentId, [sessionId]: agentSessionId }
    }))
  },

  applyActivity(event) {
    set((state) => {
      const exists = state.activities.some((e) => e.id === event.id)
      return {
        activities: exists
          ? state.activities.map((e) => (e.id === event.id ? event : e))
          : [event, ...state.activities]
      }
    })
  },

  applyTransfer(transfer) {
    set((state) => ({
      transfers: { ...state.transfers, [transfer.id]: transfer }
    }))
  },

  removeTransfer(id) {
    set((state) => {
      const next = { ...state.transfers }
      delete next[id]
      return { transfers: next }
    })
  },

  setAgentShell(connId, open) {
    set((state) => {
      const next = { ...state.agentShells }
      if (open) next[connId] = true
      else delete next[connId]
      return { agentShells: next }
    })
  },

  setAuditOpen(open) {
    set({ auditOpen: open })
  },

  pushToast(level, message) {
    const id = uid()
    set((state) => ({ toasts: [...state.toasts, { id, level, message }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  },

  confirm(options) {
    return new Promise<boolean>((resolve) => {
      set({
        dialog: {
          kind: 'confirm',
          title: options.title,
          message: options.message,
          confirmText: options.confirmText,
          danger: options.danger,
          resolve
        }
      })
    })
  },

  prompt(options) {
    return new Promise<string | null>((resolve) => {
      set({
        dialog: {
          kind: 'prompt',
          title: options.title,
          message: options.message,
          value: options.value ?? '',
          placeholder: options.placeholder,
          validate: options.validate,
          resolve
        }
      })
    })
  },

  closeDialog() {
    const dialog = get().dialog
    if (!dialog) return
    if (dialog.kind === 'confirm') dialog.resolve(false)
    else dialog.resolve(null)
    set({ dialog: null })
  }
}))
