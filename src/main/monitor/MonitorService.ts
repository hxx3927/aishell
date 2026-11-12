import type { MonitorEvent, MonitorHost, MonitorSample, MonitorStartResult } from '@shared/types'
import { monitorConnId } from '@shared/monitor'
import type { SshManager } from '../ssh/SshManager'
import {
  appendHistory,
  computeDiskIo,
  computeNetCounters,
  computeProcesses,
  type DiskBaseline,
  type NetBaseline,
  type ProcBaseline
} from './compute'
import { parseCaps, parseHostProbe, parseProbe, type ParsedProbe } from './parse'

const HISTORY_LIMIT = 450
const DEFAULT_INTERVAL_MS = 2000
const MIN_INTERVAL_MS = 1000
const MAX_INTERVAL_MS = 60_000
const PROBE_TIMEOUT_SEC = 8
const BACKOFF_MAX_MS = 30_000

/**
 * The per-process scan reads /proc/<pid>/stat once: comm, utime+stime and RSS.
 * awk strips `pid (comm)` from the head and the last `) ` from the tail, so
 * names with spaces or parentheses survive; fields after comm are numeric.
 */
// The `'\''` sequences keep the awk program single-quoted inside the outer
// `sh -c '...'` wrapper.
const PROC_STAT_AWK =
  `awk '\\''{ s=$0; sub(/^[0-9]+ \\(/,"",s); c=s; sub(/\\) [^)]*$/,"",c); ` +
  `r=$0; sub(/.*\\) /,"",r); n=split(r,f," "); if (n>=22) print $1 "|" c "|" (f[12]+f[13]) "|" f[22] }'\\''`

function probeCommand(nvidia: boolean): string {
  return `LC_ALL=C sh -c '
echo @@load; cat /proc/loadavg
echo @@uptime; cut -d" " -f1 /proc/uptime
echo @@mem; cat /proc/meminfo
echo @@cpu1; grep "^cpu" /proc/stat
sleep 0.25
echo @@cpu2; grep "^cpu" /proc/stat
echo @@disk; df -P -k
echo @@net; cat /proc/net/dev
echo @@procs; ls -d /proc/[0-9]* 2>/dev/null | wc -l
echo @@freq; grep "^cpu MHz" /proc/cpuinfo 2>/dev/null
echo @@fds; cat /proc/sys/fs/file-nr 2>/dev/null
echo @@diskio; cat /proc/diskstats 2>/dev/null
echo @@links; for i in /sys/class/net/*; do n=$(basename "$i"); echo "$n $(cat "$i/speed" 2>/dev/null)"; done
echo @@procstat; ${PROC_STAT_AWK} /proc/[0-9]*/stat 2>/dev/null
${nvidia ? 'echo @@nvidia; nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null' : ''}
echo @@amdgpu; for d in /sys/class/drm/card[0-9]*; do v=$(cat "$d/device/vendor" 2>/dev/null) || continue; [ "$v" = "0x1002" ] || continue; n=$(cat "$d/device/product_name" 2>/dev/null); [ -z "$n" ] && n=$(basename "$d"); b=$(cat "$d/device/gpu_busy_percent" 2>/dev/null); mu=$(cat "$d/device/mem_info_vram_used" 2>/dev/null); mt=$(cat "$d/device/mem_info_vram_total" 2>/dev/null); t=$(cat "$d/device/hwmon/"hwmon*/temp1_input 2>/dev/null | head -n 1); echo "amd|$n|$b|$mu|$mt|$t"; done
'`
}

const HOST_COMMAND = `LC_ALL=C sh -c '
echo @@hostname; hostname 2>/dev/null
echo @@os; grep "^PRETTY_NAME=" /etc/os-release 2>/dev/null | head -n 1
echo @@kernel; uname -sr 2>/dev/null
echo @@cpu; grep -m1 "^model name" /proc/cpuinfo 2>/dev/null
echo @@memtotal; grep "^MemTotal:" /proc/meminfo 2>/dev/null
echo @@uptime; cut -d" " -f1 /proc/uptime
echo @@caps; echo clk:$(getconf CLK_TCK 2>/dev/null || echo 100); echo page:$(getconf PAGESIZE 2>/dev/null || echo 4096); command -v nvidia-smi >/dev/null 2>&1 && echo gpu:nvidia
'`

interface Entry {
  sessionId: string
  /** The monitor's own connection; it never shares a terminal's transport. */
  connId: string
  intervalMs: number
  timer: NodeJS.Timeout | null
  inFlight: boolean
  paused: boolean
  failures: number
  host?: MonitorHost
  history: MonitorSample[]
  netPrev: Map<string, NetBaseline>
  diskPrev: Map<string, DiskBaseline>
  procPrev: Map<number, ProcBaseline>
  /** Host facts needed to turn process ticks into CPU% and RSS into bytes. */
  clockTicks: number
  pageSize: number
  /** Whether the host has nvidia-smi; the GPU section is skipped otherwise. */
  nvidiaSmi: boolean
  lastError?: string
}

type Send = (channel: string, payload: unknown) => void

/**
 * Polls a Linux host over a dedicated SSH connection and keeps a small
 * in-memory history per session. Sampling exists only while a renderer has
 * asked for it; closing the monitor tab calls stop().
 */
export class MonitorService {
  private entries = new Map<string, Entry>()
  private pending = new Map<string, Promise<MonitorStartResult>>()
  /** Sessions whose UI still wants samples; guards cancelled starts. */
  private wanted = new Set<string>()

  constructor(
    private readonly ssh: SshManager,
    private readonly send: Send
  ) {}

  async start(sessionId: string, intervalMs = DEFAULT_INTERVAL_MS): Promise<MonitorStartResult> {
    const interval = clampInterval(intervalMs)
    this.wanted.add(sessionId)
    const pending = this.pending.get(sessionId)
    if (pending) return pending
    const task = this.doStart(sessionId, interval).finally(() => {
      this.pending.delete(sessionId)
    })
    this.pending.set(sessionId, task)
    return task
  }

  private async doStart(sessionId: string, interval: number): Promise<MonitorStartResult> {
    const existing = this.entries.get(sessionId)
    if (existing) {
      let reconnected = false
      if (!this.ssh.isConnConnected(existing.connId)) {
        try {
          await this.ssh.connect(existing.connId, sessionId)
          reconnected = true
        } catch (err) {
          this.wanted.delete(sessionId)
          throw err
        }
      }
      const intervalChanged = existing.intervalMs !== interval
      existing.intervalMs = interval
      if (!existing.paused && (intervalChanged || reconnected)) this.schedule(existing, 0)
      return {
        host: existing.host,
        history: [...existing.history],
        intervalMs: existing.intervalMs,
        paused: existing.paused,
        error: existing.lastError
      }
    }

    const connId = monitorConnId(sessionId)
    if (!this.ssh.isConnConnected(connId)) {
      try {
        await this.ssh.connect(connId, sessionId)
      } catch (err) {
        this.wanted.delete(sessionId)
        throw err
      }
    }
    if (!this.wanted.has(sessionId)) {
      this.ssh.disconnect(connId)
      throw new Error('监控已停止')
    }

    const entry: Entry = {
      sessionId,
      connId,
      intervalMs: interval,
      timer: null,
      inFlight: false,
      paused: false,
      failures: 0,
      history: [],
      netPrev: new Map(),
      diskPrev: new Map(),
      procPrev: new Map(),
      clockTicks: 100,
      pageSize: 4096,
      nvidiaSmi: false
    }
    this.entries.set(sessionId, entry)
    entry.host = await this.probeHost(entry)

    if (!this.wanted.has(sessionId)) {
      this.stopEntry(entry, false)
      throw new Error('监控已停止')
    }

    await this.tick(entry, false)
    if (!entry.paused) this.schedule(entry, this.nextDelay(entry))
    return {
      host: entry.host,
      history: [...entry.history],
      intervalMs: entry.intervalMs,
      paused: entry.paused,
      error: entry.lastError
    }
  }

  stop(sessionId: string): void {
    this.wanted.delete(sessionId)
    const entry = this.entries.get(sessionId)
    if (entry) this.stopEntry(entry, true)
    this.send('monitor:sample', {
      sessionId,
      sampling: false,
      paused: false
    } satisfies MonitorEvent)
  }

  stopAll(): void {
    for (const sessionId of Array.from(this.wanted)) this.stop(sessionId)
    for (const sessionId of Array.from(this.entries.keys())) this.stop(sessionId)
  }

  pause(sessionId: string, paused: boolean): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.paused === paused) return
    entry.paused = paused
    if (paused) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    } else {
      this.schedule(entry, 0)
    }
    this.send('monitor:sample', {
      sessionId,
      sampling: true,
      paused,
      host: entry.host,
      sample: entry.history.at(-1)
    } satisfies MonitorEvent)
  }

  async sampleNow(sessionId: string): Promise<MonitorSample> {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new Error('监控未启动')
    await this.tick(entry, false)
    const sample = entry.history.at(-1)
    if (!sample) throw new Error(entry.lastError ?? '暂未获取到监控数据')
    return sample
  }

  dispose(): void {
    this.stopAll()
    this.pending.clear()
  }

  private stopEntry(entry: Entry, disconnect: boolean): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    if (this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId)
    entry.history = []
    if (disconnect) this.ssh.disconnect(entry.connId)
  }

  private nextDelay(entry: Entry): number {
    if (!entry.failures) return entry.intervalMs
    return Math.min(BACKOFF_MAX_MS, entry.intervalMs * 2 ** Math.min(entry.failures, 5))
  }

  private schedule(entry: Entry, delay: number): void {
    if (entry.paused || !this.wanted.has(entry.sessionId)) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.tick(entry, true)
    }, Math.max(0, delay))
    entry.timer.unref?.()
  }

  private async tick(entry: Entry, reschedule: boolean): Promise<void> {
    if (entry.paused && reschedule) return
    if (entry.inFlight) return
    entry.inFlight = true
    try {
      if (!this.ssh.isConnConnected(entry.connId)) throw new Error('SSH 会话未连接')
      const result = await this.ssh.exec(entry.connId, probeCommand(entry.nvidiaSmi), {
        timeoutSec: PROBE_TIMEOUT_SEC
      })
      const parsed = parseProbe(result.stdout)
      const sample = this.toSample(entry, parsed)
      appendHistory(entry.history, sample, HISTORY_LIMIT)
      entry.failures = 0
      entry.lastError = undefined
      entry.host = this.mergeHost(entry, parsed, sample)
      this.send('monitor:sample', {
        sessionId: entry.sessionId,
        sampling: true,
        paused: entry.paused,
        host: entry.host,
        sample
      } satisfies MonitorEvent)
    } catch (err) {
      entry.failures += 1
      entry.lastError = (err as Error).message
      this.send('monitor:sample', {
        sessionId: entry.sessionId,
        sampling: true,
        paused: entry.paused,
        host: entry.host,
        error: entry.lastError
      } satisfies MonitorEvent)
    } finally {
      entry.inFlight = false
      if (reschedule) this.schedule(entry, this.nextDelay(entry))
    }
  }

  private toSample(entry: Entry, parsed: ParsedProbe): MonitorSample {
    const ts = Date.now()
    const netSample = computeNetCounters(parsed.net, parsed.links, entry.netPrev, ts)
    entry.netPrev = netSample.next
    const diskSample = computeDiskIo(parsed.diskIo, entry.diskPrev, ts)
    entry.diskPrev = diskSample.next
    const procSample = computeProcesses(
      parsed.procStat,
      entry.procPrev,
      ts,
      entry.clockTicks,
      entry.pageSize,
      parsed.cpu.cores
    )
    entry.procPrev = procSample.next
    const net = netSample.items
    const diskIo = diskSample.items
    const processes = procSample.items
    const memTotal = parsed.memory.totalBytes || entry.host?.totalMemBytes || 0
    return {
      sessionId: entry.sessionId,
      ts,
      cpuPct: parsed.cpu.usage,
      perCorePct: parsed.cpu.perCore,
      load: parsed.load,
      cores: parsed.cpu.cores,
      processCount: parsed.processCount,
      threadCount: parsed.threadCount,
      openFds: parsed.openFds,
      cpuMhz: parsed.cpuMhz,
      uptimeSec: parsed.uptimeSec,
      memTotalBytes: memTotal,
      memUsedBytes: parsed.memory.totalBytes ? parsed.memory.usedBytes : 0,
      memAvailableBytes: parsed.memory.availableBytes,
      memCachedBytes: parsed.memory.cachedBytes,
      swapTotalBytes: parsed.memory.swapTotalBytes,
      swapUsedBytes: parsed.memory.swapUsedBytes,
      memCommittedBytes: parsed.memory.committedBytes,
      memCommitLimitBytes: parsed.memory.commitLimitBytes,
      disks: parsed.disks,
      net,
      diskIo,
      gpus: parsed.gpus.length ? parsed.gpus : undefined,
      processes
    }
  }

  private mergeHost(entry: Entry, parsed: ParsedProbe, sample: MonitorSample): MonitorHost {
    const base = entry.host
    return {
      hostname: base?.hostname || '',
      os: base?.os,
      kernel: base?.kernel,
      cpuModel: base?.cpuModel,
      cores: sample.cores || base?.cores || 1,
      totalMemBytes: sample.memTotalBytes || base?.totalMemBytes || 0,
      interfaces: sample.net.map((item) => item.iface),
      bootedAt: sample.uptimeSec > 0 ? Date.now() - sample.uptimeSec * 1000 : base?.bootedAt
    }
  }

  private async probeHost(entry: Entry): Promise<MonitorHost | undefined> {
    try {
      const result = await this.ssh.exec(entry.connId, HOST_COMMAND, { timeoutSec: 8 })
      const caps = parseCaps(result.stdout)
      entry.clockTicks = caps.clockTicks
      entry.pageSize = caps.pageSize
      entry.nvidiaSmi = caps.nvidia
      const host = parseHostProbe(result.stdout)
      return {
        hostname: host.hostname || '',
        os: host.os,
        kernel: host.kernel,
        cpuModel: host.cpuModel,
        cores: 0,
        totalMemBytes: host.totalMemBytes,
        interfaces: [],
        bootedAt: host.uptimeSec > 0 ? Date.now() - host.uptimeSec * 1000 : undefined
      }
    } catch {
      return undefined
    }
  }
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(value)))
}
