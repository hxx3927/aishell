import { create } from 'zustand'
import type {
  ActivityEvent,
  AgentSession,
  ConnectionStatus,
  HostInfo,
  KnownHost,
  MonitorEvent,
  MonitorHost,
  MonitorSample,
  Session,
  Settings,
  TransferProgress
} from '@shared/types'
import { monitorConnId } from '@shared/monitor'

export interface Tab {
  id: string
  kind: 'terminal' | 'file' | 'picker' | 'monitor'
  /** Absent for the picker tab, which has no server until one is chosen. */
  sessionId?: string
  title: string
  path?: string
  dirty?: boolean
}

export interface MonitorState {
  status: 'starting' | 'sampling' | 'paused' | 'error'
  host?: MonitorHost
  samples: MonitorSample[]
  intervalMs: number
  lastError?: string
  lastSampleAt?: number
}

const MONITOR_INTERVAL_KEY = 'aishell.monitorIntervalMs'
const MONITOR_HISTORY_LIMIT = 450

export function monitorInterval(): number {
  const saved = Number(localStorage.getItem(MONITOR_INTERVAL_KEY))
  return Number.isFinite(saved) && saved >= 1000 && saved <= 60_000 ? saved : 2000
}

function saveMonitorInterval(intervalMs: number): void {
  localStorage.setItem(MONITOR_INTERVAL_KEY, String(intervalMs))
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
  /** Resource-monitor state, keyed by server session id. */
  monitors: Record<string, MonitorState>
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

  /** Focuses the server's monitor tab, creating it on first use. */
  openMonitorTab: (session: Session) => void
  startMonitor: (sessionId: string, intervalMs?: number) => Promise<void>
  stopMonitor: (sessionId: string) => Promise<void>
  pauseMonitor: (sessionId: string, paused: boolean) => Promise<void>
  refreshMonitor: (sessionId: string) => Promise<void>
  setMonitorInterval: (sessionId: string, intervalMs: number) => Promise<void>
  applyMonitorEvent: (event: MonitorEvent) => void

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
  removeSessionTabs: (sessionId: string, options?: { keepMonitor?: boolean }) => void
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
  await window.aishell.monitor.stop(sessionId).catch(() => undefined)
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
    const monitors = { ...state.monitors }
    delete monitors[sessionId]
    return {
      connections,
      agentSessions,
      agentShells,
      activeAgentId,
      monitors,
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
    const hasMonitor = remainingTabs.some(
      (t) => t.kind === 'monitor' && t.sessionId === sessionId
    )
    const hasAgents = Object.values(state.agentSessions).some(
      (agent) => agent.sessionId === sessionId
    )
    if (!otherTerminals.length && !hasMonitor && !hasAgents) {
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
  if (tab.kind === 'monitor' && tab.sessionId) {
    const sessionId = tab.sessionId
    const remainingTabs = state.tabs.filter((t) => t.id !== tabId)
    const stillUsed =
      remainingTabs.some(
        (t) => t.sessionId === sessionId && (t.kind === 'terminal' || t.kind === 'monitor')
      ) ||
      Object.values(state.agentSessions).some((agent) => agent.sessionId === sessionId)
    if (!stillUsed) {
      // Nothing else is using this server: stopping the monitor also tears
      // down its connection and the file tabs that were riding on it.
      void endSessionConnection(sessionId)
      state.removeSessionTabs(sessionId)
      return
    }
    void state.stopMonitor(sessionId)
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
  monitors: {},
  agentShells: {},
  auditOpen: false,
  toasts: [],
  dialog: null,
  settingsOpen: false,
  sessionEditor: { open: false },

  async init() {
    // A renderer reload drops the old tab list but the main process would keep
    // polling; nothing is watching those samples any more.
    await window.aishell.monitor.stopAll().catch(() => undefined)
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

  openMonitorTab(session) {
    const id = `monitor-${session.id}`
    const state = get()
    if (state.tabs.some((t) => t.id === id)) {
      set({ activeTabId: id, activeSessionId: session.id })
    } else {
      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            id,
            kind: 'monitor' as const,
            sessionId: session.id,
            title: `${session.name} · 监控`
          }
        ],
        activeTabId: id,
        activeSessionId: session.id
      }))
    }
    // Sampling only starts on its own when the server is already connected.
    // A disconnected server waits for the explicit "连接并开始监控" action.
    const current = get()
    if (current.monitors[session.id]) return
    if (sessionConnection(current.connections, session.id)?.status === 'connected') {
      void current.startMonitor(session.id)
    }
  },

  async startMonitor(sessionId, intervalMs) {
    const interval = intervalMs ?? get().monitors[sessionId]?.intervalMs ?? monitorInterval()
    saveMonitorInterval(interval)
    set((state) => ({
      monitors: {
        ...state.monitors,
        [sessionId]: {
          ...(state.monitors[sessionId] ?? {
            samples: [],
            intervalMs: interval
          }),
          status: 'starting',
          intervalMs: interval,
          lastError: undefined
        }
      }
    }))
    try {
      const result = await window.aishell.monitor.start(sessionId, interval)
      // `start` reattaches to a paused entry without resuming it; asking for
      // the monitor is an explicit resume.
      await window.aishell.monitor.pause(sessionId, false).catch(() => undefined)
      set((state) => {
        const existing = state.monitors[sessionId]
        // `start` immediately probes once; a failing first probe is reported in
        // the result so the status does not depend on event ordering.
        const samples = result.history.length ? result.history : (existing?.samples ?? [])
        return {
          monitors: {
            ...state.monitors,
            [sessionId]: {
              ...(existing ?? { samples: [], intervalMs: interval }),
              status: result.error ? 'error' : samples.length ? 'sampling' : 'starting',
              host: result.host ?? existing?.host,
              samples,
              intervalMs: result.intervalMs,
              lastError: result.error,
              lastSampleAt: samples.at(-1)?.ts ?? existing?.lastSampleAt
            }
          }
        }
      })
    } catch (err) {
      set((state) => ({
        monitors: {
          ...state.monitors,
          [sessionId]: {
            ...(state.monitors[sessionId] ?? { samples: [], intervalMs: interval }),
            status: 'error',
            intervalMs: interval,
            lastError: (err as Error).message
          }
        }
      }))
    }
  },

  async stopMonitor(sessionId) {
    await window.aishell.monitor.stop(sessionId).catch(() => undefined)
    set((state) => {
      if (!state.monitors[sessionId]) return {}
      const monitors = { ...state.monitors }
      delete monitors[sessionId]
      return { monitors }
    })
  },

  async pauseMonitor(sessionId, paused) {
    const existing = get().monitors[sessionId]
    if (!existing) {
      if (!paused) await get().startMonitor(sessionId)
      return
    }
    if (paused) {
      set((state) => ({
        monitors: {
          ...state.monitors,
          [sessionId]: { ...existing, status: 'paused' }
        }
      }))
      await window.aishell.monitor.pause(sessionId, true).catch(() => undefined)
      return
    }
    // Pausing also releases the connection on some servers; going back to
    // sampling after a drop needs a fresh connection first.
    const connected = get().connections[monitorConnId(sessionId)]?.status === 'connected'
    if (!connected) {
      await get().startMonitor(sessionId)
      return
    }
    set((state) => ({
      monitors: {
        ...state.monitors,
        [sessionId]: { ...existing, status: 'sampling' }
      }
    }))
    await window.aishell.monitor.pause(sessionId, false).catch(() => undefined)
  },

  async refreshMonitor(sessionId) {
    try {
      const sample = await window.aishell.monitor.sampleNow(sessionId)
      // The main process also broadcasts the sample; the event handler dedupes.
      get().applyMonitorEvent({
        sessionId,
        sampling: true,
        paused: get().monitors[sessionId]?.status === 'paused',
        sample
      })
    } catch (err) {
      const message = (err as Error).message
      set((state) => {
        const existing = state.monitors[sessionId]
        if (!existing) return {}
        return {
          monitors: {
            ...state.monitors,
            [sessionId]: { ...existing, status: 'error', lastError: message }
          }
        }
      })
    }
  },

  async setMonitorInterval(sessionId, intervalMs) {
    const interval = Math.min(60_000, Math.max(1000, Math.round(intervalMs)))
    saveMonitorInterval(interval)
    const existing = get().monitors[sessionId]
    if (existing) {
      set((state) => ({
        monitors: {
          ...state.monitors,
          [sessionId]: { ...existing, intervalMs: interval }
        }
      }))
    }
    try {
      const result = await window.aishell.monitor.start(sessionId, interval)
      set((state) => {
        const current = state.monitors[sessionId]
        if (!current) return {}
        const samples = result.history.length ? result.history : current.samples
        return {
          monitors: {
            ...state.monitors,
            [sessionId]: {
              ...current,
              intervalMs: result.intervalMs,
              host: result.host ?? current.host,
              samples,
              // A paused poller returns its last known failure unchanged.
              lastError: result.error,
              status: result.error
                ? 'error'
                : current.status === 'starting'
                  ? samples.length
                    ? 'sampling'
                    : 'starting'
                  : current.status
            }
          }
        }
      })
    } catch (err) {
      const message = (err as Error).message
      set((state) => {
        const current = state.monitors[sessionId]
        if (!current) return {}
        return {
          monitors: {
            ...state.monitors,
            [sessionId]: { ...current, lastError: message }
          }
        }
      })
    }
  },

  applyMonitorEvent(event) {
    set((state) => {
      const existing = state.monitors[event.sessionId]
      if (!event.sampling) {
        if (!existing) return {}
        const monitors = { ...state.monitors }
        delete monitors[event.sessionId]
        return { monitors }
      }
      const base: MonitorState =
        existing ?? { status: 'starting', samples: [], intervalMs: monitorInterval() }
      let samples = base.samples
      const sample = event.sample
      if (sample && !samples.some((item) => item.ts === sample.ts)) {
        samples = [...samples, sample]
        if (samples.length > MONITOR_HISTORY_LIMIT) {
          samples = samples.slice(samples.length - MONITOR_HISTORY_LIMIT)
        }
      }
      const status: MonitorState['status'] = event.error
        ? 'error'
        : event.paused
          ? 'paused'
          : samples.length
            ? 'sampling'
            : 'starting'
      return {
        monitors: {
          ...state.monitors,
          [event.sessionId]: {
            ...base,
            status,
            host: event.host ?? base.host,
            samples,
            lastError: event.error,
            lastSampleAt: sample?.ts ?? base.lastSampleAt
          }
        }
      }
    })
  },

  openSessionTab(session) {
    const state = get()
    const existing = terminalTabsOf(state.tabs, session.id)[0]
    if (existing) {
      set({ activeTabId: existing.id, activeSessionId: session.id })
      // The tab id carries the connection instance id; returning the tab id
      // would make the caller open a second, tab-less connection.
      return existing.id.slice('term-'.length)
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

    // Closing the last terminal or monitor of a server also closes its file
    // tabs. Agents and the other kind of window keep the server alive.
    const sessionId = tab.sessionId
    const hasOtherConsumer =
      Boolean(sessionId) &&
      (state.tabs.some(
        (t) =>
          t.id !== tabId &&
          t.sessionId === sessionId &&
          (t.kind === 'terminal' || t.kind === 'monitor')
      ) ||
        Object.values(state.agentSessions).some((agent) => agent.sessionId === sessionId))
    const lastWindow =
      (tab.kind === 'terminal' || tab.kind === 'monitor') &&
      Boolean(sessionId) &&
      !hasOtherConsumer
    const dirtyTabs =
      lastWindow
        ? state.tabs.filter(
            (t) => t.sessionId === sessionId && t.kind === 'file' && t.dirty
          )
        : tab.dirty
          ? [tab]
          : []
    if (!dirtyTabs.length) {
      closeTabNow(tabId)
      return
    }

    const closingTerminal = tab.kind === 'terminal'
    const closingMonitor = tab.kind === 'monitor'
    void state
      .confirm({
        title: closingTerminal ? '关闭终端' : closingMonitor ? '关闭监控' : '关闭文件',
        message: closingTerminal
          ? `该会话还有 ${dirtyTabs.length} 个文件未保存，关闭最后一个窗口会一并关闭它们。`
          : closingMonitor
            ? `关闭监控会停止采样；该会话还有 ${dirtyTabs.length} 个文件未保存，关闭后会一并关闭它们。`
            : '文件有未保存的修改，确定关闭吗？',
        confirmText: '关闭',
        danger: true
      })
      .then((ok) => {
        if (ok) closeTabNow(tabId)
      })
  },

  removeSessionTabs(sessionId, options) {
    set((state) => {
      // An explicit disconnect keeps the monitor tab so its host card and
      // history survive, with a "重新连接" action.
      const keepMonitor = options?.keepMonitor === true
      const removableIds = new Set(
        state.tabs
          .filter(
            (t) => t.sessionId === sessionId && !(keepMonitor && t.kind === 'monitor')
          )
          .map((t) => t.id)
      )
      if (!removableIds.size) {
        if (state.activeSessionId !== sessionId) return {}
        const monitor = state.tabs.find(
          (t) => t.sessionId === sessionId && t.kind === 'monitor'
        )
        return monitor ? { activeTabId: monitor.id } : { activeSessionId: null }
      }
      const firstRemoved = state.tabs.findIndex((t) => removableIds.has(t.id))
      const tabs = state.tabs.filter((t) => !removableIds.has(t.id))
      let activeTabId = state.activeTabId
      if (activeTabId === null || removableIds.has(activeTabId)) {
        // Prefer a tab of the same server (a kept monitor), then the neighbour
        // before the closed tab.
        const sameSession = tabs.find((t) => t.sessionId === sessionId)
        const before = [...state.tabs.slice(0, firstRemoved)]
          .reverse()
          .find((t) => !removableIds.has(t.id))
        activeTabId = sameSession?.id ?? before?.id ?? tabs[0]?.id ?? null
      }
      const nextActive = tabs.find((t) => t.id === activeTabId)
      const activeSessionId =
        nextActive?.sessionId ??
        (state.activeSessionId === sessionId ? null : state.activeSessionId)
      return { tabs, activeTabId, activeSessionId }
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
