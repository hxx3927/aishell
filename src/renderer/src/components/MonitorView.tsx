import {
  Activity,
  AlertTriangle,
  Cpu,
  HardDrive,
  Info,
  Loader2,
  MemoryStick,
  Network,
  Pause,
  Play,
  RefreshCw,
  Server,
  WifiOff
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@shared/types'
import { monitorConnId } from '@shared/monitor'
import { formatBytes, formatTime } from '../lib/format'
import { sessionConnection, useAppStore } from '../state/store'
import { DetailPanel, type DetailTab } from './monitor/DetailPanel'
import { DiskTable } from './monitor/DiskTable'
import { Meter } from './monitor/Meter'
import {
  formatDuration,
  formatPct,
  formatRate,
  formatUptime,
  hostDisks,
  meterLevel,
  meterTextClass,
  primaryInterface,
  sampleDiskPct,
  sampleMemPct,
  type MeterLevel
} from './monitor/format'

interface MonitorViewProps {
  sessionId: string
  session?: Session
  visible: boolean
}

/** The detail charts keep a stable time window rather than a growing one. */
const WINDOW_MIN_MS = 60_000
const INTERVALS = [2000, 5000, 10_000, 30_000]

/** Each overview card selects the matching detail tab. */
type CardKey = DetailTab

const levelLabel: Record<MeterLevel, string> = {
  ok: '',
  warn: '偏高',
  crit: '紧张'
}

/** Re-render stale banners while no samples are arriving. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function StatCard({
  icon,
  title,
  value,
  sub,
  meter,
  footer,
  tone,
  selected,
  onSelect
}: {
  icon: ReactNode
  title: string
  value: string
  sub?: string
  meter?: number
  footer?: string
  tone?: MeterLevel
  selected: boolean
  onSelect: () => void
}) {
  const level = tone ?? 'ok'
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`min-w-0 rounded-xl border px-3 py-2.5 text-left transition ${
        selected
          ? 'border-accent/60 bg-accent/[0.06] ring-1 ring-accent/40'
          : 'border-line-2 bg-panel-2/40 hover:border-line-2 hover:bg-panel-2/70'
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{title}</span>
        {level !== 'ok' && (
          <span
            className={`ml-auto flex shrink-0 items-center gap-1 text-[10px] ${meterTextClass[level]}`}
          >
            <AlertTriangle size={10} />
            {levelLabel[level]}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-lg font-medium leading-tight tabular-nums text-ink">
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[10px] text-dim">{sub}</div>}
      {typeof meter === 'number' && <Meter value={meter} className="mt-1.5" />}
      {footer && <div className="mt-1 truncate text-[10px] text-faint">{footer}</div>}
    </button>
  )
}

function Skeleton() {
  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-2 @min-[900px]:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-[82px] animate-pulse rounded-xl border border-line-2 bg-panel-2/40"
          />
        ))}
      </div>
      <div className="mt-3 h-[224px] animate-pulse rounded-xl border border-line-2 bg-panel-2/40" />
      <div className="mt-3 grid grid-cols-1 gap-3 @min-[900px]:grid-cols-2">
        <div className="h-[220px] animate-pulse rounded-xl border border-line-2 bg-panel-2/40" />
        <div className="h-[220px] animate-pulse rounded-xl border border-line-2 bg-panel-2/40" />
      </div>
      <div className="mt-3 flex items-center justify-center gap-2 text-[10px] text-faint">
        <Loader2 size={12} className="animate-spin" />
        正在采集首个样本…
      </div>
    </div>
  )
}

function Banner({
  icon,
  children,
  action
}: {
  icon: ReactNode
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-2 bg-panel-2 px-3 py-1.5 text-[11px] text-ink">
      {icon}
      <span className="min-w-0">{children}</span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  )
}

export function MonitorView({ sessionId, session, visible }: MonitorViewProps) {
  const monitor = useAppStore((s) => s.monitors[sessionId])
  const connections = useAppStore((s) => s.connections)
  const startMonitor = useAppStore((s) => s.startMonitor)
  const pauseMonitor = useAppStore((s) => s.pauseMonitor)
  const refreshMonitor = useAppStore((s) => s.refreshMonitor)
  const setMonitorInterval = useAppStore((s) => s.setMonitorInterval)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [focus, setFocus] = useState<CardKey>('cpu')
  /** `null` means "follow the primary physical interface". */
  const [ifaceName, setIfaceName] = useState<string | null>(null)

  const samples = monitor?.samples ?? []
  const latest = samples.at(-1)
  const host = monitor?.host
  const status = monitor?.status
  const hasSamples = samples.length > 0
  const connStatus = connections[monitorConnId(sessionId)]?.status
  const monitorConnected = connStatus === 'connected' || connStatus === 'connecting'
  const disconnected = Boolean(monitor) && status !== 'starting' && !monitorConnected
  const stale = status === 'error'
  const paused = status === 'paused' && !disconnected
  const now = useNow(disconnected || stale || paused)

  // With no entry at all the poller has never started; opening the tab on a
  // live server starts it, so this state means "disconnected, waiting for go".
  const neverStarted = !monitor
  const sessionStatus = sessionConnection(connections, sessionId)?.status

  const intervalValue = monitor?.intervalMs ?? 2000
  const intervalOptions = INTERVALS.includes(intervalValue)
    ? INTERVALS
    : [...INTERVALS, intervalValue].sort((a, b) => a - b)
  // At 30s intervals a 60s window would hold two points; scale the window
  // with the interval so a chart always spans about 30 samples.
  const windowMs = Math.max(WINDOW_MIN_MS, intervalValue * 30)
  const windowed = useMemo(() => {
    const lastTs = samples.at(-1)?.ts
    if (!lastTs) return samples
    return samples.filter((sample) => sample.ts >= lastTs - windowMs)
  }, [samples, windowMs])
  const chartHint =
    windowed.length > 1
      ? `最近 ${formatDuration(windowMs / 1000)} · ${windowed.length} 个样本`
      : windowed.length === 1
        ? '最近 1 个样本'
        : undefined

  const selectedIface = ifaceName
    ? latest?.net.find((item) => item.iface === ifaceName)
    : undefined
  const iface = selectedIface ?? (latest ? primaryInterface(latest.net) : undefined)

  const cpuPct = latest?.cpuPct ?? 0
  const memPct = latest ? sampleMemPct(latest) : 0
  const disks = latest ? hostDisks(latest) : []
  const diskPct = latest ? sampleDiskPct(latest) : 0
  const fullest = [...disks].sort((a, b) => b.usePct - a.usePct)[0]
  const cores = latest?.cores ?? host?.cores ?? 0
  const lastAge = monitor?.lastSampleAt
    ? Math.max(0, Math.round((now - monitor.lastSampleAt) / 1000))
    : null

  const statusChip = disconnected ? (
    <span className="chip text-err">
      <WifiOff size={10} />
      已断开
    </span>
  ) : paused ? (
    <span className="chip">
      <Pause size={10} />
      已暂停
    </span>
  ) : status === 'error' ? (
    <span className="chip text-err">
      <AlertTriangle size={10} />
      采样异常
    </span>
  ) : status === 'starting' ? (
    <span className="chip">
      <Loader2 size={10} className="animate-spin" />
      连接中
    </span>
  ) : (
    <span className="chip">
      <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-ok" />
      采样中
    </span>
  )

  return (
    <div className={`h-full min-h-0 flex-col ${visible ? 'flex' : 'hidden'}`}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-4 py-3">
          <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Activity size={15} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-semibold text-ink">
                    {session?.name ?? host?.hostname ?? '资源监控'}
                  </span>
                  {monitor && statusChip}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-faint">
                  {session
                    ? `${session.username}@${session.host}:${session.port}`
                    : (host?.hostname ?? '')}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-dim">
                  {host?.os && <span className="truncate">{host.os}</span>}
                  {host?.kernel && <span className="truncate">内核 {host.kernel}</span>}
                  {latest && <span>已运行 {formatUptime(latest.uptimeSec)}</span>}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {monitor && (
                <label className="flex items-center gap-1 text-[10px] text-faint">
                  间隔
                  <select
                    className="input h-7 w-[68px] py-0 text-[10px]"
                    value={intervalValue}
                    onChange={(event) =>
                      void setMonitorInterval(sessionId, Number(event.target.value))
                    }
                    title="采样间隔"
                  >
                    {intervalOptions.map((value) => (
                      <option key={value} value={value}>
                        {value % 1000 === 0 ? `${value / 1000}s` : `${value}ms`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {monitor && !disconnected && (
                <button
                  type="button"
                  className="btn-secondary h-7 px-2 py-0 text-[10px]"
                  onClick={() => void pauseMonitor(sessionId, !paused)}
                >
                  {paused ? <Play size={11} /> : <Pause size={11} />}
                  {paused ? '继续' : '暂停'}
                </button>
              )}

              {disconnected && (
                <button
                  type="button"
                  className="btn-primary h-7 px-2 py-0 text-[10px]"
                  onClick={() => void startMonitor(sessionId)}
                >
                  <RefreshCw size={11} />
                  重新连接
                </button>
              )}

              <button
                type="button"
                className="btn-secondary h-7 px-2 py-0 text-[10px]"
                disabled={!monitor || disconnected || status === 'starting'}
                onClick={() => void refreshMonitor(sessionId)}
                title="立即采样一次"
              >
                <RefreshCw size={11} />
                刷新
              </button>

              {host && (
                <div className="relative">
                  <button
                    type="button"
                    className="icon-btn h-7 w-7"
                    title="系统详情"
                    aria-expanded={detailsOpen}
                    onClick={() => setDetailsOpen((open) => !open)}
                  >
                    <Info size={13} />
                  </button>
                  {detailsOpen && (
                    <>
                      <button
                        type="button"
                        className="fixed inset-0 z-40 cursor-default"
                        aria-label="关闭详情"
                        onClick={() => setDetailsOpen(false)}
                      />
                      <div className="slide-in absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-line-2 bg-panel p-3 text-[10px] shadow-xl">
                        <div className="mb-2 text-[11px] font-semibold text-ink">系统详情</div>
                        <dl className="space-y-1">
                          <Detail label="主机名" value={host.hostname || '—'} mono />
                          <Detail label="系统" value={host.os ?? '—'} />
                          <Detail label="内核" value={host.kernel ?? '—'} mono />
                          <Detail label="CPU" value={host.cpuModel ?? '—'} />
                          <Detail label="核心数" value={cores ? `${cores} 核` : '—'} />
                          <Detail label="总内存" value={formatBytes(host.totalMemBytes)} />
                          <Detail
                            label="启动时间"
                            value={host.bootedAt ? formatTime(host.bootedAt) : '—'}
                          />
                          <Detail
                            label="接口"
                            value={host.interfaces.length ? host.interfaces.join('、') : '—'}
                            mono
                          />
                        </dl>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </header>

          {neverStarted ? (
            <section className="rounded-2xl border border-line-2 bg-panel-2/40 px-5 py-8">
              <div className="mx-auto max-w-[460px] text-center">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Activity size={20} />
                </div>
                <div className="mt-3 text-sm font-medium text-ink">
                  {session?.name ?? '服务器资源监控'}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-dim">
                  {sessionStatus === 'connected'
                    ? '正在准备资源监控…'
                    : '监控会新建一条专用 SSH 连接，只读取 /proc 与 df。'}
                </div>
                <button
                  type="button"
                  className="btn-primary mt-4"
                  disabled={sessionStatus === 'connecting'}
                  onClick={() => void startMonitor(sessionId)}
                >
                  {sessionStatus === 'connecting' ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Server size={13} />
                  )}
                  连接并开始监控
                </button>
                <div className="mt-3 text-[10px] leading-relaxed text-faint">
                  不需要 root，不安装远程组件，也不写入审计日志。断开监控页会关闭这条连接。
                </div>
              </div>
            </section>
          ) : monitor?.status === 'starting' && !hasSamples ? (
            <Skeleton />
          ) : status === 'error' && !hasSamples ? (
            <section className="rounded-2xl border border-err/30 bg-err/5 px-5 py-7">
              <div className="mx-auto max-w-[480px] text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-err/10 text-err">
                  <AlertTriangle size={18} />
                </div>
                <div className="mt-3 text-sm font-medium text-ink">无法读取服务器资源</div>
                <div className="mt-1 break-words text-xs leading-relaxed text-dim">
                  {monitor?.lastError ?? '采样失败'}
                </div>
                {host?.os && (
                  <div className="mt-1 text-[10px] text-faint">
                    {host.os}
                    {host.kernel ? ` · ${host.kernel}` : ''}
                  </div>
                )}
                <button
                  type="button"
                  className="btn-secondary mt-4"
                  onClick={() => void startMonitor(sessionId)}
                >
                  <RefreshCw size={13} />
                  重试
                </button>
              </div>
            </section>
          ) : (
            <>
              {disconnected ? (
                <Banner
                  icon={<WifiOff size={13} className="text-err" />}
                  action={
                    <button
                      type="button"
                      className="btn-secondary h-6 px-2 py-0 text-[10px]"
                      onClick={() => void startMonitor(sessionId)}
                    >
                      <RefreshCw size={10} />
                      重新连接
                    </button>
                  }
                >
                  连接已断开{monitor?.lastError ? `：${monitor.lastError}` : '，保留最后一次数据'}
                </Banner>
              ) : paused ? (
                <Banner
                  icon={<Pause size={13} className="text-warn" />}
                  action={
                    <button
                      type="button"
                      className="btn-secondary h-6 px-2 py-0 text-[10px]"
                      onClick={() => void pauseMonitor(sessionId, false)}
                    >
                      <Play size={10} />
                      继续
                    </button>
                  }
                >
                  已暂停采样
                  {lastAge !== null && ` · 最后样本 ${lastAge} 秒前`}
                </Banner>
              ) : stale ? (
                <Banner
                  icon={<AlertTriangle size={13} className="text-warn" />}
                  action={
                    <button
                      type="button"
                      className="btn-secondary h-6 px-2 py-0 text-[10px]"
                      onClick={() => void startMonitor(sessionId)}
                    >
                      <RefreshCw size={10} />
                      重试
                    </button>
                  }
                >
                  数据可能已过期
                  {lastAge !== null && ` · ${lastAge} 秒前`}
                  {monitor?.lastError ? ` · ${monitor.lastError}` : ''}
                </Banner>
              ) : null}

              <div className={stale || disconnected ? 'opacity-60' : undefined}>
                <div className="grid grid-cols-2 gap-2 @min-[900px]:grid-cols-4">
                  <StatCard
                    icon={<Cpu size={11} />}
                    title="CPU 使用率"
                    value={latest ? formatPct(cpuPct) : '—'}
                    sub={cores ? `${cores} 核` : undefined}
                    meter={latest ? cpuPct : undefined}
                    tone={latest ? meterLevel(cpuPct) : 'ok'}
                    footer={
                      latest ? `${latest.processCount.toLocaleString()} 个进程` : undefined
                    }
                    selected={focus === 'cpu'}
                    onSelect={() => setFocus('cpu')}
                  />
                  <StatCard
                    icon={<MemoryStick size={11} />}
                    title="内存"
                    value={latest ? formatPct(memPct) : '—'}
                    sub={
                      latest && latest.memTotalBytes
                        ? `${formatBytes(latest.memUsedBytes)} / ${formatBytes(latest.memTotalBytes)}`
                        : undefined
                    }
                    meter={latest && latest.memTotalBytes ? memPct : undefined}
                    tone={latest && latest.memTotalBytes ? meterLevel(memPct) : 'ok'}
                    footer={
                      latest
                        ? latest.swapTotalBytes > 0
                          ? `Swap ${formatBytes(latest.swapUsedBytes)} / ${formatBytes(latest.swapTotalBytes)}`
                          : 'Swap 未启用'
                        : undefined
                    }
                    selected={focus === 'mem'}
                    onSelect={() => setFocus('mem')}
                  />
                  <StatCard
                    icon={<HardDrive size={11} />}
                    title="磁盘"
                    value={latest && disks.length ? formatPct(diskPct) : '—'}
                    sub={
                      fullest
                        ? `${fullest.mount === '/' ? '根分区' : fullest.mount} · ${disks.length} 个挂载点`
                        : undefined
                    }
                    meter={latest && disks.length ? diskPct : undefined}
                    tone={latest && disks.length ? meterLevel(diskPct) : 'ok'}
                    selected={focus === 'disk'}
                    onSelect={() => setFocus('disk')}
                  />
                  <StatCard
                    icon={<Network size={11} />}
                    title="网络"
                    value={iface ? `↓ ${formatRate(iface.rxBps)}` : '—'}
                    sub={iface ? `↑ ${formatRate(iface.txBps)}` : undefined}
                    footer={iface ? iface.iface : undefined}
                    selected={focus === 'net'}
                    onSelect={() => setFocus('net')}
                  />
                </div>

                <div className="mt-3">
                  <DetailPanel
                    tab={focus}
                    onSelectTab={setFocus}
                    samples={windowed}
                    latest={latest}
                    windowMs={windowMs}
                    hint={chartHint}
                    iface={iface}
                    ifaceName={iface?.iface ?? ''}
                    onSelectIface={setIfaceName}
                  />
                </div>

                <div className="mt-3">
                  <DiskTable disks={latest?.disks ?? []} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-faint">{label}</dt>
      <dd className={`min-w-0 flex-1 break-words text-dim ${mono ? 'font-mono text-[10px]' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
