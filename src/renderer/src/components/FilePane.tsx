import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  Maximize2,
  File as FileIcon,
  RefreshCw,
  RotateCcw,
  Search
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { clamp, formatBytes, formatTime } from '../lib/format'
import { ContextMenu } from './ContextMenu'

/** Columns the user can widen or narrow by dragging the header divider. */
const COL_KEYS = ['name', 'perms', 'size', 'time'] as const
type ColKey = (typeof COL_KEYS)[number]
type ColWidths = Partial<Record<ColKey, number>>

/** Smallest width a column can be dragged to, in px. */
const MIN_COL_PX: Record<ColKey, number> = { name: 140, perms: 64, size: 52, time: 96 }
const MAX_COL_PX = 4000

interface ColDrag {
  key: ColKey
  startX: number
  startWidth: number
  /** Every visible column's px width at pointerdown, so the first drag can
   *  freeze the responsive default layout without the columns jumping. */
  base: ColWidths
  latest: ColWidths
  /** Boundary position inside the scroller's content, for the drag guide. */
  boundaryX: number
  guideHeight: number
  moved: boolean
}

/**
 * Widths are saved in px, per pane. A pane without saved widths keeps the
 * responsive percentage layout; the first drag freezes the rendered widths,
 * and from then on dragging a divider changes only that column — the empty
 * space at the right absorbs the difference, the way Explorer/Finder work.
 */
function readColWidths(storageKey: string): ColWidths | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const widths: ColWidths = {}
    for (const key of COL_KEYS) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        widths[key] = clamp(Math.round(value), MIN_COL_PX[key], MAX_COL_PX)
      }
    }
    return Object.keys(widths).length ? widths : null
  } catch {
    return null
  }
}

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

  const colStorageKey = `aishell.fileCols.v2.${dragType}`
  const [colWidths, setColWidths] = useState<ColWidths | null>(() =>
    readColWidths(colStorageKey)
  )
  const [activeCol, setActiveCol] = useState<ColKey | null>(null)
  const [guide, setGuide] = useState<{ x: number; height: number } | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{
    x: number
    y: number
    key: ColKey
  } | null>(null)
  const colDrag = useRef<ColDrag | null>(null)
  /** A drag that ends close to a click must not be read as a double-click. */
  const lastDragEnd = useRef(0)
  const tableRef = useRef<HTMLTableElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Drop the old percentage layout so every pane starts from the default
  // proportions instead of inheriting a stale, half-broken width set.
  useEffect(() => {
    try {
      localStorage.removeItem(`aishell.fileCols.${dragType}`)
    } catch {
      /* ignore */
    }
  }, [dragType])

  // If a drag is interrupted by an unmount, don't leave the window stuck with
  // a resize cursor and text selection disabled.
  useEffect(
    () => () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    },
    []
  )

  const widthStyle = (key: ColKey): { width: string } | undefined =>
    colWidths?.[key] != null ? { width: `${colWidths[key]}px` } : undefined

  const visibleCols = (table: HTMLTableElement): HTMLTableCellElement[] =>
    Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th[data-col]')).filter(
      (th) => getComputedStyle(th).display !== 'none'
    )

  const snapshotWidths = (table: HTMLTableElement): ColWidths => {
    const widths: ColWidths = {}
    for (const th of visibleCols(table)) {
      widths[th.dataset.col as ColKey] = th.getBoundingClientRect().width
    }
    return widths
  }

  const persistWidths = (widths: ColWidths): void => {
    try {
      localStorage.setItem(colStorageKey, JSON.stringify(widths))
    } catch {
      /* ignore */
    }
  }

  const setDragCursor = (active: boolean): void => {
    document.body.style.cursor = active ? 'col-resize' : ''
    document.body.style.userSelect = active ? 'none' : ''
  }

  const startColResize = (
    event: ReactPointerEvent<HTMLSpanElement>,
    key: ColKey
  ): void => {
    event.preventDefault()
    const table = tableRef.current
    const scroller = scrollerRef.current
    if (!table || !scroller) return
    const th = table.querySelector<HTMLTableCellElement>(`thead th[data-col="${key}"]`)
    if (!th) return
    const base = snapshotWidths(table)
    const startWidth = base[key]
    if (startWidth == null) return
    const thRect = th.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    colDrag.current = {
      key,
      startX: event.clientX,
      startWidth,
      base,
      latest: base,
      boundaryX: thRect.right - scrollerRect.left + scroller.scrollLeft,
      guideHeight: scroller.scrollHeight,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setActiveCol(key)
    setDragCursor(true)
  }

  const moveColResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const drag = colDrag.current
    if (!drag) return
    const delta = event.clientX - drag.startX
    if (!drag.moved && Math.abs(delta) < 2) return
    drag.moved = true
    const width = clamp(drag.startWidth + delta, MIN_COL_PX[drag.key], MAX_COL_PX)
    drag.latest = { ...drag.base, [drag.key]: width }
    setColWidths(drag.latest)
    setGuide({ x: drag.boundaryX + (width - drag.startWidth), height: drag.guideHeight })
  }

  const endColResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const drag = colDrag.current
    if (!drag) return
    colDrag.current = null
    setActiveCol(null)
    setGuide(null)
    setDragCursor(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    if (!drag.moved) return
    lastDragEnd.current = Date.now()
    persistWidths(drag.latest)
  }

  /** Size a column to its content, the double-click convention of Explorer
   *  and Excel. Measured with an auto layout in one synchronous pass and then
   *  restored, so the user never sees the temporary layout. */
  const fitColumn = (key: ColKey): void => {
    const table = tableRef.current
    const scroller = scrollerRef.current
    if (!table) return
    const ths = visibleCols(table)
    const snapshot = snapshotWidths(table)
    const available = scroller?.clientWidth || table.getBoundingClientRect().width
    const prevLayout = table.style.tableLayout
    const prevWidth = table.style.width
    const prevTh = ths.map((th) => th.style.width)

    table.style.tableLayout = 'auto'
    table.style.width = 'max-content'
    for (const th of ths) th.style.width = 'auto'
    const natural: ColWidths = {}
    for (const th of ths) natural[th.dataset.col as ColKey] = th.getBoundingClientRect().width

    table.style.tableLayout = prevLayout
    table.style.width = prevWidth
    ths.forEach((th, index) => {
      th.style.width = prevTh[index]
    })

    const otherWidth = ths.reduce(
      (sum, th) =>
        th.dataset.col === key ? sum : sum + (snapshot[th.dataset.col as ColKey] ?? 0),
      0
    )
    const maxWidth = Math.max(MIN_COL_PX[key], available - otherWidth)
    const next = {
      ...snapshot,
      [key]: clamp(natural[key] ?? snapshot[key] ?? MIN_COL_PX[key], MIN_COL_PX[key], maxWidth)
    }
    setColWidths(next)
    persistWidths(next)
  }

  const resetColWidths = (): void => {
    colDrag.current = null
    setActiveCol(null)
    setGuide(null)
    setColWidths(null)
    try {
      localStorage.removeItem(colStorageKey)
    } catch {
      /* ignore */
    }
  }

  // The grip on a column boundary. The hit area is wider than the visible
  // line so the boundary is easy to grab; the line grows into a full-height
  // accent bar on hover/drag, like Explorer and VS Code sashes.
  const colResizeHandle = (key: ColKey, visibleClass: string): ReactNode => {
    const active = activeCol === key
    return (
      <span
        className={`group/col absolute right-0 top-0 z-[2] flex h-full w-2.5 cursor-col-resize touch-none select-none items-center justify-end ${visibleClass}`}
        title="拖动调整列宽，双击适应内容，右键更多"
        onPointerDown={(event) => startColResize(event, key)}
        onPointerMove={moveColResize}
        onPointerUp={endColResize}
        onPointerCancel={endColResize}
        onDoubleClick={() => {
          if (Date.now() - lastDragEnd.current < 350) return
          fitColumn(key)
        }}
      >
        <span
          className={`pointer-events-none rounded-full transition-all duration-150 ${
            active
              ? 'h-full w-0.5 bg-accent'
              : 'h-2.5 w-px bg-line-2 group-hover/col:h-full group-hover/col:w-0.5 group-hover/col:bg-accent'
          }`}
        />
      </span>
    )
  }

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
        ref={scrollerRef}
        className="relative min-h-0 flex-1 overflow-auto"
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
        {guide && (
          <div
            className="pointer-events-none absolute top-0 z-[3] w-px bg-accent/70"
            style={{ left: guide.x, height: guide.height }}
          />
        )}
        {error ? (
          <div className="px-3 py-6 text-center text-[11px] text-err">{error}</div>
        ) : visible.length === 0 && !loading ? (
          <div className="px-3 py-8 text-center text-[11px] text-faint">{emptyHint}</div>
        ) : (
          <table ref={tableRef} className="w-full table-fixed border-collapse text-[11px]">
            <thead
              className="sticky top-0 z-[1] bg-panel-2/95 text-[10px] text-faint backdrop-blur"
              onContextMenu={(event) => {
                const th = (event.target as HTMLElement).closest('th[data-col]')
                if (!th) return
                event.preventDefault()
                event.stopPropagation()
                setHeaderMenu({
                  x: event.clientX,
                  y: event.clientY,
                  key: (th as HTMLTableCellElement).dataset.col as ColKey
                })
              }}
            >
              <tr>
                {/* Without saved widths the pane keeps this responsive
                    proportion; the first drag switches to saved px widths and
                    the trailing spacer column absorbs the leftover space. */}
                <th
                  data-col="name"
                  className="relative w-[46%] py-1 pl-2 pr-1 text-left font-medium"
                  style={widthStyle('name')}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 shrink-0" aria-hidden />
                    名称
                  </span>
                  {colResizeHandle('name', '')}
                </th>
                {showPermissions && (
                  <th
                    data-col="perms"
                    className="relative hidden w-[76px] px-1 py-1 text-left font-medium @min-[440px]:table-cell"
                    style={widthStyle('perms')}
                  >
                    权限
                    {colResizeHandle('perms', 'hidden @min-[440px]:flex')}
                  </th>
                )}
                <th
                  data-col="size"
                  className="relative hidden w-[74px] py-1 pl-1 pr-2 text-right font-medium @min-[220px]:table-cell"
                  style={widthStyle('size')}
                >
                  大小
                  {colResizeHandle('size', 'hidden @min-[220px]:flex')}
                </th>
                <th
                  data-col="time"
                  className="relative hidden w-[112px] py-1 pl-1 pr-2 text-right font-medium @min-[340px]:table-cell"
                  style={widthStyle('time')}
                >
                  修改时间
                  {colResizeHandle('time', 'hidden @min-[340px]:flex')}
                </th>
                {colWidths && <th aria-hidden className="p-0" />}
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
                    <td className="py-[3px] pl-2 pr-1" title={entry.name}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0">
                          {entry.isDir ? (
                            <Folder size={12} className="text-accent/80" />
                          ) : entry.isSymlink ? (
                            <Link2 size={12} className="text-warn/80" />
                          ) : (
                            <FileIcon size={12} className="text-faint" />
                          )}
                        </span>
                        <span className="truncate">{entry.name}</span>
                      </span>
                    </td>
                    {showPermissions && (
                      <td className="hidden px-1 py-[3px] font-mono text-[10px] text-faint @min-[440px]:table-cell">
                        {entry.permissions ?? ''}
                      </td>
                    )}
                    <td className="hidden py-[3px] pl-1 pr-2 text-right font-mono text-[10px] text-faint @min-[220px]:table-cell">
                      {entry.isDir ? '—' : formatBytes(entry.size)}
                    </td>
                    <td className="hidden py-[3px] pl-1 pr-2 text-right text-[10px] text-faint @min-[340px]:table-cell">
                      {formatTime(entry.mtime)}
                    </td>
                    {colWidths && <td aria-hidden className="p-0" />}
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

      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          items={[
            {
              label: '适应内容',
              icon: <Maximize2 size={13} />,
              onClick: () => fitColumn(headerMenu.key)
            },
            {
              label: '恢复默认列宽',
              icon: <RotateCcw size={13} />,
              onClick: resetColWidths
            }
          ]}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </div>
  )
}
