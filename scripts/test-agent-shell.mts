/**
 * Exercises AgentShell (sentinel protocol) and the redaction rules against
 * the mock SSH server, without Electron.
 *
 *   MOCK_SSH_PORT=2299 node scripts/mock-ssh-server.mjs
 *   npx esbuild scripts/test-agent-shell.mts \
 *     --bundle --platform=node --format=esm --external:ssh2 \
 *     --outfile=scripts/.tmp-test.mjs
 *   MOCK_SSH_PORT=2299 node scripts/.tmp-test.mjs
 */
import ssh2 from 'ssh2'
import { AgentShell } from '../src/main/ssh/AgentShell.ts'
import { redactText, clipOutput } from '../src/main/audit/redact.ts'

const port = Number(process.env.MOCK_SSH_PORT || 2222)
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push({ name, ok, detail: ok ? undefined : detail })
}

// --- redaction -------------------------------------------------------------
const cases: Array<[string, string, string]> = [
  ['mysql -p', 'mysql -uroot -pS3cret! -e "show databases"', 'S3cret!'],
  ['--password=', 'app --password=hunter2 --user x', 'hunter2'],
  ['--token space', 'cli login --token abc.def.ghi', 'abc.def.ghi'],
  ['env assign', 'DB_PASSWORD=p@ss ./run.sh', 'p@ss'],
  ['url creds', 'git clone https://bob:tok123@github.com/x/y', 'tok123'],
  ['bearer', 'curl -H "Authorization: Bearer eyJhbGci.x.y" https://a', 'eyJhbGci.x.y'],
  ['sudo -S', "echo 'rootpw' | sudo -S systemctl restart nginx", 'rootpw'],
  ['sshpass', 'sshpass -p topsecret ssh host', 'topsecret'],
  ['json token', '{"api_key": "AKIA123", "name": "x"}', 'AKIA123']
]
for (const [name, input, secret] of cases) {
  const out = redactText(input)
  check(`redact: ${name}`, !out.includes(secret), out)
}
check('redact: plain command untouched', redactText('ls -la /var/log') === 'ls -la /var/log')
check('redact: mysql -p alone untouched', redactText('mysql -u root -p') === 'mysql -u root -p')
const clipped = clipOutput('x'.repeat(10_000))
check('clipOutput keeps head+tail', clipped.length < 4000 && clipped.includes('省略'), clipped.length)

// --- agent shell -----------------------------------------------------------
const client = new ssh2.Client()
await new Promise<void>((resolve, reject) => {
  client.on('ready', () => resolve()).on('error', reject)
  client.connect({ host: '127.0.0.1', port, username: 'demo', password: 'test' })
})

let closedReason = ''
const shell = await AgentShell.open(client, { onClose: (reason) => (closedReason = reason) })

const r1 = await shell.run('cd /var/log', 10)
check('cd: exit 0', r1.exit_code === 0 && !r1.running, r1)
check('cd: cwd reported', r1.cwd === '/var/log', r1)

const r2 = await shell.run('pwd', 10)
check('cwd persists across calls', r2.output.trim() === '/var/log', r2)

await shell.run('export GREETING=hello', 10)
const r3 = await shell.run('echo $GREETING', 10)
check('env persists across calls', r3.output.trim() === 'hello', r3)

const r4 = await shell.run('exitcode 3', 10)
check('non-zero exit code', r4.exit_code === 3, r4)

const r5 = await shell.run('cat /nope', 10)
check('stderr-ish output captured', r5.exit_code === 1 && r5.output.includes('No such file'), r5)

const r6 = await shell.run('echo one\necho two', 10)
check('multi-line command', r6.output.trim() === 'one\ntwo' && r6.exit_code === 0, r6)

check('no prompt or sentinel noise', !/__AIE_|demo@mock/.test(r2.output + r3.output + r6.output), {
  r2: r2.output,
  r3: r3.output,
  r6: r6.output
})

// Long command: times out, keeps running, then shell_read collects the end.
const slow = await shell.run('sleep 3; echo done', 1)
check('timeout returns running=true', slow.running && slow.timed_out && slow.exit_code === null, slow)
check('timed-out result has no later output', !slow.output.includes('done'), slow)
let busyError = ''
try {
  await shell.run('echo blocked', 5)
} catch (err) {
  busyError = (err as Error).message
}
check('second run while busy is rejected', busyError.includes('仍在运行'), busyError)
const rest = await shell.read(10)
check('shell_read gets final output', !rest.running && rest.exit_code === 0 && rest.output.includes('done'), rest)

// Interrupt a long command.
const long = await shell.run('sleep 30', 1)
check('long command running', long.running, long)
const stopped = await shell.interrupt()
check('interrupt finishes command', !stopped.running && stopped.interrupted, stopped)
const after = await shell.run('echo alive', 10)
check('shell usable after interrupt', after.output.trim() === 'alive' && after.exit_code === 0, after)

let interactiveError = ''
try {
  await shell.run('vim /etc/hosts', 5)
} catch (err) {
  interactiveError = (err as Error).message
}
check('interactive command rejected', interactiveError.includes('交互式'), interactiveError)
let topAllowed = true
try {
  await shell.run('top -bn1 | head -5', 5)
} catch {
  topAllowed = false
}
check('top -b allowed', topAllowed)

shell.close('agent')
check('close fires callback', closedReason === 'agent', closedReason)
let closedError = ''
try {
  await shell.run('pwd', 5)
} catch (err) {
  closedError = (err as Error).message
}
check('run after close rejected', closedError.includes('已关闭'), closedError)

// A disconnect while a command runs reports shell_closed instead of hanging.
const shell2 = await AgentShell.open(client, { onClose: (reason) => (closedReason = reason) })
const pendingRun = shell2.run('sleep 30', 20)
setTimeout(() => client.end(), 300)
const dropped = await pendingRun
check('disconnect mid-command resolves', dropped.shell_closed === true && dropped.running === false, dropped)

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
if (failed.length) {
  console.log('\nFailures:')
  for (const f of failed) console.log(f.name, JSON.stringify(f.detail, null, 2))
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
