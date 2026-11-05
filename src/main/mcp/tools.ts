import { app } from 'electron'
import { join, resolve as resolveLocalPath, sep } from 'node:path'
import type { ExecResult, Session } from '@shared/types'
import type { SessionStore } from '../store/SessionStore'
import type { SshManager } from '../ssh/SshManager'
import type { AgentShellResult } from '../ssh/AgentShell'
import type { AuditStore } from '../audit/AuditStore'
import { captureSnapshot } from '../audit/snapshot'
import { clipOutput, sha256 } from '../audit/redact'
import type { ActivityLog } from './activity'
import { isDangerousCommand, truncateText } from '../util'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  destructive: boolean
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

interface ToolContext {
  scopedSessionId: string
  sessionId: string
  ssh: SshManager
  store: SessionStore
}

/** Who is calling: the session the MCP URL is bound to and, if known, the agent. */
export interface McpScope {
  sessionId: string
  agentSessionId?: string
}

export type AgentResolver = (agentSessionId: string) => { profileId: string } | undefined

const sessionIdProp = {
  type: 'string',
  description: '目标会话 ID；默认使用当前绑定的会话。跨会话操作会被审计日志标记。'
}

const PATH_PROP = (description: string): Record<string, unknown> => ({
  type: 'string',
  description
})

const COMMAND_TOOLS = new Set(['exec', 'shell_run'])

export const TOOL_INSTRUCTIONS = `AIShell 已经连接到远程服务器，你通过本 MCP 服务操作远程主机。
规则：
1. 所有远程操作使用 aishell 工具（exec / shell_run / write_file / upload / download ...），不要在本机执行 ssh、scp、sftp。只有走 MCP 的操作才会被完整记录。
2. 先读后写：修改或删除前先用 exec 确认现状（ls -la / stat / head / cat）。
3. 危险操作（删除、覆盖、重启服务、修改权限）由你自己的安全策略负责判断；AIShell 不拦截任何命令，但会把它们记入审计日志。
4. 输出可能很大，优先使用 grep / head / tail / du -sh 等过滤。
5. exec 每次都是全新的 shell，不保留 cd / export；需要连续保持工作目录、环境变量或虚拟环境，或运行长任务、持续输出（编译、部署、tail -f）时，先 shell_open，再用 shell_run；长任务超时后用 shell_read 继续读取、shell_interrupt 中断，用完 shell_close。
6. 持久 shell 不支持交互式程序（vim、less、top、需要输入密码的 sudo），请使用非交互方式。
7. 不要尝试读取凭据文件。所有操作都会记录在 AIShell 的审计日志中。`

export class ToolRegistry {
  readonly tools: ToolDefinition[]

  constructor(
    private readonly ssh: SshManager,
    private readonly store: SessionStore,
    private readonly activity: ActivityLog,
    private readonly audit: AuditStore,
    private readonly resolveAgent: AgentResolver
  ) {
    this.tools = buildTools()
  }

  list(): Array<Record<string, unknown>> {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.name,
        readOnlyHint: tool.readOnly,
        destructiveHint: tool.destructive,
        idempotentHint: tool.readOnly,
        openWorldHint: false
      }
    }))
  }

  async call(name: string, args: Record<string, unknown>, scope: McpScope): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`未知工具：${name}`)

    const scopedSessionId = scope.sessionId
    const requestedSessionId =
      typeof args.session_id === 'string' && args.session_id.trim()
        ? args.session_id.trim()
        : scopedSessionId
    const sessionId = requestedSessionId || scopedSessionId

    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`会话不存在：${sessionId}`)

    const crossSession = Boolean(scopedSessionId) && sessionId !== scopedSessionId
    // A tag for the audit log only: AIShell does not block or ask about any
    // command, that is the agent's own responsibility.
    const dangerous =
      COMMAND_TOOLS.has(name) &&
      typeof args.command === 'string' &&
      isDangerousCommand(args.command)

    const agentSessionId = scope.agentSessionId
    const profileId = agentSessionId ? this.resolveAgent(agentSessionId)?.profileId : undefined
    const host = `${session.host}:${session.port}`

    // Write the intent before anything reaches the server. If the host or
    // the app dies mid-command, this record is what survives.
    let auditId: string
    try {
      auditId = this.audit.recordIntent(
        {
          sessionId,
          sessionName: session.name,
          host,
          username: session.username,
          agentSessionId,
          profileId,
          tool: name,
          args,
          crossSession,
          dangerous
        },
        { durable: !tool.readOnly }
      )
    } catch (err) {
      throw new Error(`审计日志写入失败，已拒绝执行：${(err as Error).message}`)
    }

    const event = this.activity.start(sessionId, name, args, { agentSessionId, profileId })

    // A destructive command gets a pre-flight snapshot so the audit trail can
    // show what the server looked like just before the agent changed it.
    if (dangerous && tool.destructive) {
      void captureSnapshot(this.ssh, this.store, this.audit, {
        sessionId,
        trigger: 'before_dangerous',
        agentSessionId,
        profileId,
        relatedId: auditId
      })
    }

    this.activity.update(event.id, 'running')
    const started = Date.now()
    try {
      const result = await tool.handler(args, {
        scopedSessionId,
        sessionId,
        ssh: this.ssh,
        store: this.store
      })
      const summary = summarize(name, args, result)
      this.audit.recordResult(auditId, {
        status: 'success',
        durationMs: Date.now() - started,
        exitCode: exitCodeOf(result),
        summary,
        output: auditOutput(name, result)
      })
      this.activity.update(event.id, 'success', { summary })
      return result
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      this.audit.recordResult(auditId, {
        status: 'error',
        durationMs: Date.now() - started,
        error: message
      })
      this.activity.update(event.id, 'error', { error: message })
      throw err
    }
  }
}

function exitCodeOf(result: unknown): number | null | undefined {
  if (!result || typeof result !== 'object') return undefined
  const obj = result as Record<string, unknown>
  for (const key of ['code', 'exit_code']) {
    if (key in obj && (typeof obj[key] === 'number' || obj[key] === null)) {
      return obj[key] as number | null
    }
  }
  return undefined
}

/** What to keep of a tool's result: enough to review, never whole files. */
function auditOutput(tool: string, result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined
  if (tool === 'exec') {
    const res = result as ExecResult
    return {
      stdout: clipOutput(res.stdout),
      stderr: clipOutput(res.stderr),
      stdoutBytes: Buffer.byteLength(res.stdout),
      stderrBytes: Buffer.byteLength(res.stderr),
      stdoutSha256: sha256(res.stdout),
      truncated: Boolean(res.truncated)
    }
  }
  if (tool.startsWith('shell_') && 'output' in result) {
    const res = result as AgentShellResult
    return {
      output: clipOutput(res.output),
      outputBytes: Buffer.byteLength(res.output),
      running: res.running,
      cwd: res.cwd,
      timedOut: res.timed_out,
      interrupted: res.interrupted,
      truncated: res.truncated,
      shellClosed: res.shell_closed
    }
  }
  if (Array.isArray(result)) return { count: result.length }
  const json = JSON.stringify(result)
  return json.length <= 4096 ? (result as Record<string, unknown>) : { bytes: json.length }
}

function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key]
  return typeof value === 'string' ? value : fallback
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampSec(value: number): number {
  return Math.min(Math.max(Math.floor(value) || 1, 1), 600)
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

function workspaceDir(sessionId: string): string {
  return join(app.getPath('userData'), 'workspaces', sessionId)
}

function assertLocalWriteAllowed(sessionId: string, target: string): void {
  const abs = resolveLocalPath(target)
  const allowedRoots = [workspaceDir(sessionId), app.getPath('downloads')].map((p) =>
    resolveLocalPath(p)
  )
  const allowed = allowedRoots.some((root) => abs === root || abs.startsWith(root + sep))
  if (!allowed) {
    throw new Error(
      `出于安全考虑，下载目标必须位于 Agent 工作区或系统下载目录：${workspaceDir(sessionId)} 或 ${app.getPath('downloads')}`
    )
  }
}

function summarize(tool: string, args: Record<string, unknown>, result: unknown): string {
  if (tool === 'exec') {
    const command = String(args.command ?? '')
    const res = result as { code?: number | null }
    return `${truncateText(command, 100).text} → exit ${res.code ?? '?'}`
  }
  if (tool === 'write_file') return `${String(args.path ?? '')} 已写入`
  if (tool === 'upload') return `上传 ${String(args.local_path ?? '')} → ${String(args.remote_path ?? '')}`
  if (tool === 'download') return `下载 ${String(args.remote_path ?? '')} → ${String(args.local_path ?? '')}`
  if (tool === 'session_info') return '读取会话信息'
  if (tool === 'list_sessions') return '列出会话'
  if (tool === 'shell_open') {
    return (result as { reused?: boolean })?.reused ? '复用已打开的持久 shell' : '打开持久 shell'
  }
  if (tool === 'shell_close') return '关闭持久 shell'
  if (tool === 'shell_run' || tool === 'shell_read' || tool === 'shell_interrupt') {
    const res = result as AgentShellResult
    const head =
      tool === 'shell_run'
        ? truncateText(String(args.command ?? ''), 100).text
        : tool === 'shell_read'
          ? '继续读取'
          : '中断'
    if (res.shell_closed) return `${head} → shell 已关闭`
    return res.running ? `${head} → 仍在运行` : `${head} → exit ${res.exit_code ?? '?'}`
  }
  return '完成'
}

function buildTools(): ToolDefinition[] {
  return [
    {
      name: 'session_info',
      description: '获取当前远程会话的信息：主机、端口、用户、操作系统、内核、家目录、当前目录和连接状态。',
      readOnly: true,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: { session_id: sessionIdProp },
        additionalProperties: false
      },
      async handler(_args, ctx) {
        const info = ctx.ssh.getSessionInfo(ctx.sessionId)
        return {
          session_id: info.session.id,
          name: info.session.name,
          host: info.session.host,
          port: info.session.port,
          username: info.session.username,
          status: info.status,
          os: info.hostInfo.os,
          kernel: info.hostInfo.kernel,
          home: info.hostInfo.home,
          cwd: info.hostInfo.cwd
        }
      }
    },
    {
      name: 'list_sessions',
      description: '列出 AIShell 中配置的所有会话及其连接状态。只读。',
      readOnly: true,
      destructive: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler(_args, ctx) {
        return ctx.store.listSessions().map((session) => ({
          session_id: session.id,
          name: session.name,
          group: session.group,
          host: session.host,
          port: session.port,
          username: session.username,
          status: ctx.ssh.getStatus(session.id)
        }))
      }
    },
    {
      name: 'exec',
      description:
        '在远程服务器执行一条 shell 命令，返回 stdout、stderr 和退出码。默认超时 60 秒，输出各截断到 64KB。可执行任意命令。',
      readOnly: false,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          cwd: { type: 'string', description: '执行前切换到的远程目录（可选）' },
          timeout_sec: { type: 'number', description: '超时秒数，1-600，默认 60' },
          session_id: sessionIdProp
        },
        required: ['command'],
        additionalProperties: false
      },
      async handler(args, ctx) {
        const result = await ctx.ssh.exec(ctx.sessionId, str(args, 'command'), {
          cwd: str(args, 'cwd') || undefined,
          timeoutSec: num(args, 'timeout_sec', 60)
        })
        return result
      }
    },
    {
      name: 'write_file',
      description:
        '写入远程文本文件（覆盖）。默认先创建 .aishell.bak 备份。适合多行内容；单条命令用 exec。',
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROP('远程文件路径'),
          content: { type: 'string', description: '完整文件内容' },
          create_backup: { type: 'boolean', description: '写入前是否备份，默认 true' },
          session_id: sessionIdProp
        },
        required: ['path', 'content'],
        additionalProperties: false
      },
      async handler(args, ctx) {
        await ctx.ssh.writeFile(ctx.sessionId, str(args, 'path'), str(args, 'content'), {
          backup: bool(args, 'create_backup', true)
        })
        return { ok: true, path: str(args, 'path') }
      }
    },
    {
      name: 'upload',
      description: '把本机文件或目录上传到远程服务器。',
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          local_path: { type: 'string', description: '本机路径' },
          remote_path: { type: 'string', description: '远程目标路径或目标目录' },
          session_id: sessionIdProp
        },
        required: ['local_path', 'remote_path'],
        additionalProperties: false
      },
      async handler(args, ctx) {
        await ctx.ssh.upload(ctx.sessionId, str(args, 'local_path'), str(args, 'remote_path'))
        return { ok: true }
      }
    },
    {
      name: 'download',
      description:
        '把远程文件或目录下载到本机。目标必须位于 Agent 工作区或系统下载目录。',
      readOnly: false,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          remote_path: { type: 'string', description: '远程路径' },
          local_path: { type: 'string', description: '本机目标路径' },
          session_id: sessionIdProp
        },
        required: ['remote_path', 'local_path'],
        additionalProperties: false
      },
      async handler(args, ctx) {
        const target = str(args, 'local_path')
        if (!target) throw new Error('缺少 local_path')
        assertLocalWriteAllowed(ctx.sessionId, target)
        await ctx.ssh.download(ctx.sessionId, str(args, 'remote_path'), target)
        return { ok: true, local_path: target }
      }
    },
    {
      name: 'shell_open',
      description:
        '在远程服务器打开一条持久 shell（每个会话一条）。之后用 shell_run 执行的命令会保留工作目录、环境变量和已激活的虚拟环境。已打开时直接复用。空闲 30 分钟或断开连接后自动关闭。',
      readOnly: false,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: { session_id: sessionIdProp },
        additionalProperties: false
      },
      async handler(_args, ctx) {
        const { reused } = await ctx.ssh.openAgentShell(ctx.sessionId)
        return { ok: true, reused, idle_timeout_minutes: 30 }
      }
    },
    {
      name: 'shell_run',
      description:
        '在持久 shell 中执行命令（需先 shell_open），返回输出、退出码和执行后的工作目录。超时后命令不会被终止，会返回 running=true 和已产生的输出，之后用 shell_read 继续读取或 shell_interrupt 中断。不支持交互式程序；stdin 不可用。',
      readOnly: false,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令，可以多行' },
          timeout_sec: {
            type: 'number',
            description: '本次等待的秒数，1-600，默认 60；超时不会终止命令'
          },
          session_id: sessionIdProp
        },
        required: ['command'],
        additionalProperties: false
      },
      async handler(args, ctx) {
        return ctx.ssh
          .getAgentShell(ctx.sessionId)
          .run(str(args, 'command'), clampSec(num(args, 'timeout_sec', 60)))
      }
    },
    {
      name: 'shell_read',
      description:
        '继续等待持久 shell 中仍在运行的命令，返回自上次读取以来的新输出；命令结束时返回退出码。',
      readOnly: true,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          timeout_sec: { type: 'number', description: '最多等待的秒数，1-600，默认 30' },
          session_id: sessionIdProp
        },
        additionalProperties: false
      },
      async handler(args, ctx) {
        return ctx.ssh
          .getAgentShell(ctx.sessionId)
          .read(clampSec(num(args, 'timeout_sec', 30)))
      }
    },
    {
      name: 'shell_interrupt',
      description: '向持久 shell 中正在运行的命令发送 Ctrl+C，并返回剩余输出。',
      readOnly: false,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: { session_id: sessionIdProp },
        additionalProperties: false
      },
      async handler(_args, ctx) {
        return ctx.ssh.getAgentShell(ctx.sessionId).interrupt()
      }
    },
    {
      name: 'shell_close',
      description: '关闭持久 shell。任务完成后请关闭。',
      // Closing the agent's own shell changes nothing on the server.
      readOnly: true,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: { session_id: sessionIdProp },
        additionalProperties: false
      },
      async handler(_args, ctx) {
        return { ok: true, closed: ctx.ssh.closeAgentShell(ctx.sessionId, 'agent') }
      }
    }
  ]
}

export function sessionSummary(session: Session): string {
  return `${session.username}@${session.host}:${session.port}`
}
