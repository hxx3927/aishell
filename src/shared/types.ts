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

/**
 * One agent window. Agents are independent of terminal tabs: each window owns
 * its SSH connection (`agent:<agentSessionId>`), MCP scope and persistent
 * shell. The local workspace is shared by every window of the server session.
 */
export interface AgentSession {
  agentSessionId: string
  sessionId: string
  /** Connection instance owned by this agent window. */
  connId: string
  /** Display name, defaults to "<profile> #n" per server. */
  name: string
  profileId: string
  profileLabel: string
  status: 'starting' | 'running' | 'stopped' | 'error'
  error?: string
  workspace: string
  createdAt: number
}

/**
 * A launched agent window kept on disk after it ends. Reopening a record reuses
 * its workspace and its own CLI session; the workspace is shared with the
 * server's other windows, so the conversation is identified by `cliSessionId`.
 */
export interface AgentWindowRecord {
  agentSessionId: string
  sessionId: string
  profileId: string
  profileLabel: string
  kind: AgentKind
  name: string
  /**
   * Shared project directory of the server session. Every window of the same
   * server runs here, which is what makes Claude Code treat them as one
   * project; per-window files live under `.aishell/agents/<agentSessionId>/`.
   */
  workspace: string
  /**
   * Claude Code session id owned by this window. Windows of a server share one
   * project, so «继续» must resume by id; `--continue` would pick whichever
   * window talked last. Absent on windows created before this existed.
   */
  cliSessionId?: string
  createdAt: number
  /** Last launch or exit; orders the history list. */
  lastActiveAt: number
  endedAt?: number
  endReason?: AgentExitReason
}

/** History row: a record plus whether the CLI has a conversation to resume. */
export interface AgentWindowEntry extends AgentWindowRecord {
  resumable: boolean
}

/** @deprecated Use AgentSession. */
export type AgentRuntime = AgentSession

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
  /** Connection instance the call ran on. */
  connId?: string
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
  connId: string
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
  /** Agent windows that survive a renderer reload. */
  agents: AgentSession[]
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
  runtime: AgentSession
}

export interface AgentDataEvent {
  agentSessionId: string
  data: string
}

export type AgentExitReason = 'exit' | 'stopped' | 'app_quit'

export interface AgentExitEvent {
  agentSessionId: string
  code: number
  /** Why the agent went away; user-initiated stops stay quiet in the UI. */
  reason?: AgentExitReason
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
