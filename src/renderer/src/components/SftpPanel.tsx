import {
  ArrowUpDown,
  ArrowUpFromLine,
  Download,
  FilePlus,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { LocalEntry, SftpEntry, TransferProgress } from '@shared/types'
import { sessionConnection, useAppStore } from '../state/store'
import {
  clamp,
  describeFsError,
  formatBytes,
  localDirname,
  localJoin,
  posixDirname,
  posixJoin
} from '../lib/format'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { FilePane, type PaneEntry } from './FilePane'
import { ResizeHandle } from './ResizeHandle'

interface SftpPanelProps {
  sessionId: string
}

interface MenuState {
  x: number
  y: number
  pane: 'local' | 'remote'
  entry: PaneEntry | null
}

const TRANSFER_POPOVER_WIDTH = 280
const TRANSFER_POS_KEY = 'aishell.transferPos'

function readTransferPos(): { x: number; y: number } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRANSFER_POS_KEY) ?? 'null') as {
      x?: unknown
      y?: unknown
    } | null
    if (
      !parsed ||
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y)
    ) {
      return null
    }
    const width = Math.min(TRANSFER_POPOVER_WIDTH, window.innerWidth - 16)
    return {
      x: clamp(parsed.x, 8, Math.max(8, window.innerWidth - width - 8)),
      y: clamp(parsed.y, 8, Math.max(8, window.innerHeight - 120))
    }
  } catch {
    return null
  }
}

export function SftpPanel({ sessionId }: SftpPanelProps) {
  const connection = useAppStore((s) => sessionConnection(s.connections, sessionId))
  const showHidden = useAppStore((s) => s.settings.showHiddenFiles ?? false)
  const localStartPath = useAppStore((s) => s.settings.localStartPath)
  const transfers = useAppStore((s) => s.transfers)
  const removeTransfer = useAppStore((s) => s.removeTransfer)
  const openFileTab = useAppStore((s) => s.openFileTab)
  const pushToast = useAppStore((s) => s.pushToast)
  const confirm = useAppStore((s) => s.confirm)
  const prompt = useAppStore((s) => s.prompt)
  const togglePanel = useAppStore((s) => s.togglePanel)

  const connected = connection?.status === 'connected'

  const [localPath, setLocalPath] = useState('')
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState('')
  const [localSel, setLocalSel] = useState<string[]>([])
  const [localBack, setLocalBack] = useState<string[]>([])
  const [localForward, setLocalForward] = useState<string[]>([])
  const [localRoots, setLocalRoots] = useState<Array<{ label: string; path: string }>>([])

  const [remotePath, setRemotePath] = useState('')
  const [remoteHome, setRemoteHome] = useState('')
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [remoteSel, setRemoteSel] = useState<string[]>([])
  const [remoteBack, setRemoteBack] = useState<string[]>([])
  const [remoteForward, setRemoteForward] = useState<string[]>([])

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [batch, setBatch] = useState<{
    kind: 'upload' | 'download' | 'delete'
    done: number
    total: number
  } | null>(null)
  const [showTransfers, setShowTransfers] = useState(false)
  const [transferPos, setTransferPos] = useState(() => readTransferPos() ?? { x: 8, y: 80 })
  const transferBtnRef = useRef<HTMLButtonElement>(null)
  const transferDrag = useRef<{
    startX: number
    startY: number
    posX: number
    posY: number
  } | null>(null)

  const toggleTransfers = (): void => {
    if (showTransfers) {
      setShowTransfers(false)
      return
    }
    const saved = readTransferPos()
    if (saved) {
      setTransferPos(saved)
      setShowTransfers(true)
      return
    }
    const rect = transferBtnRef.current?.getBoundingClientRect()
    const width = Math.min(TRANSFER_POPOVER_WIDTH, window.innerWidth - 16)
    setTransferPos({
      x: rect
        ? clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8))
        : 8,
      y: rect ? Math.min(rect.bottom + 6, window.innerHeight - 120) : 80
    })
    setShowTransfers(true)
  }

  const startTransferDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    transferDrag.current = {
      startX: event.clientX,
      startY: event.clientY,
      posX: transferPos.x,
      posY: transferPos.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveTransferDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = transferDrag.current
    if (!drag) return
    setTransferPos({
      x: clamp(
        drag.posX + event.clientX - drag.startX,
        8,
        Math.max(8, window.innerWidth - TRANSFER_POPOVER_WIDTH)
      ),
      y: clamp(drag.posY + event.clientY - drag.startY, 8, Math.max(8, window.innerHeight - 120))
    })
  }

  const endTransferDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    transferDrag.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    localStorage.setItem(TRANSFER_POS_KEY, JSON.stringify(transferPos))
  }
  const [panelHeight, setPanelHeight] = useState(() => {
    const stored = Number(localStorage.getItem('aishell.filesHeight'))
    return Number.isFinite(stored) && stored >= 140 && stored <= 900 ? stored : 218
  })

  useEffect(() => {
    localStorage.setItem('aishell.filesHeight', String(panelHeight))
  }, [panelHeight])

  const localPathRef = useRef(localPath)
  const remotePathRef = useRef(remotePath)
  localPathRef.current = localPath
  remotePathRef.current = remotePath
  // Lets a failed listing keep the previous directory on screen instead of
  // replacing it with an error message.
  const localHasEntries = useRef(false)
  localHasEntries.current = localEntries.length > 0

  const loadLocal = useCallback(
    async (target?: string, record = true): Promise<void> => {
      setLocalLoading(true)
      setLocalError('')
      const requested = target || localPathRef.current || localStartPath
      try {
        const path = requested || (await window.aishell.local.home())
        const entries = await window.aishell.local.list(path, showHidden)
        if (record && localPathRef.current && path !== localPathRef.current) {
          setLocalBack((prev) => [...prev, localPathRef.current])
          setLocalForward([])
        }
        setLocalPath(path)
        setLocalEntries(entries)
        setLocalSel([])
      } catch (err) {
        const message = describeFsError(err, requested || '所选目录')
        pushToast('error', message)
        // Keep the old listing visible; only surface it inline when there is
        // nothing else to show (e.g. an invalid start directory).
        if (!localHasEntries.current) setLocalError(message)
      } finally {
        setLocalLoading(false)
      }
    },
    [localStartPath, pushToast, showHidden]
  )

  const loadRemote = useCallback(
    async (target?: string, record = true): Promise<void> => {
      if (!connected) return
      setRemoteLoading(true)
      setRemoteError('')
      try {
        const raw = target || remotePathRef.current || remoteHome || '.'
        const real = await window.aishell.sftp.realpath(sessionId, raw)
        const entries = await window.aishell.sftp.list(sessionId, real)
        if (record && remotePathRef.current && real !== remotePathRef.current) {
          setRemoteBack((prev) => [...prev, remotePathRef.current])
          setRemoteForward([])
        }
        setRemotePath(real)
        setRemoteEntries(entries)
        setRemoteSel([])
      } catch (err) {
        setRemoteError((err as Error).message)
      } finally {
        setRemoteLoading(false)
      }
    },
    [connected, remoteHome, sessionId]
  )

  // Reset when switching sessions.
  useEffect(() => {
    setLocalPath('')
    setLocalEntries([])
    setLocalSel([])
    setLocalBack([])
    setLocalForward([])
    setRemotePath('')
    setRemoteEntries([])
    setRemoteSel([])
    setRemoteBack([])
    setRemoteForward([])
    setRemoteHome('')
    setRemoteError('')
  }, [sessionId])

  useEffect(() => {
    void loadLocal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  useEffect(() => {
    void window.aishell.local
      .roots()
      .then(setLocalRoots)
      .catch(() => undefined)
  }, [])

  // Keep only the most recent finished transfers so the list cannot grow
  // without bound over a long session.
  useEffect(() => {
    const finished = Object.values(transfers).filter(
      (transfer) => transfer.sessionId === sessionId && transfer.done
    )
    if (finished.length <= 30) return
    finished.slice(0, finished.length - 30).forEach((transfer) => removeTransfer(transfer.id))
  }, [transfers, sessionId, removeTransfer])

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    void (async () => {
      try {
        const home = await window.aishell.sftp.home(sessionId)
        if (cancelled) return
        setRemoteHome(home)
        await loadRemote(remotePathRef.current || home, Boolean(remotePathRef.current))
      } catch (err) {
        if (!cancelled) setRemoteError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionId])

  useEffect(() => {
    if (!connected) {
      setRemoteEntries([])
      setRemoteError('连接服务器后可使用文件管理')
    } else {
      setRemoteError('')
    }
  }, [connected])

  const refreshLocal = (): void => void loadLocal(localPathRef.current, false)
  const refreshRemote = (): void => void loadRemote(remotePathRef.current, false)

  const batchRef = useRef(false)

  const runBatch = async (
    kind: 'upload' | 'download',
    entries: PaneEntry[]
  ): Promise<void> => {
    if (!entries.length || batchRef.current) return
    const targetDir = kind === 'upload' ? remotePathRef.current : localPathRef.current
    if (!targetDir) return
    if (kind === 'upload' && !connected) return

    batchRef.current = true
    setBatch({ kind, done: 0, total: entries.length })
    let ok = 0
    const failures: string[] = []
    for (const entry of entries) {
      try {
        if (kind === 'upload') {
          await window.aishell.sftp.upload(
            sessionId,
            entry.path,
            posixJoin(targetDir, entry.name)
          )
        } else {
          // Pass the containing directory; SshManager appends the basename.
          // Passing the full path made directory downloads nest twice.
          await window.aishell.sftp.download(sessionId, entry.path, targetDir)
        }
        ok += 1
      } catch (err) {
        failures.push(`${entry.name}：${describeFsError(err, entry.path)}`)
      }
      setBatch((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
    }
    batchRef.current = false
    setBatch(null)

    // Only refresh the pane the files landed in, and only if the user is
    // still looking at the directory we copied them into.
    if (kind === 'upload' && remotePathRef.current === targetDir) {
      await loadRemote(targetDir, false)
    }
    if (kind === 'download' && localPathRef.current === targetDir) {
      await loadLocal(targetDir, false)
    }

    const label = kind === 'upload' ? '上传' : '下载'
    if (failures.length) {
      pushToast(
        'error',
        `${label}完成：成功 ${ok} 个，失败 ${failures.length} 个。${failures[0]}`
      )
    } else {
      pushToast('info', `${label}完成：${ok} 个`)
    }
  }

  const deleteSelection = async (): Promise<void> => {
    if (batchRef.current) return
    const isLocal = localSelEntries.length > 0
    const targets = isLocal ? localSelEntries : remoteSelEntries
    if (!targets.length) return
    if (!isLocal && !connected) return
    const side = isLocal ? '本地' : '远程'
    const ok = await confirm({
      title: `删除${side}文件`,
      message: `确定删除选中的 ${targets.length} 项${side}文件吗？${
        targets.some((entry) => entry.isDir) ? '\n目录及其内容会被递归删除。' : ''
      }`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return

    batchRef.current = true
    setBatch({ kind: 'delete', done: 0, total: targets.length })
    let done = 0
    const failures: string[] = []
    for (const entry of targets) {
      try {
        if (isLocal) {
          await window.aishell.local.remove(entry.path, entry.isDir)
        } else {
          await window.aishell.sftp.remove(sessionId, entry.path, entry.isDir)
        }
        done += 1
      } catch (err) {
        failures.push(`${entry.name}：${describeFsError(err, entry.path)}`)
      }
      setBatch((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
    }
    batchRef.current = false
    setBatch(null)

    if (isLocal) {
      await loadLocal(localPathRef.current, false)
    } else {
      await loadRemote(remotePathRef.current, false)
    }

    if (failures.length) {
      pushToast(
        'error',
        `删除完成：成功 ${done} 个，失败 ${failures.length} 个。${failures[0]}`
      )
    } else {
      pushToast('info', `删除完成：${done} 个`)
    }
  }

  const remoteRename = async (entry: PaneEntry): Promise<void> => {
    const name = await prompt({
      title: '重命名 / 移动',
      message: '输入新的路径，支持移动到其他目录。',
      value: entry.path
    })
    if (!name || name === entry.path) return
    try {
      await window.aishell.sftp.rename(sessionId, entry.path, name)
      await loadRemote(remotePath, false)
    } catch (err) {
      pushToast('error', `重命名失败：${(err as Error).message}`)
    }
  }

  const remoteDelete = async (entry: PaneEntry): Promise<void> => {
    const ok = await confirm({
      title: '删除远程文件',
      message: `确定删除 ${entry.isDir ? '目录' : '文件'}「${entry.path}」吗？${
        entry.isDir ? '\n目录及其内容会被递归删除。' : ''
      }`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await window.aishell.sftp.remove(sessionId, entry.path, entry.isDir)
      await loadRemote(remotePath, false)
    } catch (err) {
      pushToast('error', `删除失败：${(err as Error).message}`)
    }
  }

  const newRemoteFile = async (): Promise<void> => {
    const name = await prompt({
      title: '新建远程文件',
      message: '输入文件名，将创建在当前目录。',
      value: 'untitled.txt',
      validate: (input) => {
        const trimmed = input.trim()
        if (!trimmed) return '文件名不能为空'
        if (/[\\/]/.test(trimmed)) return '文件名不能包含 / 或 \\'
        if (trimmed === '.' || trimmed === '..') return '文件名不能为 . 或 ..'
        return null
      }
    })
    if (name === null) return
    const fileName = name.trim()
    const target = posixJoin(remotePath, fileName)
    try {
      await window.aishell.sftp.createFile(sessionId, target)
      await loadRemote(remotePath, false)
      openFileTab(sessionId, target, fileName)
    } catch (err) {
      pushToast('error', `创建失败：${describeFsError(err, target)}`)
    }
  }

  const newRemoteFolder = async (): Promise<void> => {
    const name = await prompt({ title: '新建远程文件夹', value: '新建文件夹' })
    if (!name) return
    const target = posixJoin(remotePath, name)
    try {
      await window.aishell.sftp.mkdir(sessionId, target)
      await loadRemote(remotePath, false)
    } catch (err) {
      pushToast('error', `创建失败：${describeFsError(err, target)}`)
    }
  }

  const localRename = async (entry: PaneEntry): Promise<void> => {
    const value = await prompt({ title: '重命名 / 移动', value: entry.path })
    if (!value || value === entry.path) return
    try {
      await window.aishell.local.rename(entry.path, value)
      await loadLocal(localPath, false)
    } catch (err) {
      pushToast('error', `重命名失败：${describeFsError(err, entry.path)}`)
    }
  }

  const localDelete = async (entry: PaneEntry): Promise<void> => {
    const ok = await confirm({
      title: '删除本地文件',
      message: `确定删除「${entry.path}」吗？${entry.isDir ? '\n目录及其内容会被递归删除。' : ''}`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await window.aishell.local.remove(entry.path, entry.isDir)
      await loadLocal(localPath, false)
    } catch (err) {
      pushToast('error', `删除失败：${describeFsError(err, entry.path)}`)
    }
  }

  const newLocalFolder = async (): Promise<void> => {
    const name = await prompt({ title: '新建本地文件夹', value: '新建文件夹' })
    if (!name) return
    try {
      await window.aishell.local.mkdir(localJoin(localPath, name))
      await loadLocal(localPath, false)
    } catch (err) {
      pushToast('error', `创建失败：${describeFsError(err, localJoin(localPath, name))}`)
    }
  }

  const openRemoteEntry = (entry: PaneEntry): void => {
    if (entry.isDir) void loadRemote(entry.path)
    else openFileTab(sessionId, entry.path, entry.name)
  }

  const openLocalEntry = (entry: PaneEntry): void => {
    if (entry.isDir) void loadLocal(entry.path)
    else void window.aishell.local.reveal(entry.path)
  }

  const localSelEntries = localEntries.filter((entry) => localSel.includes(entry.path))
  const remoteSelEntries = remoteEntries.filter((entry) => remoteSel.includes(entry.path))
  // Context-menu actions target the whole selection when the clicked row is
  // part of it, otherwise just that row.
  const menuEntries: PaneEntry[] =
    menu?.pane === 'local'
      ? localSelEntries.length
        ? localSelEntries
        : menu.entry
          ? [menu.entry]
          : []
      : remoteSelEntries.length
        ? remoteSelEntries
        : menu?.entry
          ? [menu.entry]
          : []

  const menuItems: MenuItem[] = !menu
    ? []
    : menu.pane === 'remote'
      ? menu.entry
        ? [
            {
              label: menu.entry.isDir ? '打开目录' : '在编辑器中打开',
              icon: <FolderPlus size={13} />,
              onClick: () => openRemoteEntry(menu.entry!)
            },
            {
              label:
                menuEntries.length > 1
                  ? `下载选中的 ${menuEntries.length} 项到本地`
                  : '下载到本地',
              icon: <Download size={13} />,
              onClick: () => void runBatch('download', menuEntries)
            },
            { separator: true },
            {
              label: '重命名 / 移动',
              icon: <Pencil size={13} />,
              onClick: () => void remoteRename(menu.entry!)
            },
            {
              label: '删除',
              icon: <Trash2 size={13} />,
              danger: true,
              onClick: () => void remoteDelete(menu.entry!)
            },
            { separator: true },
            {
              label: '刷新',
              icon: <RefreshCw size={13} />,
              onClick: refreshRemote
            }
          ]
        : [
            {
              label: '新建文件夹',
              icon: <FolderPlus size={13} />,
              onClick: () => void newRemoteFolder()
            },
            {
              label: '新建文件',
              icon: <FilePlus size={13} />,
              onClick: () => void newRemoteFile()
            },
            { label: '刷新', icon: <RefreshCw size={13} />, onClick: refreshRemote }
          ]
      : menu.entry
        ? [
            {
              label: menu.entry.isDir ? '打开目录' : '在资源管理器中显示',
              icon: <HardDrive size={13} />,
              onClick: () => openLocalEntry(menu.entry!)
            },
            {
              label:
                menuEntries.length > 1
                  ? `上传选中的 ${menuEntries.length} 项到远程`
                  : '上传到远程',
              icon: <ArrowUpFromLine size={13} />,
              onClick: () => void runBatch('upload', menuEntries)
            },
            { separator: true },
            {
              label: '重命名 / 移动',
              icon: <Pencil size={13} />,
              onClick: () => void localRename(menu.entry!)
            },
            {
              label: '删除',
              icon: <Trash2 size={13} />,
              danger: true,
              onClick: () => void localDelete(menu.entry!)
            },
            { separator: true },
            { label: '刷新', icon: <RefreshCw size={13} />, onClick: refreshLocal }
          ]
        : [
            {
              label: '新建文件夹',
              icon: <FolderPlus size={13} />,
              onClick: () => void newLocalFolder()
            },
            { label: '刷新', icon: <RefreshCw size={13} />, onClick: refreshLocal }
          ]

  const sessionTransfers = Object.values(transfers).filter(
    (transfer) => transfer.sessionId === sessionId
  )
  const runningTransfers = sessionTransfers.filter((transfer) => !transfer.done)
  const finishedTransfers = sessionTransfers.filter((transfer) => transfer.done)
  const visibleTransfers = [...runningTransfers, ...finishedTransfers.slice(-30)]
  const runningCount = runningTransfers.length
  const finishedCount = finishedTransfers.length

  const transferHint = !connected
    ? '未连接'
    : batch
      ? `${batch.kind === 'upload' ? '上传' : batch.kind === 'download' ? '下载' : '删除'}中 ${batch.done}/${batch.total}…`
      : localSelEntries.length
        ? localSelEntries.length === 1
          ? `已选本地「${localSelEntries[0].name}」，可上传`
          : `已选 ${localSelEntries.length} 项本地文件，可上传`
        : remoteSelEntries.length
          ? remoteSelEntries.length === 1
            ? `已选远程「${remoteSelEntries[0].name}」，可下载`
            : `已选 ${remoteSelEntries.length} 项远程文件，可下载`
          : '单击选中文件，再次单击取消；可多选，或直接拖拽到另一侧'

  return (
    <div className="flex min-h-0 flex-col border-t border-line bg-panel/20">
      <ResizeHandle
        axis="y"
        onDelta={(delta) =>
          setPanelHeight((height) =>
            clamp(height - delta, 140, Math.max(320, window.innerHeight - 360))
          )
        }
      />
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line/60 px-3">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-faint">
          文件管理
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-faint" title={transferHint}>
          {transferHint}
        </span>
        <button
          className="btn-ghost h-6 shrink-0 px-2 text-[10px]"
          disabled={!connected || localSelEntries.length === 0 || Boolean(batch)}
          title={
            !connected
              ? '连接服务器后可用'
              : localSelEntries.length
                ? `上传 ${localSelEntries.length} 项到远程 ${remotePath}`
                : '先在左侧「本地」选中文件'
          }
          onClick={() => void runBatch('upload', localSelEntries)}
        >
          <Upload size={11} />
          {batch?.kind === 'upload'
            ? `上传中 ${batch.done}/${batch.total}`
            : localSelEntries.length > 1
              ? `上传 (${localSelEntries.length})`
              : '上传'}
        </button>
        <button
          className="btn-ghost h-6 shrink-0 px-2 text-[10px]"
          disabled={!connected || remoteSelEntries.length === 0 || Boolean(batch)}
          title={
            !connected
              ? '连接服务器后可用'
              : remoteSelEntries.length
                ? `下载 ${remoteSelEntries.length} 项到本地 ${localPath}`
                : '先在右侧「远程」选中文件'
          }
          onClick={() => void runBatch('download', remoteSelEntries)}
        >
          <Download size={11} />
          {batch?.kind === 'download'
            ? `下载中 ${batch.done}/${batch.total}`
            : remoteSelEntries.length > 1
              ? `下载 (${remoteSelEntries.length})`
              : '下载'}
        </button>
        <button
          className="btn-ghost h-6 shrink-0 px-2 text-[10px] text-err/80 hover:text-err"
          disabled={
            (!localSelEntries.length && !remoteSelEntries.length) || Boolean(batch)
          }
          title={
            localSelEntries.length
              ? `删除选中的 ${localSelEntries.length} 项本地文件`
              : remoteSelEntries.length
                ? `删除选中的 ${remoteSelEntries.length} 项远程文件`
                : '先选中要删除的文件'
          }
          onClick={() => void deleteSelection()}
        >
          <Trash2 size={11} />
          {batch?.kind === 'delete'
            ? `删除中 ${batch.done}/${batch.total}`
            : (localSelEntries.length || remoteSelEntries.length) > 1
              ? `删除 (${localSelEntries.length || remoteSelEntries.length})`
              : '删除'}
        </button>
        <button
          ref={transferBtnRef}
          className="btn-ghost h-6 shrink-0 px-2 text-[10px]"
          title={showTransfers ? '收起传输记录' : '展开传输记录'}
          onClick={toggleTransfers}
        >
          {runningCount > 0 ? (
            <Loader2 size={11} className="animate-spin text-accent" />
          ) : (
            <ArrowUpDown size={11} />
          )}
          传输{runningCount > 0 ? ` (${runningCount})` : ''}
        </button>
        <button
          className="icon-btn h-6 w-6"
          title="折叠文件面板"
          onClick={() => togglePanel('files', false)}
        >
          <ArrowUpFromLine size={12} className="rotate-180" />
        </button>
      </div>

      <div className="flex min-h-0" style={{ height: panelHeight }}>
        <FilePane
          title="本地"
          path={localPath}
          entries={localEntries}
          loading={localLoading}
          error={localError}
          selectedPaths={localSel}
          emptyHint={showHidden ? '空目录' : '空目录（隐藏文件已过滤）'}
          dragType="local"
          acceptDragType="remote"
          onSelectionChange={(paths) => {
            setLocalSel(paths)
            // Local and remote selections are mutually exclusive so only one
            // direction of transfer is armed at a time.
            if (paths.length) setRemoteSel([])
          }}
          onOpen={openLocalEntry}
          onNavigate={(path) => void loadLocal(path)}
          onBack={
            localBack.length
              ? () => {
                  const prev = localBack[localBack.length - 1]
                  setLocalBack((stack) => stack.slice(0, -1))
                  setLocalForward((stack) => [...stack, localPath])
                  void loadLocal(prev, false)
                }
              : undefined
          }
          onForward={
            localForward.length
              ? () => {
                  const next = localForward[localForward.length - 1]
                  setLocalForward((stack) => stack.slice(0, -1))
                  setLocalBack((stack) => [...stack, localPath])
                  void loadLocal(next, false)
                }
              : undefined
          }
          onUp={() => void loadLocal(localDirname(localPath))}
          onRefresh={refreshLocal}
          onContextMenu={(event, entry) =>
            setMenu({ x: event.clientX, y: event.clientY, pane: 'local', entry })
          }
          onDropEntries={(entries, type) => {
            if (type === 'remote') void runBatch('download', entries)
          }}
          leadingToolbar={
            <LocalRootsMenu roots={localRoots} onPick={(path) => void loadLocal(path)} />
          }
          toolbar={
            <button
              className="icon-btn h-6 w-6"
              title="新建本地文件夹"
              onClick={() => void newLocalFolder()}
            >
              <FolderPlus size={12} />
            </button>
          }
        />

        <div className="flex w-8 shrink-0 flex-col items-center justify-center gap-1 border-x border-line/60 bg-panel/60">
          <div className="text-[9px] uppercase tracking-wider text-faint [writing-mode:vertical-rl]">
            SFTP
          </div>
        </div>

        <FilePane
          title="远程"
          subtitle={remoteHome || undefined}
          path={remotePath}
          entries={remoteEntries}
          loading={remoteLoading}
          error={!connected ? '连接服务器后可使用文件管理' : remoteError}
          selectedPaths={remoteSel}
          emptyHint="空目录"
          showPermissions
          dragType="remote"
          acceptDragType="local"
          onSelectionChange={(paths) => {
            setRemoteSel(paths)
            if (paths.length) setLocalSel([])
          }}
          onOpen={openRemoteEntry}
          onNavigate={(path) => void loadRemote(path)}
          onBack={
            remoteBack.length
              ? () => {
                  const prev = remoteBack[remoteBack.length - 1]
                  setRemoteBack((stack) => stack.slice(0, -1))
                  setRemoteForward((stack) => [...stack, remotePath])
                  void loadRemote(prev, false)
                }
              : undefined
          }
          onForward={
            remoteForward.length
              ? () => {
                  const next = remoteForward[remoteForward.length - 1]
                  setRemoteForward((stack) => stack.slice(0, -1))
                  setRemoteBack((stack) => [...stack, remotePath])
                  void loadRemote(next, false)
                }
              : undefined
          }
          onUp={() => void loadRemote(posixDirname(remotePath))}
          onHome={() => void loadRemote(remoteHome || '~')}
          onRefresh={refreshRemote}
          onContextMenu={(event, entry) =>
            setMenu({ x: event.clientX, y: event.clientY, pane: 'remote', entry })
          }
          onDropEntries={(entries, type) => {
            if (type === 'local') void runBatch('upload', entries)
          }}
          toolbar={
            <>
              <button
                className="icon-btn h-6 w-6"
                title="新建远程文件"
                disabled={!connected}
                onClick={() => void newRemoteFile()}
              >
                <FilePlus size={12} />
              </button>
              <button
                className="icon-btn h-6 w-6"
                title="新建远程文件夹"
                disabled={!connected}
                onClick={() => void newRemoteFolder()}
              >
                <FolderPlus size={12} />
              </button>
            </>
          }
        />
      </div>

      {showTransfers && (
        <div
          className="fixed z-[95] flex max-h-[70vh] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-line-2 bg-panel-2/95 shadow-2xl shadow-black/50 backdrop-blur"
          style={{
            left: transferPos.x,
            top: transferPos.y,
            width: Math.min(TRANSFER_POPOVER_WIDTH, window.innerWidth - 16)
          }}
        >
          <div
            className="flex h-7 shrink-0 cursor-move select-none items-center gap-2 border-b border-line/60 px-2.5"
            onPointerDown={startTransferDrag}
            onPointerMove={moveTransferDrag}
            onPointerUp={endTransferDrag}
            onPointerCancel={endTransferDrag}
          >
            <ArrowUpDown size={11} className="shrink-0 text-faint" />
            <span className="shrink-0 text-[10px] font-medium text-dim">传输记录</span>
            <span className="truncate text-[10px] text-faint">
              {runningCount > 0 ? `${runningCount} 进行中` : ''}
              {runningCount > 0 && finishedCount > 0 ? ' · ' : ''}
              {finishedCount > 0 ? `${finishedCount} 已完成` : ''}
            </span>
            <button
              className="ml-auto shrink-0 text-[10px] text-faint transition hover:text-ink disabled:opacity-40"
              disabled={finishedCount === 0}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                for (const transfer of finishedTransfers) removeTransfer(transfer.id)
              }}
            >
              清空已完成
            </button>
            <button
              className="icon-btn h-5 w-5 shrink-0"
              title="关闭"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setShowTransfers(false)}
            >
              <X size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleTransfers.length === 0 ? (
              <div className="px-3 py-5 text-center text-[10px] text-faint">暂无传输记录</div>
            ) : (
              visibleTransfers.map((transfer) => (
                <TransferRow key={transfer.id} transfer={transfer} />
              ))
            )}
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/**
 * Quick jump between home / common folders / drive roots. Without this the
 * local pane is stuck on whatever path it started in (usually C:).
 */
function LocalRootsMenu({
  roots,
  onPick
}: {
  roots: Array<{ label: string; path: string }>
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  if (roots.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        className="icon-btn h-6 w-6"
        title="切换磁盘 / 常用目录"
        onClick={() => setOpen((value) => !value)}
      >
        <HardDrive size={12} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 max-h-64 w-44 overflow-y-auto rounded-lg border border-line-2 bg-panel-2 py-1 shadow-xl">
          {roots.map((root) => (
            <button
              key={root.path}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-dim transition hover:bg-panel-3 hover:text-ink"
              onClick={() => {
                setOpen(false)
                onPick(root.path)
              }}
            >
              {/^[A-Za-z]:[\\/]$/.test(root.path) ? (
                <HardDrive size={11} className="shrink-0 text-faint" />
              ) : (
                <Folder size={11} className="shrink-0 text-accent/80" />
              )}
              <span className="truncate">{root.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TransferRow({ transfer }: { transfer: TransferProgress }) {
  const percent =
    transfer.total > 0 ? Math.min(100, (transfer.transferred / transfer.total) * 100) : 0
  const failed = Boolean(transfer.error)
  return (
    <div className="border-b border-line/40 px-2.5 py-1.5 last:border-b-0">
      <div className="flex items-center gap-1.5 text-[10px]">
        {transfer.done ? (
          failed ? (
            <Trash2 size={10} className="shrink-0 text-err" />
          ) : (
            <Server size={10} className="shrink-0 text-ok" />
          )
        ) : (
          <Loader2 size={10} className="shrink-0 animate-spin text-accent" />
        )}
        <span
          className="truncate text-ink"
          title={failed ? `${transfer.name}\n${transfer.error}` : transfer.name}
        >
          {transfer.direction === 'upload' ? '↑' : '↓'} {transfer.name}
        </span>
        <span className="ml-auto shrink-0 text-faint">
          {formatBytes(transfer.transferred)} / {formatBytes(transfer.total)}
        </span>
        <span
          className={`w-9 shrink-0 text-right ${
            failed ? 'text-err' : transfer.done ? 'text-ok' : 'text-accent'
          }`}
        >
          {failed ? '失败' : transfer.done ? '完成' : `${Math.round(percent)}%`}
        </span>
      </div>
      <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-panel-3">
        <div
          className={`h-full transition-all ${failed ? 'bg-err' : transfer.done ? 'bg-ok' : 'bg-accent'}`}
          style={{ width: `${failed ? 100 : percent}%` }}
        />
      </div>
    </div>
  )
}
