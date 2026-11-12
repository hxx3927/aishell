import type { MonitorDiskIo, MonitorNet, MonitorProcess } from '@shared/types'
import type { ParsedDiskCounter, ParsedNetCounter, ParsedProcStat } from './parse'

/**
 * Rate and ranking math for the monitor, kept free of timers and SSH so the
 * numbers can be tested directly. Each function takes the previous sample's
 * baselines and returns the next ones; the caller owns the storage.
 */

/** Cumulative byte counters for one interface at a point in time. */
export interface NetBaseline {
  rx: number
  tx: number
  ts: number
}

/** Cumulative disk counters; /proc/diskstats values never go backwards. */
export interface DiskBaseline {
  reads: number
  writes: number
  sectorsRead: number
  sectorsWritten: number
  ioMs: number
  ts: number
}

/** Per-process CPU ticks at a point in time. */
export interface ProcBaseline {
  ticks: number
  ts: number
}

export interface NetSample {
  items: MonitorNet[]
  next: Map<string, NetBaseline>
}

export interface DiskSample {
  items: MonitorDiskIo[]
  next: Map<string, DiskBaseline>
}

export interface ProcessSample {
  items: MonitorProcess[] | undefined
  next: Map<number, ProcBaseline>
}

export function computeNetCounters(
  counters: ParsedNetCounter[],
  links: Map<string, number>,
  previous: Map<string, NetBaseline>,
  ts: number
): NetSample {
  const items = counters.map((counter) => {
    const prev = previous.get(counter.iface)
    const seconds = prev ? Math.max(0.001, (ts - prev.ts) / 1000) : 0
    // A counter can wrap or reset; a negative delta is not traffic.
    const rxDelta = prev && counter.rxBytes >= prev.rx ? counter.rxBytes - prev.rx : 0
    const txDelta = prev && counter.txBytes >= prev.tx ? counter.txBytes - prev.tx : 0
    return {
      iface: counter.iface,
      rxBps: seconds ? rxDelta / seconds : 0,
      txBps: seconds ? txDelta / seconds : 0,
      rxBytes: counter.rxBytes,
      txBytes: counter.txBytes,
      speedBps: links.get(counter.iface)
    }
  })
  const next = new Map(
    counters.map((counter) => [
      counter.iface,
      { rx: counter.rxBytes, tx: counter.txBytes, ts }
    ])
  )
  return { items, next }
}

export function computeDiskIo(
  counters: ParsedDiskCounter[],
  previous: Map<string, DiskBaseline>,
  ts: number
): DiskSample {
  const items = counters.map((counter) => {
    const prev = previous.get(counter.dev)
    const seconds = prev ? Math.max(0.001, (ts - prev.ts) / 1000) : 0
    const delta = (current: number, before: number | undefined): number =>
      prev && before !== undefined && current >= before ? current - before : 0
    const readDelta = delta(counter.sectorsRead, prev?.sectorsRead)
    const writeDelta = delta(counter.sectorsWritten, prev?.sectorsWritten)
    const ops = delta(counter.reads, prev?.reads) + delta(counter.writes, prev?.writes)
    const busyMs = delta(counter.ioMs, prev?.ioMs)
    return {
      dev: counter.dev,
      // /proc/diskstats counts 512-byte sectors regardless of the real
      // block size.
      readBps: seconds ? (readDelta * 512) / seconds : 0,
      writeBps: seconds ? (writeDelta * 512) / seconds : 0,
      iops: seconds ? ops / seconds : 0,
      activePct: seconds ? Math.min(100, (busyMs / (seconds * 1000)) * 100) : 0,
      awaitMs: ops > 0 ? busyMs / ops : 0
    }
  })
  const next = new Map(
    counters.map((counter) => [
      counter.dev,
      {
        reads: counter.reads,
        writes: counter.writes,
        sectorsRead: counter.sectorsRead,
        sectorsWritten: counter.sectorsWritten,
        ioMs: counter.ioMs,
        ts
      }
    ])
  )
  return { items, next }
}

/**
 * Keeps the union of the top processes by CPU and by memory. CPU% comes from
 * tick deltas between samples, which is what "currently busy" means; `ps`
 * reports a lifetime average instead. A process seen for the first time has
 * no baseline yet, so its first reading is 0.
 *
 * An empty probe clears the baselines instead of reusing stale ones: after a
 * gap, averaging over the whole gap would misreport the current load.
 */
export function computeProcesses(
  procs: ParsedProcStat[],
  previous: Map<number, ProcBaseline>,
  ts: number,
  clockTicks: number,
  pageSize: number,
  cores: number
): ProcessSample {
  if (!procs.length) return { items: undefined, next: new Map() }
  const next = new Map<number, ProcBaseline>()
  const rows: MonitorProcess[] = []
  // Share of the whole machine, like the CPU card: one saturated core on an
  // 8-core host is 12.5%, so the rows never add up to more than the total.
  const coreCount = Math.max(1, cores)
  for (const proc of procs) {
    const prev = previous.get(proc.pid)
    next.set(proc.pid, { ticks: proc.ticks, ts })
    const seconds = prev ? (ts - prev.ts) / 1000 : 0
    const ticks = prev && proc.ticks >= prev.ticks ? proc.ticks - prev.ticks : 0
    const cpuPct =
      seconds > 0 ? (ticks / Math.max(1, clockTicks) / seconds / coreCount) * 100 : 0
    rows.push({
      pid: proc.pid,
      name: proc.name,
      cpuPct: Math.round(cpuPct * 10) / 10,
      memBytes: proc.rssPages * pageSize
    })
  }

  const picked = new Map<number, MonitorProcess>()
  for (const row of [...rows].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 8)) {
    picked.set(row.pid, row)
  }
  for (const row of [...rows].sort((a, b) => b.memBytes - a.memBytes).slice(0, 8)) {
    picked.set(row.pid, row)
  }
  if (!picked.size) return { items: undefined, next }
  return {
    items: [...picked.values()].sort(
      (a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes
    ),
    next
  }
}

/** Pushes a sample and drops the oldest ones beyond the ring limit. */
export function appendHistory<T>(history: T[], sample: T, limit: number): void {
  history.push(sample)
  if (history.length > limit) history.splice(0, history.length - limit)
}
