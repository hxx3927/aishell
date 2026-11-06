import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type FileEntry,
  type SFTPWrapper
} from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type {
  ConnectionStatus,
  ExecResult,
  FileContent,
  HostInfo,
  Session,
  SftpEntry,
  TransferProgress
} from '@shared/types'
import type { SessionStore } from '../store/SessionStore'
import { AgentShell } from './AgentShell'
import {
  formatPermissions,
  isProbablyBinary,
  normalizeRemotePath,
  remoteBasename,
  remoteDirname,
  remoteJoin,
  shellQuote,
  toPosixPath,
  truncateText
} from '../util'

const MAX_EXEC_OUTPUT = 64 * 1024
const MAX_EDITABLE_FILE = 5 * 1024 * 1024

interface Runtime {
  /** Connection instance id. The primary one equals the session id. */
  id: string
  session: Session
  client: Client | null
  status: ConnectionStatus
  shell: ClientChannel | null
  decoder: StringDecoder
  sftp: SFTPWrapper | null
  pending: string
  flushTimer: NodeJS.Timeout | null
  hostInfo: HostInfo
  error?: string
  closing: boolean
  agentShell: AgentShell | null
}

type Send = (channel: string, payload: unknown) => void

export class SshManager {
  private runtimes = new Map<string, Runtime>()

  /** Called whenever an agent shell opens or closes (including idle and disconnect). */
  onAgentShellChange: (
    connId: string,
    sessionId: string,
    open: boolean,
    reason?: string
  ) => void = () => undefined

  constructor(
    private readonly store: SessionStore,
    private readonly send: Send
  ) {}

  private makeRuntime(session: Session, id: string): Runtime {
    return {
      id,
      session,
      client: null,
      status: 'disconnected',
      shell: null,
      decoder: new StringDecoder('utf8'),
      sftp: null,
      pending: '',
      flushTimer: null,
      hostInfo: {},
      closing: false,
      agentShell: null
    }
  }

  /**
   * Session-scoped lookup: the primary connection if it is up, otherwise any
   * connected instance of the same session. MCP tools, SFTP and the agent
   * shell all address a server by session id, not by terminal instance.
   */
  private runtimeForSession(sessionId: string): Runtime | undefined {
    const primary = this.runtimes.get(sessionId)
    if (primary?.status === 'connected') return primary
    let fallback = primary
    for (const rt of this.runtimes.values()) {
      if (rt.session.id !== sessionId) continue
      if (rt.status === 'connected') return rt
      fallback ??= rt
    }
    return fallback
  }

  /**
   * Resolves a target that is either a session id or a connection instance id.
   * Both are keys in `runtimes` (the primary instance's id is the session id),
   * so an exact match wins and a session id falls back to any instance.
   */
  private runtimeForTarget(target: string): Runtime | undefined {
    return this.runtimes.get(target) ?? this.runtimeForSession(target)
  }

  private getRuntime(target: string): Runtime {
    const rt = this.runtimeForTarget(target)
    if (!rt) throw new Error('会话不存在或已断开')
    return rt
  }

  /** True when this exact connection instance is up. */
  isConnConnected(connId: string): boolean {
    const rt = this.runtimes.get(connId)
    return Boolean(rt && rt.status === 'connected' && rt.client)
  }

  private requireConnected(sessionId: string): Runtime {
    const rt = this.getRuntime(sessionId)
    if (rt.status !== 'connected' || !rt.client) throw new Error('SSH 会话未连接')
    return rt
  }

  /** Terminal-scoped lookup: exactly the instance the tab is attached to. */
  private requireConn(connId: string): Runtime {
    const rt = this.runtimes.get(connId)
    if (!rt) throw new Error('终端会话不存在')
    if (rt.status !== 'connected' || !rt.client) throw new Error('SSH 会话未连接')
    return rt
  }

  private setState(rt: Runtime, status: ConnectionStatus, error?: string): void {
    rt.status = status
    rt.error = error
    this.send('ssh:state', {
      connId: rt.id,
      sessionId: rt.session.id,
      status,
      error,
      hostInfo: rt.hostInfo
    })
  }

  isConnected(sessionId: string): boolean {
    return Array.from(this.runtimes.values()).some(
      (rt) => rt.session.id === sessionId && rt.status === 'connected'
    )
  }

  getStatus(target: string): ConnectionStatus {
    return this.runtimeForTarget(target)?.status ?? 'disconnected'
  }

  getHostInfo(target: string): HostInfo {
    return this.runtimeForTarget(target)?.hostInfo ?? {}
  }

  listConnected(): Array<{ session: Session; status: ConnectionStatus; hostInfo: HostInfo }> {
    return Array.from(this.runtimes.values())
      .filter((rt) => rt.status === 'connected')
      .map((rt) => ({ session: rt.session, status: rt.status, hostInfo: rt.hostInfo }))
  }

  /**
   * Opens one connection instance. `connId` identifies this terminal; several
   * instances may share a session, each with its own shell.
   */
  async connect(connId: string, sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')

    this.closeRuntime(connId, true)
    const rt = this.makeRuntime(session, connId)
    this.runtimes.set(connId, rt)
    this.setState(rt, 'connecting')
    // Errors raised while assembling the config happen before ssh2 exists,
    // so no socket event will reset the status — do it here.
    const failSetup = (message: string): never => {
      this.setState(rt, 'error', message)
      throw new Error(message)
    }

    const config: ConnectConfig = {
      host: session.host,
      port: session.port,
      username: session.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const fingerprint = `SHA256:${createHash('sha256')
          .update(key)
          .digest('base64')
          .replace(/=+$/, '')}`
        const result = this.store.verifyHost(session.host, session.port, fingerprint)
        if (result === 'mismatch') {
          const known = this.store.getKnownHost(session.host, session.port)
          this.send('app:notice', {
            level: 'error',
            message: `主机指纹不匹配！${session.host}:${session.port} 当前 ${fingerprint}，已记录 ${known?.fingerprint ?? '未知'}`
          })
          verify(false)
          return
        }
        if (result === 'new') {
          this.send('app:notice', {
            level: 'info',
            message: `首次连接 ${session.host}:${session.port}，已记录主机指纹 ${fingerprint}`
          })
        }
        verify(true)
      }
    }

    if (session.auth.type === 'password') {
      const password = this.store.getSecret(session.id, 'password')
      if (!password) failSetup('缺少登录密码，请编辑会话重新填写')
      config.password = password
    } else if (session.auth.type === 'key') {
      const keyPath = session.auth.privateKeyPath
      if (!keyPath) failSetup('未配置私钥路径')
      try {
        config.privateKey = readFileSync(keyPath!)
      } catch (err) {
        failSetup(`读取私钥失败：${(err as Error).message}`)
      }
      const passphrase = this.store.getSecret(session.id, 'passphrase')
      if (passphrase) config.passphrase = passphrase
    } else if (session.auth.type === 'agent') {
      const agent =
        process.env.SSH_AUTH_SOCK ||
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
      if (!agent) failSetup('未找到 SSH Agent，请设置 SSH_AUTH_SOCK')
      config.agent = agent
    }

    const client = new Client()
    rt.client = client

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        this.setState(rt, 'error', err.message)
        reject(err)
      }

      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        const secret =
          this.store.getSecret(session.id, 'password') ??
          this.store.getSecret(session.id, 'passphrase') ??
          ''
        finish(prompts.map(() => secret))
      })

      client.on('ready', () => {
        if (settled) return
        settled = true
        this.setState(rt, 'connected')
        this.store.touchSession(sessionId).catch(() => undefined)
        this.gatherHostInfo(sessionId)
          .then((info) => {
            rt.hostInfo = info
            this.send('ssh:state', {
              connId,
              sessionId,
              status: 'connected',
              hostInfo: info
            })
          })
          .catch((err) => console.warn('[ssh] host info failed', err))
        resolve()
      })

      client.on('error', (err) => {
        console.error('[ssh] connection error', err)
        this.setState(rt, 'error', err.message)
        fail(new Error(`连接失败：${err.message}`))
      })

      client.on('close', () => {
        if (rt.closing) return
        rt.agentShell?.close('disconnected')
        rt.shell = null
        rt.sftp = null
        this.setState(rt, 'disconnected')
        this.send('term:exit', { connId, sessionId, reason: 'disconnected' })
      })

      try {
        client.connect(config)
        // ssh2 leaves Nagle on (Node's socket default), which holds each
        // keystroke until the previous small packet is ACKed — up to one RTT
        // of lag on a high-latency link. OpenSSH and PuTTY both disable it
        // for interactive sessions; the socket exists by now, so this takes
        // effect for the whole connection.
        client.setNoDelay(true)
      } catch (err) {
        fail(err as Error)
      }
    })
  }

  disconnect(connId: string): void {
    this.closeRuntime(connId, false)
  }

  /** Closes every connection instance of a session. */
  disconnectSession(sessionId: string): void {
    for (const rt of Array.from(this.runtimes.values())) {
      if (rt.session.id === sessionId) this.closeRuntime(rt.id, false)
    }
  }

  private closeRuntime(connId: string, silent: boolean): void {
    const rt = this.runtimes.get(connId)
    if (!rt) return
    rt.closing = true
    rt.agentShell?.close('disconnected')
    if (rt.flushTimer) {
      clearTimeout(rt.flushTimer)
      rt.flushTimer = null
    }
    try {
      rt.shell?.close()
    } catch {
      /* ignore */
    }
    try {
      rt.sftp?.end()
    } catch {
      /* ignore */
    }
    try {
      rt.client?.end()
    } catch {
      /* ignore */
    }
    if (rt.pending) {
      this.send('term:data', { connId, sessionId: rt.session.id, data: rt.pending })
      rt.pending = ''
    }
    rt.shell = null
    rt.sftp = null
    rt.client = null
    rt.status = 'disconnected'
    if (!silent) {
      this.setState(rt, 'disconnected')
      this.send('term:exit', { connId, sessionId: rt.session.id, reason: 'disconnected' })
    }
    // The instance is gone; a reconnect creates a fresh runtime.
    if (this.runtimes.get(connId) === rt) this.runtimes.delete(connId)
  }

  async openShell(
    connId: string,
    cols: number,
    rows: number,
    fresh = false
  ): Promise<void> {
    const rt = this.requireConn(connId)
    if (rt.shell) {
      if (!fresh) return
      // The renderer has no scrollback for this channel (e.g. after a reload),
      // so replace any leftover shell instead of attaching to a zombie.
      const stale = rt.shell
      rt.shell = null
      try {
        stale.close()
      } catch {
        /* ignore */
      }
    }
    const client = rt.client!

    return new Promise<void>((resolve, reject) => {
      client.shell(
        {
          term: 'xterm-256color',
          cols: Math.max(2, Math.floor(cols) || 80),
          rows: Math.max(2, Math.floor(rows) || 24)
        },
        (err, stream) => {
          if (err) {
            reject(new Error(`打开终端失败：${err.message}`))
            return
          }
          const decoder = new StringDecoder('utf8')
          rt.shell = stream
          rt.decoder = decoder
          let exitCode: number | undefined
          let exitSignal: string | undefined

          stream.on('exit', (code: number | null, signal: string | null) => {
            if (typeof code === 'number') exitCode = code
            if (typeof signal === 'string' && signal) exitSignal = signal
          })
          const write = (chunk: Buffer): void => {
            if (rt.shell !== stream) return
            this.enqueueData(rt, decoder.write(chunk))
          }
          stream.on('data', write)
          stream.stderr?.on('data', write)
          stream.on('close', () => {
            if (rt.shell !== stream) return
            const tail = decoder.end()
            if (tail) this.enqueueData(rt, tail)
            rt.shell = null
            rt.decoder = new StringDecoder('utf8')
            this.send('term:exit', {
              connId,
              sessionId: rt.session.id,
              code: exitCode,
              signal: exitSignal,
              reason: exitCode === undefined && !exitSignal ? 'dropped' : 'exit'
            })
          })
          resolve()
        }
      )
    })
  }

  private enqueueData(rt: Runtime, data: string): void {
    if (!data) return
    rt.pending += data
    if (rt.pending.length > 512 * 1024) {
      this.flushData(rt)
      return
    }
    if (rt.flushTimer) return
    rt.flushTimer = setTimeout(() => this.flushData(rt), 16)
  }

  private flushData(rt: Runtime): void {
    if (rt.flushTimer) {
      clearTimeout(rt.flushTimer)
      rt.flushTimer = null
    }
    if (!rt.pending) return
    const data = rt.pending
    rt.pending = ''
    this.send('term:data', { connId: rt.id, sessionId: rt.session.id, data })
  }

  write(connId: string, data: string): void {
    this.runtimes.get(connId)?.shell?.write(data)
  }

  resize(connId: string, cols: number, rows: number): void {
    this.runtimes
      .get(connId)
      ?.shell?.setWindow(Math.max(2, rows), Math.max(2, cols), 0, 0)
  }

  closeShell(connId: string): void {
    const rt = this.runtimes.get(connId)
    if (!rt) return
    try {
      rt.shell?.close()
    } catch {
      /* ignore */
    }
    rt.shell = null
  }

  hasAgentShell(target: string): boolean {
    return Boolean(this.runtimeForTarget(target)?.agentShell?.isOpen)
  }

  /** Connection instance ids that currently hold an agent shell. */
  listAgentShells(): string[] {
    return Array.from(this.runtimes.values())
      .filter((rt) => rt.agentShell?.isOpen)
      .map((rt) => rt.id)
  }

  getAgentShell(target: string): AgentShell {
    const shell = this.runtimeForTarget(target)?.agentShell
    if (!shell?.isOpen) throw new Error('持久 shell 未打开，请先调用 shell_open')
    return shell
  }

  /** Opens the agent shell, or returns the one already open. */
  async openAgentShell(target: string): Promise<{ shell: AgentShell; reused: boolean }> {
    const rt = this.requireConnected(target)
    if (rt.agentShell?.isOpen) return { shell: rt.agentShell, reused: true }
    const shell = await AgentShell.open(rt.client!, {
      onClose: (reason) => {
        if (rt.agentShell === shell) rt.agentShell = null
        this.onAgentShellChange(rt.id, rt.session.id, false, reason)
      }
    })
    rt.agentShell = shell
    this.onAgentShellChange(rt.id, rt.session.id, true)
    return { shell, reused: false }
  }

  closeAgentShell(target: string, reason = 'closed'): boolean {
    const shell = this.runtimeForTarget(target)?.agentShell
    if (!shell?.isOpen) return false
    shell.close(reason)
    return true
  }

  async exec(
    sessionId: string,
    command: string,
    options: { cwd?: string; timeoutSec?: number } = {}
  ): Promise<ExecResult> {
    const rt = this.requireConnected(sessionId)
    const client = rt.client!
    let full = command
    if (options.cwd) {
      const cwd = await this.resolveRemotePath(sessionId, options.cwd)
      full = `cd ${shellQuote(cwd)} && ${command}`
    }
    const timeoutMs = Math.min(Math.max(options.timeoutSec ?? 60, 1), 600) * 1000

    return new Promise<ExecResult>((resolve, reject) => {
      let done = false
      let stream: ClientChannel | null = null
      const finish = (fn: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        fn()
      }

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`命令执行超时（${timeoutMs / 1000}s）`)))
        try {
          stream?.signal('KILL')
        } catch {
          /* ignore */
        }
      }, timeoutMs)
      client.exec(full, (err, channel) => {
        if (err) {
          finish(() => reject(new Error(`执行失败：${err.message}`)))
          return
        }
        stream = channel
        const outDecoder = new StringDecoder('utf8')
        const errDecoder = new StringDecoder('utf8')
        let stdout = ''
        let stderr = ''
        let truncated = false

        channel.on('data', (chunk: Buffer) => {
          if (stdout.length >= MAX_EXEC_OUTPUT) {
            truncated = true
            return
          }
          stdout += outDecoder.write(chunk)
          if (stdout.length > MAX_EXEC_OUTPUT) {
            stdout = truncateText(stdout, MAX_EXEC_OUTPUT).text
            truncated = true
          }
        })
        channel.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length >= MAX_EXEC_OUTPUT) {
            truncated = true
            return
          }
          stderr += errDecoder.write(chunk)
          if (stderr.length > MAX_EXEC_OUTPUT) {
            stderr = truncateText(stderr, MAX_EXEC_OUTPUT).text
            truncated = true
          }
        })
        channel.on('close', (code: number | null) => {
          finish(() => {
            const rest = outDecoder.end()
            if (rest) stdout += rest
            const errRest = errDecoder.end()
            if (errRest) stderr += errRest
            resolve({ stdout, stderr, code: code ?? null, truncated })
          })
        })
        channel.on('error', (channelErr: Error) => {
          finish(() => reject(new Error(channelErr.message)))
        })
      })
    })
  }

  async ping(sessionId: string): Promise<number> {
    const started = Date.now()
    await this.exec(sessionId, 'echo AISHELL_PING', { timeoutSec: 10 })
    return Date.now() - started
  }

  async resolveRemotePath(sessionId: string, input: string): Promise<string> {
    const raw = toPosixPath((input || '.').trim())
    let home: string | undefined
    const getHome = async (): Promise<string> => {
      if (home) return home
      const info = this.getRuntime(sessionId).hostInfo
      if (info.home) return (home = info.home)
      const sftp = await this.getSftp(sessionId)
      home = await new Promise<string>((resolve, reject) => {
        sftp.realpath('.', (err, abs) => (err ? reject(err) : resolve(abs)))
      })
      return home
    }
    if (raw === '~' || raw.startsWith('~/')) {
      return normalizeRemotePath(`${await getHome()}${raw.slice(1)}`)
    }
    if (!raw.startsWith('/')) {
      return normalizeRemotePath(`${await getHome()}/${raw}`)
    }
    return normalizeRemotePath(raw)
  }

  async getSftp(sessionId: string): Promise<SFTPWrapper> {
    const rt = this.requireConnected(sessionId)
    if (rt.sftp) return rt.sftp
    return new Promise<SFTPWrapper>((resolve, reject) => {
      rt.client!.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP 连接失败：${err.message}`))
          return
        }
        rt.sftp = sftp
        resolve(sftp)
      })
    })
  }

  async realpath(sessionId: string, path: string): Promise<string> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs)))
    })
  }

  async listDir(sessionId: string, path: string): Promise<SftpEntry[]> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    const list = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(abs, (err, entries) => {
        if (err) reject(err)
        else resolve(entries)
      })
    })

    const entries: SftpEntry[] = list
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => {
        const attrs = e.attrs as unknown as {
          isDirectory(): boolean
          isSymbolicLink(): boolean
          size?: number
          mtime?: number
          mode?: number
        }
        return {
          name: e.filename,
          path: remoteJoin(abs, e.filename),
          isDir: attrs.isDirectory(),
          isSymlink: attrs.isSymbolicLink(),
          size: attrs.size ?? 0,
          mtime: (attrs.mtime ?? 0) * 1000,
          mode: attrs.mode ?? 0,
          permissions: formatPermissions(attrs.mode ?? 0)
        }
      })

    // Resolve symlinked directories so double-click navigation works.
    await Promise.all(
      entries
        .filter((e) => e.isSymlink)
        .map(async (e) => {
          try {
            const stats = await this.statPath(sessionId, e.path, true)
            e.isDir = stats.isDir
          } catch {
            /* broken symlink */
          }
        })
    )

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  }

  async statPath(
    sessionId: string,
    path: string,
    follow = true
  ): Promise<{ isDir: boolean; isSymlink: boolean; size: number; mtime: number; mode: number }> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    return new Promise((resolve, reject) => {
      const cb = (err: Error | undefined, stats: any): void => {
        if (err) {
          reject(err)
          return
        }
        resolve({
          isDir: stats.isDirectory(),
          isSymlink: stats.isSymbolicLink(),
          size: stats.size ?? 0,
          mtime: (stats.mtime ?? 0) * 1000,
          mode: stats.mode ?? 0
        })
      }
      if (follow) sftp.stat(abs, cb)
      else sftp.lstat(abs, cb)
    })
  }

  async readFile(sessionId: string, path: string, maxBytes = MAX_EDITABLE_FILE): Promise<FileContent> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    const stats = await this.statPath(sessionId, abs)
    if (stats.isDir) throw new Error('这是一个目录，不能作为文件打开')
    if (stats.size > maxBytes) {
      throw new Error(`文件过大（${formatBytes(stats.size)}），超过 ${formatBytes(maxBytes)} 限制`)
    }
    const buf = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(abs, (err, data) => (err ? reject(err) : resolve(data)))
    })
    if (isProbablyBinary(buf)) {
      return { content: '', size: buf.length, binary: true }
    }
    return { content: buf.toString('utf8'), size: buf.length, binary: false }
  }

  async writeFile(
    sessionId: string,
    path: string,
    content: string,
    options: { backup?: boolean } = {}
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    if (options.backup) {
      const exists = await this.remoteExists(sessionId, abs)
      if (exists) {
        await this.renamePath(sessionId, abs, `${abs}.aishell.bak`).catch(() => undefined)
      }
    }
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(abs, content, { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()))
    })
  }

  async createFile(sessionId: string, path: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    // Fail instead of silently truncating an existing file, matching mkdir.
    if (await this.remoteExists(sessionId, abs)) throw new Error('文件已存在')
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(abs, '', { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()))
    })
  }

  async remoteExists(sessionId: string, path: string): Promise<boolean> {
    try {
      await this.statPath(sessionId, path, false)
      return true
    } catch {
      return false
    }
  }

  async mkdir(sessionId: string, path: string, recursive = false): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    if (!recursive) {
      if (await this.remoteExists(sessionId, abs)) throw new Error('目录已存在')
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(abs, (err) => (err ? reject(err) : resolve()))
      })
      return
    }
    const parts = abs.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => (err ? reject(err) : resolve()))
        })
      } catch {
        const exists = await this.remoteExists(sessionId, current)
        if (!exists) throw new Error(`创建目录失败：${current}`)
      }
    }
  }

  async renamePath(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const absFrom = await this.resolveRemotePath(sessionId, from)
    const absTo = to.startsWith('/')
      ? normalizeRemotePath(to)
      : remoteJoin(remoteDirname(absFrom), to)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(absFrom, absTo, (err) => (err ? reject(err) : resolve()))
    })
  }

  async deletePath(sessionId: string, path: string, recursive = false): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    if (abs === '/') throw new Error('拒绝删除根目录')
    const stats = await this.statPath(sessionId, abs, false)
    if (!stats.isDir) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(abs, (err) => (err ? reject(err) : resolve()))
      })
      return
    }
    if (!recursive) {
      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(abs, (err) => (err ? reject(err) : resolve()))
      })
      return
    }
    const children = await this.listDir(sessionId, abs)
    for (const child of children) {
      await this.deletePath(sessionId, child.path, true)
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(abs, (err) => (err ? reject(err) : resolve()))
    })
  }

  async chmod(sessionId: string, path: string, mode: number): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const abs = await this.resolveRemotePath(sessionId, path)
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(abs, mode, (err) => (err ? reject(err) : resolve()))
    })
  }

  async upload(sessionId: string, localPath: string, remotePath: string): Promise<void> {
    await this.getSftp(sessionId)
    const localStats = await fsp.stat(localPath)
    if (localStats.isDirectory()) {
      const remoteIsDir = await this.remoteIsDirectory(sessionId, remotePath)
      const target = remoteIsDir
        ? remoteJoin(await this.resolveRemotePath(sessionId, remotePath), basename(localPath))
        : await this.resolveRemotePath(sessionId, remotePath)
      await this.uploadDir(sessionId, localPath, target, basename(localPath))
      return
    }

    const resolved = await this.resolveRemotePath(sessionId, remotePath)
    const remoteIsDir = await this.remoteIsDirectory(sessionId, resolved)
    const target = remoteIsDir ? remoteJoin(resolved, basename(localPath)) : resolved
    await this.putFile(sessionId, localPath, target, basename(localPath))
  }

  private async uploadDir(
    sessionId: string,
    localDir: string,
    remoteDir: string,
    displayRoot: string
  ): Promise<void> {
    await this.mkdir(sessionId, remoteDir, true)
    const entries = await fsp.readdir(localDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const from = join(localDir, entry.name)
      const to = remoteJoin(remoteDir, entry.name)
      const display = `${displayRoot}/${entry.name}`
      if (entry.isDirectory()) {
        await this.uploadDir(sessionId, from, to, display)
      } else if (entry.isFile()) {
        await this.putFile(sessionId, from, to, display)
      }
    }
  }

  private putFile(sessionId: string, localPath: string, remotePath: string, display: string): Promise<void> {
    const sftpRuntime = this.getRuntime(sessionId)
    return new Promise<void>((resolve, reject) => {
      const transferId = randomUUID()
      let lastEmit = 0
      let lastTransferred = 0
      let lastTotal = 0
      this.emitTransfer(
        sftpRuntime,
        transferId,
        'upload',
        display,
        0,
        0,
        false
      )
      sftpRuntime.sftp!.fastPut(
        localPath,
        remotePath,
        {
          concurrency: 16,
          step: (transferred: number, _chunk: number, total: number) => {
            lastTransferred = transferred
            lastTotal = total
            const now = Date.now()
            if (now - lastEmit < 120) return
            lastEmit = now
            this.emitTransfer(sftpRuntime, transferId, 'upload', display, transferred, total, false)
          }
        },
        (err) => {
          if (err) {
            this.emitTransfer(sftpRuntime, transferId, 'upload', display, 0, 0, true, err.message)
            reject(err)
            return
          }
          // Keep the real byte counts so the completed row doesn't show "1 B / 1 B".
          this.emitTransfer(sftpRuntime, transferId, 'upload', display, lastTransferred, lastTotal, true)
          resolve()
        }
      )
    })
  }

  async download(sessionId: string, remotePath: string, localPath: string): Promise<void> {
    const resolved = await this.resolveRemotePath(sessionId, remotePath)
    const stats = await this.statPath(sessionId, resolved)
    if (stats.isDir) {
      const localParent = localPath
      const target = join(localParent, remoteBasename(resolved))
      await this.downloadDir(sessionId, resolved, target, remoteBasename(resolved))
      return
    }

    let target = localPath
    try {
      const localStats = await fsp.stat(localPath)
      if (localStats.isDirectory()) target = join(localPath, remoteBasename(resolved))
    } catch {
      /* path does not exist yet */
    }
    await this.getFile(sessionId, resolved, target, remoteBasename(resolved))
  }

  private async downloadDir(
    sessionId: string,
    remoteDir: string,
    localDir: string,
    displayRoot: string
  ): Promise<void> {
    await fsp.mkdir(localDir, { recursive: true })
    const entries = await this.listDir(sessionId, remoteDir)
    for (const entry of entries) {
      const to = join(localDir, entry.name)
      const display = `${displayRoot}/${entry.name}`
      if (entry.isDir) {
        await this.downloadDir(sessionId, entry.path, to, display)
      } else {
        await this.getFile(sessionId, entry.path, to, display)
      }
    }
  }

  private getFile(sessionId: string, remotePath: string, localPath: string, display: string): Promise<void> {
    const rt = this.getRuntime(sessionId)
    return new Promise<void>((resolve, reject) => {
      const transferId = randomUUID()
      let lastEmit = 0
      let lastTransferred = 0
      let lastTotal = 0
      this.emitTransfer(rt, transferId, 'download', display, 0, 0, false)
      rt.sftp!.fastGet(
        remotePath,
        localPath,
        {
          concurrency: 16,
          step: (transferred: number, _chunk: number, total: number) => {
            lastTransferred = transferred
            lastTotal = total
            const now = Date.now()
            if (now - lastEmit < 120) return
            lastEmit = now
            this.emitTransfer(rt, transferId, 'download', display, transferred, total, false)
          }
        },
        (err) => {
          if (err) {
            this.emitTransfer(rt, transferId, 'download', display, 0, 0, true, err.message)
            reject(err)
            return
          }
          // Keep the real byte counts so the completed row doesn't show "1 B / 1 B".
          this.emitTransfer(rt, transferId, 'download', display, lastTransferred, lastTotal, true)
          resolve()
        }
      )
    })
  }

  private async remoteIsDirectory(sessionId: string, path: string): Promise<boolean> {
    try {
      const stats = await this.statPath(sessionId, path)
      return stats.isDir
    } catch {
      return false
    }
  }

  private emitTransfer(
    rt: Runtime,
    id: string,
    direction: 'upload' | 'download',
    name: string,
    transferred: number,
    total: number,
    done: boolean,
    error?: string
  ): void {
    const payload: TransferProgress = {
      id,
      sessionId: rt.session.id,
      direction,
      name,
      transferred,
      total,
      done,
      error
    }
    this.send('sftp:transfer', payload)
  }

  async gatherHostInfo(sessionId: string): Promise<HostInfo> {
    const script = [
      'printf "%s\\n" "$(uname -sr 2>/dev/null)"',
      'printf "%s\\n" "$(pwd 2>/dev/null)"',
      'printf "%s\\n" "$HOME"',
      '(cat /etc/os-release 2>/dev/null | head -4)'
    ].join('; ')
    try {
      const result = await this.exec(sessionId, script, { timeoutSec: 15 })
      const lines = result.stdout.split(/\r?\n/)
      const kernel = lines[0]?.trim() || undefined
      const cwd = lines[1]?.trim() || undefined
      const home = lines[2]?.trim() || undefined
      const pretty = lines.find((line) => line.startsWith('PRETTY_NAME='))
      const os = pretty
        ? pretty.replace('PRETTY_NAME=', '').replace(/^"|"$/g, '')
        : lines.slice(3).map((l) => l.trim()).filter(Boolean).join(' ')
      return { kernel, cwd, home, os: os || undefined }
    } catch {
      return {}
    }
  }

  getSessionInfo(sessionId: string): {
    session: Session
    status: ConnectionStatus
    hostInfo: HostInfo
  } {
    const rt = this.getRuntime(sessionId)
    return { session: rt.session, status: rt.status, hostInfo: rt.hostInfo }
  }

  disposeAll(): void {
    for (const id of Array.from(this.runtimes.keys())) {
      this.closeRuntime(id, true)
    }
    this.runtimes.clear()
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
