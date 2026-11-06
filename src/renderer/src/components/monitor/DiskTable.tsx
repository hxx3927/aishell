import { AlertTriangle } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MonitorDisk } from '@shared/types'
import { formatBytes } from '../../lib/format'
import { formatPct, meterLevel, meterTextClass } from './format'
import { Meter } from './Meter'

const COLLAPSED_ROWS = 8

export function DiskTable({ disks }: { disks: MonitorDisk[] }) {
  const [expanded, setExpanded] = useState(false)
  // Docker/containerd mounts repeat the same capacity once per container; a
  // host with a dozen containers otherwise buries its real filesystems.
  const [showContainers, setShowContainers] = useState(false)
  const containers = useMemo(() => disks.filter((disk) => disk.container), [disks])
  const source = useMemo(
    () => (showContainers ? disks : disks.filter((disk) => !disk.container)),
    [disks, showContainers]
  )
  const sorted = useMemo(
    () => [...source].sort((a, b) => b.usePct - a.usePct),
    [source]
  )
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_ROWS)
  const hidden = sorted.length - visible.length

  return (
    <section className="rounded-xl border border-line-2 bg-panel-2/40 px-3 pb-2.5 pt-2.5">
      <header className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium text-ink">文件系统</div>
        <div className="flex shrink-0 items-center gap-2">
          {containers.length > 0 && (
            <button
              type="button"
              className="text-[10px] text-accent hover:underline"
              aria-pressed={showContainers}
              onClick={() => {
                setExpanded(false)
                setShowContainers((value) => !value)
              }}
            >
              {showContainers ? '隐藏容器挂载' : `容器挂载 ${containers.length}`}
            </button>
          )}
          <span className="text-[10px] text-faint">{sorted.length ? '按使用率排序' : ''}</span>
        </div>
      </header>

      {sorted.length === 0 ? (
        <div className="mt-2 flex h-16 items-center justify-center rounded-lg border border-dashed border-line-2 text-[10px] text-faint">
          未检测到文件系统
        </div>
      ) : (
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full min-w-[360px] border-collapse text-[10px] tabular-nums">
            <thead className="text-faint">
              <tr>
                <th className="py-1 pr-2 text-left font-medium">挂载点</th>
                <th className="px-2 py-1 text-left font-medium">类型</th>
                <th className="px-2 py-1 text-right font-medium">已用 / 总量</th>
                <th className="w-[130px] px-2 py-1 text-left font-medium">使用率</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((disk) => {
                const level = meterLevel(disk.usePct)
                return (
                  <tr key={`${disk.mount}-${disk.fs}`} className="border-t border-line/60">
                    <td className="max-w-[220px] truncate py-1.5 pr-2 font-mono text-[10px] text-ink" title={disk.mount}>
                      {disk.mount}
                    </td>
                    <td className="px-2 py-1.5 text-dim">{disk.fs}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right text-dim">
                      {formatBytes(disk.usedBytes)} / {formatBytes(disk.sizeBytes)}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <Meter value={disk.usePct} className="min-w-[40px] flex-1" />
                        <span className={`w-8 shrink-0 text-right ${meterTextClass[level]}`}>
                          {formatPct(disk.usePct)}
                        </span>
                        {level === 'crit' && (
                          <span className="flex shrink-0 items-center gap-1 text-err">
                            <AlertTriangle size={10} />
                            空间不足
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hidden > 0 && (
        <button
          type="button"
          className="mt-1.5 text-[10px] text-accent hover:underline"
          onClick={() => setExpanded(true)}
        >
          还有 {hidden} 个挂载点
        </button>
      )}
      {expanded && sorted.length > COLLAPSED_ROWS && (
        <button
          type="button"
          className="mt-1.5 text-[10px] text-dim hover:text-ink hover:underline"
          onClick={() => setExpanded(false)}
        >
          收起
        </button>
      )}
    </section>
  )
}
