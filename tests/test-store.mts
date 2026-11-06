/**
 * Renderer store reducers: tab lifecycle, connection bookkeeping, monitor
 * event folding and agent-window bookkeeping. Only the pure-ish actions are
 * exercised; the ones that call `window.aishell` (connecting, starting a
 * monitor) are covered by the app itself.
 *
 *   npx esbuild tests/test-store.mts --bundle --platform=node \
 *     --format=cjs --tsconfig=tsconfig.tests.json \
 *     --outfile=tests/.tmp-store.cjs
 *   node tests/.tmp-store.cjs
 */
import { useAppStore } from '../src/renderer/src/state/store'
import type {
  ActivityEvent,
  AgentSession,
  MonitorEvent,
  MonitorSample,
  Session,
  TransferProgress
} from '@shared/types'

const results: Array<[string, boolean, unknown]> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push([name, ok, detail])
}

// ------------------------------------------------------------ browser stubs
const saved = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => {
    saved.set(key, String(value))
  },
  removeItem: (key: string) => {
    saved.delete(key)
  }
}
// Actions that reach the preload bridge need a `window`; keep it undefined here
// so a test that accidentally calls one fails loudly instead of silently.
;(globalThis as Record<string, unknown>).window = globalThis

const state = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()

const reset = (): void => {
  saved.clear()
  useAppStore.setState({
    tabs: [],
    activeTabId: null,
    activeSessionId: null,
    connections: {},
    monitors: {},
    agentSessions: {},
    agentOrder: [],
    activeAgentId: {},
    agentShells: {},
    activities: [],
    transfers: {}
  })
}

const session = (id: string, name = id): Session => ({
  id,
  name,
  group: '默认',
  host: '10.0.0.1',
  port: 22,
  username: 'demo',
  auth: { type: 'password' },
  createdAt: 0
})

const sample = (ts: number, sessionId = 's1'): MonitorSample => ({
  sessionId,
  ts,
  cpuPct: 0,
  perCorePct: [],
  load: [0, 0, 0],
  cores: 1,
  processCount: 0,
  uptimeSec: 0,
  memTotalBytes: 0,
  memUsedBytes: 0,
  memAvailableBytes: 0,
  memCachedBytes: 0,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  disks: [],
  net: [],
  diskIo: []
})

const agent = (
  agentSessionId: string,
  overrides: Partial<AgentSession> = {}
): AgentSession => ({
  agentSessionId,
  sessionId: 's1',
  connId: `agent:${agentSessionId}`,
  name: 'Claude Code #1',
  profileId: 'claude',
  profileLabel: 'Claude Code',
  status: 'running',
  workspace: '/tmp/ws',
  createdAt: 0,
  ...overrides
})

// -------------------------------------------------------------------- tabs

reset()
state().openPickerTab()
check(
  'picker: opens an unnamed tab and focuses it',
  state().tabs.length === 1 &&
    state().tabs[0].kind === 'picker' &&
    state().activeTabId === 'tab-picker' &&
    state().activeSessionId === null,
  state().tabs
)
state().openPickerTab()
check('picker: reopening keeps a single picker tab', state().tabs.length === 1, state().tabs)

const firstConn = state().pickSessionForTab('tab-picker', session('s1', 'web'))
check(
  'picker: picking a server replaces the picker',
  firstConn === 's1' &&
    state().tabs.length === 1 &&
    state().tabs[0].id === 'term-s1' &&
    state().tabs[0].kind === 'terminal' &&
    state().tabs[0].title === 'web' &&
    state().activeTabId === 'term-s1',
  state().tabs
)

state().openPickerTab()
const secondConn = state().pickSessionForTab('tab-picker', session('s1', 'web'))
check(
  'picker: a second window gets its own connection id',
  secondConn.startsWith('s1#') && state().tabs.length === 2,
  { secondConn, tabs: state().tabs }
)
check(
  'picker: the new window becomes active',
  state().activeTabId === `term-${secondConn}` && state().activeSessionId === 's1',
  state().activeTabId
)

reset()
state().openSessionTab(session('s1', 'web'))
const reused = state().openSessionTab(session('s1', 'web'))
check(
  'terminal: reopening a session focuses the existing tab',
  reused === 's1' && state().tabs.length === 1,
  { reused, tabs: state().tabs }
)

reset()
state().openFileTab('s1', '/var/log/app.log')
check(
  'file: tab title defaults to the basename',
  state().tabs.length === 1 &&
    state().tabs[0].id === 'file-s1-/var/log/app.log' &&
    state().tabs[0].title === 'app.log',
  state().tabs
)
state().updateTab(state().tabs[0].id, { dirty: true })
state().openFileTab('s1', '/var/log/app.log')
check(
  'file: reopening activates without duplicating, edits survive',
  state().tabs.length === 1 && state().tabs[0].dirty === true,
  state().tabs
)

reset()
useAppStore.setState({
  tabs: [
    { id: 'term-s1', kind: 'terminal', sessionId: 's1', title: 'a' },
    { id: 'file-s1-x', kind: 'file', sessionId: 's1', title: 'x' },
    { id: 'term-s2', kind: 'terminal', sessionId: 's2', title: 'b' }
  ],
  activeTabId: 'term-s1',
  activeSessionId: 's1'
})
state().removeSessionTabs('s1')
check(
  'tabs: closing a session drops only its tabs',
  state().tabs.map((t) => t.id).join(',') === 'term-s2' &&
    state().activeTabId === 'term-s2' &&
    state().activeSessionId === 's2',
  { tabs: state().tabs, activeTabId: state().activeTabId, activeSessionId: state().activeSessionId }
)

reset()
useAppStore.setState({
  tabs: [
    { id: 'term-s1', kind: 'terminal', sessionId: 's1', title: 'a' },
    { id: 'monitor-s1', kind: 'monitor', sessionId: 's1', title: 'm' }
  ],
  activeTabId: 'term-s1',
  activeSessionId: 's1'
})
state().removeSessionTabs('s1', { keepMonitor: true })
check(
  'tabs: an explicit disconnect keeps the monitor tab focused',
  state().tabs.length === 1 &&
    state().tabs[0].id === 'monitor-s1' &&
    state().activeTabId === 'monitor-s1',
  { tabs: state().tabs, activeTabId: state().activeTabId }
)

reset()
state().openMonitorTab(session('s1', 'web'))
state().openMonitorTab(session('s1', 'web'))
check(
  'monitor: opening twice focuses the existing tab',
  state().tabs.length === 1 &&
    state().tabs[0].id === 'monitor-s1' &&
    state().activeTabId === 'monitor-s1',
  state().tabs
)

reset()
state().setActiveTab('nope')
check('tabs: focusing an unknown tab clears the session', state().activeSessionId === null)

// ------------------------------------------------------------- connections

reset()
state().setConnection('c1', 's1', { status: 'connected' })
state().setLatency('c1', 42)
state().setConnection('c1', 's1', { status: 'error', error: 'boom' })
check(
  'connection: patches merge instead of replacing',
  state().connections.c1.status === 'error' &&
    state().connections.c1.error === 'boom' &&
    state().connections.c1.latency === 42,
  state().connections.c1
)
state().setLatency('missing', 10)
check('connection: latency for an unknown id is ignored', !state().connections.missing)
useAppStore.setState({ connections: {} })
state().setConnection('c2', 's1', {})
check(
  'connection: a new entry starts disconnected',
  state().connections.c2.status === 'disconnected',
  state().connections.c2
)

// ---------------------------------------------------------------- monitors

reset()
state().applyMonitorEvent({ sessionId: 's1', sampling: true, paused: false, sample: sample(1000) })
check(
  'monitor: first sample creates sampling state with the default interval',
  state().monitors.s1.status === 'sampling' &&
    state().monitors.s1.samples.length === 1 &&
    state().monitors.s1.intervalMs === 2000,
  state().monitors.s1
)
state().applyMonitorEvent({ sessionId: 's1', sampling: true, paused: false, sample: sample(1000) })
check(
  'monitor: a repeated timestamp is not appended twice',
  state().monitors.s1.samples.length === 1,
  state().monitors.s1.samples
)

const host = {
  hostname: 'web',
  cores: 8,
  totalMemBytes: 1024,
  interfaces: ['eth0']
}
state().applyMonitorEvent({ sessionId: 's1', sampling: true, paused: false, host, sample: sample(2000) })
state().applyMonitorEvent({ sessionId: 's1', sampling: true, paused: false, sample: sample(3000) })
check(
  'monitor: host facts survive samples that omit them',
  state().monitors.s1.host?.hostname === 'web' && state().monitors.s1.samples.length === 3,
  state().monitors.s1.host
)

state().applyMonitorEvent({
  sessionId: 's1',
  sampling: true,
  paused: true,
  host,
  sample: sample(4000)
})
check(
  'monitor: a paused event updates the status',
  state().monitors.s1.status === 'paused' && state().monitors.s1.samples.length === 4,
  state().monitors.s1.status
)

state().applyMonitorEvent({
  sessionId: 's1',
  sampling: true,
  paused: false,
  error: 'ssh down'
})
check(
  'monitor: an error event keeps the history and records the message',
  state().monitors.s1.status === 'error' &&
    state().monitors.s1.lastError === 'ssh down' &&
    state().monitors.s1.samples.length === 4,
  state().monitors.s1
)

reset()
for (let index = 0; index < 455; index++) {
  state().applyMonitorEvent({
    sessionId: 's1',
    sampling: true,
    paused: false,
    sample: sample(index)
  })
}
const capped = state().monitors.s1.samples
check(
  'monitor: history is capped, keeping the newest samples',
  capped.length === 450 && capped[0].ts === 5 && capped.at(-1)?.ts === 454,
  { length: capped.length, first: capped[0].ts, last: capped.at(-1)?.ts }
)

state().applyMonitorEvent({ sessionId: 's1', sampling: false, paused: false })
check('monitor: sampling=false drops the entry', !state().monitors.s1)
state().applyMonitorEvent({ sessionId: 's2', sampling: false, paused: false })
check('monitor: stop for an unknown session creates nothing', !state().monitors.s2)

saved.set('aishell.monitorIntervalMs', '5000')
state().applyMonitorEvent({ sessionId: 's3', sampling: true, paused: false })
check(
  'monitor: the saved interval is used for a new entry',
  state().monitors.s3.intervalMs === 5000,
  state().monitors.s3.intervalMs
)

// ------------------------------------------------------------------ agents

reset()
state().applyAgentState(agent('a1', { status: 'starting' }))
check(
  'agent: a starting window is appended and focused',
  state().agentOrder.join(',') === 'a1' && state().activeAgentId.s1 === 'a1',
  state().activeAgentId
)
state().applyAgentState(agent('a2'))
check(
  'agent: a running window does not steal the focus',
  state().agentOrder.join(',') === 'a1,a2' && state().activeAgentId.s1 === 'a1',
  state().activeAgentId
)
state().setActiveAgent('s1', 'a2')
state().applyAgentState(agent('a2', { status: 'stopped' }))
check(
  'agent: updating an existing window keeps the list and the pick',
  state().agentOrder.join(',') === 'a1,a2' &&
    state().agentSessions.a2.status === 'stopped' &&
    state().activeAgentId.s1 === 'a2',
  { order: state().agentOrder, active: state().activeAgentId }
)

reset()
state().applyAgentState(agent('a1'))
state().applyAgentState(agent('a2'))
state().setActiveAgent('s1', 'a1')
state().setAgentShell('agent:a1', true)
useAppStore.setState({
  connections: {
    'agent:a1': { sessionId: 's1', status: 'connected' },
    'agent:a2': { sessionId: 's1', status: 'connected' }
  },
  activeSessionId: 's1',
  tabs: [{ id: 'term-s1', kind: 'terminal', sessionId: 's1', title: 'a' }]
})
state().removeAgentSession('a1')
check(
  'agent: removing the focused window hands over to its sibling',
  !state().agentSessions.a1 &&
    state().agentOrder.join(',') === 'a2' &&
    state().activeAgentId.s1 === 'a2',
  { sessions: Object.keys(state().agentSessions), active: state().activeAgentId }
)
check(
  'agent: its shell flag and connection go with it',
  !state().agentShells['agent:a1'] && !state().connections['agent:a1']
)

state().removeAgentSession('a2')
check(
  'agent: the last window of a server keeps the terminal panel context',
  state().activeAgentId.s1 === null && state().activeSessionId === 's1',
  { active: state().activeAgentId, session: state().activeSessionId }
)

// ------------------------------------------------------- activity/transfer

reset()
const activity = (id: string, status: ActivityEvent['status']): ActivityEvent => ({
  id,
  sessionId: 's1',
  tool: 'shell_run',
  args: {},
  status,
  startedAt: 0
})
state().applyActivity(activity('e1', 'running'))
state().applyActivity(activity('e2', 'running'))
check('activity: new ids are prepended', state().activities.map((e) => e.id).join(',') === 'e2,e1')
state().applyActivity(activity('e1', 'success'))
check(
  'activity: an existing id is updated in place',
  state().activities.map((e) => e.id).join(',') === 'e2,e1' &&
    state().activities[1].status === 'success',
  state().activities
)

reset()
const transfer: TransferProgress = {
  id: 't1',
  sessionId: 's1',
  direction: 'upload',
  name: 'a.txt',
  transferred: 5,
  total: 10,
  done: false
}
state().applyTransfer(transfer)
check('transfer: upserted by id', state().transfers.t1.transferred === 5)
state().removeTransfer('t1')
check('transfer: removed by id', !state().transfers.t1)

reset()
state().setAgentShell('c1', true)
check('agent shell: opens', state().agentShells.c1 === true)
state().setAgentShell('c1', false)
check('agent shell: closes', !state().agentShells.c1)

let failed = 0
for (const [name, pass, detail] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) {
    failed += 1
    console.log('      ', JSON.stringify(detail))
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
