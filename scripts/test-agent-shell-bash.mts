/**
 * Runs AgentShell against a local bash (no SSH, no pty) to confirm the
 * sentinel and init script parse correctly in a real POSIX shell, not only in
 * the mock server's fake shell.
 *
 *   npx esbuild scripts/test-agent-shell-bash.mts \
 *     --bundle --platform=node --format=esm --external:ssh2 \
 *     --outfile=scripts/.tmp-bash.mjs
 *   node scripts/.tmp-bash.mjs
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { AgentShell } from '../src/main/ssh/AgentShell.ts'

/** Just enough of ssh2's Client/ClientChannel for AgentShell. */
function fakeClient(): unknown {
  return {
    shell(_opts: unknown, cb: (err: Error | undefined, channel: unknown) => void) {
      const child = spawn('bash', ['--norc', '--noprofile', '-s'], { stdio: 'pipe' })
      const channel = Object.assign(new EventEmitter(), {
        stderr: child.stderr,
        write: (data: string) => child.stdin.write(data),
        close: () => child.kill()
      })
      child.stdout.on('data', (chunk) => channel.emit('data', chunk))
      child.on('close', () => channel.emit('close'))
      cb(undefined, channel)
    }
  }
}

const results: Array<[string, boolean, unknown]> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push([name, ok, detail])
}

const shell = await AgentShell.open(fakeClient() as never, { onClose: () => undefined })

const a = await shell.run('cd / && pwd', 10)
check('cd + pwd', a.output.trim() === '/' && a.exit_code === 0 && a.cwd === '/', a)

const b = await shell.run('export FOO="a b"; echo "$FOO"', 10)
check('export with spaces', b.output.trim() === 'a b', b)

const c = await shell.run('echo $FOO', 10)
check('env persists', c.output.trim() === 'a b', c)

const d = await shell.run('(exit 7)', 10)
check('exit code 7', d.exit_code === 7, d)

const e = await shell.run("printf '%s\\n' \"it's\" 'quoted \"x\"'", 10)
check('quotes survive', e.output === "it's\nquoted \"x\"\n" || e.output.trim() === "it's\nquoted \"x\"", e)

const f = await shell.run('for i in 1 2 3; do\n  echo line$i\ndone', 10)
check('multi-line loop', f.output.trim() === 'line1\nline2\nline3', f)

const g = await shell.run('printf "no trailing newline"', 10)
check('output without newline', g.output.includes('no trailing newline') && g.exit_code === 0, g)

const h = await shell.run('echo out; echo err 1>&2', 10)
check('stderr merged', h.output.includes('out') && h.output.includes('err'), h)

const i = await shell.run('cd "/tmp" 2>/dev/null || cd /; mkdir -p "dir with space" && cd "dir with space"', 10)
check('cwd with spaces', Boolean(i.cwd?.endsWith('dir with space')), i)

const slow = await shell.run('sleep 2; echo finished', 1)
check('timeout keeps running', slow.running && slow.exit_code === null, slow)
const tail = await shell.read(10)
check('read collects tail', !tail.running && tail.output.includes('finished') && tail.exit_code === 0, tail)

shell.close()

let failed = 0
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failed += 1
    console.log('      ', JSON.stringify(detail))
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
