export type AuthType = 'password' | 'key' | 'agent'

export interface SessionAuth {
  type: AuthType
  privateKeyPath?: string
}

export interface Session {
  id: string
  name: string
  group: string
  host: string
  port: number
  username: string
  auth: SessionAuth
  color?: string
  tags?: string[]
  createdAt: number
  lastUsedAt?: number
}

export interface SessionInput extends Session {
  password?: string
  passphrase?: string
}

export type AgentKind = 'claude' | 'codex' | 'custom'

export interface AgentProfile {
  id: string
  label: string
  command: string
  args?: string[]
  kind: AgentKind
  enabled: boolean
}

export type ThemeMode = 'dark' | 'light'

export interface Settings {
  fontSize: number
  fontFamily: string
  theme: ThemeMode
  /** Known connection groups, including groups that currently hold no sessions. */
  groups?: string[]
  agentProfiles: AgentProfile[]
  localStartPath?: string
  claudeStrictMcp?: boolean
  showHiddenFiles?: boolean
  /** Days to keep audit logs; 0 keeps them forever. */
  auditRetentionDays?: number
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface HostInfo {
  os?: string
  kernel?: string
  home?: string
  cwd?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  truncated?: boolean
}

export interface SftpEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
  mode: number
  permissions: string
}

export interface LocalEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
}

export interface FileContent {
  content: string
  size: number
  binary: boolean
}

export interface TransferProgress {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  transferred: number
  total: number
  done: boolean
  error?: string
}

export interface AgentRuntime {
  agentSessionId: string
  sessionId: string
  profileId: string
  profileLabel: string
  status: 'starting' | 'running' | 'stopped' | 'error'
  error?: string
  workspace: string
}

export type ActivityStatus = 'running' | 'success' | 'error' | 'pending' | 'denied'

export interface ActivityEvent {
  id: string
  sessionId: string
  agentSessionId?: string
  profileId?: string
  tool: string
  args: Record<string, unknown>
  status: ActivityStatus
  startedAt: number
  endedAt?: number
  summary?: string
  error?: string
}

export type AuditStatus = 'success' | 'error' | 'denied' | 'running' | 'unfinished'


/** One tool call reassembled from its intent / decision / result records. */
export interface AuditCall {
  kind: 'call'
  id: string
  ts: number
  sessionId: string
  sessionName: string
  host: string
  username: string
  agentSessionId?: string
  profileId?: string
  tool: string
  args: Record<string, unknown>
  /** The call targeted a session other than the one the agent is bound to. */
  crossSession?: boolean
  dangerous: boolean
  status: AuditStatus
  /** Legacy: approval decisions in logs written before AIShell became record-only. */
  decision?: string
  endedAt?: number
  durationMs?: number
  exitCode?: number | null
  summary?: string
  error?: string
  output?: Record<string, unknown>
}

/** Snapshots, agent lifecycle, shell lifecycle and local-shell records. */
export interface AuditNote {
  kind: 'snapshot' | 'agent' | 'shell' | 'bash'
  id: string
  ts: number
  sessionId: string
  sessionName?: string
  host?: string
  agentSessionId?: string
  profileId?: string
  action?: string
  reason?: string
  /** Audit id of the tool call this note belongs to. */
  relatedId?: string
  payload?: Record<string, unknown>
}

export type AuditEntry = AuditCall | AuditNote

export interface AuditQuery {
  /** Inclusive local dates, YYYY-MM-DD. */
  from: string
  to: string
  sessionId?: string
  status?: AuditStatus
  text?: string
  limit?: number
}

export interface AuditQueryResult {
  entries: AuditEntry[]
  /** True when more entries matched than `limit`. */
  hasMore: boolean
}

export interface AuditInfo {
  dir: string
  totalBytes: number
  fileCount: number
  retentionDays: number
  oversize: boolean
}

export interface AgentShellStateEvent {
  sessionId: string
  open: boolean
  reason?: string
}

export interface KnownHost {
  key: string
  fingerprint: string
  addedAt: number
}

export interface AppState {
  sessions: Session[]
  settings: Settings
  knownHosts: KnownHost[]
  mcpPort: number | null
  platform: string
  versions: { app: string; electron: string; node: string }
  userDataPath: string
  encryptionAvailable: boolean
  /** Sessions that currently hold an agent shell. */
  agentShells: string[]
}

export interface SshStateEvent {
  /** Connection instance the event belongs to. */
  connId: string
  sessionId: string
  status: ConnectionStatus
  error?: string
  hostInfo?: HostInfo
}

export interface TermDataEvent {
  connId: string
  sessionId: string
  data: string
}

export type TermExitReason = 'exit' | 'dropped' | 'disconnected'

export interface TermExitEvent {
  connId: string
  sessionId: string
  code?: number
  signal?: string
  reason?: TermExitReason
}

export interface AgentStateEvent {
  runtime: AgentRuntime
}

export interface AgentDataEvent {
  agentSessionId: string
  data: string
}

export interface AgentExitEvent {
  agentSessionId: string
  code: number
}

export interface NoticeEvent {
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface McpInfo {
  port: number | null
  running: boolean
}

export type SaveSessionResult = Session

export interface OpenTabRequest {
  sessionId: string
  kind: 'terminal' | 'file'
  path?: string
  title?: string
}

export interface SftpTransferRequest {
  sessionId: string
  localPath: string
  remotePath: string
}
