import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'
import { AlertTriangle, Download, Loader2, RefreshCw, Save, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sessionConnection, useAppStore, type Tab } from '../state/store'
import { fileExtension, formatBytes } from '../lib/format'

interface FileEditorProps {
  tab: Tab
  visible: boolean
}

function languageFor(name: string): { label: string; extension: Extension | null } {
  const ext = fileExtension(name)
  switch (ext) {
    case 'js':
      return { label: 'JavaScript', extension: javascript() }
    case 'jsx':
      return { label: 'JSX', extension: javascript({ jsx: true }) }
    case 'ts':
      return { label: 'TypeScript', extension: javascript({ typescript: true }) }
    case 'tsx':
      return { label: 'TSX', extension: javascript({ jsx: true, typescript: true }) }
    case 'json':
      return { label: 'JSON', extension: json() }
    case 'py':
      return { label: 'Python', extension: python() }
    case 'html':
    case 'htm':
      return { label: 'HTML', extension: html() }
    case 'css':
    case 'scss':
    case 'less':
      return { label: 'CSS', extension: css() }
    case 'md':
    case 'markdown':
      return { label: 'Markdown', extension: markdown() }
    case 'xml':
    case 'svg':
      return { label: 'XML', extension: xml() }
    case 'sql':
      return { label: 'SQL', extension: sql() }
    case 'yaml':
    case 'yml':
      return { label: 'YAML', extension: yaml() }
    default:
      return { label: ext ? ext.toUpperCase() : '纯文本', extension: null }
  }
}

export function FileEditor({ tab, visible }: FileEditorProps) {
  // Only file tabs reach this component, so a session is always present.
  const sessionId = tab.sessionId ?? ''
  const path = tab.path ?? ''
  const connection = useAppStore((s) => sessionConnection(s.connections, sessionId))
  const updateTab = useAppStore((s) => s.updateTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const pushToast = useAppStore((s) => s.pushToast)
  const confirm = useAppStore((s) => s.confirm)

  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [size, setSize] = useState(0)
  const [binary, setBinary] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const localDownloadDir = useAppStore((s) => s.settings.localStartPath)
  const themeMode = useAppStore((s) => s.settings.theme)

  const contentRef = useRef(content)
  contentRef.current = content
  const originalRef = useRef(original)
  originalRef.current = original

  const language = useMemo(() => languageFor(tab.title || path), [tab.title, path])
  const dirty = content !== original

  useEffect(() => {
    updateTab(tab.id, { dirty })
  }, [dirty, tab.id, updateTab])

  const load = useCallback(async (): Promise<void> => {
    if (!path) return
    setLoading(true)
    setError('')
    try {
      const file = await window.aishell.sftp.readFile(sessionId, path)
      setContent(file.content)
      setOriginal(file.content)
      setSize(file.size)
      setBinary(file.binary)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [sessionId, path])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async (): Promise<void> => {
    if (binary || saving) return
    setSaving(true)
    try {
      await window.aishell.sftp.writeFile(sessionId, path, contentRef.current)
      setOriginal(contentRef.current)
      setSize(new Blob([contentRef.current]).size)
      pushToast('info', `已保存 ${path.split('/').pop()}`)
    } catch (err) {
      pushToast('error', `保存失败：${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }, [binary, path, pushToast, saving, sessionId])

  useEffect(() => {
    if (!visible) return
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save, visible])

  const reload = async (): Promise<void> => {
    if (dirty) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        message: '重新加载会丢弃当前编辑内容。',
        confirmText: '重新加载',
        danger: true
      })
      if (!ok) return
    }
    await load()
  }

  const close = (): void => {
    // Dirty checks live in the tab store so every close path (editor button,
    // tab ×, middle-click, terminal tab) asks the same question.
    closeTab(tab.id)
  }

  const download = async (): Promise<void> => {
    try {
      const base = localDownloadDir || (await window.aishell.local.home())
      const target = `${base.replace(/[\\/]+$/, '')}${
        base.includes('\\') ? '\\' : '/'
      }${path.split('/').pop()}`
      await window.aishell.sftp.download(sessionId, path, target)
      pushToast('info', `已下载到 ${target}`)
    } catch (err) {
      pushToast('error', `下载失败：${(err as Error).message}`)
    }
  }

  const extensions = useMemo(
    () => (language.extension ? [language.extension] : []),
    [language]
  )

  return (
    <div className={`h-full min-h-0 flex-col ${visible ? 'flex' : 'hidden'}`}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line/70 bg-panel/60 px-3">
        <span className="truncate font-mono text-[11px] text-dim" title={path}>
          {path}
        </span>
        {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
        <span className="chip shrink-0">{language.label}</span>
        {size > 0 && <span className="text-[10px] text-faint">{formatBytes(size)}</span>}
        {connection?.status !== 'connected' && (
          <span className="text-[10px] text-warn">连接已断开</span>
        )}
        <div className="flex-1" />
        <button className="icon-btn h-6 w-6" title="重新加载" onClick={() => void reload()}>
          <RefreshCw size={13} />
        </button>
        <button className="icon-btn h-6 w-6" title="下载到本地" onClick={() => void download()}>
          <Download size={13} />
        </button>
        <button className="icon-btn h-6 w-6" title="关闭" onClick={() => void close()}>
          <X size={13} />
        </button>
        <button
          className="btn-primary h-6 px-2.5 py-0 text-[11px]"
          disabled={binary || saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          保存
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-base">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-dim">
            <Loader2 size={14} className="animate-spin" /> 正在读取文件…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <AlertTriangle size={20} className="mx-auto text-err" />
              <div className="mt-2 text-xs text-dim">{error}</div>
            </div>
          </div>
        ) : binary ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <AlertTriangle size={20} className="mx-auto text-warn" />
              <div className="mt-2 text-xs text-dim">这是二进制文件，无法在线编辑。</div>
              <button className="btn-secondary mt-3" onClick={() => void download()}>
                <Download size={13} />
                下载到本地
              </button>
            </div>
          </div>
        ) : (
          <CodeMirror
            value={content}
            height="100%"
            theme={themeMode === 'dark' ? oneDark : undefined}
            extensions={extensions}
            onChange={(value) => setContent(value)}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: true,
              autocompletion: true,
              bracketMatching: true
            }}
            className="h-full text-[12px]"
          />
        )}
      </div>
    </div>
  )
}
