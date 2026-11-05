import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { AgentRuntime } from '@shared/types'
import { agentTerminalTheme } from '../lib/termTheme'
import { useAppStore } from '../state/store'

interface AgentTerminalProps {
  runtime: AgentRuntime
  visible: boolean
}

export function AgentTerminal({ runtime, visible }: AgentTerminalProps) {
  const settings = useAppStore((s) => s.settings)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(visible)
  const sizeRef = useRef({ cols: 0, rows: 0 })

  useEffect(() => {
    visibleRef.current = visible
    if (visible) {
      const timer = setTimeout(() => {
        try {
          fitRef.current?.fit()
        } catch {
          /* ignore */
        }
        termRef.current?.focus()
      }, 30)
      return () => clearTimeout(timer)
    }
  }, [visible])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const agentSessionId = runtime.agentSessionId

    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      theme: agentTerminalTheme(settings.theme)
    })
    const fit = new FitAddon()
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(unicode)
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.aishell.shell.openExternal(uri)
      })
    )
    try {
      term.unicode.activeVersion = '11'
    } catch {
      /* ignore */
    }

    term.open(container)
    termRef.current = term
    fitRef.current = fit

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.shiftKey && event.code === 'KeyC') {
        const selection = term.getSelection()
        if (selection) void window.aishell.clipboard.writeText(selection)
        return false
      }
      // Ctrl+Shift+V is handled natively by xterm's textarea paste event.
      return true
    })

    const inputDisposable = term.onData((data) => {
      void window.aishell.agent.input(agentSessionId, data)
    })

    const unsubData = window.aishell.on('agent:data', (event) => {
      if (event.agentSessionId !== agentSessionId) return
      term.write(event.data)
    })

    const unsubExit = window.aishell.on('agent:exit', (event) => {
      if (event.agentSessionId !== agentSessionId) return
      term.write(`\r\n\x1b[90m[Agent 已退出，代码 ${event.code}]\x1b[0m\r\n`)
    })

    const observer = new ResizeObserver(() => {
      if (!visibleRef.current) return
      try {
        fit.fit()
      } catch {
        return
      }
      if (term.cols !== sizeRef.current.cols || term.rows !== sizeRef.current.rows) {
        sizeRef.current = { cols: term.cols, rows: term.rows }
        void window.aishell.agent.resize(agentSessionId, term.cols, term.rows)
      }
    })
    observer.observe(container)

    const timer = setTimeout(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      sizeRef.current = { cols: term.cols, rows: term.rows }
      void window.aishell.agent.resize(agentSessionId, term.cols, term.rows)
      term.focus()
    }, 80)

    return () => {
      clearTimeout(timer)
      observer.disconnect()
      inputDisposable.dispose()
      unsubData()
      unsubExit()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.agentSessionId, settings.fontFamily, settings.fontSize])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = agentTerminalTheme(settings.theme)
  }, [settings.theme])

  return <div ref={containerRef} className="absolute inset-0" />
}
