import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { promises as fsp, readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentExitReason,
  AgentProfile,
  AgentSession,
  AgentWindowEntry,
  AgentWindowRecord,
  Session
} from '@shared/types'
import type { SessionStore } from '../store/SessionStore'
import type { SshManager } from '../ssh/SshManager'
import type { PtyManager } from '../pty/PtyManager'
import type { McpServer } from '../mcp/server'
import type { AuditStore } from '../audit/AuditStore'
import { captureSnapshot } from '../audit/snapshot'
import {
  agentFilesPath,
  ensureDir,
  quoteWinArg,
  sessionWorkspacePath,
  shellQuote,
  writeFileAtomic
} from '../util'

interface Runtime extends AgentSession {
  ptyId: string
  finalized: boolean
}

type Send = (channel: string, payload: unknown) => void

export class AgentManager {
  /** Keyed by agent window id; a server may hold any number of them. */
  private runtimes = new Map<string, Runtime>()
  private bySession = new Map<string, Set<string>>()
  /** Per-server, per-profile counters for default window names. */
  private nameSeq = new Map<string, number>()
  /** Every window ever launched, including ended ones, for resuming. */
  private records = new Map<string, AgentWindowRecord>()
  /**
   * Last terminal size each window asked for. A resize can arrive before the
   * PTY exists — the renderer mounts its terminal while the agent is still
   * `starting` — so the spawn uses this instead of a fixed default.
   */
  private sizes = new Map<string, { cols: number; rows: number }>()
  /**
   * First prompt of each transcript, keyed by file and invalidated by size and
   * mtime. Claude Code names a conversation after it first prompt; the panel
   * shows that instead of the generic "Claude Code #n".
   */
  private titleCache = new Map<string, { key: string; title?: string }>()

  constructor(
    private readonly store: SessionStore,
    private readonly ssh: SshManager,
    private readonly pty: PtyManager,
    private readonly mcp: McpServer,
    private readonly audit: AuditStore,
    private readonly send: Send
  ) {
    this.loadRecords()
  }

  private get recordsFile(): string {
    return join(app.getPath('userData'), 'agent-windows.json')
  }

  getRuntimeById(agentSessionId: string): AgentSession | undefined {
    const rt = this.runtimes.get(agentSessionId)
    return rt ? this.toPublic(rt) : undefined
  }

  list(sessionId: string): AgentSession[] {
    const ids = this.bySession.get(sessionId)
    if (!ids) return []
    return Array.from(ids)
      .map((id) => this.runtimes.get(id))
      .filter((rt): rt is Runtime => Boolean(rt))
      .map((rt) => this.toPublic(rt))
  }

  listAll(): AgentSession[] {
    return Array.from(this.runtimes.values()).map((rt) => this.toPublic(rt))
  }

  /**
   * Creates an agent window. Each window owns its SSH connection, MCP scope and
   * persistent shell so several can run in parallel on one host; the workspace
   * (and therefore the Claude Code project) is shared by the server's windows.
   */
  async launch(
    sessionId: string,
    profileId: string,
    name?: string,
    cols?: number,
    rows?: number
  ): Promise<AgentSession> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const profile = this.findProfile(profileId, true)
    return this.launchWindow(session, profile, name, undefined, sanitizeSize(cols, rows))
  }

  /**
   * Reopens an ended window in its original workspace. When the CLI still has a
   * conversation there it is told to continue it.
   */
  async resume(
    agentSessionId: string,
    cols?: number,
    rows?: number
  ): Promise<AgentSession> {
    const record = this.records.get(agentSessionId)
    if (!record) throw new Error('会话记录不存在')
    if (this.runtimes.has(agentSessionId)) throw new Error('该窗口仍在运行')
    const session = this.store.getSession(record.sessionId)
    if (!session) throw new Error('会话不存在')
    const profile = this.findProfile(record.profileId, true)
    return this.launchWindow(
      session,
      profile,
      record.name,
      record,
      sanitizeSize(cols, rows)
    )
  }

  /** Ended windows of one server, newest first. */
  async history(sessionId: string): Promise<AgentWindowEntry[]> {
    const ended = Array.from(this.records.values())
      .filter((record) => record.sessionId === sessionId && !this.runtimes.has(record.agentSessionId))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return Promise.all(
      ended.map(async (record) => ({
        ...record,
        resumable: await this.hasHistory(
          record.kind,
          record.workspace,
          record.agentSessionId,
          record.cliSessionId
        )
      }))
    )
  }

  /**
   * Conversation titles of the session's windows, keyed by agentSessionId.
   * Only windows that have already talked have one.
   */
  async titles(sessionId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const record of this.records.values()) {
      if (record.sessionId !== sessionId) continue
      if (record.kind !== 'claude' || !record.cliSessionId) continue
      const title = await this.readTitle(record.workspace, record.cliSessionId)
      if (title) out[record.agentSessionId] = title
    }
    return out
  }

  /**
   * Deletes a history entry. A window in the shared project only loses its own
   * files and its own Claude transcript; the project directory, its files and
   * the other windows' conversations stay.
   */
  async forget(agentSessionId: string): Promise<boolean> {
    if (this.runtimes.has(agentSessionId)) throw new Error('窗口仍在运行，请先停止')
    const record = this.records.get(agentSessionId)
    if (!record) return false
    this.records.delete(agentSessionId)
    this.sizes.delete(agentSessionId)
    this.saveRecords()

    const userData = app.getPath('userData')
    // Never delete outside the workspace root, even if the stored path is odd.
    const root = resolve(userData, 'workspaces')
    const target = resolve(record.workspace)
    const shared = resolve(sessionWorkspacePath(userData, record.sessionId))
    if (target === shared) {
      await fsp
        .rm(agentFilesPath(target, record.agentSessionId), { recursive: true, force: true })
        .catch(() => undefined)
    } else if (target.startsWith(`${root}${sep}`)) {
      // A window from before the shared project owned its whole directory.
      await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined)
    }

    if (record.kind === 'claude' && record.cliSessionId) {
      await this.forgetTranscript(record.workspace, record.cliSessionId)
    }
    return true
  }

  /** Removes only the transcript this window owns, never a sibling's. */
  private async forgetTranscript(workspace: string, cliSessionId: string): Promise<void> {
    // Guard against a malformed record turning into path traversal.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cliSessionId)) {
      return
    }
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const project = workspace.replace(/[^a-zA-Z0-9]/g, '-')
    await fsp
      .rm(join(configDir, 'projects', project, `${cliSessionId}.jsonl`), { force: true })
      .catch(() => undefined)
  }

  private findProfile(profileId: string, requireEnabled: boolean): AgentProfile {
    const profile = this.store.getSettings().agentProfiles.find((p) => p.id === profileId)
    if (!profile) throw new Error('Agent 配置不存在，请到设置中检查')
    if (requireEnabled && !profile.enabled) throw new Error('Agent 配置已停用，请到设置中启用')
    if (!profile.command.trim()) throw new Error('Agent 命令为空，请先在设置中配置')
    return profile
  }

  private async launchWindow(
    session: Session,
    profile: AgentProfile,
    name?: string,
    previous?: AgentWindowRecord,
    size?: { cols: number; rows: number }
  ): Promise<AgentSession> {
    const sessionId = session.id
    const agentSessionId = previous?.agentSessionId ?? randomUUID()
    const connId = `agent:${agentSessionId}`
    // New windows join the server's shared project directory; records created
    // before that change keep their own workspace, so «继续» still works.
    const workspace =
      previous?.workspace ?? sessionWorkspacePath(app.getPath('userData'), sessionId)
    await ensureDir(join(workspace, '.aishell'))
    if (size) this.sizes.set(agentSessionId, size)

    // Every window keeps its own Claude session id. The project directory is
    // shared, so `--continue` would resume whichever window talked last;
    // `--resume <id>` pins the conversation to this window. Records without an
    // id predate the shared workspace and stay on `--continue` (theirs is
    // isolated, so it is unambiguous there).
    const cliSessionId =
      profile.kind === 'claude' ? (previous ? previous.cliSessionId : randomUUID()) : undefined

    // Only continue when the CLI's own history for this window still exists;
    // resuming fails when there is nothing to resume.
    const resumeHistory = previous
      ? await this.hasHistory(previous.kind, workspace, agentSessionId, previous.cliSessionId)
      : false

    const runtime: Runtime = {
      agentSessionId,
      sessionId,
      connId,
      name: name?.trim() || previous?.name || this.nextName(sessionId, profile),
      profileId: profile.id,
      profileLabel: profile.label,
      status: 'starting',
      workspace,
      createdAt: Date.now(),
      ptyId: agentSessionId,
      finalized: false
    }

    const now = Date.now()
    const record: AgentWindowRecord = previous
      ? {
          ...previous,
          profileId: profile.id,
          profileLabel: profile.label,
          kind: profile.kind,
          name: runtime.name,
          workspace,
          lastActiveAt: now
        }
      : {
          agentSessionId,
          sessionId,
          profileId: profile.id,
          profileLabel: profile.label,
          kind: profile.kind,
          name: runtime.name,
          workspace,
          createdAt: now,
          lastActiveAt: now
        }
    delete record.endedAt
    delete record.endReason
    if (cliSessionId) record.cliSessionId = cliSessionId
    else delete record.cliSessionId
    this.records.set(agentSessionId, record)
    this.saveRecords()

    this.runtimes.set(agentSessionId, runtime)
    const siblings = this.bySession.get(sessionId) ?? new Set<string>()
    siblings.add(agentSessionId)
    this.bySession.set(sessionId, siblings)
    this.emitState(runtime)

    try {
      // The window's own transport. A dropped agent connection never takes a
      // terminal or another agent with it.
      await this.ssh.connect(connId, sessionId)
      if (runtime.finalized) throw new Error('启动已取消')

      const hostInfo = await this.ssh
        .gatherHostInfo(connId)
        .catch(() => this.ssh.getHostInfo(connId))
      const mcpUrl = this.mcp.getUrl(sessionId, agentSessionId, connId)
      const env: Record<string, string> = {
        ...baseAgentEnv(),
        AISHELL_MCP_URL: mcpUrl,
        AISHELL_MCP_TOKEN: this.mcp.token,
        AISHELL_SESSION_ID: sessionId,
        AISHELL_CONN_ID: connId,
        AISHELL_AGENT_SESSION_ID: agentSessionId,
        AISHELL_SESSION_HOST: `${session.username}@${session.host}:${session.port}`,
        AISHELL_WORKSPACE: workspace
      }

      await this.writeContext(
        session,
        profile,
        workspace,
        agentSessionId,
        mcpUrl,
        hostInfo,
        connId,
        runtime.name
      )
      if (runtime.finalized) throw new Error('启动已取消')

      let command: { file: string; args: string[] }
      if (profile.kind === 'claude') {
        command = await this.prepareClaude(
          agentSessionId,
          session,
          profile,
          workspace,
          mcpUrl,
          env,
          resumeHistory,
          cliSessionId
        )
      } else if (profile.kind === 'codex') {
        command = await this.prepareCodex(
          agentSessionId,
          session,
          profile,
          workspace,
          mcpUrl,
          env,
          resumeHistory
        )
      } else {
        command = await this.prepareCustom(
          agentSessionId,
          session,
          profile,
          workspace,
          env,
          Boolean(previous)
        )
      }
      if (runtime.finalized) throw new Error('启动已取消')

      // Spawn at the size the renderer already measured. A CLI that starts at
      // 120x32 inside a narrow panel draws a wide TUI and repaints it badly
      // when it is resized afterwards.
      const initialSize = this.sizes.get(agentSessionId) ?? { cols: 120, rows: 32 }
      this.pty.create(
        agentSessionId,
        {
          file: command.file,
          args: command.args,
          cwd: workspace,
          env,
          cols: initialSize.cols,
          rows: initialSize.rows
        },
        {
          onData: (data) => this.send('agent:data', { agentSessionId, data }),
          onExit: (code) => this.finalize(agentSessionId, code, 'exit')
        }
      )

      if (runtime.finalized) {
        this.pty.kill(agentSessionId)
        throw new Error('启动已取消')
      }

      runtime.status = 'running'
      this.emitState(runtime)
      this.recordAgent(runtime, 'launch', { command: profile.command, args: profile.args ?? [] })
      void captureSnapshot(this.ssh, this.store, this.audit, {
        sessionId,
        connId,
        trigger: 'agent_launch',
        agentSessionId,
        profileId: profile.id
      })
      return this.toPublic(runtime)
    } catch (err) {
      if (runtime.finalized) throw new Error('启动已取消')
      runtime.status = 'error'
      runtime.error = (err as Error).message
      this.emitState(runtime)
      this.recordAgent(runtime, 'error', { error: runtime.error })
      this.ssh.disconnect(connId)
      return this.toPublic(runtime)
    }
  }

  write(agentSessionId: string, data: string): void {
    this.pty.write(agentSessionId, data)
  }

  resize(agentSessionId: string, cols: number, rows: number): void {
    const size = sanitizeSize(cols, rows)
    if (size) this.sizes.set(agentSessionId, size)
    this.pty.resize(agentSessionId, cols, rows)
  }

  /**
   * Stops a window and removes it from state. The workspace stays on disk; the
   * renderer falls back to the agent picker when no window is left.
   */
  stop(agentSessionId: string): void {
    this.finalize(agentSessionId, 0, 'stopped')
  }

  /** Re-establishes the SSH connection after a network drop. */
  async reconnect(agentSessionId: string): Promise<AgentSession> {
    const rt = this.runtimes.get(agentSessionId)
    if (!rt) throw new Error('Agent 不存在或已停止')
    await this.ssh.connect(rt.connId, rt.sessionId)
    return this.toPublic(rt)
  }

  /** Stops every agent of a session. */
  stopForSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids) return
    for (const id of Array.from(ids)) this.stop(id)
  }

  disposeAll(): void {
    const endedAt = Date.now()
    for (const rt of this.runtimes.values()) {
      if (!rt.finalized && (rt.status === 'running' || rt.status === 'starting')) {
        this.recordAgent(rt, 'app_quit')
      }
      rt.finalized = true
      const record = this.records.get(rt.agentSessionId)
      if (record) {
        record.endedAt = endedAt
        record.endReason = 'app_quit'
        record.lastActiveAt = endedAt
      }
      this.ssh.disconnect(rt.connId)
    }
    this.saveRecords()
    this.pty.disposeAll()
    this.runtimes.clear()
    this.bySession.clear()
  }

  private finalize(agentSessionId: string, code: number, reason: AgentExitReason): void {
    const rt = this.runtimes.get(agentSessionId)
    if (!rt || rt.finalized) return
    rt.finalized = true
    if (rt.status === 'running' || rt.status === 'starting') {
      this.recordAgent(
        rt,
        reason === 'stopped' ? 'stop' : reason === 'app_quit' ? 'app_quit' : 'exit',
        { exitCode: code }
      )
    }
    const record = this.records.get(agentSessionId)
    if (record) {
      record.endedAt = Date.now()
      record.endReason = reason
      record.lastActiveAt = record.endedAt
      this.saveRecords()
    }
    this.pty.kill(agentSessionId)
    this.ssh.disconnect(rt.connId)
    this.runtimes.delete(agentSessionId)
    // The size outlives a stop so «继续» reopens at the same geometry; it is
    // dropped in forget(), together with the window record.
    const siblings = this.bySession.get(rt.sessionId)
    siblings?.delete(agentSessionId)
    if (siblings && siblings.size === 0) this.bySession.delete(rt.sessionId)
    this.send('agent:exit', { agentSessionId, code, reason })
  }

  /** First prompt of a window's transcript, cached until the file changes. */
  private async readTitle(workspace: string, cliSessionId: string): Promise<string | undefined> {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const project = workspace.replace(/[^a-zA-Z0-9]/g, '-')
    const file = join(configDir, 'projects', project, `${cliSessionId}.jsonl`)
    try {
      const stat = await fsp.stat(file)
      const key = `${stat.size}:${stat.mtimeMs}`
      const cached = this.titleCache.get(file)
      if (cached && cached.key === key) return cached.title
      const title = await firstPrompt(file)
      this.titleCache.set(file, { key, title })
      return title
    } catch {
      return undefined
    }
  }

  /** Whether the CLI has a conversation recorded for this window. */
  private async hasHistory(
    kind: AgentWindowRecord['kind'],
    workspace: string,
    agentSessionId: string,
    cliSessionId?: string
  ): Promise<boolean> {
    if (kind === 'claude') {
      const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
      // Claude Code names its project directory after the cwd, replacing every
      // non-alphanumeric character with a dash.
      const project = workspace.replace(/[^a-zA-Z0-9]/g, '-')
      const dir = join(configDir, 'projects', project)
      // With the project shared, a recorded id is the only way to tell whether
      // *this* window has a conversation; without one, any transcript will do.
      if (cliSessionId) return existsSync(join(dir, `${cliSessionId}.jsonl`))
      return hasJsonl(dir)
    }
    if (kind === 'codex') {
      if (await hasJsonl(join(agentFilesPath(workspace, agentSessionId), 'codex', 'sessions'))) {
        return true
      }
      // Windows created before the shared workspace kept Codex's home at the root.
      return hasJsonl(join(workspace, '.codex', 'sessions'))
    }
    // Custom agents keep their own history; the workspace is all we can reuse.
    return false
  }

  private loadRecords(): void {
    try {
      const raw = JSON.parse(readFileSync(this.recordsFile, 'utf8')) as {
        items?: AgentWindowRecord[]
      }
      for (const item of raw.items ?? []) {
        if (item?.agentSessionId && item?.sessionId) {
          this.records.set(item.agentSessionId, item)
        }
      }
    } catch {
      /* first run, or an unreadable history file */
    }
  }

  private saveRecords(): void {
    const items = Array.from(this.records.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt
    )
    // Bound the file; old workspaces stay on disk until deleted from the UI.
    while (items.length > MAX_WINDOW_RECORDS) {
      const dropped = items.pop()
      if (dropped) this.records.delete(dropped.agentSessionId)
    }
    void writeFileAtomic(
      this.recordsFile,
      `${JSON.stringify({ version: 1, items }, null, 2)}\n`
    ).catch((err) => {
      console.warn('[agent] failed to save window records', err)
    })
  }

  private nextName(sessionId: string, profile: AgentProfile): string {
    const key = `${sessionId}:${profile.id}`
    // Records survive restarts, so start above the highest suffix they already
    // use; otherwise every restart names the next window #1 again.
    let previous = 0
    for (const record of this.records.values()) {
      if (record.sessionId !== sessionId || record.profileId !== profile.id) continue
      const suffix = /#(\d+)\s*$/.exec(record.name)
      if (suffix) previous = Math.max(previous, Number(suffix[1]))
    }
    const ordinal = Math.max(this.nameSeq.get(key) ?? 0, previous) + 1
    this.nameSeq.set(key, ordinal)
    return `${profile.label} #${ordinal}`
  }

  private toPublic(runtime: Runtime): AgentSession {
    const { ptyId: _ptyId, finalized: _finalized, ...publicRuntime } = runtime
    return publicRuntime
  }

  private emitState(runtime: Runtime): void {
    this.send('agent:state', { runtime: this.toPublic(runtime) })
  }

  private recordAgent(runtime: Runtime, action: string, payload?: Record<string, unknown>): void {
    const session = this.store.getSession(runtime.sessionId)
    this.audit.recordNote({
      kind: 'agent',
      sessionId: runtime.sessionId,
      sessionName: session?.name,
      host: session ? `${session.host}:${session.port}` : undefined,
      agentSessionId: runtime.agentSessionId,
      profileId: runtime.profileId,
      action,
      payload: { ...payload, connId: runtime.connId }
    })
  }

  private async writeContext(
    session: Session,
    profile: AgentProfile,
    workspace: string,
    agentSessionId: string,
    mcpUrl: string,
    hostInfo: { os?: string; kernel?: string; home?: string; cwd?: string },
    connId: string,
    agentName: string
  ): Promise<void> {
    const host = `${session.username}@${session.host}:${session.port}`
    const content = `# AIShell 远程会话上下文

你正在协助用户操作一台**远程服务器**。所有远程操作必须通过 AIShell MCP 服务完成。

## 当前会话
- 会话名称：${session.name}
- 连接地址：${host}
- 会话 ID：${session.id}
- 操作系统：${hostInfo.os ?? '未知'}
- 内核：${hostInfo.kernel ?? '未知'}
- 远程家目录：${hostInfo.home ?? '未知'}
- 远程当前目录：${hostInfo.cwd ?? '未知'}

## 可用 MCP 工具
Claude Code 中工具名为 \`mcp__aishell__<tool>\`，其他客户端可能显示为 \`aishell.<tool>\`。

- \`exec\`：在远程执行一条命令，返回 stdout / stderr / 退出码；每次都是全新 shell，不保留 cd / export
- \`shell_open\` / \`shell_run\` / \`shell_read\` / \`shell_interrupt\` / \`shell_close\`：持久 shell，保留工作目录、环境变量和虚拟环境，适合连续操作、长任务和持续输出
- 查看文件请直接用 \`exec\`：\`ls -la\`、\`stat\`、\`head\` / \`cat\`、\`find\`、\`du -sh\`
- \`write_file\`：写入多行文本文件（默认先备份）；建目录、改权限、移动、删除等直接用 \`exec\`
- \`upload\` / \`download\`：本机与远程之间传输文件
- \`session_info\` / \`list_sessions\`：查看会话信息

## 行为规范
1. 远程操作一律使用上述 MCP 工具；不要在本机执行 ssh / scp / sftp。
2. 先读后写：修改或删除前先用 exec 确认（ls -la / stat / head）。
3. 危险操作（删除、覆盖、修改权限、重启服务）按你自己的安全策略判断是否需要确认；AIShell 不拦截任何命令，只做记录。
4. 命令使用绝对路径；优先使用 grep / head / tail / du -sh 等过滤大输出。
5. 单条独立的命令用 exec；需要先 cd / source / export 再接着操作，或运行编译、部署、tail -f 这类长任务时，先 shell_open 再 shell_run。shell_run 超时不会终止命令，用 shell_read 继续读取、shell_interrupt 中断；任务结束后 shell_close。
6. 持久 shell 没有可交互的终端：不要运行 vim、less、top 或需要输入密码的 sudo，改用非交互方式（cat / head、top -bn1、write_file）。
7. 不要读取或输出服务器上的凭据文件。
8. 用户使用中文时，用中文回答。

## 审计
你通过 AIShell 执行的每一次工具调用（含参数、退出码和输出摘要）都会在执行前写入本机审计日志，供事后复查。只有走 MCP 的操作才会被完整记录。

## 并发
这台服务器上可能同时运行多个 AIShell Agent 窗口。不要假设你对服务器有独占控制权；修改共享配置、重启服务或删除文件前先确认现状，避免和别的窗口互相覆盖。

## 工作区
本机当前目录（${workspace}）只是 Agent 的临时工作区，不代表远程服务器。
这台服务器的所有 Agent 窗口共用这个目录，也共用同一份 Claude Code 对话记录；不要把其他窗口正在使用的文件当作临时文件覆盖。
如果需要把本机文件送到远程，使用 upload；需要取回远程文件，使用 download。
`

    // CLAUDE.md / AGENTS.md describe the server and are shared; everything that
    // carries a per-window token, URL or name lives under the window's own dir.
    const filesDir = agentFilesPath(workspace, agentSessionId)
    await Promise.all([
      writeFileAtomic(join(workspace, 'CLAUDE.md'), content),
      writeFileAtomic(join(workspace, 'AGENTS.md'), content),
      writeFileAtomic(join(filesDir, 'session.json'), JSON.stringify({
        sessionId: session.id,
        connId,
        agentName,
        name: session.name,
        host: session.host,
        port: session.port,
        username: session.username,
        profile: profile.id,
        mcpUrl
      }, null, 2)),
      writeFileAtomic(
        join(filesDir, 'claude-mcp.json'),
        JSON.stringify(
          {
            mcpServers: {
              aishell: {
                type: 'http',
                url: mcpUrl,
                headers: { Authorization: `Bearer ${this.mcp.token}` }
              }
            }
          },
          null,
          2
        )
      ),
      writeFileAtomic(join(filesDir, 'README.md'), this.customReadme(session, mcpUrl))
    ])
  }

  private customReadme(session: Session, mcpUrl: string): string {
    return `# 接入 AIShell MCP

在自定义 Agent 中注册一个 Streamable HTTP MCP Server：

- URL: ${mcpUrl}
- Header: Authorization: Bearer \${AISHELL_MCP_TOKEN}

环境变量已自动注入：

- AISHELL_MCP_URL=${mcpUrl}
- AISHELL_MCP_TOKEN=***
- AISHELL_SESSION_ID=${session.id}
- AISHELL_SESSION_HOST=${session.username}@${session.host}:${session.port}

示例（Claude Code 风格配置）：

\`\`\`json
{
  "mcpServers": {
    "aishell": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer \${AISHELL_MCP_TOKEN}" }
    }
  }
}
\`\`\`
`
  }

  private async prepareClaude(
    agentSessionId: string,
    session: Session,
    profile: AgentProfile,
    workspace: string,
    _mcpUrl: string,
    _env: Record<string, string>,
    resume: boolean,
    cliSessionId?: string
  ): Promise<{ file: string; args: string[] }> {
    // Per-window config: the token and URL are scoped to this window, and
    // sibling windows share the directory.
    const configPath = join(agentFilesPath(workspace, agentSessionId), 'claude-mcp.json')
    const args = [...(profile.args ?? []), '--mcp-config', configPath]
    if (this.store.getSettings().claudeStrictMcp) args.push('--strict-mcp-config')
    // The user may have put their own resume/session flags in the profile args.
    const userArgs = profile.args ?? []
    const hasResumeFlag = userArgs.some(
      (arg) => ['--continue', '--resume', '-c', '-r'].includes(arg) || arg.startsWith('--resume=')
    )
    const hasSessionFlag = userArgs.some(
      (arg) => arg === '--session-id' || arg.startsWith('--session-id=')
    )
    if (!hasResumeFlag && !hasSessionFlag) {
      if (resume) {
        // Resume this window's own conversation rather than whatever the
        // shared project saw most recently.
        if (cliSessionId) args.push('--resume', cliSessionId)
        else args.push('--continue')
      } else if (cliSessionId) {
        // Assign the id up front so a later «继续» can address it exactly.
        args.push('--session-id', cliSessionId)
      }
    }
    await this.installBashAuditHook(workspace)
    return this.makeLauncher(agentSessionId, workspace, profile.command, args)
  }

  /**
   * Installs a Claude Code PreToolUse hook that reports local `ssh`/`scp`/`sftp`
   * commands to AIShell's audit log.
   *
   * Claude Code's permission rules only ever see the outer `ssh` token — the
   * remote payload stays an opaque argument. The hook receives the full
   * command string, which is exactly what the audit needs. It fails open, so a
   * stopped app or a broken script never blocks the agent.
   */
  private async installBashAuditHook(workspace: string): Promise<void> {
    const dir = join(workspace, '.aishell')
    await ensureDir(dir)
    const script = join(dir, 'hook-bash.mjs')
    await writeFileAtomic(script, BASH_AUDIT_HOOK)

    const hasNode = spawnSync('node', ['-v'], { stdio: 'ignore' }).status === 0

    if (process.platform === 'win32') {
      const launcher = join(dir, 'hook-bash.cmd')
      const run = hasNode
        ? `node ${quoteWinArg(script)}`
        : [
            'set "ELECTRON_RUN_AS_NODE=1"',
            `${quoteWinArg(process.execPath)} ${quoteWinArg(script)}`
          ].join('\r\n')
      await writeFileAtomic(launcher, ['@echo off', run, 'exit /b 0', ''].join('\r\n'))
      await this.writeHookSettings(workspace, launcher)
      return
    }

    const launcher = join(dir, 'hook-bash.sh')
    const run = hasNode
      ? `exec node ${shellQuote(script)}`
      : `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)}`
    await writeFileAtomic(launcher, ['#!/bin/sh', run, 'exit 0', ''].join('\n'))
    await fsp.chmod(launcher, 0o755)
    await this.writeHookSettings(workspace, shellQuote(launcher))
  }

  /** Merges our PreToolUse entry into the workspace's Claude settings. */
  private async writeHookSettings(workspace: string, launcher: string): Promise<void> {
    const file = join(workspace, '.claude', 'settings.json')
    let settings: Record<string, unknown> = {}
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          settings = raw as Record<string, unknown>
        }
      } catch {
        settings = {}
      }
    }

    const hooks =
      settings.hooks && typeof settings.hooks === 'object'
        ? (settings.hooks as Record<string, unknown>)
        : {}
    const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
    // Idempotent: drop our previous entry, keep any user-supplied ones.
    const kept = existing.filter(
      (entry) => !JSON.stringify(entry ?? '').includes('hook-bash')
    )
    const command = process.platform === 'win32' ? quoteWinArg(launcher) : launcher

    settings.hooks = {
      ...hooks,
      PreToolUse: [...kept, { matcher: 'Bash', hooks: [{ type: 'command', command }] }]
    }
    await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
  }

  private async prepareCodex(
    agentSessionId: string,
    _session: Session,
    profile: AgentProfile,
    workspace: string,
    mcpUrl: string,
    env: Record<string, string>,
    resume: boolean
  ): Promise<{ file: string; args: string[] }> {
    // Codex history is keyed by CODEX_HOME, not by cwd, so each window keeps its
    // own home even though they all share the project directory.
    const codexHome = join(agentFilesPath(workspace, agentSessionId), 'codex')
    await ensureDir(codexHome)

    const realHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    const realConfig = join(realHome, 'config.toml')
    let config = ''
    if (existsSync(realConfig)) {
      try {
        config = await fsp.readFile(realConfig, 'utf8')
      } catch {
        config = ''
      }
    }
    config = stripMcpSection(config, 'aishell')
    const mcpSection = `
[mcp_servers.aishell]
url = "${mcpUrl}"
bearer_token_env_var = "AISHELL_MCP_TOKEN"
`
    const finalConfig = `${config.trimEnd()}\n${mcpSection}`
    await writeFileAtomic(join(codexHome, 'config.toml'), finalConfig)

    const authFile = join(realHome, 'auth.json')
    if (existsSync(authFile)) {
      try {
        await fsp.copyFile(authFile, join(codexHome, 'auth.json'))
      } catch (err) {
        console.warn('[agent] failed to copy codex auth', err)
      }
    }

    // The user's config may point at files relative to CODEX_HOME (for example
    // model_catalog_json). Those must exist in the isolated home too, or Codex
    // exits with "Error loading configuration: ... (os error 2)".
    const catalog = config.match(/^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m)
    if (catalog && !isAbsolute(catalog[1])) {
      const source = join(realHome, catalog[1])
      if (existsSync(source)) {
        try {
          await fsp.mkdir(join(codexHome, dirname(catalog[1])), { recursive: true })
          await fsp.copyFile(source, join(codexHome, catalog[1]))
        } catch (err) {
          console.warn('[agent] failed to copy codex model catalog', err)
        }
      }
    }

    env.CODEX_HOME = codexHome
    const baseArgs = profile.args ?? []
    // `codex resume --last` reads the same CODEX_HOME, so history is local to
    // this window's workspace. User args (model, sandbox) still apply.
    const args =
      resume && !baseArgs.includes('resume') ? ['resume', '--last', ...baseArgs] : baseArgs
    return this.makeLauncher(agentSessionId, workspace, profile.command, args)
  }

  private async prepareCustom(
    agentSessionId: string,
    _session: Session,
    profile: AgentProfile,
    workspace: string,
    env: Record<string, string>,
    reopened: boolean
  ): Promise<{ file: string; args: string[] }> {
    // AIShell cannot know how a custom CLI resumes, so it only signals that the
    // window is being reopened in the same workspace.
    if (reopened) env.AISHELL_RESUME = '1'
    return this.makeLauncher(agentSessionId, workspace, profile.command, profile.args ?? [])
  }

  private async makeLauncher(
    agentSessionId: string,
    workspace: string,
    command: string,
    args: string[]
  ): Promise<{ file: string; args: string[] }> {
    const scriptDir = agentFilesPath(workspace, agentSessionId)
    await ensureDir(scriptDir)

    if (process.platform === 'win32') {
      const launcher = join(scriptDir, `launch-${agentSessionId}.cmd`)
      const line = [command, ...args].map(quoteWinArg).join(' ')
      const content = [
        '@echo off',
        'chcp 65001 >nul 2>nul',
        `cd /d ${quoteWinArg(workspace)}`,
        line,
        'exit /b %ERRORLEVEL%'
      ].join('\r\n')
      await writeFileAtomic(launcher, `${content}\r\n`)
      const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
      // The extra "call" token keeps cmd from stripping the quotes around a
      // launcher path that contains spaces.
      return { file: comspec, args: ['/d', '/s', '/c', 'call', launcher] }
    }

    const launcher = join(scriptDir, `launch-${agentSessionId}.sh`)
    const line = [command, ...args].map(shellQuote).join(' ')
    const content = ['#!/bin/sh', `cd ${shellQuote(workspace)}`, `exec ${line}`, ''].join('\n')
    await writeFileAtomic(launcher, content)
    await fsp.chmod(launcher, 0o755)
    return { file: '/bin/sh', args: [launcher] }
  }
}

/**
 * Written into each Claude workspace and wired up through
 * `.claude/settings.json`. Kept as source text so the exact bytes the agent
 * runs are visible in this file.
 */
const BASH_AUDIT_HOOK = String.raw`#!/usr/bin/env node
/**
 * AIShell PreToolUse hook.
 *
 * Reports local shell commands that reach a server outside AIShell's MCP
 * channel -- ssh, scp, sftp and friends -- to the audit log. Claude Code's own
 * permission rules only classify the outer "ssh" token; the remote payload is
 * an opaque argument. This hook receives the whole command string.
 *
 * Fails open: any error exits 0, and nothing is ever written to stdout
 * (Claude Code reads hook decisions from there).
 */
const TRANSPORT = /\b(ssh|scp|sftp|rsync|mosh|plink|pcp|pscp|telnet)\b/
const TIMEOUT_MS = 2000

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(''))
  })
}

async function main() {
  const url = process.env.AISHELL_MCP_URL
  const token = process.env.AISHELL_MCP_TOKEN
  const sessionId = process.env.AISHELL_SESSION_ID
  if (!url || !token || !sessionId) return

  const raw = await readStdin()
  if (!raw.trim()) return

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  if (!payload || payload.tool_name !== 'Bash') return

  const input = payload.tool_input || {}
  const command = String(input.command || '')
  const match = command.match(TRANSPORT)
  if (!match) return

  const base = new URL(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    await fetch('http://' + base.host + '/hook/bash', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token
      },
      body: JSON.stringify({
        sessionId: sessionId,
        connId: base.searchParams.get('conn') || undefined,
        agentSessionId: base.searchParams.get('agent') || undefined,
        command: command,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        transport: match[1],
        hookSessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined
      }),
      signal: controller.signal
    })
  } catch {
    // App not running or too slow: the command still proceeds.
  } finally {
    clearTimeout(timer)
  }
}

main().catch(() => undefined).finally(() => process.exit(0))
`

/** Keeps the history file bounded; removing a record is what frees a workspace. */
const MAX_WINDOW_RECORDS = 100

/**
 * Marker variables Claude Code sets when it starts another CLI. If AIShell was
 * itself launched from a Claude Code shell, these leak into the agent process,
 * which then treats itself as a nested session and stops saving transcripts --
 * which would make resuming a conversation impossible.
 */
const NESTED_CLAUDE_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION'
]

/** Terminal sizes cross process boundaries; keep only usable values. */
function sanitizeSize(
  cols?: number,
  rows?: number
): { cols: number; rows: number } | undefined {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined
  const c = Math.floor(cols as number)
  const r = Math.floor(rows as number)
  if (c < 2 || r < 2 || c > 1000 || r > 500) return undefined
  return { cols: c, rows: r }
}

function baseAgentEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) }
  for (const key of NESTED_CLAUDE_ENV) delete env[key]
  return env
}

async function hasJsonl(dir: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true })
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
  } catch {
    return false
  }
}

/** How much of a transcript to scan; the first prompt is always near the top. */
const TITLE_SCAN_BYTES = 128 * 1024
const TITLE_MAX_LENGTH = 60

/**
 * Claude Code titles a conversation with its first user prompt. The transcript
 * is JSONL, so read the head of the file and return the first usable message.
 */
async function firstPrompt(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    handle = await fsp.open(file, 'r')
    const buffer = Buffer.alloc(TITLE_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, TITLE_SCAN_BYTES, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    // The last line is incomplete when the scan stopped mid-file.
    if (bytesRead === TITLE_SCAN_BYTES) lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: {
        type?: string
        isMeta?: boolean
        isSidechain?: boolean
        message?: { content?: unknown }
      }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) continue
      const title = normalizeTitle(entry.message?.content)
      if (title) return title
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Text of a user message, skipping injected context and tool results. */
function normalizeTitle(content: unknown): string | undefined {
  let raw = ''
  if (typeof content === 'string') {
    raw = content
  } else if (Array.isArray(content)) {
    raw = content
      .map((part) => {
        const block = part as { type?: string; text?: unknown }
        return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .filter(Boolean)
      .join(' ')
  }
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  // Slash commands, injected <system> context and meta notes are not titles.
  if (text.startsWith('<') || text.startsWith('/') || text.startsWith('Caveat:')) return undefined
  return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH)}…` : text
}

/** Remove an existing [mcp_servers.<name>] table from a TOML document. */
function stripMcpSection(toml: string, name: string): string {
  const lines = toml.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  const header = `[mcp_servers.${name}]`
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === header) {
      skipping = true
      continue
    }
    if (skipping) {
      if (trimmed.startsWith('[') && !trimmed.startsWith(`[mcp_servers.${name}.`)) {
        skipping = false
      } else {
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}
