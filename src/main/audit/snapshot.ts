import type { SessionStore } from '../store/SessionStore'
import type { SshManager } from '../ssh/SshManager'
import type { AuditStore } from './AuditStore'

const PROBES = {
  uptime: 'uptime',
  memory: 'free -m',
  disks: 'df -hP',
  processes: 'ls -d /proc/[0-9]* 2>/dev/null | wc -l',
  cpus: 'nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0'
} as const

export interface SnapshotInput {
  sessionId: string
  trigger: 'agent_launch' | 'before_dangerous'
  agentSessionId?: string
  profileId?: string
  relatedId?: string
}

/**
 * Records the host's load, memory, disk and process count, so a later review
 * can tell whether the machine was already near its limits when the agent
 * acted. Never throws; a failed probe is recorded as such.
 */
export async function captureSnapshot(
  ssh: SshManager,
  store: SessionStore,
  audit: AuditStore,
  input: SnapshotInput
): Promise<void> {
  if (!ssh.isConnected(input.sessionId)) return
  const session = store.getSession(input.sessionId)
  const raw: Record<string, string> = {}

  await Promise.all(
    Object.entries(PROBES).map(async ([key, command]) => {
      try {
        const result = await ssh.exec(input.sessionId, command, { timeoutSec: 10 })
        raw[key] = (result.stdout || result.stderr).trim()
      } catch (err) {
        raw[key] = `失败：${(err as Error).message}`
      }
    })
  )

  audit.recordNote({
    kind: 'snapshot',
    sessionId: input.sessionId,
    sessionName: session?.name,
    host: session ? `${session.host}:${session.port}` : undefined,
    agentSessionId: input.agentSessionId,
    profileId: input.profileId,
    action: input.trigger,
    relatedId: input.relatedId,
    payload: {
      load: parseLoad(raw.uptime),
      memUsedPct: parseUsage(raw.memory, 'Mem:'),
      swapUsedPct: parseUsage(raw.memory, 'Swap:'),
      disks: parseDisks(raw.disks),
      procCount: /^\d+$/.test(raw.processes ?? '') ? Number(raw.processes) : undefined,
      cpus: /^\d+$/.test(raw.cpus ?? '') && Number(raw.cpus) > 0 ? Number(raw.cpus) : undefined,
      raw
    }
  })
}

function parseLoad(text = ''): number[] | undefined {
  const match = /load averages?:\s*([\d.]+),?\s+([\d.]+),?\s+([\d.]+)/.exec(text)
  return match ? match.slice(1, 4).map(Number) : undefined
}

/** Used/total as a percentage from a `free` row; works for any unit suffix. */
function parseUsage(text = '', label: string): number | undefined {
  const line = text.split('\n').find((l) => l.trim().startsWith(label))
  if (!line) return undefined
  const [, total, used] = line.trim().split(/\s+/)
  const t = Number.parseFloat(total)
  const u = Number.parseFloat(used)
  if (!(t > 0) || !Number.isFinite(u)) return undefined
  return Math.round((u / t) * 100)
}

function parseDisks(text = ''): Array<{ mount: string; usePct: number }> | undefined {
  const disks: Array<{ mount: string; usePct: number }> = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6) continue
    const pct = /^(\d+)%$/.exec(cols[4])
    const mount = cols.slice(5).join(' ')
    if (!pct || /^\/(proc|sys|dev|run)(\/|$)/.test(mount)) continue
    disks.push({ mount, usePct: Number(pct[1]) })
  }
  return disks.length ? disks : undefined
}
