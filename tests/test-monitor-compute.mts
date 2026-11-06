/**
 * Monitor rate math: interface rates from cumulative counters, diskstats
 * rates, per-process CPU% from tick deltas, the top-N union, and the history
 * ring. Pure functions, no timer or SSH involved.
 *
 *   npx esbuild tests/test-monitor-compute.mts --bundle --platform=node \
 *     --format=cjs --outfile=tests/.tmp-monitor-compute.cjs
 *   node tests/.tmp-monitor-compute.cjs
 */
import {
  appendHistory,
  computeDiskIo,
  computeNetCounters,
  computeProcesses
} from '../src/main/monitor/compute'

const results: Array<[string, boolean, unknown]> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push([name, ok, detail])
}
const near = (actual: number, expected: number, tolerance = 0.01): boolean =>
  Math.abs(actual - expected) <= tolerance

// ---------------------------------------------------------------- network

const links = new Map([['eth0', 1_000_000_000]])
const net1 = computeNetCounters(
  [{ iface: 'eth0', rxBytes: 1000, txBytes: 500 }],
  links,
  new Map(),
  1000
)
check(
  'net: first sample has zero rates',
  net1.items[0].rxBps === 0 && net1.items[0].txBps === 0,
  net1.items[0]
)
check(
  'net: totals pass through',
  net1.items[0].rxBytes === 1000 && net1.items[0].txBytes === 500
)
check('net: link speed attached', net1.items[0].speedBps === 1_000_000_000)
check(
  'net: baseline recorded',
  net1.next.get('eth0')?.rx === 1000 && net1.next.get('eth0')?.ts === 1000,
  net1.next.get('eth0')
)

const net2 = computeNetCounters(
  [{ iface: 'eth0', rxBytes: 3000, txBytes: 1500 }],
  links,
  net1.next,
  3000
)
check(
  'net: deltas become bytes/s over the interval',
  near(net2.items[0].rxBps, 1000) && near(net2.items[0].txBps, 500),
  net2.items[0]
)

const netReset = computeNetCounters(
  [{ iface: 'eth0', rxBytes: 100, txBytes: 50 }],
  links,
  net2.next,
  4000
)
check(
  'net: counter reset yields zero instead of a negative rate',
  netReset.items[0].rxBps === 0 && netReset.items[0].txBps === 0,
  netReset.items[0]
)

const netOnlyOne = computeNetCounters(
  [{ iface: 'eth1', rxBytes: 10, txBytes: 10 }],
  links,
  net2.next,
  4000
)
check(
  'net: interfaces missing from this probe leave the baseline',
  netOnlyOne.next.size === 1 && !netOnlyOne.next.has('eth0'),
  [...netOnlyOne.next.keys()]
)
check('net: unknown link speed stays undefined', netOnlyOne.items[0].speedBps === undefined)

// ------------------------------------------------------------------- disk

const disk1 = computeDiskIo(
  [{ dev: 'sda', reads: 10, writes: 20, sectorsRead: 1000, sectorsWritten: 2000, ioMs: 500 }],
  new Map(),
  1000
)
const firstDisk = disk1.items[0]
check(
  'disk: first sample has zero rates',
  firstDisk.readBps === 0 &&
    firstDisk.writeBps === 0 &&
    firstDisk.iops === 0 &&
    firstDisk.activePct === 0 &&
    firstDisk.awaitMs === 0,
  firstDisk
)
check(
  'disk: baseline recorded',
  disk1.next.get('sda')?.ioMs === 500 && disk1.next.get('sda')?.ts === 1000,
  disk1.next.get('sda')
)

const disk2 = computeDiskIo(
  [{ dev: 'sda', reads: 20, writes: 25, sectorsRead: 5096, sectorsWritten: 4048, ioMs: 800 }],
  disk1.next,
  3000
)
const secondDisk = disk2.items[0]
check(
  'disk: sectors become bytes/s over the interval',
  near(secondDisk.readBps, 1_048_576) && near(secondDisk.writeBps, 524_288),
  secondDisk
)
check('disk: iops from read+write deltas', near(secondDisk.iops, 7.5), secondDisk.iops)
check('disk: active share clamped to 100%', near(secondDisk.activePct, 15), secondDisk.activePct)
check('disk: await derived from busy time and ops', near(secondDisk.awaitMs, 20), secondDisk.awaitMs)

const diskBusy = computeDiskIo(
  [{ dev: 'sda', reads: 20, writes: 25, sectorsRead: 5096, sectorsWritten: 4048, ioMs: 5500 }],
  disk2.next,
  5000
)
check(
  'disk: active share clamps at 100',
  diskBusy.items[0].activePct === 100,
  diskBusy.items[0].activePct
)

const diskReset = computeDiskIo(
  [{ dev: 'sda', reads: 1, writes: 1, sectorsRead: 1, sectorsWritten: 1, ioMs: 1 }],
  diskBusy.next,
  7000
)
check(
  'disk: reset counters yield zero',
  diskReset.items[0].readBps === 0 &&
    diskReset.items[0].iops === 0 &&
    diskReset.items[0].awaitMs === 0,
  diskReset.items[0]
)

// -------------------------------------------------------------- processes

const p1 = computeProcesses(
  [{ pid: 1, name: 'nginx', ticks: 1000, rssPages: 100 }],
  new Map(),
  10_000,
  100,
  4096
)
check(
  'proc: first sample has no CPU baseline',
  p1.items?.[0].cpuPct === 0 && p1.items?.[0].memBytes === 409_600,
  p1.items?.[0]
)
check('proc: baseline recorded', p1.next.get(1)?.ticks === 1000 && p1.next.get(1)?.ts === 10_000)

const p2 = computeProcesses(
  [{ pid: 1, name: 'nginx', ticks: 1100, rssPages: 100 }],
  p1.next,
  12_000,
  100,
  4096
)
check('proc: tick delta becomes CPU% over the interval', near(p2.items?.[0].cpuPct ?? -1, 50), p2.items?.[0])

const pRounded = computeProcesses(
  [{ pid: 1, name: 'nginx', ticks: 1001, rssPages: 100 }],
  p1.next,
  10_300,
  100,
  4096
)
check(
  'proc: CPU% rounds to one decimal',
  pRounded.items?.[0].cpuPct === 3.3,
  pRounded.items?.[0].cpuPct
)

const pOver = computeProcesses(
  [{ pid: 1, name: 'java', ticks: 1800, rssPages: 100 }],
  p1.next,
  11_000,
  100,
  4096
)
check(
  'proc: multi-threaded CPU% may exceed 100',
  near(pOver.items?.[0].cpuPct ?? -1, 800),
  pOver.items?.[0].cpuPct
)

const pReset = computeProcesses(
  [{ pid: 1, name: 'nginx', ticks: 10, rssPages: 100 }],
  p2.next,
  14_000,
  100,
  4096
)
check('proc: tick reset yields zero', pReset.items?.[0].cpuPct === 0)

// Ten processes: CPU rises with the pid, memory falls with it. The top 8 by
// CPU and the top 8 by memory overlap, so the union keeps all ten and both
// extremes must survive.
const many = Array.from({ length: 10 }, (_, index) => index + 1)
const prevMany = new Map(many.map((pid) => [pid, { ticks: 0, ts: 10_000 }]))
const manySample = computeProcesses(
  many.map((pid) => ({
    pid,
    name: `p${pid}`,
    ticks: pid * 10,
    rssPages: (11 - pid) * 1000
  })),
  prevMany,
  11_000,
  100,
  4096
)
check('proc: top-N is the union of CPU and memory picks', manySample.items?.length === 10, manySample.items?.length)
check('proc: CPU-heavy process survives', manySample.items?.[0]?.pid === 10, manySample.items?.[0])
check(
  'proc: memory-heavy process survives',
  manySample.items?.some((item) => item.pid === 1) === true,
  manySample.items?.map((item) => item.pid)
)
check(
  'proc: rows sorted by CPU desc',
  manySample.items?.every((item, index, list) => index === 0 || list[index - 1].cpuPct >= item.cpuPct) === true,
  manySample.items?.map((item) => item.cpuPct)
)
check(
  'proc: baselines only keep current pids',
  manySample.next.size === 10 && !manySample.next.has(999)
)

const empty = computeProcesses([], manySample.next, 12_000, 100, 4096)
check('proc: empty probe yields no rows', empty.items === undefined, empty.items)
check(
  'proc: empty probe clears stale baselines',
  empty.next.size === 0,
  empty.next.size
)

const afterGap = computeProcesses(
  [{ pid: 1, name: 'nginx', ticks: 5000, rssPages: 10 }],
  empty.next,
  13_000,
  100,
  4096
)
check('proc: first reading after a gap is zero', afterGap.items?.[0].cpuPct === 0)

// --------------------------------------------------------------- history

const history: string[] = []
appendHistory(history, 'a', 3)
appendHistory(history, 'b', 3)
appendHistory(history, 'c', 3)
check('history: appends in order', history.join('') === 'abc', history)
appendHistory(history, 'd', 3)
check('history: trims the oldest beyond the limit', history.join('') === 'bcd', history)
appendHistory(history, 'e', 3)
appendHistory(history, 'f', 3)
check('history: stays at the limit', history.join('') === 'def', history)

let failed = 0
for (const [name, pass, detail] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) {
    failed += 1
    console.log('      ', JSON.stringify(detail))
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
