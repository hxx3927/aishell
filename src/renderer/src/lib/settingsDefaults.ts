import type { Settings } from '@shared/types'

/**
 * Renderer-side defaults, used to show "modified" markers and to reset a
 * single setting. Must stay in sync with `DEFAULT_SETTINGS` in
 * `src/main/store/SessionStore.ts`.
 */
export const SETTINGS_DEFAULTS = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  theme: 'dark',
  lineHeight: 1.25,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: false,
  rightClickAction: 'paste',
  pasteLineBreakGuard: true,
  trimPaste: true,
  bellStyle: 'off',
  shiftEnterNewline: true,
  sshKeepaliveInterval: 15000,
  sshKeepaliveCountMax: 4,
  sshReadyTimeout: 20000
} as const satisfies Partial<Settings>

/** Keys the settings UI can reset individually (excludes lists and paths). */
export type ResettableSetting = keyof typeof SETTINGS_DEFAULTS
export type ResettableValue = (typeof SETTINGS_DEFAULTS)[ResettableSetting]
