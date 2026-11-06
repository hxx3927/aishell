import { useMemo, useState } from 'react'
import type { MonitorGpu, MonitorNet, MonitorProcess, MonitorSample } from '@shared/types'
import { formatBytes } from '../../lib/format'
import { Meter } from './Meter'
import { TrendChart } from './TrendChart'
import {
  formatCount,
  formatFreq,
  formatLinkSpeed,
  formatPct,
  formatRate,
  formatRateShort,
  formatUptime,
  hostDisks,
  isVirtualInterface,
  meterLevel,
  meterTextClass,
  sampleMemPct
} from './format'

export type DetailTab = 'cpu' | 'mem' | 'disk' | 'net'

const TABS: Array<{ key: DetailTab; label: string }> = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: '内存' },
  { key: 'disk', label: '磁盘' },
  { key: 'net', label: '网络' }
]

interface DetailPanelProps {
  tab: DetailTab
  onSelectTab: (tab: DetailTab) => void
  samples: MonitorSample[]
  latest?: MonitorSample
  /** Fixed chart window in ms. */
  windowMs: number
  hint?: string
  iface?: MonitorNet
  ifaceName: string
  onSelectIface: (iface: string) => void
}

export function DetailPanel({
  tab,
  onSelectTab,
  samples,
  latest,
  windowMs,
  hint,
  iface,
  ifaceName,
  onSelectIface
}: DetailPanelProps) {
  const interfaces = latest?.net ?? []
  const physical = interfaces.filter((item) => !isVirtualInterface(item.iface))
  const orderedInterfaces = [...physical, ...interfaces.filter((item) => isVirtualInterface(item.iface))]

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="资源详情"
          className="flex items-center gap-0.5 rounded-lg bg-panel-3 p-0.5 text-[10px]"
        >
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`rounded-md px-2.5 py-1 transition ${
                tab === item.key
                  ? 'bg-segment text-ink shadow-sm'
                  : 'text-dim hover:text-ink'
              }`}
              onClick={() => onSelectTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'net' && orderedInterfaces.length > 1 && (
          <label className="flex items-center gap-1 text-[10px] text-faint">
            接口
            <select
              className="input h-6 w-[132px] py-0 text-[10px]"
              value={ifaceName}
              onChange={(event) => onSelectIface(event.target.value)}
            >
              {orderedInterfaces.map((item) => (
                <option key={item.iface} value={item.iface}>
                  {item.iface}
                  {isVirtualInterface(item.iface) ? '（虚拟）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-2">
        {tab === 'cpu' && (
          <TrendChart
            title="CPU 使用率"
            hint={hint}
            samples={samples}
            series={[
              {
                key: 'cpu',
                label: 'CPU',
                color: 'var(--color-chart-1)',
                values: samples.map((sample) => sample.cpuPct)
              }
            ]}
            format={formatPct}
            fixedMax={100}
            windowMs={windowMs}
          />
        )}
        {tab === 'mem' && (
          <TrendChart
            title="内存使用率"
            hint={hint}
            samples={samples}
            series={[
              {
                key: 'mem',
                label: '内存',
                color: 'var(--color-chart-1)',
                values: samples.map((sample) => sampleMemPct(sample))
              }
            ]}
            format={formatPct}
            fixedMax={100}
            windowMs={windowMs}
          />
        )}
        {tab === 'disk' && (
          <TrendChart
            title="磁盘吞吐"
            hint={hint}
            samples={samples}
            series={[
              {
                key: 'read',
                label: '读取',
                color: 'var(--color-chart-1)',
                values: samples.map((sample) =>
                  (sample.diskIo ?? []).reduce((sum, item) => sum + item.readBps, 0)
                )
              },
              {
                key: 'write',
                label: '写入',
                color: 'var(--color-chart-2)',
                values: samples.map((sample) =>
                  (sample.diskIo ?? []).reduce((sum, item) => sum + item.writeBps, 0)
                )
              }
            ]}
            format={formatRate}
            formatAxis={formatRateShort}
            windowMs={windowMs}
          />
        )}
        {tab === 'net' && (
          <TrendChart
            title={`网络吞吐${iface ? ` · ${iface.iface}` : ''}`}
            hint={hint}
            samples={samples}
            series={[
              {
                key: 'rx',
                label: '下行',
                color: 'var(--color-chart-1)',
                values: samples.map(
                  (sample) =>
                    sample.net.find((item) => item.iface === ifaceName)?.rxBps ?? 0
                )
              },
              {
                key: 'tx',
                label: '上行',
                color: 'var(--color-chart-2)',
                values: samples.map(
                  (sample) =>
                    sample.net.find((item) => item.iface === ifaceName)?.txBps ?? 0
                )
              }
            ]}
            format={formatRate}
            formatAxis={formatRateShort}
            windowMs={windowMs}
          />
        )}
      </div>

      <section className="mt-3 rounded-xl border border-line-2 bg-panel-2/40 px-3 py-2.5">
        {tab === 'cpu' && <CpuStats latest={latest} />}
        {tab === 'mem' && <MemoryStats latest={latest} />}
        {tab === 'disk' && <DiskStats latest={latest} />}
        {tab === 'net' && (
          <NetworkStats latest={latest} iface={iface} interfaces={orderedInterfaces} />
        )}
      </section>
    </>
  )
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] text-faint">{label}</div>
      <div className="mt-0.5 truncate text-xs tabular-nums text-ink" title={title ?? value}>
        {value}
      </div>
    </div>
  )
}

const METRIC_GRID =
  'grid grid-cols-2 gap-x-4 gap-y-2 @min-[640px]:grid-cols-3 @min-[900px]:grid-cols-5'

function CpuStats({ latest }: { latest?: MonitorSample }) {
  const perCore = latest?.perCorePct ?? []
  return (
    <>
      <div className={METRIC_GRID}>
        <Metric label="速度" value={formatFreq(latest?.cpuMhz)} />
        <Metric
          label="负载（1/5/15 分钟）"
          value={latest ? latest.load.map((value) => value.toFixed(2)).join(' / ') : '—'}
        />
        <Metric
          label="进程"
          value={formatCount(latest?.processCount)}
          title={latest?.processCount?.toLocaleString()}
        />
        <Metric
          label="线程"
          value={formatCount(latest?.threadCount)}
          title={latest?.threadCount?.toLocaleString()}
        />
        <Metric
          label="句柄（打开文件）"
          value={formatCount(latest?.openFds)}
          title={latest?.openFds?.toLocaleString()}
        />
        <Metric label="运行时间" value={formatUptime(latest?.uptimeSec)} />
      </div>

      {perCore.length > 0 && (
        <div className="mt-3 border-t border-line/60 pt-2">
          <div className="flex items-center justify-between text-[10px] text-faint">
            <span>逻辑处理器</span>
            <span>
              {perCore.length > 64 ? `显示前 64 / 共 ${perCore.length} 核` : `${perCore.length} 核`}
            </span>
          </div>
          <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1">
            {perCore.slice(0, 64).map((pct, index) => {
              const level = meterLevel(pct)
              return (
                <div
                  key={index}
                  className="rounded-md border border-line-2/70 px-1.5 py-1"
                  title={`CPU ${index}：${formatPct(pct)}`}
                >
                  <div className="flex items-baseline justify-between text-[9px]">
                    <span className="text-faint">{index}</span>
                    <span className={`tabular-nums ${meterTextClass[level]}`}>
                      {Math.round(pct)}%
                    </span>
                  </div>
                  <Meter value={pct} className="mt-1" />
                </div>
              )
            })}
          </div>
        </div>
      )}

      <GpuStats gpus={latest?.gpus ?? []} />
      <ProcessList processes={latest?.processes ?? []} />
    </>
  )
}

function GpuStats({ gpus }: { gpus: MonitorGpu[] }) {
  if (!gpus.length) return null
  const shown = gpus.slice(0, 8)
  return (
    <div className="mt-3 border-t border-line/60 pt-2">
      <div className="flex items-center justify-between text-[10px] text-faint">
        <span>GPU</span>
        <span>
          {gpus.length > shown.length ? `显示前 ${shown.length} / 共 ${gpus.length} 块` : `${gpus.length} 块`}
        </span>
      </div>
      <div
        className={`mt-1.5 grid gap-1.5 ${shown.length > 1 ? '@min-[640px]:grid-cols-2' : ''}`}
      >
        {shown.map((gpu, index) => (
          <div
            key={`${gpu.vendor}-${index}`}
            className="rounded-md border border-line-2/70 px-2 py-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[10px] text-ink" title={gpu.name}>
                {gpu.name}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink">
                {gpu.utilPct === undefined ? '—' : formatPct(gpu.utilPct)}
              </span>
            </div>
            <Meter value={gpu.utilPct ?? 0} className="mt-1" />
            <div className="mt-1 flex flex-wrap gap-x-3 text-[9px] text-faint">
              <span>
                显存{' '}
                {gpu.memTotalBytes
                  ? `${formatBytes(gpu.memUsedBytes ?? 0)} / ${formatBytes(gpu.memTotalBytes)}`
                  : '—'}
              </span>
              {gpu.tempC !== undefined && <span>温度 {Math.round(gpu.tempC)} °C</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProcessList({ processes }: { processes: MonitorProcess[] }) {
  const [sort, setSort] = useState<'cpu' | 'mem'>('cpu')
  const rows = useMemo(() => {
    const sorted = [...processes].sort((a, b) =>
      sort === 'cpu' ? b.cpuPct - a.cpuPct : b.memBytes - a.memBytes
    )
    return sorted.slice(0, 5)
  }, [processes, sort])

  if (!processes.length) return null
  return (
    <div className="mt-3 border-t border-line/60 pt-2">
      <div className="flex items-center justify-between text-[10px] text-faint">
        <span>进程 TOP</span>
        <div className="flex items-center gap-0.5 rounded-md bg-panel-3 p-0.5">
          {(['cpu', 'mem'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={sort === key}
              className={`rounded px-1.5 py-0.5 transition ${
                sort === key ? 'bg-segment text-ink shadow-sm' : 'text-faint hover:text-ink'
              }`}
              onClick={() => setSort(key)}
            >
              {key === 'cpu' ? '按 CPU' : '按内存'}
            </button>
          ))}
        </div>
      </div>
      <table className="mt-1 w-full border-collapse text-[10px] tabular-nums">
        <thead className="text-faint">
          <tr>
            <th className="py-1 pr-2 text-left font-medium">进程</th>
            <th className="px-2 py-1 text-right font-medium">PID</th>
            <th className="px-2 py-1 text-right font-medium">CPU</th>
            <th className="px-2 py-1 text-right font-medium">内存</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.pid} className="border-t border-line/60">
              <td
                className="max-w-[240px] truncate py-1.5 pr-2 text-ink"
                title={`${row.name} (${row.pid})`}
              >
                {row.name}
              </td>
              <td className="px-2 py-1.5 text-right text-dim">{row.pid}</td>
              <td className="px-2 py-1.5 text-right text-dim">{row.cpuPct.toFixed(1)}%</td>
              <td className="px-2 py-1.5 text-right text-dim">{formatBytes(row.memBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MemoryStats({ latest }: { latest?: MonitorSample }) {
  const total = latest?.memTotalBytes ?? 0
  const used = latest?.memUsedBytes ?? 0
  const cached = latest?.memCachedBytes ?? 0
  const free = Math.max(0, total - used - cached)
  const swapTotal = latest?.swapTotalBytes ?? 0
  const committed = latest?.memCommittedBytes
  const limit = latest?.memCommitLimitBytes

  return (
    <>
      <MemoryComposition used={used} cached={cached} free={free} total={total} />
      <div className={`${METRIC_GRID} mt-3`}>
        <Metric label="使用中" value={total ? `${formatBytes(used)} / ${formatBytes(total)}` : '—'} />
        <Metric label="可用" value={formatBytes(latest?.memAvailableBytes ?? 0)} />
        <Metric label="已缓存" value={formatBytes(cached)} />
        <Metric
          label="已提交"
          value={
            committed === undefined
              ? '—'
              : `${formatBytes(committed)}${limit ? ` / ${formatBytes(limit)}` : ''}`
          }
        />
        <Metric
          label="交换"
          value={swapTotal > 0 ? `${formatBytes(latest?.swapUsedBytes ?? 0)} / ${formatBytes(swapTotal)}` : '未启用'}
        />
      </div>
    </>
  )
}

function MemoryComposition({
  used,
  cached,
  free,
  total
}: {
  used: number
  cached: number
  free: number
  total: number
}) {
  const parts = [
    { key: 'used', label: '使用中', bytes: used, color: 'var(--color-chart-1)' },
    { key: 'cached', label: '已缓存', bytes: cached, color: 'var(--color-chart-2)' },
    { key: 'free', label: '空闲', bytes: free, color: 'var(--color-line-2)' }
  ].filter((part) => part.bytes > 0)

  if (!(total > 0)) {
    return <div className="text-[10px] text-faint">暂无内存数据</div>
  }

  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-panel-3">
        {parts.map((part) => (
          <span
            key={part.key}
            className="h-full"
            style={{ width: `${(part.bytes / total) * 100}%`, background: part.color }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
        {parts.map((part) => (
          <span key={part.key} className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-sm"
              style={{ background: part.color }}
              aria-hidden="true"
            />
            <span className="text-dim">{part.label}</span>
            <span className="tabular-nums text-ink">{formatBytes(part.bytes)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function DiskStats({ latest }: { latest?: MonitorSample }) {
  const devices = [...(latest?.diskIo ?? [])].sort((a, b) => b.activePct - a.activePct)
  const active = devices.reduce((max, item) => Math.max(max, item.activePct), 0)
  const iops = devices.reduce((sum, item) => sum + item.iops, 0)
  const awaitMs = iops > 0 ? devices.reduce((sum, item) => sum + item.awaitMs * item.iops, 0) / iops : 0
  const disks = latest ? hostDisks(latest) : []
  const capacity = disks.reduce((max, disk) => Math.max(max, disk.usePct), 0)

  return (
    <>
      <div className={METRIC_GRID}>
        <Metric label="活动时间" value={formatPct(active)} />
        <Metric label="IOPS" value={formatCount(Math.round(iops))} />
        <Metric label="平均响应" value={iops > 0 ? `${awaitMs.toFixed(1)} ms` : '—'} />
        <Metric label="容量使用" value={disks.length ? formatPct(capacity) : '—'} />
        <Metric label="块设备" value={String(devices.length)} />
      </div>

      {devices.length > 0 && (
        <div className="mt-3 overflow-x-auto border-t border-line/60 pt-2">
          <table className="w-full min-w-[420px] border-collapse text-[10px] tabular-nums">
            <thead className="text-faint">
              <tr>
                <th className="py-1 pr-2 text-left font-medium">设备</th>
                <th className="px-2 py-1 text-right font-medium">读取</th>
                <th className="px-2 py-1 text-right font-medium">写入</th>
                <th className="px-2 py-1 text-right font-medium">活动</th>
                <th className="px-2 py-1 text-right font-medium">IOPS</th>
                <th className="px-2 py-1 text-right font-medium">响应</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => {
                const level = meterLevel(device.activePct)
                return (
                  <tr key={device.dev} className="border-t border-line/60">
                    <td className="py-1.5 pr-2 font-mono text-[10px] text-ink">{device.dev}</td>
                    <td className="px-2 py-1.5 text-right text-dim">{formatRate(device.readBps)}</td>
                    <td className="px-2 py-1.5 text-right text-dim">{formatRate(device.writeBps)}</td>
                    <td className={`px-2 py-1.5 text-right ${meterTextClass[level]}`}>
                      {formatPct(device.activePct)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-dim">{Math.round(device.iops)}</td>
                    <td className="px-2 py-1.5 text-right text-dim">
                      {device.iops > 0 ? `${device.awaitMs.toFixed(1)} ms` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function NetworkStats({
  latest,
  iface,
  interfaces
}: {
  latest?: MonitorSample
  iface?: MonitorNet
  interfaces: MonitorNet[]
}) {
  return (
    <>
      <div className={METRIC_GRID}>
        <Metric label="下行" value={formatRate(iface?.rxBps ?? 0)} />
        <Metric label="上行" value={formatRate(iface?.txBps ?? 0)} />
        <Metric label="链路速度" value={formatLinkSpeed(iface?.speedBps)} />
        <Metric label="累计接收" value={formatBytes(iface?.rxBytes ?? 0)} />
        <Metric label="累计发送" value={formatBytes(iface?.txBytes ?? 0)} />
      </div>

      {interfaces.length > 0 && (
        <div className="mt-3 overflow-x-auto border-t border-line/60 pt-2">
          <table className="w-full min-w-[420px] border-collapse text-[10px] tabular-nums">
            <thead className="text-faint">
              <tr>
                <th className="py-1 pr-2 text-left font-medium">接口</th>
                <th className="px-2 py-1 text-right font-medium">下行</th>
                <th className="px-2 py-1 text-right font-medium">上行</th>
                <th className="px-2 py-1 text-right font-medium">链路速度</th>
                <th className="px-2 py-1 text-right font-medium">累计接收 / 发送</th>
              </tr>
            </thead>
            <tbody>
              {interfaces.map((item) => (
                <tr
                  key={item.iface}
                  className={`border-t border-line/60 ${
                    item.iface === iface?.iface ? 'text-ink' : 'text-dim'
                  }`}
                >
                  <td className="py-1.5 pr-2 font-mono text-[10px]">
                    {item.iface}
                    {isVirtualInterface(item.iface) && (
                      <span className="ml-1.5 rounded bg-panel-3 px-1 py-0.5 font-sans text-[9px] text-faint">
                        虚拟
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">{formatRate(item.rxBps)}</td>
                  <td className="px-2 py-1.5 text-right">{formatRate(item.txBps)}</td>
                  <td className="px-2 py-1.5 text-right">{formatLinkSpeed(item.speedBps)}</td>
                  <td className="px-2 py-1.5 text-right">
                    {formatBytes(item.rxBytes)} / {formatBytes(item.txBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
