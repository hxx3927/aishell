import type { Terminal } from '@xterm/xterm'
import type { Settings } from '@shared/types'
import { useAppStore } from '../state/store'

/**
 * Applies the paste preferences and writes the text into `term`. Every paste
 * path (Ctrl+Shift+V, right-click, context menu) goes through here so the
 * guard and trimming behave the same everywhere.
 */
export async function pasteIntoTerminal(term: Terminal, settings: Settings): Promise<void> {
  const raw = await window.aishell.clipboard.readText()
  if (!raw) return
  await writePaste(term, raw, settings)
  term.focus()
}

/**
 * The focused xterm textarea turns every native paste (Ctrl+Shift+V, Ctrl+V,
 * Shift+Insert, middle-click) into terminal input. Capturing the event here
 * lets the preferences apply to those paths too. Returns a disposer; call it
 * after xterm is opened.
 */
export function interceptNativePaste(term: Terminal): () => void {
  const textarea = term.textarea
  if (!textarea) return () => undefined
  const handler = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    event.stopPropagation()
    void pasteTextIntoTerminal(term, text, useAppStore.getState().settings)
  }
  textarea.addEventListener('paste', handler, true)
  return () => textarea.removeEventListener('paste', handler, true)
}

/** Pastes already-read clipboard text (used by the context menu). */
export async function pasteTextIntoTerminal(
  term: Terminal,
  text: string,
  settings: Settings
): Promise<void> {
  await writePaste(term, text, settings)
  term.focus()
}

async function writePaste(term: Terminal, raw: string, settings: Settings): Promise<void> {
  const text = settings.trimPaste ? raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') : raw
  if (!text) return
  if (settings.pasteLineBreakGuard && (text.match(/\n/g)?.length ?? 0) >= 2) {
    const ok = await useAppStore.getState().confirm({
      title: '粘贴多行文本',
      message:
        `剪贴板中有 ${(text.match(/\n/g)?.length ?? 0) + 1} 行内容，粘贴后可能被立即逐行执行：\n\n` +
        `${text.length > 400 ? `${text.slice(0, 400)}…` : text}`,
      confirmText: '仍然粘贴'
    })
    if (!ok) return
  }
  term.paste(text)
}
