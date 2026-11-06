import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  File as FileIcon,
  RefreshCw,
  Search
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { formatBytes, formatTime } from '../lib/format'

export interface PaneEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink?: boolean
  size: number
  mtime: number
  mode?: number
  permissions?: string
}

interface FilePaneProps {
  title: string
  subtitle?: string
  path: string
  entries: PaneEntry[]
  loading?: boolean
  error?: string
  selectedPaths: string[]
  emptyHint: string
  showPermissions?: boolean
  dragType: 'local' | 'remote'
  acceptDragType?: 'local' | 'remote'
  onSelectionChange: (paths: string[]) => void
  onOpen: (entry: PaneEntry) => void
  onNavigate: (path: string) => void
  onBack?: () => void
  onForward?: () => void
  onUp: () => void
  onHome?: () => void
  onRefresh: () => void
  onContextMenu: (event: MouseEvent, entry: PaneEntry | null) => void
  onDropEntries?: (entries: PaneEntry[], type: 'local' | 'remote') => void
  onDropFiles?: (files: File[]) => void
  // Rendered next to the up button, replacing the home button when onHome is
  // omitted (e.g. the local pane uses a directory switcher there).
  leadingToolbar?: ReactNode
  toolbar?: ReactNode
}

export function FilePane({
  title,
  subtitle,
  path,
  entries,
  loading,
  error,
  selectedPaths,
  emptyHint,
  showPermissions,
  dragType,
  acceptDragType,
  onSelectionChange,
  onOpen,
  onNavigate,
  onBack,
  onForward,
  onUp,
  onHome,
  onRefresh,
  onContextMenu,
  onDropEntries,
  onDropFiles,
  leadingToolbar,
  toolbar
}: FilePaneProps) {
  const [editingPath, setEditingPath] = useState(path)
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    setEditingPath(path)
  }, [path])

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase()
    const list = term
      ? entries.filter((entry) => entry.name.toLowerCase().includes(term))
      : entries
    return list.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  }, [entries, filter])

  const selected = useMemo(() => new Set(selectedPaths), [selectedPaths])

  const handleRowClick = (entry: PaneEntry, event: MouseEvent<HTMLTableRowElement>): void => {
    // The second click of a double-click must not toggle the row back off.
    if (event.detail > 1) return
    onSelectionChange(
      selected.has(entry.path)
        ? selectedPaths.filter((item) => item !== entry.path)
        : [...selectedPaths, entry.path]
    )
  }

  const openEntry = (entry: PaneEntry): void => {
    if (!selected.has(entry.path)) onSelectionChange([...selectedPaths, entry.path])
    onOpen(entry)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragOver(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length && onDropFiles) {
      onDropFiles(files)
      return
    }
    if (!onDropEntries || !acceptDragType) return
    const raw = event.dataTransfer.getData(`application/x-aishell-${acceptDragType}`)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as PaneEntry | PaneEntry[]
      const list = Array.isArray(parsed) ? parsed : [parsed]
      if (list.length) onDropEntries(list, acceptDragType)
    } catch {
      /* ignore malformed drag payload */
    }
  }

  return (
    // @container lets the toolbar and table shed optional controls/columns as
    // the pane narrows (e.g. after widening the agent panel), instead of
    // squeezing the name column and letting the header overflow.
    <div
      className={`@container flex min-h-0 min-w-0 flex-1 flex-col bg-panel/40 transition ${
        dragOver ? 'ring-1 ring-inset ring-accent/60' : ''
      }`}
      onDragOver={(event) => {
        if (!acceptDragType) return
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-hidden border-b border-line/70 px-2">
        <span className="mr-1 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-faint">
          {title}
        </span>
        {subtitle && (
          <span className="mr-1 hidden shrink-0 text-[10px] text-faint @min-[600px]:inline">
            {subtitle}
          </span>
        )}
        <button
          className="icon-btn hidden h-6 w-6 @min-[320px]:inline-flex"
          title="后退"
          disabled={!onBack}
          onClick={onBack}
        >
          <ArrowLeft size={12} />
        </button>
        <button
          className="icon-btn hidden h-6 w-6 @min-[320px]:inline-flex"
          title="前进"
          disabled={!onForward}
          onClick={onForward}
        >
          <ArrowRight size={12} />
        </button>
        <button className="icon-btn h-6 w-6" title="上级目录" onClick={onUp}>
          <ArrowUp size={12} />
        </button>
        {onHome && (
          <button
            className="icon-btn hidden h-6 w-6 @min-[320px]:inline-flex"
            title="主目录"
            onClick={onHome}
          >
            <FolderOpen size={12} />
          </button>
        )}
        <div className="hidden @min-[300px]:contents">{leadingToolbar}</div>
        <input
          className="mx-1 min-w-0 flex-1 rounded border border-transparent bg-base/60 px-2 py-0.5 font-mono text-[10px] text-ink outline-none transition focus:border-accent/40"
          value={editingPath}
          spellCheck={false}
          onChange={(event) => setEditingPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onNavigate(editingPath.trim())
              // If the navigation fails, fall back to the directory still on
              // screen instead of leaving the rejected path in the bar.
              setEditingPath(path)
            }
            if (event.key === 'Escape') setEditingPath(path)
          }}
          onBlur={() => setEditingPath(path)}
        />
        <div className="relative hidden shrink-0 @min-[400px]:block">
          <Search size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            className="w-24 rounded bg-base/60 py-0.5 pl-5 pr-1.5 text-[10px] text-ink outline-none placeholder:text-faint focus:w-32"
            placeholder="筛选"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <button className="icon-btn h-6 w-6" title="刷新" onClick={onRefresh}>
          <RefreshCw size={12} className={loading ? 'animate-spin text-accent' : ''} />
        </button>
        <div className="hidden @min-[260px]:contents">{toolbar}</div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto"
        onClick={(event) => {
          // Clicking the empty area below the rows clears the selection.
          if (!(event.target as HTMLElement).closest('tr')) onSelectionChange([])
        }}
        onContextMenu={(event) => {
          // Rows handle their own menu; this covers the empty area.
          if ((event.target as HTMLElement).closest('tr')) return
          event.preventDefault()
          onContextMenu(event, null)
        }}
      >
        {error ? (
          <div className="px-3 py-6 text-center text-[11px] text-err">{error}</div>
        ) : visible.length === 0 && !loading ? (
          <div className="px-3 py-8 text-center text-[11px] text-faint">{emptyHint}</div>
        ) : (
          <table className="w-full table-fixed border-collapse text-[11px]">
            <thead className="sticky top-0 z-[1] bg-panel-2/95 text-[10px] text-faint backdrop-blur">
              <tr>
                <th className="w-6 px-1" />
                <th className="px-1 py-1 text-left font-medium">名称</th>
                {showPermissions && (
                  <th className="hidden w-[76px] px-1 py-1 text-left font-medium @min-[440px]:table-cell">
                    权限
                  </th>
                )}
                <th className="hidden w-[74px] px-1 py-1 text-right font-medium @min-[220px]:table-cell">
                  大小
                </th>
                <th className="hidden w-[112px] px-1 py-1 text-right font-medium @min-[340px]:table-cell">
                  修改时间
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const isSelected = selected.has(entry.path)
                return (
                  <tr
                    key={entry.path}
                    draggable
                    onDragStart={(event) => {
                      const payload = isSelected
                        ? visible.filter((item) => selected.has(item.path))
                        : [entry]
                      if (!isSelected) onSelectionChange([entry.path])
                      event.dataTransfer.effectAllowed = 'copy'
                      event.dataTransfer.setData(
                        `application/x-aishell-${dragType}`,
                        JSON.stringify(payload)
                      )
                    }}
                    className={`cursor-pointer select-none ${
                      isSelected ? 'bg-accent/15 text-ink' : 'hover:bg-panel-2/80 text-dim'
                    }`}
                    onClick={(event) => handleRowClick(entry, event)}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      if (!isSelected) onSelectionChange([entry.path])
                      onContextMenu(event, entry)
                    }}
                  >
                    <td className="pl-2 text-faint">
                      {entry.isDir ? (
                        <Folder size={12} className="text-accent/80" />
                      ) : entry.isSymlink ? (
                        <Link2 size={12} className="text-warn/80" />
                      ) : (
                        <FileIcon size={12} className="text-faint" />
                      )}
                    </td>
                    <td className="truncate px-1 py-[3px]" title={entry.name}>
                      {entry.name}
                    </td>
                    {showPermissions && (
                      <td className="hidden px-1 py-[3px] font-mono text-[10px] text-faint @min-[440px]:table-cell">
                        {entry.permissions ?? ''}
                      </td>
                    )}
                    <td className="hidden px-1 py-[3px] text-right font-mono text-[10px] text-faint @min-[220px]:table-cell">
                      {entry.isDir ? '—' : formatBytes(entry.size)}
                    </td>
                    <td className="hidden px-1 py-[3px] text-right text-[10px] text-faint @min-[340px]:table-cell">
                      {formatTime(entry.mtime)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {loading && visible.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-[11px] text-faint">
            <Loader2 size={12} className="animate-spin" /> 加载中…
          </div>
        )}
      </div>
    </div>
  )
}
