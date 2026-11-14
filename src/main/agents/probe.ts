import { execFile } from 'node:child_process'
import type { AgentProbeResult } from '@shared/types'

const PROBE_TIMEOUT_MS = 4000

/**
 * Locates an agent CLI on PATH and asks it for its version. The renderer runs
 * this from both the settings page and the new-agent menu, so the answer is
 * short-lived cached — an agent installed mid-session shows up after a minute.
 */
const cache = new Map<string, { at: number; result: AgentProbeResult }>()
const CACHE_MS = 60_000

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        shell: process.platform === 'win32',
        // Some CLIs print help and exit 1 on an unknown flag; the text still
        // tells us the binary is there.
        maxBuffer: 256 * 1024
      },
      (_err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
        resolve(out || null)
      }
    )
  })
}

export async function probeAgent(rawCommand: string): Promise<AgentProbeResult> {
  const command = rawCommand.trim()
  if (!command) return { command, found: false }
  const hit = cache.get(command)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result

  const result: AgentProbeResult = { command, found: false }
  const found = await run(process.platform === 'win32' ? 'where' : 'which', [command])
  if (found) {
    result.found = true
    result.path = found
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    const versionOut = await run(command, ['--version'])
    if (versionOut) {
      const match = versionOut.match(/\d+\.\d+(?:\.\d+)?(?:[-.\w]+)?/)
      result.version = match ? match[0] : versionOut.split(/\r?\n/)[0].slice(0, 60)
    }
  }
  cache.set(command, { at: Date.now(), result })
  return result
}
