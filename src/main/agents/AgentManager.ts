import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentProfile, AgentRuntime, Session } from '@shared/types'
import type { SessionStore } from '../store/SessionStore'
import type { SshManager } from '../ssh/SshManager'
import type { PtyManager } from '../pty/PtyManager'
import type { McpServer } from '../mcp/server'
import type { AuditStore } from '../audit/AuditStore'
import { captureSnapshot } from '../audit/snapshot'
import { ensureDir, quoteWinArg, shellQuote, writeFileAtomic } from '../util'

interface Runtime extends AgentRuntime {
  ptyId: string
}

type Send = (channel: string, payload: unknown) => void

export class AgentManager {
  private runtimes = new Map<string, Runtime>()
  private bySession = new Map<string, string>()

  constructor(
    private readonly store: SessionStore,
    private readonly ssh: SshManager,
    private readonly pty: PtyManager,
    private readonly mcp: McpServer,
    private readonly audit: AuditStore,
    private readonly send: Send
  ) {}

  getRuntime(sessionId: string): AgentRuntime | undefined {
    const id = this.bySession.get(sessionId)
    if (!id) return undefined
    const rt = this.runtimes.get(id)
    if (!rt) return undefined
    const { ptyId: _ptyId, ...publicRuntime } = rt
    return publicRuntime
  }

  getRuntimeById(agentSessionId: string): AgentRuntime | undefined {
    const rt = this.runtimes.get(agentSessionId)
    if (!rt) return undefined
    const { ptyId: _ptyId, ...publicRuntime } = rt
    return publicRuntime
  }

  async launch(sessionId: string, profileId: string): Promise<AgentRuntime> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (!this.ssh.isConnected(sessionId)) throw new Error('请先连接 SSH 会话')

    const settings = this.store.getSettings()
    const profile = settings.agentProfiles.find((p) => p.id === profileId && p.enabled)
    if (!profile) throw new Error('Agent 不存在或未启用')
    if (!profile.command.trim()) throw new Error('Agent 命令为空，请先在设置中配置')

    this.stopForSession(sessionId)

    const agentSessionId = randomUUID()
    const workspace = join(app.getPath('userData'), 'workspaces', sessionId)
    await ensureDir(join(workspace, '.aishell'))

    const hostInfo = this.ssh.getHostInfo(sessionId)
    const mcpUrl = this.mcp.getUrl(sessionId, agentSessionId)
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      AISHELL_MCP_URL: mcpUrl,
      AISHELL_MCP_TOKEN: this.mcp.token,
      AISHELL_SESSION_ID: sessionId,
      AISHELL_SESSION_HOST: `${session.username}@${session.host}:${session.port}`,
      AISHELL_WORKSPACE: workspace
    }

    const runtime: Runtime = {
      agentSessionId,
      sessionId,
      profileId: profile.id,
      profileLabel: profile.label,
      status: 'starting',
      workspace,
      ptyId: agentSessionId
    }
    this.runtimes.set(agentSessionId, runtime)
    this.bySession.set(sessionId, agentSessionId)
    this.emitState(runtime)

    try {
      await this.writeContext(session, profile, workspace, mcpUrl, hostInfo)

      let command: { file: string; args: string[] }
      if (profile.kind === 'claude') {
        command = await this.prepareClaude(agentSessionId, session, profile, workspace, mcpUrl, env)
      } else if (profile.kind === 'codex') {
        command = await this.prepareCodex(agentSessionId, session, profile, workspace, mcpUrl, env)
      } else {
        command = await this.prepareCustom(agentSessionId, session, profile, workspace, env)
      }

      this.pty.create(
        agentSessionId,
        {
          file: command.file,
          args: command.args,
          cwd: workspace,
          env,
          cols: 120,
          rows: 32
        },
        {
          onData: (data) => this.send('agent:data', { agentSessionId, data }),
          onExit: (code) => {
            const rt = this.runtimes.get(agentSessionId)
            if (!rt) return
            if (rt.status !== 'stopped') {
              this.recordAgent(rt, 'exit', { exitCode: code })
            }
            rt.status = 'stopped'
            this.emitState(rt)
            this.send('agent:exit', { agentSessionId, code })
          }
        }
      )

      runtime.status = 'running'
      this.emitState(runtime)
      this.recordAgent(runtime, 'launch', { command: profile.command, args: profile.args ?? [] })
      void captureSnapshot(this.ssh, this.store, this.audit, {
        sessionId,
        trigger: 'agent_launch',
        agentSessionId,
        profileId: profile.id
      })
      return this.toPublic(runtime)
    } catch (err) {
      runtime.status = 'error'
      runtime.error = (err as Error).message
      this.emitState(runtime)
      throw err
    }
  }

  write(agentSessionId: string, data: string): void {
    this.pty.write(agentSessionId, data)
  }

  resize(agentSessionId: string, cols: number, rows: number): void {
    this.pty.resize(agentSessionId, cols, rows)
  }

  stop(agentSessionId: string): void {
    const rt = this.runtimes.get(agentSessionId)
    if (!rt) return
    if (rt.status === 'running' || rt.status === 'starting') this.recordAgent(rt, 'stop')
    this.pty.kill(agentSessionId)
    rt.status = 'stopped'
    this.emitState(rt)
    if (this.bySession.get(rt.sessionId) === agentSessionId) {
      this.bySession.delete(rt.sessionId)
    }
  }

  stopForSession(sessionId: string): void {
    const id = this.bySession.get(sessionId)
    if (id) this.stop(id)
  }

  disposeAll(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.status === 'running' || rt.status === 'starting') this.recordAgent(rt, 'app_quit')
      rt.status = 'stopped'
    }
    this.pty.disposeAll()
    this.runtimes.clear()
    this.bySession.clear()
  }

  private toPublic(runtime: Runtime): AgentRuntime {
    const { ptyId: _ptyId, ...publicRuntime } = runtime
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
      payload
    })
  }

  private async writeContext(
    session: Session,
    profile: AgentProfile,
    workspace: string,
    mcpUrl: string,
    hostInfo: { os?: string; kernel?: string; home?: string; cwd?: string }
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
- MCP 服务：${mcpUrl}

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

## 工作区
本机当前目录（${workspace}）只是 Agent 的临时工作区，不代表远程服务器。
如果需要把本机文件送到远程，使用 upload；需要取回远程文件，使用 download。
`

    await Promise.all([
      writeFileAtomic(join(workspace, 'CLAUDE.md'), content),
      writeFileAtomic(join(workspace, 'AGENTS.md'), content),
      writeFileAtomic(join(workspace, '.aishell', 'session.json'), JSON.stringify({
        sessionId: session.id,
        name: session.name,
        host: session.host,
        port: session.port,
        username: session.username,
        profile: profile.id,
        mcpUrl
      }, null, 2)),
      writeFileAtomic(
        join(workspace, '.aishell', 'claude-mcp.json'),
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
      writeFileAtomic(join(workspace, '.aishell', 'README.md'), this.customReadme(session, mcpUrl))
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
    _env: Record<string, string>
  ): Promise<{ file: string; args: string[] }> {
    const configPath = join(workspace, '.aishell', 'claude-mcp.json')
    const args = [...(profile.args ?? []), '--mcp-config', configPath]
    if (this.store.getSettings().claudeStrictMcp) args.push('--strict-mcp-config')
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
    env: Record<string, string>
  ): Promise<{ file: string; args: string[] }> {
    const codexHome = join(workspace, '.codex')
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
    return this.makeLauncher(agentSessionId, workspace, profile.command, profile.args ?? [])
  }

  private async prepareCustom(
    agentSessionId: string,
    _session: Session,
    profile: AgentProfile,
    workspace: string,
    _env: Record<string, string>
  ): Promise<{ file: string; args: string[] }> {
    return this.makeLauncher(agentSessionId, workspace, profile.command, profile.args ?? [])
  }

  private async makeLauncher(
    agentSessionId: string,
    workspace: string,
    command: string,
    args: string[]
  ): Promise<{ file: string; args: string[] }> {
    const scriptDir = join(workspace, '.aishell')
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
