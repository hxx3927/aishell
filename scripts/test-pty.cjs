const pty = require('node-pty')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = path.join(os.tmpdir(), 'aishell pty test')
fs.mkdirSync(dir, { recursive: true })
const launcher = path.join(dir, 'launch test.cmd')
fs.writeFileSync(
  launcher,
  [
    '@echo off',
    'chcp 65001 >nul 2>nul',
    'echo HELLO_FROM_LAUNCHER',
    'node -e "console.log(JSON.stringify(process.argv.slice(1)))" one "two three"',
    'exit /b 0'
  ].join('\r\n') + '\r\n'
)

const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
const proc = pty.spawn(comspec, ['/d', '/s', '/c', 'call', launcher], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: dir,
  env: process.env
})

let output = ''
proc.onData((data) => {
  output += data
  process.stdout.write(data)
})
proc.onExit(({ exitCode }) => {
  console.log(`\n[exit ${exitCode}]`)
  if (output.includes('HELLO_FROM_LAUNCHER') && output.includes('two three')) {
    console.log('[PTY TEST OK]')
    process.exit(0)
  }
  console.log('[PTY TEST FAILED]')
  process.exit(1)
})

setTimeout(() => {
  console.log('[PTY TEST TIMEOUT]')
  process.exit(2)
}, 15000)
