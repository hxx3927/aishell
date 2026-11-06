const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  try {
    require('ssh2')
    console.log('[ssh2] loaded')
  } catch (err) {
    console.error('[ssh2] failed', err)
    app.exit(1)
    return
  }

  let pty
  try {
    pty = require('node-pty')
    console.log('[node-pty] loaded')
  } catch (err) {
    console.error('[node-pty] failed', err)
    app.exit(1)
    return
  }

  const dir = path.join(os.tmpdir(), 'aishell pty test')
  fs.mkdirSync(dir, { recursive: true })
  const launcher = path.join(dir, 'launch test.cmd')
  fs.writeFileSync(
    launcher,
    [
      '@echo off',
      'echo HELLO_FROM_ELECTRON_PTY',
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
  })
  proc.onExit(({ exitCode }) => {
    console.log(`[exit ${exitCode}] ${JSON.stringify(output.slice(-200))}`)
    if (output.includes('HELLO_FROM_ELECTRON_PTY') && output.includes('two three')) {
      console.log('[ELECTRON PTY TEST OK]')
      app.exit(0)
    } else {
      console.log('[ELECTRON PTY TEST FAILED]')
      app.exit(1)
    }
  })
  setTimeout(() => {
    console.log('[ELECTRON PTY TEST TIMEOUT]')
    app.exit(2)
  }, 20000)
})
