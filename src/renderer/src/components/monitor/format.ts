import type { MonitorNet, MonitorSample } from '@shared/types'

export type MeterLevel = 'ok' | 'warn' | 'crit'

/** Thresholds are shared by meters, KPI cards and the disk table. */
export function meterLevel(pct: number): MeterLevel {
  if (!Number.isFinite(pct)) return 'ok'
  if (pct >= 90) return 'crit'
  if (pct >= 70) return 'warn'
  return 'ok'
}

export const meterBarClass: Record<MeterLevel, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-err'
}

/** The track carries the same hue at low opacity, never a neutral gray. */
export const meterTrackClass: Record<MeterLevel, string> = {
  ok: 'bg-ok/15',
  warn: 'bg-warn/15',
  crit: 'bg-err/15'
}

export const meterTextClass: Record<MeterLevel, string> = {
  ok: 'text-dim',
  warn: 'text-warn',
  crit: 'text-err'
}

export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

const RATE_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']

/** Axis-sized rates: "1.2M" rather than "1.2 MB/s". */
export function formatRateShort(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0'
  const units = ['B', 'K', 'M', 'G', 'T']
  let value = bytesPerSec
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`
}

export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  let value = bytesPerSec
  let unit = 0
  while (value >= 1024 && unit < RATE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${RATE_UNITS[unit]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes > 0) return `${minutes} 分钟`
  return `${Math.max(1, Math.round(seconds))} 秒`
}

/** Compact uptime for the header: "12 天 4 小时". */
export function formatUptime(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  return formatDuration(seconds)
}

/** Bridges, veths, tunnels and container adapters are never the host uplink. */
const VIRTUAL_IFACE =
  /^(?:lo|docker|veth|br-|virbr|tun|tap|wg|cni|flannel|cali|kube-|vxlan|dummy)/

export function isVirtualInterface(iface: string): boolean {
  return VIRTUAL_IFACE.test(iface)
}

/**
 * The interface the network card and chart follow. Prefer a physical adapter
 * with live traffic; container bridges accumulate bytes too, so cumulative
 * counters only break ties among physical interfaces. Summing every interface
 * would double count bridges and veths.
 */
export function primaryInterface(net: MonitorNet[]): MonitorNet | undefined {
  const physical = net.filter((item) => !isVirtualInterface(item.iface))
  const pool = physical.length ? physical : net
  let best: MonitorNet | undefined
  let bestScore = -1
  for (const item of pool) {
    const rate = item.rxBps + item.txBps
    const score = rate > 0 ? rate : item.rxBytes + item.txBytes
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}

/** Capacity disks that are worth showing as the host's storage. */
export function hostDisks(sample: MonitorSample): MonitorSample['disks'] {
  const physical = sample.disks.filter((disk) => !disk.container)
  return physical.length ? physical : sample.disks
}

export function sampleMemPct(sample: MonitorSample): number {
  if (!sample.memTotalBytes) return 0
  return (sample.memUsedBytes / sample.memTotalBytes) * 100
}

export function sampleDiskPct(sample: MonitorSample): number {
  let max = 0
  for (const disk of hostDisks(sample)) max = Math.max(max, disk.usePct)
  return max
}

export function formatFreq(mhz: number | undefined): string {
  if (!mhz || !Number.isFinite(mhz)) return '—'
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`
}

/** Compact counts for processes, threads and file handles. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`
  return value.toLocaleString()
}

export function formatLinkSpeed(bps: number | undefined): string {
  if (!bps || !Number.isFinite(bps) || bps <= 0) return '—'
  const mbps = bps / 1_000_000
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(1)} Gbps` : `${Math.round(mbps)} Mbps`
}
