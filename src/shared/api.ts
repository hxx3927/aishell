import type {
  ActivityEvent,
  AgentSession,
  AppState,
  ConnectionStatus,
  FileContent,
  HostInfo,
  KnownHost,
  LocalEntry,
  McpInfo,
  MonitorEvent,
  MonitorSample,
  MonitorStartResult,
  Session,
  SessionInput,
  Settings,
  SftpEntry,
  TransferProgress,
  TransferResult,
  AgentDataEvent,
  AgentProbeResult,
  AgentExitEvent,
  AgentStateEvent,
  AgentShellStateEvent,
  AgentWindowEntry,
  AuditInfo,
  AuditQuery,
  AuditQueryResult,
  NoticeEvent,
  SshStateEvent,
  ThemeMode,
  TermDataEvent,
  TermExitEvent
} from './types'

export interface GroupMutationResult {
  sessions: Session[]
  groups: string[]
}

export interface ThemeChangedEvent {
  resolved: ThemeMode
}

export interface EventMap {
  'ssh:state': SshStateEvent
  'term:data': TermDataEvent
  'term:exit': TermExitEvent
  'agent:state': AgentStateEvent
  'agent:data': AgentDataEvent
  'agent:exit': AgentExitEvent
  'agent:shell': AgentShellStateEvent
  'activity:event': ActivityEvent
  'sftp:transfer': TransferProgress
  'app:notice': NoticeEvent
  'monitor:sample': MonitorEvent
  /** Emitted when `theme: system` and the OS preference flips. */
  'theme:changed': ThemeChangedEvent
}

export type EventChannel = keyof EventMap

export interface AishellApi {
  getState(): Promise<AppState>

  sessions: {
    save(input: SessionInput): Promise<Session>
    remove(sessionId: string): Promise<boolean>
  }

  groups: {
    create(name: string): Promise<string[]>
    rename(from: string, to: string): Promise<GroupMutationResult>
    remove(name: string): Promise<GroupMutationResult>
  }

  ssh: {
    /** `connId` identifies the terminal instance; several may share a session. */
    connect(connId: string, sessionId: string): Promise<boolean>
    /** Disconnects every instance of the session. */
    disconnect(sessionId: string): Promise<boolean>
    disconnectConn(connId: string): Promise<boolean>
    ping(sessionId: string): Promise<number>
    info(
      sessionId: string
    ): Promise<{ session: Session; status: ConnectionStatus; hostInfo: HostInfo }>
  }

  term: {
    open(connId: string, cols: number, rows: number, fresh?: boolean): Promise<void>
    input(connId: string, data: string): Promise<boolean>
    resize(connId: string, cols: number, rows: number): Promise<boolean>
    close(connId: string): Promise<boolean>
  }

  sftp: {
    list(sessionId: string, path: string): Promise<SftpEntry[]>
    realpath(sessionId: string, path: string): Promise<string>
    home(sessionId: string): Promise<string>
    readFile(sessionId: string, path: string): Promise<FileContent>
    writeFile(sessionId: string, path: string, content: string): Promise<void>
    createFile(sessionId: string, path: string): Promise<void>
    mkdir(sessionId: string, path: string): Promise<void>
    rename(sessionId: string, from: string, to: string): Promise<void>
    remove(sessionId: string, path: string, recursive: boolean): Promise<void>
    chmod(sessionId: string, path: string, mode: number): Promise<void>
    upload(sessionId: string, localPath: string, remotePath: string): Promise<void>
    download(sessionId: string, remotePath: string, localPath: string): Promise<TransferResult>
    /** Stops a running download; returns false when it already finished. */
    cancelTransfer(transferId: string): Promise<boolean>
  }

  local: {
    home(): Promise<string>
    roots(): Promise<Array<{ label: string; path: string }>>
    list(path: string, showHidden: boolean): Promise<LocalEntry[]>
    mkdir(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    remove(path: string, recursive: boolean): Promise<void>
    reveal(path: string): Promise<void>
    copy(from: string, to: string): Promise<void>
  }

  agent: {
    /** Looks the CLI up on PATH and reads its version (60s cache in main). */
    probe(command: string): Promise<AgentProbeResult>
    /**
     * Creates an agent window with its own SSH connection and MCP scope. All
     * windows of a server share the local workspace (and Claude Code project).
     * `cols`/`rows` are the renderer's terminal size so the CLI starts with the
     * right geometry instead of a 120x32 default.
     */
    launch(
      sessionId: string,
      profileId: string,
      name?: string,
      cols?: number,
      rows?: number
    ): Promise<AgentSession>
    /** Reopens an ended window in its workspace, continuing its own CLI chat. */
    resume(agentSessionId: string, cols?: number, rows?: number): Promise<AgentSession>
    /** Ended windows of a server, newest first. */
    history(sessionId: string): Promise<AgentWindowEntry[]>
    /**
     * Conversation titles of the session's windows, keyed by agentSessionId.
     * Claude Code titles a conversation with its first prompt; windows that
     * never talked have no entry.
     */
    titles(sessionId: string): Promise<Record<string, string>>
    /**
     * Deletes a history entry, its per-window files and its own CLI transcript.
     * A shared workspace and the other windows of the server are left alone.
     */
    forget(agentSessionId: string): Promise<boolean>
    list(sessionId: string): Promise<AgentSession[]>
    stop(agentSessionId: string): Promise<boolean>
    /** Re-establishes the agent's SSH connection after a drop. */
    reconnect(agentSessionId: string): Promise<AgentSession>
    input(agentSessionId: string, data: string): Promise<boolean>
    resize(agentSessionId: string, cols: number, rows: number): Promise<boolean>
  }

  monitor: {
    /** Starts (or reconnects) the session's dedicated sampling connection. */
    start(sessionId: string, intervalMs?: number): Promise<MonitorStartResult>
    stop(sessionId: string): Promise<void>
    /** Stops every poller, used after a renderer reload. */
    stopAll(): Promise<void>
    pause(sessionId: string, paused: boolean): Promise<void>
    sampleNow(sessionId: string): Promise<MonitorSample>
  }

  activity: {
    list(sessionId?: string): Promise<ActivityEvent[]>
  }

  agentShell: {
    close(connId: string): Promise<boolean>
  }

  audit: {
    query(query: AuditQuery): Promise<AuditQueryResult>
    info(): Promise<AuditInfo>
    openDir(): Promise<boolean>
    export(
      query: AuditQuery,
      format: 'jsonl' | 'csv'
    ): Promise<{ path: string; count: number } | null>
    /** Today's date (YYYY-MM-DD) in the main process's local time. */
    today(): Promise<string>
  }

  settings: {
    save(patch: Partial<Settings>): Promise<Settings>
  }

  hosts: {
    remove(key: string): Promise<void>
  }

  dialog: {
    pickKey(): Promise<string | null>
    pickDirectory(): Promise<string | null>
  }

  mcp: {
    info(): Promise<McpInfo>
  }

  shell: {
    openExternal(url: string): Promise<boolean>
    /** Opens the AIShell user-data folder in the OS file manager. */
    openDataDir(): Promise<string | null>
    /** Copies version and environment details for bug reports. */
    copyDiagnostics(): Promise<boolean>
  }

  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }

  on<K extends EventChannel>(channel: K, callback: (payload: EventMap[K]) => void): () => void
}

export type { KnownHost }
