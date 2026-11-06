/**
 * Monitor probe parsers: /proc/stat deltas, meminfo, df with spaces and
 * duplicates, /proc/net/dev, host metadata and the non-Linux rejection.
 *
 *   npx esbuild scripts/test-monitor-parse.mts --bundle --platform=node \
 *     --format=cjs --outfile=scripts/.tmp-monitor-parse.cjs
 *   node scripts/.tmp-monitor-parse.cjs
 */
import {
  parseCaps,
  parseDiskStats,
  parseHostProbe,
  parseProcStat,
  parseProbe,
  splitSections
} from '../src/main/monitor/parse'

const results: Array<[string, boolean, unknown]> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push([name, ok, detail])
}
const near = (actual: number, expected: number, tolerance = 0.01): boolean =>
  Math.abs(actual - expected) <= tolerance

const UBUNTU_PROBE = `@@load
0.52 0.41 0.33 2/512 90210
@@uptime
864123.45
@@mem
MemTotal:       16384000 kB
MemFree:         1200000 kB
MemAvailable:    6000000 kB
Buffers:          150000 kB
Cached:          3200000 kB
SReclaimable:     180000 kB
SwapTotal:       4096000 kB
SwapFree:        3000000 kB
Committed_AS:    9000000 kB
CommitLimit:    12288000 kB
@@cpu1
cpu  200000 1000 80000 2000000 0 0 0 0 0 0
cpu0 100000 500 40000 1000000 0 0 0 0 0 0
cpu1 100000 500 40000 1000000 0 0 0 0 0 0
@@cpu2
cpu  200600 1000 80000 2002000 0 0 0 0 0 0
cpu0 100300 500 40000 1001000 0 0 0 0 0 0
cpu1 100300 500 40000 1001000 0 0 0 0 0 0
@@disk
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1         41943040  12582912  29360128      30% /
/dev/sdb1        524288000 430000000  94288000      82% /data
/dev/sdc1        104857600  104847360     10240     100% /mnt/backup disk
tmpfs              8192000         0   8192000       0% /dev/shm
/dev/sda1         41943040  12582912  29360128      30% /var/lib/docker
overlay          524288000 430000000  94288000      82% /var/lib/docker/overlay2/abc/merged
overlay          524288000 430000000  94288000      82% /var/lib/containerd/io.containerd.runtime/def/rootfs
@@net
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
  eth0: 123456789 1000 0 0 0 0 0 0 98765432 1000 0 0 0 0 0 0
  eth1: 444 4 0 0 0 0 0 0 555 5 0 0 0 0 0 0
@@procs
321
@@freq
cpu MHz		: 2000.000
cpu MHz		: 3000.500
@@fds
12345	0	9223372036854775807
@@diskio
   8       0 sda 40000 100 1600000 5000 20000 50 800000 3000 0 7000 9000 0 0 0
   8       1 sda1 39000 90 1500000 4900 19000 40 790000 2900 0 6900 8900 0 0 0
 259       0 nvme0n1 100 0 800 10 50 0 400 5 0 20 30 0 0 0
   7       0 loop0 10 0 80 2 0 0 0 0 0 4 2 0 0 0
 253       0 dm-0 40000 100 1600000 5000 20000 50 800000 3000 0 7000 9000 0 0 0
@@links
lo 0
eth0 1000
eth1
@@procstat
812|node|1500|480000
640|my sql (pool)|900|310000
1533|java|2200|2400000
@@nvidia
0, NVIDIA T4, 35, 2048, 15360, 46
1, Tesla V100-SXM2, [N/A], 1024, 16384, 52
@@amdgpu
amd|card0|17|1073741824|17179869184|51000
`

const CONTAINER_PROBE = `@@load
0.10 0.08 0.05 1/64 42
@@uptime
1000.50
@@mem
MemTotal:        2097152 kB
MemAvailable:     524288 kB
Cached:            65536 kB
@@cpu1
cpu  10 0 5 100 0 0 0 0 0 0
@@cpu2
cpu  20 0 5 130 0 0 0 0 0 0
@@disk
Filesystem     1024-blocks  Used Available Capacity Mounted on
overlay           10485760 5242880   5242880      50% /
@@net
  eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
@@procs
7
`

const NOT_LINUX_PROBE = `@@load
sh: /proc/loadavg: No such file or directory
@@uptime
sh: /proc/uptime: No such file or directory
@@mem
sh: /proc/meminfo: No such file or directory
@@cpu1
sh: /proc/stat: No such file or directory
@@cpu2
sh: /proc/stat: No such file or directory
@@disk
Filesystem 1024-blocks Used Available Capacity Mounted on
@@net
@@procs
sh: not found
`

const HOST_PROBE = `@@hostname
web-01
@@os
PRETTY_NAME="Ubuntu 24.04.1 LTS"
@@kernel
Linux 6.8.0-45-generic
@@cpu
model name\t: Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz
@@memtotal
MemTotal:       16384000 kB
@@uptime
864123.45
`

function main(): void {
  check('sections split on markers', splitSections(UBUNTU_PROBE).get('cpu2')?.includes('cpu1') === true)

  const probe = parseProbe(UBUNTU_PROBE)
  check('load average', probe.load[0] === 0.52 && probe.load[1] === 0.41 && probe.load[2] === 0.33, probe.load)
  check('uptime', near(probe.uptimeSec, 864123.45), probe.uptimeSec)
  check('process count', probe.processCount === 321, probe.processCount)

  // total delta 2600, idle delta 2000 → 23.08% busy.
  check('cpu usage from two snapshots', near(probe.cpu.usage, 23.0769), probe.cpu.usage)
  check(
    'per-core usage and core count',
    probe.cpu.cores === 2 && probe.cpu.perCore.length === 2 && probe.cpu.perCore.every((v) => near(v, 23.0769)),
    probe.cpu
  )

  check('memory total', probe.memory.totalBytes === 16_384_000 * 1024, probe.memory)
  check(
    'memory used = total - available',
    probe.memory.usedBytes === (16_384_000 - 6_000_000) * 1024,
    probe.memory
  )
  check('memory available', probe.memory.availableBytes === 6_000_000 * 1024, probe.memory)
  check(
    'cache = buffers + cached + sreclaimable',
    probe.memory.cachedBytes === (150_000 + 3_200_000 + 180_000) * 1024,
    probe.memory
  )
  check('swap used = total - free', probe.memory.swapUsedBytes === (4_096_000 - 3_000_000) * 1024, probe.memory)
  check(
    'committed memory and commit limit',
    probe.memory.committedBytes === 9_000_000 * 1024 &&
      probe.memory.commitLimitBytes === 12_288_000 * 1024,
    probe.memory
  )

  check(
    'tmpfs filtered, duplicate mount deduped, spaces kept',
    probe.disks.length === 5 &&
      probe.disks[0].mount === '/mnt/backup disk' &&
      probe.disks[0].usePct === 100 &&
      probe.disks[1].mount === '/data' &&
      probe.disks[4].mount === '/',
    probe.disks
  )
  check(
    'disk bytes',
    probe.disks[4].sizeBytes === 41_943_040 * 1024 &&
      probe.disks[4].usedBytes === 12_582_912 * 1024,
    probe.disks[4]
  )
  check(
    'container mounts flagged, host mounts not',
    probe.disks[2].container === true &&
      probe.disks[2].mount.startsWith('/var/lib/containerd') &&
      probe.disks[3].container === true &&
      probe.disks[3].mount.startsWith('/var/lib/docker/overlay2') &&
      !probe.disks[0].container &&
      !probe.disks[4].container,
    probe.disks
  )

  check(
    'network skips loopback and keeps counters',
    probe.net.length === 2 &&
      probe.net[0].iface === 'eth0' &&
      probe.net[0].rxBytes === 123_456_789 &&
      probe.net[0].txBytes === 98_765_432 &&
      probe.net[1].iface === 'eth1',
    probe.net
  )

  check('thread count from loadavg', probe.threadCount === 512, probe.threadCount)
  check('open file handles', probe.openFds === 12345, probe.openFds)
  check('average cpu MHz', probe.cpuMhz === 2500, probe.cpuMhz)
  check(
    'link speeds in bits/s, unknown ignored',
    probe.links.get('eth0') === 1_000_000_000 && !probe.links.has('eth1') && !probe.links.has('lo'),
    Array.from(probe.links.entries())
  )

  check(
    'process rows parsed',
    probe.procStat.length === 3 &&
      probe.procStat[0].pid === 812 &&
      probe.procStat[0].name === 'node' &&
      probe.procStat[0].ticks === 1500 &&
      probe.procStat[0].rssPages === 480000,
    probe.procStat
  )
  check(
    'process names with spaces and parens survive',
    probe.procStat[1].name === 'my sql (pool)',
    probe.procStat[1]
  )
  check(
    'parseProcStat drops malformed rows',
    parseProcStat('garbage\n1|ok|10|20\n2|bad ticks|x|3').length === 1,
    parseProcStat('garbage\n1|ok|10|20\n2|bad ticks|x|3')
  )
  check(
    'nvidia GPUs parsed with MiB and temperature',
    probe.gpus.length === 3 &&
      probe.gpus[0].vendor === 'nvidia' &&
      probe.gpus[0].name === 'NVIDIA T4' &&
      probe.gpus[0].utilPct === 35 &&
      probe.gpus[0].memUsedBytes === 2048 * 1024 * 1024 &&
      probe.gpus[0].memTotalBytes === 15360 * 1024 * 1024 &&
      probe.gpus[0].tempC === 46,
    probe.gpus
  )
  check(
    'unsupported nvidia metric stays undefined',
    probe.gpus[1].utilPct === undefined && probe.gpus[1].memTotalBytes === 16384 * 1024 * 1024,
    probe.gpus[1]
  )
  check(
    'AMD GPU from sysfs',
    probe.gpus[2].vendor === 'amd' &&
      probe.gpus[2].utilPct === 17 &&
      probe.gpus[2].memUsedBytes === 1_073_741_824 &&
      probe.gpus[2].memTotalBytes === 17_179_869_184 &&
      probe.gpus[2].tempC === 51,
    probe.gpus[2]
  )

  check(
    'capabilities parsed',
    (() => {
      const caps = parseCaps('@@caps\nclk:250\npage:65536\ngpu:nvidia\n')
      return caps.clockTicks === 250 && caps.pageSize === 65536 && caps.nvidia
    })()
  )
  check(
    'capability defaults when missing',
    (() => {
      const caps = parseCaps('')
      return caps.clockTicks === 100 && caps.pageSize === 4096 && !caps.nvidia
    })()
  )

  check(
    'diskstats keeps whole devices only',
    probe.diskIo.length === 2 &&
      probe.diskIo[0].dev === 'sda' &&
      probe.diskIo[1].dev === 'nvme0n1',
    probe.diskIo
  )
  check(
    'diskstats field mapping',
    probe.diskIo[0].reads === 40000 &&
      probe.diskIo[0].sectorsRead === 1_600_000 &&
      probe.diskIo[0].writes === 20000 &&
      probe.diskIo[0].sectorsWritten === 800_000 &&
      probe.diskIo[0].ioMs === 7000 &&
      probe.diskIo[1].ioMs === 20,
    probe.diskIo
  )
  check(
    'parseDiskStats skips partitions, loop and dm',
    parseDiskStats('8 1 sda1 1 0 8 0 0 0 0 0 0 0 0 0 0\n7 0 loop0 1 0 8 0 0 0 0 0 0 0 0 0 0').length === 0
  )

  const container = parseProbe(CONTAINER_PROBE)
  check('missing swap reads as zero', container.memory.swapTotalBytes === 0 && container.memory.swapUsedBytes === 0, container.memory)
  check('single-core fallback', container.cpu.cores === 1, container.cpu)
  check(
    'no process or GPU data yields empty lists',
    container.procStat.length === 0 && container.gpus.length === 0,
    { procStat: container.procStat, gpus: container.gpus }
  )
  check(
    'overlay root kept and not flagged as container',
    container.disks.length === 1 &&
      container.disks[0].fs === 'overlay' &&
      container.disks[0].mount === '/' &&
      !container.disks[0].container,
    container.disks
  )

  let rejected = ''
  try {
    parseProbe(NOT_LINUX_PROBE)
  } catch (err) {
    rejected = (err as Error).message
  }
  check('non-Linux probe rejected', rejected.includes('仅支持 Linux'), rejected)

  const host = parseHostProbe(HOST_PROBE)
  check('host hostname', host.hostname === 'web-01', host.hostname)
  check('os name unquoted', host.os === 'Ubuntu 24.04.1 LTS', host.os)
  check('kernel', host.kernel === 'Linux 6.8.0-45-generic', host.kernel)
  check('cpu model', host.cpuModel === 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', host.cpuModel)
  check('host total memory', host.totalMemBytes === 16_384_000 * 1024, host.totalMemBytes)
}

function report(): void {
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
}

main()
report()
