const { Client } = require('ssh2')

const conn = new Client()

function exec(command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      let errOut = ''
      stream.on('data', (d) => (out += d))
      stream.stderr.on('data', (d) => (errOut += d))
      stream.on('close', (code) => resolve({ out, errOut, code }))
    })
  })
}

function sftpCall(method, ...args) {
  return new Promise((resolve, reject) => {
    const sftp = conn.__sftp
    sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)))
  })
}

conn
  .on('ready', async () => {
    try {
      console.log('READY')
      const uname = await exec('uname -a')
      console.log('EXEC uname:', JSON.stringify(uname))

      const ls = await exec('cd /home/demo && ls -la')
      console.log('EXEC ls:\n' + ls.out)

      const hostInfo = await exec(
        'printf "%s\\n" "$(uname -sr 2>/dev/null)"; printf "%s\\n" "$(pwd 2>/dev/null)"; printf "%s\\n" "$HOME"; (cat /etc/os-release 2>/dev/null | head -4)'
      )
      console.log('HOSTINFO:', JSON.stringify(hostInfo.out))

      conn.sftp(async (err, sftp) => {
        if (err) throw err
        conn.__sftp = sftp
        const list = await sftpCall('readdir', '/home/demo')
        console.log(
          'SFTP list:',
          list.map((e) => `${e.filename}${e.attrs.isDirectory() ? '/' : ''}(${e.attrs.size})`)
        )

        await sftpCall('writeFile', '/home/demo/from-test.txt', 'hello from test\n')
        const read = await sftpCall('readFile', '/home/demo/from-test.txt')
        console.log('SFTP read:', JSON.stringify(read.toString()))

        await sftpCall('rename', '/home/demo/from-test.txt', '/home/demo/renamed.txt')
        await sftpCall('mkdir', '/home/demo/newdir')
        const list2 = await sftpCall('readdir', '/home/demo')
        console.log('SFTP after ops:', list2.map((e) => e.filename))

        await sftpCall('unlink', '/home/demo/renamed.txt')
        await sftpCall('rmdir', '/home/demo/newdir')

        conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err2, stream) => {
          if (err2) throw err2
          let out = ''
          stream.on('data', (d) => {
            out += d.toString()
          })
          stream.write('cd projects\r')
          setTimeout(() => stream.write('ls\r'), 200)
          setTimeout(() => {
            console.log('SHELL OUTPUT:\n' + out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
            stream.end()
            conn.end()
          }, 700)
        })
      })
    } catch (e) {
      console.error('TEST FAILED', e)
      conn.end()
      process.exitCode = 1
    }
  })
  .on('error', (e) => {
    console.error('CONN ERROR', e.message)
    process.exitCode = 1
  })
  .on('close', () => console.log('CLOSED'))
  .connect({ host: '127.0.0.1', port: 2222, username: 'demo', password: 'test' })
