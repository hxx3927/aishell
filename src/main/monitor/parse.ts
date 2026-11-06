import type { MonitorDisk } from '@shared/types'

export interface ParsedCpu {
  usage: number
  perCore: number[]
  cores: number
}

export interface ParsedMemory {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  cachedBytes: number
  swapTotalBytes: number
  swapUsedBytes: number
  committedBytes?: number
  commitLimitBytes?: number
}

export interface ParsedNetCounter {
  iface: string
  rxBytes: number
  txBytes: number
}

/** Cumulative counters from /proc/diskstats; rates need the previous sample. */
export interface ParsedDiskCounter {
  dev: string
  reads: number
  writes: number
  sectorsRead: number
  sectorsWritten: number
  ioMs: number
}

/** One line of /proc/<pid>/stat, reduced to what the process table needs. */
export interface ParsedProcStat {
  pid: number
  name: string
  /** utime + stime in clock ticks; the service turns deltas into CPU%. */
  ticks: number
  rssPages: number
}

export interface ParsedGpu {
  vendor: 'nvidia' | 'amd'
  name: string
  utilPct?: number
  memUsedBytes?: number
  memTotalBytes?: number
  tempC?: number
}

/** Host facts the sampler needs once: tick rate, page size, GPU tooling. */
export interface ParsedCaps {
  clockTicks: number
  pageSize: number
  nvidia: boolean
}

export interface ParsedProbe {
  cpu: ParsedCpu
  load: [number, number, number]
  uptimeSec: number
  memory: ParsedMemory
  disks: MonitorDisk[]
  net: ParsedNetCounter[]
  /** Link speed per interface, in bits/s, when sysfs reports it. */
  links: Map<string, number>
  diskIo: ParsedDiskCounter[]
  processCount: number
  threadCount?: number
  openFds?: number
  cpuMhz?: number
  procStat: ParsedProcStat[]
  gpus: ParsedGpu[]
}

export interface ParsedHost {
  hostname?: string
  os?: string
  kernel?: string
  cpuModel?: string
  totalMemBytes: number
  uptimeSec: number
}

interface CpuTimes {
  total: number
  idle: number
}

/**
 * The probe writes sections between `@@name` marker lines. Keeping one exec
 * per sample avoids a burst of SSH channels on every refresh.
 */
export function splitSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current: string | null = null
  let lines: string[] = []
  const flush = (): void => {
    if (current) sections.set(current, lines.join('\n'))
  }
  for (const line of raw.split(/\r?\n/)) {
    const marker = /^@@([\w-]+)\s*$/.exec(line.trim())
    if (marker) {
      flush()
      current = marker[1] ?? null
      lines = []
      continue
    }
    if (current) lines.push(line)
  }
  flush()
  return sections
}

function parseCpuLine(line: string): { name: string; times: CpuTimes } | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 5 || !/^cpu\d*$/.test(parts[0] ?? '')) return null
  const numbers = parts.slice(1, 9).map(Number)
  if (numbers.some((value) => !Number.isFinite(value))) return null
  const total = numbers.reduce((sum, value) => sum + value, 0)
  // idle + iowait: waiting for I/O still counts as not doing work.
  const idle = (numbers[3] ?? 0) + (numbers[4] ?? 0)
  return { name: parts[0]!, times: { total, idle } }
}

function parseCpuTimes(text: string): Map<string, CpuTimes> {
  const result = new Map<string, CpuTimes>()
  for (const line of text.split('\n')) {
    const parsed = parseCpuLine(line)
    if (parsed) result.set(parsed.name, parsed.times)
  }
  return result
}

function percentBetween(before: CpuTimes | undefined, after: CpuTimes | undefined): number {
  if (!before || !after) return 0
  const total = after.total - before.total
  const idle = after.idle - before.idle
  if (!(total > 0)) return 0
  return clamp((1 - idle / total) * 100, 0, 100)
}

function parseCpu(before: string, after: string): ParsedCpu {
  const first = parseCpuTimes(before)
  const second = parseCpuTimes(after)
  const usage = percentBetween(first.get('cpu'), second.get('cpu'))
  const perCore: number[] = []
  const coreNames = Array.from(second.keys())
    .filter((name) => name !== 'cpu')
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
  for (const name of coreNames) {
    perCore.push(percentBetween(first.get(name), second.get(name)))
  }
  return { usage, perCore, cores: perCore.length || 1 }
}

function parseLoad(text: string): [number, number, number] {
  const parts = text.trim().split(/\s+/).map(Number)
  const [one, five, fifteen] = parts
  if (!Number.isFinite(one) || !Number.isFinite(five) || !Number.isFinite(fifteen)) {
    return [0, 0, 0]
  }
  return [one!, five!, fifteen!]
}

function parseUptime(text: string): number {
  const seconds = Number.parseFloat(text.trim().split(/\s+/)[0] ?? '')
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0
}

/** `/proc/loadavg` ends with `running/total tasks`; total counts threads. */
function parseThreadCount(loadavg: string): number | undefined {
  const tasks = loadavg.trim().split(/\s+/)[3]
  const total = Number(tasks?.split('/')[1])
  return Number.isFinite(total) && total > 0 ? total : undefined
}

/** `/proc/sys/fs/file-nr` starts with the number of allocated file handles. */
function parseOpenFds(text: string): number | undefined {
  const value = Number.parseInt(text.trim(), 10)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** `cpu MHz : 2400.000` lines, averaged across all cores. */
function parseCpuMhz(text: string): number | undefined {
  const values = text
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
  if (!values.length) return undefined
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

/** `/sys/class/net/<iface>/speed` reports Mbps; empty lines mean "unknown". */
function parseLinks(text: string): Map<string, number> {
  const links = new Map<string, number>()
  for (const line of text.split('\n')) {
    const [iface, value] = line.trim().split(/\s+/)
    if (!iface) continue
    const mbps = Number(value)
    if (Number.isFinite(mbps) && mbps > 0) links.set(iface, mbps * 1_000_000)
  }
  return links
}

/** Whole block devices only: partitions and loop/dm devices duplicate I/O. */
const BLOCK_DEVICE = /^(?:sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/

export function parseDiskStats(text: string): ParsedDiskCounter[] {
  const counters: ParsedDiskCounter[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 14) continue
    const dev = parts[2] ?? ''
    if (!BLOCK_DEVICE.test(dev)) continue
    // Fields 4–14 from the kernel doc, after major/minor/name.
    const numbers = parts.slice(3, 14).map(Number)
    if (numbers.some((value) => !Number.isFinite(value))) continue
    counters.push({
      dev,
      reads: numbers[0]!,
      sectorsRead: numbers[2]!,
      writes: numbers[4]!,
      sectorsWritten: numbers[6]!,
      ioMs: numbers[9]!
    })
  }
  return counters
}

function parseMemory(text: string): ParsedMemory {
  const values = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s*kB\s*$/.exec(line.trim())
    if (match) values.set(match[1]!, Number(match[2]))
  }
  const total = (values.get('MemTotal') ?? 0) * 1024
  const free = (values.get('MemFree') ?? 0) * 1024
  const buffers = (values.get('Buffers') ?? 0) * 1024
  const cached = (values.get('Cached') ?? 0) * 1024
  const reclaimable = (values.get('SReclaimable') ?? 0) * 1024
  const available = values.has('MemAvailable')
    ? (values.get('MemAvailable') ?? 0) * 1024
    : free + buffers + cached
  const swapTotal = (values.get('SwapTotal') ?? 0) * 1024
  const swapFree = (values.get('SwapFree') ?? 0) * 1024
  return {
    totalBytes: total,
    usedBytes: Math.max(0, total - available),
    availableBytes: available,
    cachedBytes: buffers + cached + reclaimable,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
    committedBytes: values.has('Committed_AS') ? (values.get('Committed_AS') ?? 0) * 1024 : undefined,
    commitLimitBytes: values.has('CommitLimit') ? (values.get('CommitLimit') ?? 0) * 1024 : undefined
  }
}

const IGNORED_FILESYSTEMS = new Set(['tmpfs', 'devtmpfs', 'squashfs'])
const IGNORED_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run']
/** Container runtimes mount the host root at these paths, one per container. */
const CONTAINER_MOUNT_PREFIXES = [
  '/var/lib/docker',
  '/var/lib/containerd',
  '/var/lib/kubelet',
  '/var/lib/rancher',
  '/run/containerd',
  '/run/k3s'
]

function shouldIgnoreMount(fs: string, mount: string): boolean {
  if (IGNORED_FILESYSTEMS.has(fs)) return true
  return IGNORED_MOUNT_PREFIXES.some(
    (prefix) => mount === prefix || mount.startsWith(`${prefix}/`)
  )
}

/**
 * Docker's overlay layers and bind mounts repeat the same capacity once per
 * container. They are still real mounts, so keep them but flag them: the UI
 * hides them by default instead of letting them bury the root filesystem.
 */
function isContainerMount(fs: string, mount: string): boolean {
  if (fs === 'overlay' && mount !== '/') return true
  return CONTAINER_MOUNT_PREFIXES.some(
    (prefix) => mount === prefix || mount.startsWith(`${prefix}/`)
  )
}

function parseDisks(text: string): MonitorDisk[] {
  const disks: MonitorDisk[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || /^Filesystem\s+/i.test(trimmed)) continue
    const columns = trimmed.split(/\s+/)
    if (columns.length < 6) continue
    const fs = columns[0]!
    const sizeKb = Number(columns[1])
    const usedKb = Number(columns[2])
    const availKb = Number(columns[3])
    const capacity = /^(\d+)%$/.exec(columns[4] ?? '')
    if (!capacity) continue
    const mount = columns.slice(5).join(' ')
    // The same block device can be mounted twice (bind mounts, Docker storage);
    // its usage is identical, so keep only the first occurrence.
    const deviceKey = fs.startsWith('/dev/') ? `dev:${fs}` : null
    if (seen.has(mount) || (deviceKey !== null && seen.has(deviceKey))) continue
    if (shouldIgnoreMount(fs, mount)) continue
    const sizeBytes = sizeKb * 1024
    if (!(sizeBytes > 0) || !Number.isFinite(usedKb) || !Number.isFinite(availKb)) continue
    seen.add(mount)
    if (deviceKey !== null) seen.add(deviceKey)
    disks.push({
      fs,
      mount,
      sizeBytes,
      usedBytes: usedKb * 1024,
      availBytes: availKb * 1024,
      usePct: Number(capacity[1]),
      container: isContainerMount(fs, mount)
    })
  }
  return disks.sort((a, b) => b.usePct - a.usePct || a.mount.localeCompare(b.mount))
}

function parseNet(text: string): ParsedNetCounter[] {
  const counters: ParsedNetCounter[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const iface = line.slice(0, separator).trim()
    if (!iface || iface === 'lo' || seen.has(iface)) continue
    const numbers = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .map(Number)
    const rxBytes = numbers[0]
    const txBytes = numbers[8]
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    seen.add(iface)
    counters.push({ iface, rxBytes: rxBytes!, txBytes: txBytes! })
  }
  return counters
}

function parseProcessCount(text: string): number {
  const value = Number.parseInt(text.trim(), 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * The probe prints one line per process as `pid|comm|ticks|rssPages`. comm can
 * contain spaces, so the pipe is the separator; the kernel caps it at 15 bytes.
 */
export function parseProcStat(text: string): ParsedProcStat[] {
  const processes: ParsedProcStat[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [pidText, name, ticksText, rssText] = trimmed.split('|')
    const pid = Number(pidText)
    const ticks = Number(ticksText)
    const rssPages = Number(rssText)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!Number.isFinite(ticks) || !Number.isFinite(rssPages)) continue
    processes.push({ pid, name: (name ?? '').slice(0, 64), ticks, rssPages })
  }
  return processes
}

function numberOrUndefined(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : undefined
}

/** `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`, MiB and °C. */
function parseNvidiaGpus(text: string): ParsedGpu[] {
  const gpus: ParsedGpu[] = []
  for (const line of text.split('\n')) {
    const cells = line.split(',').map((cell) => cell.trim())
    if (cells.length < 6) continue
    const name = cells[1] ?? ''
    if (!name) continue
    const util = numberOrUndefined(cells[2])
    const used = numberOrUndefined(cells[3])
    const total = numberOrUndefined(cells[4])
    const temp = numberOrUndefined(cells[5])
    gpus.push({
      vendor: 'nvidia',
      name,
      utilPct: util === undefined ? undefined : clamp(util, 0, 100),
      memUsedBytes: used === undefined ? undefined : used * 1024 * 1024,
      memTotalBytes: total === undefined ? undefined : total * 1024 * 1024,
      tempC: temp
    })
  }
  return gpus
}

/** amdgpu sysfs rows: `amd|name|busyPct|vramUsed|vramTotal|tempMilliC`. */
function parseAmdGpus(text: string): ParsedGpu[] {
  const gpus: ParsedGpu[] = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split('|')
    if (cells[0] !== 'amd' || cells.length < 6) continue
    const busy = numberOrUndefined(cells[2])
    const used = numberOrUndefined(cells[3])
    const total = numberOrUndefined(cells[4])
    const tempMilli = numberOrUndefined(cells[5])
    gpus.push({
      vendor: 'amd',
      name: cells[1]?.trim() || 'AMD GPU',
      utilPct: busy === undefined ? undefined : clamp(busy, 0, 100),
      memUsedBytes: used,
      memTotalBytes: total,
      tempC: tempMilli === undefined ? undefined : tempMilli / 1000
    })
  }
  return gpus
}

/** Capabilities read once per connection; every value has a safe default. */
export function parseCaps(raw: string): ParsedCaps {
  const caps: ParsedCaps = { clockTicks: 100, pageSize: 4096, nvidia: false }
  for (const line of (splitSections(raw).get('caps') ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === 'gpu:nvidia') {
      caps.nvidia = true
      continue
    }
    const [key, value] = trimmed.split(':')
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) continue
    if (key === 'clk') caps.clockTicks = Math.round(parsed)
    else if (key === 'page') caps.pageSize = Math.round(parsed)
  }
  return caps
}

/**
 * Parses one probe. Throws when neither CPU nor memory could be read, which is
 * what a non-Linux host (or a severely restricted shell) looks like.
 */
export function parseProbe(raw: string): ParsedProbe {
  const sections = splitSections(raw)
  const loadText = sections.get('load') ?? ''
  const cpu = parseCpu(sections.get('cpu1') ?? '', sections.get('cpu2') ?? '')
  const memory = parseMemory(sections.get('mem') ?? '')
  if (!(memory.totalBytes > 0) && cpu.cores <= 1) {
    throw new Error('无法解析服务器资源数据（当前仅支持 Linux）')
  }
  return {
    cpu,
    load: parseLoad(loadText),
    uptimeSec: parseUptime(sections.get('uptime') ?? ''),
    memory,
    disks: parseDisks(sections.get('disk') ?? ''),
    net: parseNet(sections.get('net') ?? ''),
    links: parseLinks(sections.get('links') ?? ''),
    diskIo: parseDiskStats(sections.get('diskio') ?? ''),
    processCount: parseProcessCount(sections.get('procs') ?? ''),
    threadCount: parseThreadCount(loadText),
    openFds: parseOpenFds(sections.get('fds') ?? ''),
    cpuMhz: parseCpuMhz(sections.get('freq') ?? ''),
    procStat: parseProcStat(sections.get('procstat') ?? ''),
    gpus: [
      ...parseNvidiaGpus(sections.get('nvidia') ?? ''),
      ...parseAmdGpus(sections.get('amdgpu') ?? '')
    ]
  }
}

export function parseHostProbe(raw: string): ParsedHost {
  const sections = splitSections(raw)
  const hostname = (sections.get('hostname') ?? '').split('\n')[0]?.trim() || undefined
  const osLine = (sections.get('os') ?? '').trim()
  const os = osLine
    ? osLine.replace(/^PRETTY_NAME=/, '').replace(/^"|"$/g, '') || undefined
    : undefined
  const kernel = (sections.get('kernel') ?? '').split('\n')[0]?.trim() || undefined
  const cpuLine = (sections.get('cpu') ?? '').trim()
  const cpuModel = cpuLine
    ? cpuLine.replace(/^model name\s*:\s*/i, '').trim() || undefined
    : undefined
  const memMatch = /MemTotal:\s+(\d+)\s*kB/.exec(sections.get('memtotal') ?? '')
  return {
    hostname: hostname ?? 'unknown',
    os,
    kernel,
    cpuModel,
    totalMemBytes: memMatch ? Number(memMatch[1]) * 1024 : 0,
    uptimeSec: parseUptime(sections.get('uptime') ?? '')
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
