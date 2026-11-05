import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'

const MAX_PENDING = 512 * 1024
const MAX_RETURN = 64 * 1024
const INIT_TIMEOUT_MS = 15_000
const INTERRUPT_SETTLE_MS = 5_000
const IDLE_CLOSE_MS = 30 * 60_000
const MAX_LINE_BYTES = 4000

/**
 * Runs once when the shell opens: silence the terminal so command output is
 * all that comes back, and keep pagers from blocking on a keypress.
 */
const INIT_SCRIPT = [
  'stty -echo -onlcr 2>/dev/null',
  'unset HISTFILE PROMPT_COMMAND 2>/dev/null',
  'export PS1= PS2= PS4= PROMPT= RPROMPT= TERM=dumb PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat MANPAGER=cat SYSTEMD_COLORS=0',
  "bind 'set enable-bracketed-paste off' 2>/dev/null",
  'true'
].join('; ')

const INTERACTIVE =
  /(?:^|[;&|(]\s*|\bsudo\s+)(vi|vim|nvim|nano|emacs|less|more|most|top|htop|atop|iotop|man|tmux|screen|watch|mc|nmtui)(?=\s|$)/

export interface AgentShellResult {
  output: string
  /** True while the command is still running (after a timeout). */
  running: boolean
  exit_code: number | null
  /** Working directory after the command finished. */
  cwd?: string
  timed_out: boolean
  interrupted: boolean
  truncated: boolean
  /** Set when the shell itself went away while waiting. */
  shell_closed?: boolean
}

interface Pending {
  seq: number
  text: string
  dropped: number
  done: boolean
  exitCode: number | null
  cwd?: string
  interrupted: boolean
  wake: (() => void) | null
}

export interface AgentShellHandlers {
  onClose: (reason: string) => void
}

/**
 * A persistent shell on the remote host reserved for the agent, separate from
 * the user's terminal. State (cwd, exported variables, activated venvs)
 * carries over between commands.
 *
 * Completion is detected with a sentinel line printed after every command
 * rather than by parsing prompts, which vary between shells and themes.
 */
export class AgentShell {
  private readonly nonce = randomBytes(4).toString('hex')
  private readonly markerPrefix: string
  private readonly marker: RegExp
  private readonly staleMarker: RegExp
  private readonly decoder = new StringDecoder('utf8')
  private carry = ''
  private seq = 0
  private current: Pending | null = null
  private closed = false
  private idleTimer: NodeJS.Timeout | null = null
  lastUsedAt = Date.now()

  private constructor(
    private readonly channel: ClientChannel,
    private readonly handlers: AgentShellHandlers
  ) {
    this.markerPrefix = `__AIE_${this.nonce}_`
    const body = `__AIE_${this.nonce}_(\\d+):(-?\\d+):([^\\n]*?)__\\n`
    this.marker = new RegExp(`\\n${body}`, 'g')
    this.staleMarker = new RegExp(`\\n?${body}`, 'g')

    const onData = (chunk: Buffer): void => this.append(this.decoder.write(chunk))
    channel.on('data', onData)
    channel.stderr?.on('data', onData)
    channel.on('close', () => this.close('exited'))
  }

  static open(client: Client, handlers: AgentShellHandlers): Promise<AgentShell> {
    return new Promise<AgentShell>((resolve, reject) => {
      client.shell({ term: 'dumb', cols: 200, rows: 50 }, (err, channel) => {
        if (err) {
          reject(new Error(`打开持久 shell 失败：${err.message}`))
          return
        }
        const shell = new AgentShell(channel, handlers)
        shell
          .init()
          .then(() => resolve(shell))
          .catch((initErr: Error) => {
            shell.close('init_failed')
            reject(initErr)
          })
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  get busy(): boolean {
    return this.current !== null
  }

  async run(command: string, timeoutSec: number): Promise<AgentShellResult> {
    this.assertOpen()
    const interactive = INTERACTIVE.exec(command)
    if (interactive && !(interactive[1] === 'top' && /\s-\w*b/.test(command))) {
      throw new Error(
        `「${interactive[1]}」是交互式程序，持久 shell 不支持。请改用非交互方式，例如用 cat / head / tail 代替 less，用 top -bn1 代替 top，编辑文件用 write_file。`
      )
    }
    if (this.current) {
      throw new Error('上一条命令仍在运行。先用 shell_read 等待结果，或用 shell_interrupt 中断。')
    }
    const body = command.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    // A tty in canonical mode drops input past ~4 KB per line, which would
    // silently corrupt the command.
    if (body.split('\n').some((line) => Buffer.byteLength(line) > MAX_LINE_BYTES)) {
      throw new Error(
        `命令中有超过 ${MAX_LINE_BYTES} 字节的单行，终端会截断它。请拆成多行，或用 write_file 写入脚本后再执行。`
      )
    }
    const pending = this.begin()
    this.channel.write(`${body}\n${this.sentinel(pending.seq)}\n`)
    return this.wait(pending, timeoutSec * 1000)
  }

  /** Waits for more output from the command that is still running. */
  async read(timeoutSec: number): Promise<AgentShellResult> {
    this.assertOpen()
    const pending = this.current
    if (!pending) throw new Error('没有正在运行的命令')
    return this.wait(pending, timeoutSec * 1000)
  }

  async interrupt(): Promise<AgentShellResult> {
    this.assertOpen()
    const pending = this.current
    if (!pending) throw new Error('没有正在运行的命令')
    pending.interrupted = true
    this.channel.write('\x03')
    // Ctrl+C makes the terminal discard typed-ahead input, which may include
    // this command's sentinel. Ask for a fresh one; a late original is
    // stripped as stale.
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (pending.done || this.closed) return this.collect(pending, false)
    pending.seq = ++this.seq
    this.channel.write(`${this.sentinel(pending.seq)}\n`)
    return this.wait(pending, INTERRUPT_SETTLE_MS)
  }

  close(reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    try {
      this.channel.close()
    } catch {
      /* ignore */
    }
    this.current?.wake?.()
    this.handlers.onClose(reason)
  }

  private async init(): Promise<void> {
    const pending = this.begin()
    this.channel.write(`${INIT_SCRIPT}\n${this.sentinel(pending.seq)}\n`)
    const result = await this.wait(pending, INIT_TIMEOUT_MS)
    if (result.running || result.shell_closed) {
      throw new Error('持久 shell 初始化失败：远程登录 shell 可能不是 POSIX 兼容的 shell')
    }
  }

  private begin(): Pending {
    this.touch()
    const pending: Pending = {
      seq: ++this.seq,
      text: '',
      dropped: 0,
      done: false,
      exitCode: null,
      interrupted: false,
      wake: null
    }
    this.current = pending
    return pending
  }

  /**
   * Prints `__AIE_<nonce>_<seq>:<exit code>:<cwd>__`. The nonce and seq are
   * passed as arguments so the line itself, if echoed, cannot match.
   */
  private sentinel(seq: number): string {
    return `printf '\\n__AIE_%s_%s:%s:%s__\\n' ${this.nonce} ${seq} "$?" "$PWD"`
  }

  private append(data: string): void {
    if (!data) return
    let text = this.carry + data
    this.carry = ''
    if (text.endsWith('\r')) {
      this.carry = '\r'
      text = text.slice(0, -1)
    }
    text = text.replace(/\r\n/g, '\n')

    const pending = this.current
    // Output while idle (e.g. from background jobs) has no command to go to.
    if (!pending || pending.done) return

    pending.text += text
    this.marker.lastIndex = 0
    for (const match of pending.text.matchAll(this.marker)) {
      if (Number(match[1]) !== pending.seq) continue
      pending.text = pending.text.slice(0, match.index)
      pending.done = true
      pending.exitCode = Number(match[2])
      pending.cwd = match[3] || undefined
      pending.wake?.()
      return
    }
    if (pending.text.length > MAX_PENDING) {
      const cut = pending.text.length - MAX_PENDING
      pending.text = pending.text.slice(cut)
      pending.dropped += cut
    }
  }

  private wait(pending: Pending, timeoutMs: number): Promise<AgentShellResult> {
    this.touch()
    return new Promise<AgentShellResult>((resolve) => {
      if (pending.done || this.closed) {
        resolve(this.collect(pending, false))
        return
      }
      const timer = setTimeout(() => {
        pending.wake = null
        resolve(this.collect(pending, true))
      }, Math.max(1000, timeoutMs))
      pending.wake = () => {
        clearTimeout(timer)
        pending.wake = null
        resolve(this.collect(pending, false))
      }
    })
  }

  /** Returns output not yet handed out and resets the read position. */
  private collect(pending: Pending, timedOut: boolean): AgentShellResult {
    let text = pending.text
    let held = ''
    if (!pending.done && !this.closed) {
      // Keep a possibly half-received sentinel for the next read.
      const idx = text.lastIndexOf('\n')
      if (idx !== -1) {
        const rest = text.slice(idx + 1)
        if (this.markerPrefix.startsWith(rest) || rest.startsWith(this.markerPrefix)) {
          held = text.slice(idx)
          text = text.slice(0, idx)
        }
      }
    }
    pending.text = held

    let output = this.clean(text)
    let truncated = pending.dropped > 0
    pending.dropped = 0
    if (output.length > MAX_RETURN) {
      output = output.slice(-MAX_RETURN)
      truncated = true
    }

    const finished = pending.done || this.closed
    if (finished && this.current === pending) this.current = null
    this.touch()

    return {
      output,
      running: !finished,
      exit_code: pending.done ? pending.exitCode : null,
      cwd: pending.cwd,
      timed_out: timedOut && !pending.done,
      interrupted: pending.interrupted,
      truncated,
      ...(this.closed && !pending.done ? { shell_closed: true } : {})
    }
  }

  private clean(text: string): string {
    return text
      .replace(this.staleMarker, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-9A-Za-z]/g, '')
      .replace(/\r/g, '\n')
  }

  private touch(): void {
    this.lastUsedAt = Date.now()
    if (this.closed) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close('idle'), IDLE_CLOSE_MS)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('持久 shell 已关闭，请重新调用 shell_open')
  }
}
