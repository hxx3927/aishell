import { BrowserWindow } from 'electron'
import type { ThemeMode } from '@shared/types'

export function windowChrome(theme: ThemeMode): {
  color: string
  symbolColor: string
} {
  return theme === 'light'
    ? { color: '#f5f5f7', symbolColor: '#3a3a3c' }
    : { color: '#1c1c1e', symbolColor: '#d1d1d6' }
}

export function applyThemeChrome(theme: ThemeMode): void {
  const chrome = windowChrome(theme)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.setBackgroundColor(chrome.color)
    if (process.platform === 'win32') {
      try {
        win.setTitleBarOverlay({ ...chrome, height: 40 })
      } catch {
        /* overlay is only available with a hidden title bar */
      }
    }
  }
}
