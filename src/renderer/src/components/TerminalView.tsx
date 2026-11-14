import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import {
  Copy,
  Eraser,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Terminal as TerminalIcon,
  TextSelect
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, Settings, TermExitEvent, ThemeMode } from '@shared/types'
import { interceptNativePaste, pasteIntoTerminal } from '../lib/paste'
import { applyTerminalAppearance, terminalAppearance } from '../lib/terminalOptions'
import { resolveTheme, useAppStore } from '../state/store'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface TerminalViewProps {
  /** Connection instance this terminal owns; several may share a session. */
  connId: string
  sessionId: string
  session: Session | undefined
  visible: boolean
}

type ShellState = 'idle' | 'opening' | 'open' | 'closed'

/** A short two-tone chime, synthesised so the bell sound adds no build asset. */
function playBell(): void {
  try {
    const ctx = new AudioContext()
    const started = ctx.currentTime
    for (const [offset, freq] of [
      [0, 880],
      [0.09, 660]
    ] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, started + offset)
      gain.gain.exponentialRampToValueAtTime(0.18, started + offset + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, started + offset + 0.16)
      osc.connect(gain).connect(ctx.destination)
      osc.start(started + offset)
      osc.stop(started + offset + 0.18)
    }
    setTimeout(() => void ctx.close().catch(() => undefined), 500)
  } catch {
    // No audio device or audio is blocked: the bell is best-effort.
  }
}

function exitLabel(event: TermExitEvent): string {
  if (event.reason === 'disconnected') return '连接已断开'
  if (event.signal) return `终端进程被信号 ${event.signal} 终止`
  if (typeof event.code === 'number') return `终端进程已退出（代码 ${event.code}）`
  if (event.reason === 'dropped') return '终端通道意外关闭'
  return '终端已关闭'
}

export function TerminalView({ connId, sessionId, session, visible }: TerminalViewProps) {
  const settings = useAppStore((s) => s.settings)
  const connection = useAppStore((s) => s.connections[connId])
  const pushToast = useAppStore((s) => s.pushToast)

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const stateRef = useRef<ShellState>('idle')
  const visibleRef = useRef(visible)
  const [uiState, setUiState] = useState<ShellState>('idle')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [exitInfo, setExitInfo] = useState<TermExitEvent | null>(null)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const autoRecoveredRef = useRef(false)
  const dataSeenRef = useRef(false)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setShellState = useCallback((next: ShellState) => {
    stateRef.current = next
    setUiState(next)
  }, [])

  const fitNow = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try {
      fit.fit()
      void window.aishell.term.resize(connId, term.cols, term.rows)
    } catch {
      /* container not measurable */
    }
  }, [connId])

  const openShell = useCallback(async (manual = false) => {
    if (stateRef.current === 'opening' || stateRef.current === 'open') return
    if (retryTimer.current) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
    if (manual) autoRecoveredRef.current = false
    setExitInfo(null)
    setShellState('opening')
    try {
      const fit = fitRef.current
      if (fit) {
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
      }
      const term = termRef.current
      // Always request a fresh channel: after a renderer reload the main
      // process may still hold a shell whose output nobody saw.
      await window.aishell.term.open(connId, term?.cols ?? 100, term?.rows ?? 30, true)
      // Data can arrive before this promise settles (and a buffer written
      // during "connecting" is dropped), so show it first, wait for it, then
      // clear so the old session's output does not linger behind the banner.
      dataSeenRef.current = false
      term?.refresh(0, (term.rows || 30) - 1)
      let waited = 0
      while (!dataSeenRef.current && waited < 800) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        waited += 30
      }
      term?.clear()
      termRef.current?.focus()
      setShellState('open')
      setTimeout(() => {
        fitNow()
        termRef.current?.focus()
      }, 60)
    } catch (err) {
      setShellState('idle')
      pushToast('error', `打开终端失败：${(err as Error).message}`)
    }
  }, [connId, setShellState, fitNow, pushToast])

  useEffect(() => {
    visibleRef.current = visible
    if (!visible) return
    const timer = setTimeout(() => {
      fitNow()
      termRef.current?.focus()
    }, 30)
    return () => clearTimeout(timer)
  }, [visible, fitNow])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      ...terminalAppearance(settings, resolveTheme(settings.theme), false),
      allowProposedApi: true,
      windowsPty: { backend: 'conpty' }
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const links = new WebLinksAddon((_event, uri) => {
      void window.aishell.shell.openExternal(uri)
    })
    const unicode = new Unicode11Addon()

    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(links)
    term.loadAddon(unicode)
    try {
      term.unicode.activeVersion = '11'
    } catch {
      /* ignore */
    }

    term.open(container)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // Keyboard paste (Ctrl+Shift+V and friends) arrives as a native paste
    // event on the textarea; interceptNativePaste routes it through the
    // trim/guard preferences instead of letting xterm forward it directly.
    const keyHandler = (event: KeyboardEvent): boolean => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      if (event.shiftKey && !mod && event.code === 'Enter') {
        if (!useAppStore.getState().settings.shiftEnterNewline) return true
        event.preventDefault()
        void window.aishell.term.input(connId, '\x1b\r')
        return false
      }
      if (mod && event.shiftKey && event.code === 'KeyC') {
        const selection = term.getSelection()
        if (selection) void window.aishell.clipboard.writeText(selection)
        return false
      }
      if (mod && !event.shiftKey && event.code === 'KeyF') {
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 30)
        return false
      }
      return true
    }
    term.attachCustomKeyEventHandler((event) => keyHandler(event))
    const stopPasteIntercept = interceptNativePaste(term)

    const inputDisposable = term.onData((data) => {
      void window.aishell.term.input(connId, data)
    })

    let lastCopied = ''
    const selectionDisposable = term.onSelectionChange(() => {
      if (!useAppStore.getState().settings.copyOnSelect) return
      const selection = term.getSelection()
      if (!selection || selection === lastCopied) return
      lastCopied = selection
      void window.aishell.clipboard.writeText(selection)
    })

    // The bell has no visible effect in xterm; mirror the configured style.
    const bellDisposable = term.onBell(() => {
      const style = useAppStore.getState().settings.bellStyle
      if (style === 'off') return
      if (style === 'sound') {
        playBell()
        return
      }
      const el = containerRef.current
      if (!el) return
      el.animate(
        [
          { boxShadow: 'inset 0 0 0 9999px rgba(255, 214, 10, 0)' },
          { boxShadow: 'inset 0 0 0 9999px rgba(255, 214, 10, 0.12)' },
          { boxShadow: 'inset 0 0 0 9999px rgba(255, 214, 10, 0)' }
        ],
        { duration: 320 }
      )
    })

    const unsubData = window.aishell.on('term:data', (event) => {
      if (event.connId !== connId) return
      if (event.data.trim()) dataSeenRef.current = true
      term.write(event.data)
    })
    const unsubExit = window.aishell.on('term:exit', (event) => {
      if (event.connId !== connId) return
      stateRef.current = 'closed'
      setUiState('closed')
      setExitInfo(event)
      const stillConnected =
        useAppStore.getState().connections[connId]?.status === 'connected'
      if (event.reason === 'dropped' && stillConnected && !autoRecoveredRef.current) {
        // The SSH session is healthy; only the remote shell channel died.
        // Reopen it once automatically, then leave a manual button.
        autoRecoveredRef.current = true
        term.write('\r\n\x1b[90m[终端通道意外关闭，正在自动恢复…]\x1b[0m\r\n')
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null
          if (stateRef.current !== 'closed') return
          if (useAppStore.getState().connections[connId]?.status !== 'connected') return
          void openShell(false)
        }, 400)
      } else {
        term.write(`\r\n\x1b[90m[${exitLabel(event)}]\x1b[0m\r\n`)
      }
    })

    setTimeout(() => {
      fitNow()
      if (visibleRef.current) term.focus()
    }, 40)

    const observer = new ResizeObserver(() => {
      if (!visibleRef.current) return
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
      resizeTimer.current = setTimeout(() => fitNow(), 120)
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      stopPasteIntercept()
      inputDisposable.dispose()
      selectionDisposable.dispose()
      bellDisposable.dispose()
      unsubData()
      unsubExit()
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
      if (retryTimer.current) {
        clearTimeout(retryTimer.current)
        retryTimer.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, fitNow])

  // Appearance changes apply to the live terminal; a line-height change also
  // re-fits so the PTY learns the new grid.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    applyTerminalAppearance(
      term,
      terminalAppearance(settings, resolveTheme(settings.theme), false),
      () => setTimeout(fitNow, 20)
    )
  }, [settings, fitNow])

  useEffect(() => {
    const status = connection?.status
    if (status === 'connected' && stateRef.current === 'idle') {
      void openShell()
    }
    if (status === 'connecting' || status === 'disconnected' || status === 'error') {
      if (stateRef.current === 'open' || stateRef.current === 'opening') {
        setShellState('idle')
      }
    }
  }, [connection?.status, openShell, setShellState])

  const reconnect = async (): Promise<void> => {
    try {
      setExitInfo(null)
      autoRecoveredRef.current = false
      setUiState('idle')
      // A state event normally leaves 'idle' behind for openShell; this covers
      // the case where the last event was already 'disconnected'.
      await window.aishell.ssh.connect(connId, sessionId)
    } catch (err) {
      setUiState('idle')
      pushToast('error', `重连失败：${(err as Error).message}`)
    }
  }

  const menuItems: MenuItem[] = [
    {
      label: '复制',
      icon: <Copy size={13} />,
      disabled: !termRef.current?.hasSelection(),
      onClick: () => {
        const selection = termRef.current?.getSelection()
        if (selection) void window.aishell.clipboard.writeText(selection)
      }
    },
    {
      label: '粘贴',
      icon: <TextSelect size={13} />,
      onClick: () => {
        const term = termRef.current
        if (term) void pasteIntoTerminal(term, useAppStore.getState().settings)
      }
    },
    {
      label: '全选',
      icon: <TextSelect size={13} />,
      onClick: () => termRef.current?.selectAll()
    },
    { separator: true },
    {
      label: '查找',
      icon: <Search size={13} />,
      onClick: () => {
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 30)
      }
    },
    {
      label: '清屏',
      icon: <Eraser size={13} />,
      onClick: () => {
        termRef.current?.clear()
        termRef.current?.focus()
      }
    },
    { separator: true },
    {
      label: '重新连接',
      icon: <RefreshCw size={13} />,
      onClick: () => void reconnect()
    }
  ]

  const status = connection?.status ?? 'disconnected'
  const statusLabel =
    status === 'connected'
      ? '已连接'
      : status === 'connecting'
        ? '连接中'
        : status === 'error'
          ? '连接失败'
          : '未连接'

  return (
    <div className={`h-full min-h-0 flex-col ${visible ? 'flex' : 'hidden'}`}>
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line/70 bg-panel/60 px-3">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            status === 'connected'
              ? 'bg-ok'
              : status === 'connecting'
                ? 'bg-warn pulse-dot'
                : status === 'error'
                  ? 'bg-err'
                  : 'bg-faint'
          }`}
        />
        <span className="truncate text-[11px] text-dim">
          {session ? `${session.username}@${session.host}:${session.port}` : sessionId}
        </span>
        <span className="text-[10px] text-faint">{statusLabel}</span>
        {connection?.hostInfo?.os && (
          <span className="hidden truncate text-[10px] text-faint xl:inline">
            {connection.hostInfo.os}
          </span>
        )}
        <div className="flex-1" />
        {typeof connection?.latency === 'number' && (
          <span className="text-[10px] text-faint">{connection.latency} ms</span>
        )}
        <button
          className="icon-btn h-6 w-6"
          title="查找 (Ctrl+F)"
          onClick={() => {
            setSearchOpen((v) => !v)
            setTimeout(() => searchInputRef.current?.focus(), 30)
          }}
        >
          <Search size={13} />
        </button>
        <button
          className="icon-btn h-6 w-6"
          title="清屏"
          onClick={() => {
            termRef.current?.clear()
            termRef.current?.focus()
          }}
        >
          <Eraser size={13} />
        </button>
        <button className="icon-btn h-6 w-6" title="重新连接" onClick={() => void reconnect()}>
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-panel">
        <div
          ref={containerRef}
          className="absolute inset-0"
          onContextMenu={(event) => {
            event.preventDefault()
            const current = useAppStore.getState().settings
            // Shift+right-click always opens the menu, matching Warp and Tabby.
            if (current.rightClickAction === 'paste' && !event.shiftKey) {
              const term = termRef.current
              if (term) void pasteIntoTerminal(term, current)
              return
            }
            setMenu({ x: event.clientX, y: event.clientY })
          }}
        />

        {searchOpen && (
          <div className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-md border border-line-2 bg-panel-2/95 px-2 py-1 shadow-lg backdrop-blur">
            <Search size={12} className="text-faint" />
            <input
              ref={searchInputRef}
              className="w-44 bg-transparent text-xs text-ink outline-none placeholder:text-faint"
              placeholder="在终端中查找…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                searchRef.current?.findNext(event.target.value, { incremental: true })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (event.shiftKey) searchRef.current?.findPrevious(query)
                  else searchRef.current?.findNext(query)
                }
                if (event.key === 'Escape') {
                  setSearchOpen(false)
                  termRef.current?.focus()
                }
              }}
            />
            <button
              className="rounded px-1 text-[10px] text-faint hover:text-ink"
              onClick={() => {
                setSearchOpen(false)
                termRef.current?.focus()
              }}
            >
              关闭
            </button>
          </div>
        )}

        {status !== 'connected' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-base/70 backdrop-blur-[1px]">
            <div className="w-[340px] rounded-xl border border-line-2 bg-panel-2/95 p-5 text-center shadow-xl">
              {status === 'connecting' ? (
                <>
                  <Loader2 size={22} className="mx-auto animate-spin text-accent" />
                  <div className="mt-3 text-sm text-ink">正在连接服务器…</div>
                  <div className="mt-1 text-xs text-dim">
                    {session ? `${session.username}@${session.host}:${session.port}` : ''}
                  </div>
                </>
              ) : status === 'error' ? (
                <>
                  <ShieldAlert size={22} className="mx-auto text-err" />
                  <div className="mt-3 text-sm text-ink">连接失败</div>
                  <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-dim">
                    {connection?.error}
                  </div>
                  <button className="btn-primary mt-4" onClick={() => void reconnect()}>
                    重试
                  </button>
                </>
              ) : (
                <>
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-panel-3 text-dim">
                    <TerminalIcon size={18} />
                  </div>
                  <div className="mt-3 text-sm text-ink">连接已断开</div>
                  <div className="mt-1 text-xs text-dim">
                    {session ? `${session.username}@${session.host}:${session.port}` : ''}
                  </div>
                  <button className="btn-primary mt-4" onClick={() => void reconnect()}>
                    重新连接
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {status === 'connected' && uiState === 'closed' && (
          <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2">
            {exitInfo && <span className="text-[11px] text-faint">{exitLabel(exitInfo)}</span>}
            <button className="btn-secondary shadow-lg" onClick={() => void openShell(true)}>
              重新打开终端
            </button>
          </div>
        )}

        {menu && (
          <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
        )}
      </div>
    </div>
  )
}
