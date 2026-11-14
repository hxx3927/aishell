import type { ITerminalOptions, Terminal } from '@xterm/xterm'
import type { Settings, ThemeMode } from '@shared/types'
import { agentTerminalTheme, terminalTheme } from './termTheme'
import { resolveTheme } from '../state/store'

/** Appearance options shared by the SSH terminal and the agent terminal. */
export function terminalAppearance(
  settings: Settings,
  resolvedTheme: ThemeMode,
  agent: boolean
): Pick<
  ITerminalOptions,
  | 'fontFamily'
  | 'fontSize'
  | 'lineHeight'
  | 'cursorBlink'
  | 'cursorStyle'
  | 'scrollback'
  | 'theme'
> {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    theme: agent ? agentTerminalTheme(resolvedTheme) : terminalTheme(resolvedTheme)
  }
}

/** Applies appearance changes to a live terminal and reports the size change. */
export function applyTerminalAppearance(
  term: Terminal,
  options: ReturnType<typeof terminalAppearance>,
  onResized: () => void
): void {
  const prevCellHeight = term.options.lineHeight
  Object.assign(term.options, options)
  // xterm only re-measures when rendered, but the fit addon needs to know the
  // row height changed; a microtask after the option write is enough.
  if (prevCellHeight !== options.lineHeight) queueMicrotask(onResized)
}
