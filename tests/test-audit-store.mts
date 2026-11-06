/**
 * AuditStore round trip: intent/result pairing, crash leftovers showing as
 * unfinished, redaction, retention pruning and JSONL/CSV export.
 *
 * Never touches real audit logs: the store writes to a throwaway directory
 * via AISHELL_AUDIT_TEST_DIR.
 *
 *   npx esbuild tests/test-audit-store.mts \
 *     --bundle --platform=node --format=cjs --external:electron \
 *     --outfile=tests/.tmp-audit-store.cjs
 *   node tests/.tmp-audit-store.cjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditStore, dateKey } from '../src/main/audit/AuditStore'

const userData = join(tmpdir(), `aishell-audit-test-${process.pid}`)
process.env.AISHELL_AUDIT_TEST_DIR = userData
const dir = join(userData, 'audit')
mkdirSync(dir, { recursive: true })

const results: Array<[string, boolean, unknown]> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push([name, ok, detail])
}

const today = dateKey(Date.now())
/** The crash leftover goes in yesterday's file. */
const crashedAt = Date.now() - 86_400_000
/** This run's own calls go in today's file and are written through the same
 *  append path the app uses. */
const file = join(dir, `${today}.jsonl`)

const store = new AuditStore(
  () => 90,
  (message) => check('no write-failure notification', false, message)
)
const base = {
  sessionId: 's1',
  sessionName: 'web-01',
  host: '10.0.1.11:22',
  username: 'deploy',
  agentSessionId: 'agent-1',
  profileId: 'claude'
}
const intent = (tool: string, args: Record<string, unknown>, extra = {}): string =>
  store.recordIntent({ ...base, tool, args, dangerous: false, ...extra }, { durable: true })

async function main(): Promise<void> {
  // Paired call.
  const ok = intent('exec', { command: 'uptime' })
  store.recordResult(ok, { status: 'success', durationMs: 12, exitCode: 0, output: { stdout: 'up 3 days' } })

  // Dangerous call that failed on the server. AIShell records it rather than
  // asking the user: record-only is the product contract.
  const risky = intent('exec', { command: 'rm -rf /tmp/x' }, { dangerous: true })
  store.recordResult(risky, { status: 'error', durationMs: 1, error: 'command failed' })

  // Secrets are redacted before they hit the disk.
  intent('exec', { command: 'mysql -uroot -pS3cret! -e "select 1"' })
  store.dispose()
  const own = readFileSync(file, 'utf8')

  // Another run's leftovers on an earlier day: an intent that never got a
  // result, and a torn final line after it.
  const crashedDay = dateKey(crashedAt)
  const crashedRecord = {
    v: 1,
    type: 'intent',
    id: 'crashed-1',
    ts: crashedAt,
    ...base,
    tool: 'shell_run',
    args: { command: 'sleep 600' },
    dangerous: false
  }
  writeFileSync(
    join(dir, `${crashedDay}.jsonl`),
    `${JSON.stringify(crashedRecord)}\n{"v":1,"type":"intent","id":"torn`
  )

  const entries = (await store.query({ from: crashedDay, to: today })).entries
  const calls = entries.filter((entry) => entry.kind === 'call')

  const unfinished = calls.filter((call) => call.status === 'unfinished')
  check(
    'only the crash leftover is unfinished',
    unfinished.length === 1 && JSON.stringify(unfinished[0].args).includes('sleep 600'),
    unfinished
  )

  const paired = calls.find((call) => call.tool === 'exec' && call.status === 'success')
  check('paired call is success', paired?.exitCode === 0 && paired.output?.stdout === 'up 3 days', paired)
  check('agent attribution survives', paired?.agentSessionId === 'agent-1' && paired?.profileId === 'claude', paired)

  const failed = calls.find((call) => call.status === 'error')
  check('failed call recorded', Boolean(failed) && failed?.error === 'command failed', failed)

  check(
    'secret redacted in file',
    !own.includes('S3cret!') && own.includes('mysql -uroot -p***'),
    own
  )
  check('torn line does not break the read', calls.length === 4, calls.map((call) => call.tool))

  const jsonlPath = join(userData, 'export.jsonl')
  const jsonlCount = await store.exportTo(jsonlPath, { from: crashedDay, to: today }, 'jsonl')
  const jsonLines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
  let parsed = 0
  for (const line of jsonLines) {
    JSON.parse(line)
    parsed += 1
  }
  check('jsonl export parses line by line', parsed === jsonlCount && jsonLines.length === jsonlCount, { parsed, jsonlCount })

  const csvPath = join(userData, 'export.csv')
  const csvCount = await store.exportTo(csvPath, { from: crashedDay, to: today }, 'csv')
  const csv = readFileSync(csvPath, 'utf8')
  check('csv has UTF-8 BOM', csv.charCodeAt(0) === 0xfeff, csv.charCodeAt(0))
  check(
    'csv row count matches',
    csvCount === jsonlCount && csv.replace(/^﻿/, '').trim().split('\n').length === csvCount + 1,
    csvCount
  )

  // Retention: files older than the 90 days go, recent ones stay.
  writeFileSync(join(dir, '2020-01-01.jsonl'), '{"v":1}\n')
  const removed = await store.prune()
  const left = await store.info()
  check('prune removes expired files', removed === 1, removed)
  check('prune keeps recent files', left.fileCount === 2 && left.retentionDays === 90, left)

  store.dispose()
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

void main().then(report, (err: Error) => {
  console.error(err)
  process.exit(1)
})
