import type { ITheme } from '@xterm/xterm'
import type { ThemeMode } from '@shared/types'

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1d1d1f',
  cursor: '#0071e3',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0, 113, 227, 0.18)',
  black: '#1d1d1f',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

const DARK: ITheme = {
  background: '#1c1c1e',
  foreground: '#f5f5f7',
  cursor: '#0a84ff',
  cursorAccent: '#1c1c1e',
  selectionBackground: 'rgba(10, 132, 255, 0.3)',
  black: '#3a3a3c',
  red: '#ff453a',
  green: '#30d158',
  yellow: '#ffd60a',
  blue: '#0a84ff',
  magenta: '#bf5af2',
  cyan: '#64d2ff',
  white: '#f5f5f7',
  brightBlack: '#636366',
  brightRed: '#ff6961',
  brightGreen: '#5ee07a',
  brightYellow: '#ffe066',
  brightBlue: '#409cff',
  brightMagenta: '#da8fff',
  brightCyan: '#70d7ff',
  brightWhite: '#ffffff'
}

export function terminalTheme(mode: ThemeMode): ITheme {
  return mode === 'light' ? LIGHT : DARK
}

export function agentTerminalTheme(mode: ThemeMode): ITheme {
  const base = terminalTheme(mode)
  return {
    ...base,
    cursor: mode === 'light' ? '#5856d6' : '#5e5ce6',
    cursorAccent: base.background,
    selectionBackground:
      mode === 'light' ? 'rgba(88, 86, 214, 0.18)' : 'rgba(94, 92, 230, 0.32)'
  }
}
