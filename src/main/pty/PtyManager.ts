import * as pty from 'node-pty'
import type { IPty } from 'node-pty'

export interface PtySpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface PtyHandlers {
  onData: (data: string) => void
  onExit: (code: number) => void
}

interface PtyRuntime {
  id: string
  proc: IPty
}

export class PtyManager {
  private terminals = new Map<string, PtyRuntime>()

  create(id: string, options: PtySpawnOptions, handlers: PtyHandlers): void {
    this.kill(id)
    const proc = pty.spawn(options.file, options.args, {
      name: 'xterm-256color',
      cols: Math.max(2, Math.floor(options.cols) || 100),
      rows: Math.max(2, Math.floor(options.rows) || 30),
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      } as Record<string, string>,
      useConpty: process.platform === 'win32' ? true : undefined
    })

    const runtime: PtyRuntime = { id, proc }
    this.terminals.set(id, runtime)

    proc.onData((data) => handlers.onData(data))
    proc.onExit(({ exitCode }) => {
      if (this.terminals.get(id) === runtime) this.terminals.delete(id)
      handlers.onExit(exitCode)
    })
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const rt = this.terminals.get(id)
    if (!rt) return
    try {
      rt.proc.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)))
    } catch {
      /* ignore resize errors on exited processes */
    }
  }

  kill(id: string): void {
    const rt = this.terminals.get(id)
    if (!rt) return
    this.terminals.delete(id)
    try {
      rt.proc.kill()
    } catch {
      /* ignore */
    }
  }

  has(id: string): boolean {
    return this.terminals.has(id)
  }

  disposeAll(): void {
    for (const id of Array.from(this.terminals.keys())) this.kill(id)
  }
}
