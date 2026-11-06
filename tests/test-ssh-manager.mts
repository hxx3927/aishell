/**
 * SshManager against the mock SSH server: connect, exec, shell I/O, timeout
 * and disconnect cleanup. Also guards the TCP_NODELAY fix for interactive
 * latency — ssh2 leaves Nagle on unless setNoDelay is called explicitly.
 *
 *   npx esbuild tests/test-ssh-manager.mts --bundle --platform=node \
 *     --format=esm --external:ssh2 --tsconfig=tsconfig.tests.json \
 *     --outfile=tests/.tmp-ssh-manager.mjs
 *   node tests/.tmp-ssh-manager.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'
import { SshManager } from '../src/main/ssh/SshManager.ts'
import type { SessionStore } from '../src/main/store/SessionStore.ts'
import type { Session } from '@shared/types'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function startMockServer(): Promise<{ port: number; stop: () => void }> {
  const port = await freePort()
  const script = fileURLToPath(new URL('./mock-ssh-server.mjs', import.meta.url))
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, MOCK_SSH_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`mock SSH server did not start in 15s${stderr ? `\n${stderr}` : ''}`))
    }, 15_000)
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.includes('SSH server ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(
        new Error(
          `mock SSH server exited early (${code})${stderr ? `\n${stderr}` : ''}`
        )
      )
    })
  })
  return { port, stop: () => child.kill() }
}

const externalPort = process.env.MOCK_SSH_PORT ? Number(process.env.MOCK_SSH_PORT) : undefined
const mock = externalPort
  ? { port: externalPort, stop: (): void => {} }
  : await startMockServer()
process.on('exit', () => mock.stop())

const port = mock.port
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push({ name, ok, detail: ok ? undefined : detail })
}

async function waitFor<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs = 5000
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// A hung socket would otherwise hang CI; unref keeps a normal exit prompt.
const watchdog = setTimeout(() => {
  console.error('测试超时退出')
  process.exit(1)
}, 60_000)
watchdog.unref()

const session: Session = {
  id: 's1',
  name: 'mock',
  group: '默认',
  host: '127.0.0.1',
  port,
  username: 'demo',
  auth: { type: 'password' },
  createdAt: 0
}

const store = {
  getSession: (id: string) => (id === 's1' ? session : undefined),
  getSecret: (_id: string, kind: string) => (kind === 'password' ? 'test' : undefined),
  verifyHost: () => 'ok' as const,
  getKnownHost: () => undefined,
  touchSession: async () => undefined
}

interface SentEvent {
  channel: string
  payload: Record<string, unknown>
}
const events: SentEvent[] = []
const dataFor = (connId: string): string =>
  events
    .filter((event) => event.channel === 'term:data' && event.payload.connId === connId)
    .map((event) => String(event.payload.data))
    .join('')

const statesFor = (connId: string): string[] =>
  events
    .filter((event) => event.channel === 'ssh:state' && event.payload.connId === connId)
    .map((event) => String(event.payload.status))

// --- Nagle guard -----------------------------------------------------------
const nagleCalls: Array<{ noDelay: boolean }> = []
const originalSetNoDelay = ssh2.Client.prototype.setNoDelay
ssh2.Client.prototype.setNoDelay = function (
  this: InstanceType<typeof ssh2.Client>,
  noDelay?: boolean
) {
  nagleCalls.push({ noDelay: noDelay !== false })
  return originalSetNoDelay.call(this, noDelay)
}

const manager = new SshManager(store as unknown as SessionStore, (channel, payload) => {
  events.push({ channel, payload: payload as Record<string, unknown> })
})

// --- connect ---------------------------------------------------------------
await manager.connect('s1', 's1')
check('connect: session is reported connected', manager.isConnected('s1'), manager.getStatus('s1'))
check(
  'connect: state events go connecting then connected',
  statesFor('s1').join(',') === 'connecting,connected',
  statesFor('s1')
)
check(
  'connect: Nagle is disabled on the interactive socket',
  nagleCalls.length === 1 && nagleCalls[0].noDelay === true,
  nagleCalls
)

let missingError = ''
try {
  await manager.connect('s9', 'missing')
} catch (err) {
  missingError = (err as Error).message
}
check('connect: unknown session is rejected', missingError.includes('会话不存在'), missingError)
check(
  'connect: Nagle is not touched when the connection never opens',
  nagleCalls.length === 1,
  nagleCalls.length
)

// --- exec ------------------------------------------------------------------
const echo = await manager.exec('s1', 'echo hello')
check(
  'exec: stdout and exit code are returned',
  echo.stdout === 'hello\n' && echo.code === 0 && echo.truncated === false,
  echo
)

const cwd = await manager.exec('s1', 'pwd', { cwd: '/var/log' })
check('exec: cwd is resolved and applied', cwd.stdout.trim() === '/var/log', cwd)

const missing = await manager.exec('s1', 'nosuchcommand')
check('exec: non-zero exit code passes through', missing.code === 127, missing)

const started = Date.now()
let timeoutError = ''
try {
  await manager.exec('s1', 'sleep 5', { timeoutSec: 1 })
} catch (err) {
  timeoutError = (err as Error).message
}
const elapsed = Date.now() - started
check(
  'exec: a slow command rejects at the timeout',
  timeoutError.includes('超时') && elapsed >= 900 && elapsed < 3000,
  { timeoutError, elapsed }
)
check('exec: the connection survives a timeout', manager.isConnected('s1'))

// --- shell -----------------------------------------------------------------
await manager.openShell('s1', 100, 30)
await waitFor('shell banner', () => (dataFor('s1').includes('Welcome to AIShell') ? true : undefined))
manager.write('s1', 'echo hi\r')
await waitFor('shell echo', () => (dataFor('s1').includes('hi') ? true : undefined))
manager.write('s1', 'pwd\r')
await waitFor('second command', () => (dataFor('s1').includes('/home/demo') ? true : undefined))
check(
  'shell: keystrokes reach the server and output comes back',
  dataFor('s1').includes('echo hi') && dataFor('s1').includes('hi'),
  dataFor('s1').slice(-200)
)
let unknownWriteThrew = false
try {
  manager.write('nope', 'x')
} catch {
  unknownWriteThrew = true
}
check('shell: write to an unknown connection is a no-op', !unknownWriteThrew)

// --- disconnect ------------------------------------------------------------
manager.disconnect('s1')
check('disconnect: status returns to disconnected', manager.getStatus('s1') === 'disconnected')
let afterDisconnect = ''
try {
  await manager.exec('s1', 'echo nope')
} catch (err) {
  afterDisconnect = (err as Error).message
}
check(
  'disconnect: exec no longer works',
  afterDisconnect.includes('会话不存在或已断开'),
  afterDisconnect
)

ssh2.Client.prototype.setNoDelay = originalSetNoDelay

const failed = results.filter((result) => !result.ok)
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`)
if (failed.length) {
  console.log('\nFailures:')
  for (const result of failed) console.log(result.name, JSON.stringify(result.detail, null, 2))
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
