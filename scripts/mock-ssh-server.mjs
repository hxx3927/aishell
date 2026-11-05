/**
 * AIShell mock SSH/SFTP server.
 *
 *   node scripts/mock-ssh-server.mjs
 *
 * Listen on 127.0.0.1:2222, username `demo`, password `test`.
 * Provides an in-memory filesystem, a fake interactive shell and an exec channel.
 * Useful for testing the app without a real server.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const { STATUS_CODE, OPEN_MODE } = utils.sftp

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = '127.0.0.1'
const PORT = Number(process.env.MOCK_SSH_PORT || 2222)
const USER = 'demo'
const PASSWORD = 'test'
const HOME = '/home/demo'

// ---------------------------------------------------------------- host key

const KEY_FILE = join(HERE, '.mock-ssh-host-key')
let hostKey
if (existsSync(KEY_FILE)) {
  hostKey = readFileSync(KEY_FILE, 'utf8')
} else {
  hostKey = utils.generateKeyPairSync('ed25519').private
  writeFileSync(KEY_FILE, hostKey, { mode: 0o600 })
  console.log(`[mock] generated host key at ${KEY_FILE}`)
}

// ------------------------------------------------------------- fake filesystem

const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const FS = new Map()

function norm(path, cwd = HOME) {
  if (!path || path === '.') return cwd
  let p = String(path).trim()
  if (p === '~') return HOME
  if (p.startsWith('~/')) p = `${HOME}/${p.slice(2)}`
  if (!p.startsWith('/')) p = `${cwd}/${p}`
  const parts = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}` || '/'
}

function putDir(path, mode = 0o755) {
  FS.set(norm(path), { type: 'dir', mode: S_IFDIR | mode, mtime: Math.floor(Date.now() / 1000) })
}

function putFile(path, content, mode = 0o644) {
  const target = norm(path)
  FS.set(target, {
    type: 'file',
    mode: S_IFREG | mode,
    mtime: Math.floor(Date.now() / 1000),
    content: Buffer.from(content)
  })
  // Ensure ancestors exist.
  const parts = target.split('/').filter(Boolean)
  for (let i = 1; i < parts.length; i++) {
    const dir = `/${parts.slice(0, i).join('/')}`
    if (!FS.has(dir)) putDir(dir)
  }
}

putDir('/')
putDir('/home')
putDir(HOME)
putDir('/home/demo/projects')
putDir('/home/demo/.ssh', 0o700)
putDir('/var')
putDir('/var/log')
putDir('/var/www')
putDir('/etc')
putDir('/tmp', 0o1777)
putDir('/root', 0o700)

putFile('/home/demo/readme.txt', `AIShell mock server
===================

This server is entirely in memory. Nothing is written to disk.
Login: demo / test

Try:
  ls -la
  cd projects
  cat hello.py
  df -h
  free -m
`)
putFile(
  '/home/demo/projects/hello.py',
  `#!/usr/bin/env python3


def main() -> None:
    print("hello from AIShell mock server")


if __name__ == "__main__":
    main()
`
)
putFile('/home/demo/projects/deploy.sh', '#!/bin/bash\nset -euo pipefail\necho "deploying..."\n', 0o755)
putFile('/home/demo/.ssh/authorized_keys', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKey demo@mock\n', 0o600)
putFile('/var/www/index.html', '<!doctype html>\n<title>AIShell mock</title>\n<h1>It works</h1>\n')
putFile('/etc/os-release', 'PRETTY_NAME="AIShell Mock Linux 1.0"\nNAME="AIShell Mock Linux"\nVERSION="1.0"\nID=aishell-mock\n')
putFile('/etc/hostname', 'mock-ssh\n')

const logLines = []
for (let i = 1; i <= 200; i++) {
  logLines.push(
    `2026-11-04T12:${String(i % 60).padStart(2, '0')}:00Z mock-ssh app[${1000 + (i % 30)}]: request ${i} handled in ${(i % 17) + 1}ms`
  )
}
putFile('/var/log/app.log', logLines.join('\n') + '\n')

function isDir(path) {
  return FS.get(norm(path))?.type === 'dir'
}

function exists(path) {
  return FS.has(norm(path))
}

function children(path) {
  const base = norm(path)
  const prefix = base === '/' ? '/' : `${base}/`
  const result = []
  for (const key of FS.keys()) {
    if (key === base || !key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    if (!rest || rest.includes('/')) continue
    result.push({ name: rest, path: key, entry: FS.get(key) })
  }
  result.sort((a, b) => {
    const da = a.entry.type === 'dir'
    const db = b.entry.type === 'dir'
    if (da !== db) return da ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return result
}

function removePath(path, recursive) {
  const target = norm(path)
  if (target === '/') return false
  const entry = FS.get(target)
  if (!entry) return false
  if (entry.type === 'dir') {
    const nested = children(target)
    if (nested.length && !recursive) return false
    for (const key of Array.from(FS.keys())) {
      if (key === target || key.startsWith(`${target}/`)) FS.delete(key)
    }
    return true
  }
  FS.delete(target)
  return true
}

function movePath(from, to) {
  const source = norm(from)
  const dest = norm(to)
  if (!FS.has(source)) return false
  const saved = []
  for (const [key, entry] of FS.entries()) {
    if (key === source || key.startsWith(`${source}/`)) {
      saved.push([key, dest + key.slice(source.length), entry])
    }
  }
  for (const [sourceKey] of saved) FS.delete(sourceKey)
  for (const [, destKey, entry] of saved) FS.set(destKey, entry)
  return true
}

function permString(mode) {
  const type = (mode & 0o170000) === S_IFDIR ? 'd' : '-'
  const rwx = (bits) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`
  return type + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7)
}

function attrsOf(entry) {
  const size = entry.type === 'file' ? entry.content.length : 4096
  return {
    mode: entry.mode,
    uid: 1000,
    gid: 1000,
    size,
    atime: entry.mtime,
    mtime: entry.mtime
  }
}

function statAttrs(path) {
  const entry = FS.get(norm(path))
  return entry ? attrsOf(entry) : null
}

// ------------------------------------------------------------------ commands

function tokenize(line) {
  const tokens = []
  let current = ''
  let quote = null
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

function expand(value, ctx) {
  const vars = { HOME, PWD: ctx.cwd, USER, ...(ctx.env ?? {}) }
  return value
    .replace(/\$\?/g, String(ctx.lastCode ?? 0))
    .replace(/\$\{(\w+)\}/g, (_m, name) => vars[name] ?? '')
    .replace(/\$(\w+)/g, (_m, name) => vars[name] ?? '')
}

function displayPath(path) {
  if (path === HOME) return '~'
  if (path.startsWith(`${HOME}/`)) return `~${path.slice(HOME.length)}`
  return path
}

function runCommand(raw, ctx) {
  if (raw.includes('os-release') && raw.includes('uname -sr')) {
    return {
      out:
        'Linux 6.8.0-mock\n' +
        `${ctx.cwd}\n` +
        `${HOME}\n` +
        'PRETTY_NAME="AIShell Mock Linux 1.0"\n' +
        'NAME="AIShell Mock Linux"\n' +
        'VERSION="1.0"\n' +
        'ID=aishell-mock\n',
      code: 0
    }
  }

  let output = ''
  let code = 0
  let exit = false
  let drop = false
  const statements = raw.split(';')
  for (let s = 0; s < statements.length; s++) {
    if (!statements[s].trim()) continue
    for (const part of statements[s].split('&&')) {
      const result = runSingle(part.trim(), ctx)
      output += result.out
      code = result.code
      ctx.lastCode = code
      if (result.exit) exit = true
      if (result.drop) drop = true
      if (result.sleepMs) {
        // Statements after a sleep run when it ends (the shell resumes them).
        const rest = statements.slice(s + 1).join(';')
        return { out: output, code, exit, drop, sleepMs: result.sleepMs, rest }
      }
      if (code !== 0) break
    }
  }
  return { out: output, code, exit, drop }
}

function runSingle(raw, ctx) {
  if (!raw) return { out: '', code: 0 }
  let line = expand(raw, ctx)
  if (line.startsWith('sudo ')) line = line.slice(5)
  const tokens = tokenize(line)
  if (!tokens.length) return { out: '', code: 0 }
  const cmd = tokens[0]
  const rest = tokens.slice(1)

  switch (cmd) {
    case 'pwd':
      return { out: `${ctx.cwd}\n`, code: 0 }

    case 'cd': {
      const target = norm(rest[0] ?? '~', ctx.cwd)
      if (!isDir(target)) return { out: `cd: ${rest[0] ?? '~'}: No such file or directory\n`, code: 1 }
      ctx.cwd = target
      return { out: '', code: 0 }
    }

    case 'ls': {
      let long = false
      let all = false
      const paths = []
      for (const token of rest) {
        if (token.startsWith('-') && token.length > 1) {
          long = long || token.includes('l')
          all = all || token.includes('a')
        } else {
          paths.push(token)
        }
      }
      if (!paths.length) paths.push('.')
      let out = ''
      for (const item of paths) {
        const target = norm(item, ctx.cwd)
        const entry = FS.get(target)
        if (!entry) {
          out += `ls: cannot access '${item}': No such file or directory\n`
          continue
        }
        if (entry.type === 'file') {
          out += long
            ? `${permString(entry.mode)} 1 ${USER} ${USER} ${String(entry.content.length).padStart(6)} Nov  4 12:00 ${norm(target).split('/').pop()}\n`
            : `${norm(target).split('/').pop()}\n`
          continue
        }
        const list = children(target)
        if (all) list.unshift({ name: '.', entry }, { name: '..', entry })
        for (const child of list) {
          if (long) {
            const size = child.entry.type === 'file' ? child.entry.content.length : 4096
            out += `${permString(child.entry.mode)} 1 ${USER} ${USER} ${String(size).padStart(6)} Nov  4 12:00 ${child.name}\n`
          } else {
            out += `${child.name}${child.entry.type === 'dir' ? '/' : ''}\n`
          }
        }
      }
      return { out, code: 0 }
    }

    case 'cat': {
      let out = ''
      for (const item of rest) {
        const entry = FS.get(norm(item, ctx.cwd))
        if (!entry || entry.type !== 'file') {
          return { out: `cat: ${item}: No such file or directory\n`, code: 1 }
        }
        out += entry.content.toString('utf8')
      }
      return { out, code: 0 }
    }

    case 'echo':
      return { out: `${rest.join(' ')}\n`, code: 0 }

    case 'whoami':
      return { out: `${USER}\n`, code: 0 }

    case 'id':
      return { out: 'uid=1000(demo) gid=1000(demo) groups=1000(demo),27(sudo)\n', code: 0 }

    case 'hostname':
      return { out: 'mock-ssh\n', code: 0 }

    case 'uname':
      if (rest.includes('-a')) {
        return {
          out: 'Linux mock-ssh 6.8.0-mock #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n',
          code: 0
        }
      }
      if (rest.includes('-r')) return { out: '6.8.0-mock\n', code: 0 }
      if (rest.includes('-s')) return { out: 'Linux\n', code: 0 }
      return { out: 'Linux\n', code: 0 }

    case 'df':
      return {
        out:
          'Filesystem      Size  Used Avail Use% Mounted on\n' +
          '/dev/mock0       40G   12G   26G  32% /\n' +
          'tmpfs           2.0G  4.0M  2.0G   1% /run\n',
        code: 0
      }

    case 'free':
      return {
        out:
          '               total        used        free      shared  buff/cache   available\n' +
          'Mem:           7.8Gi       2.1Gi       4.9Gi       0.1Gi       1.2Gi       5.4Gi\n' +
          'Swap:          2.0Gi          0B       2.0Gi\n',
        code: 0
      }

    case 'uptime':
      return { out: ' 12:00:00 up 3 days,  4:21,  1 user,  load average: 0.08, 0.12, 0.10\n', code: 0 }

    case 'date':
      return { out: `${new Date().toString()}\n`, code: 0 }

    case 'mkdir': {
      const recursive = rest.some((t) => t.startsWith('-') && t.includes('p'))
      const dirs = rest.filter((t) => !t.startsWith('-'))
      for (const dir of dirs) {
        const target = norm(dir, ctx.cwd)
        if (recursive) {
          const parts = target.split('/').filter(Boolean)
          for (let i = 1; i <= parts.length; i++) {
            const path = `/${parts.slice(0, i).join('/')}`
            if (!FS.has(path)) putDir(path)
          }
        } else {
          if (FS.has(target)) return { out: `mkdir: cannot create directory '${dir}': File exists\n`, code: 1 }
          putDir(target)
        }
      }
      return { out: '', code: 0 }
    }

    case 'touch': {
      for (const file of rest) {
        if (!FS.has(norm(file, ctx.cwd))) putFile(norm(file, ctx.cwd), '')
      }
      return { out: '', code: 0 }
    }

    case 'rm': {
      const recursive = rest.some((t) => t.startsWith('-') && (t.includes('r') || t.includes('R')))
      const force = rest.some((t) => t.startsWith('-') && t.includes('f'))
      const targets = rest.filter((t) => !t.startsWith('-'))
      for (const item of targets) {
        const target = norm(item, ctx.cwd)
        if (!FS.has(target)) {
          if (!force) return { out: `rm: cannot remove '${item}': No such file or directory\n`, code: 1 }
          continue
        }
        if (isDir(target) && children(target).length && !recursive) {
          return { out: `rm: cannot remove '${item}': Is a directory\n`, code: 1 }
        }
        if (!removePath(target, recursive)) {
          return { out: `rm: cannot remove '${item}'\n`, code: 1 }
        }
      }
      return { out: '', code: 0 }
    }

    case 'mv':
    case 'cp': {
      const [from, to] = rest
      if (!from || !to) return { out: `usage: ${cmd} SOURCE DEST\n`, code: 1 }
      const source = norm(from, ctx.cwd)
      if (cmd === 'mv') {
        if (!movePath(source, norm(to, ctx.cwd))) {
          return { out: `mv: cannot stat '${from}': No such file or directory\n`, code: 1 }
        }
      } else {
        const entry = FS.get(source)
        if (!entry) return { out: `cp: cannot stat '${from}': No such file or directory\n`, code: 1 }
        if (entry.type !== 'file') return { out: `cp: -r not supported in mock for directories\n`, code: 1 }
        putFile(norm(to, ctx.cwd), entry.content, entry.mode & 0o777)
      }
      return { out: '', code: 0 }
    }

    case 'head':
    case 'tail': {
      let count = 10
      const files = []
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-n') {
          count = Number(rest[++i]) || 10
        } else if (/^-\d+$/.test(rest[i])) {
          count = Number(rest[i].slice(1))
        } else {
          files.push(rest[i])
        }
      }
      let out = ''
      for (const file of files) {
        const entry = FS.get(norm(file, ctx.cwd))
        if (!entry || entry.type !== 'file') {
          return { out: `${cmd}: cannot open '${file}' for reading: No such file or directory\n`, code: 1 }
        }
        const lines = entry.content.toString('utf8').split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        out += (cmd === 'head' ? lines.slice(0, count) : lines.slice(-count)).join('\n') + '\n'
      }
      return { out, code: 0 }
    }

    case 'grep': {
      const args = rest.filter((t) => !t.startsWith('-'))
      const [pattern, file] = args
      if (!pattern) return { out: 'usage: grep PATTERN [FILE]\n', code: 1 }
      if (file) {
        const entry = FS.get(norm(file, ctx.cwd))
        if (!entry || entry.type !== 'file') {
          return { out: `grep: ${file}: No such file or directory\n`, code: 2 }
        }
        const lines = entry.content.toString('utf8').split('\n').filter((line) => line.includes(pattern))
        return { out: lines.length ? `${lines.join('\n')}\n` : '', code: lines.length ? 0 : 1 }
      }
      return { out: '', code: 1 }
    }

    case 'ps':
      return {
        out:
          'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n' +
          'root         1  0.0  0.1 168000 12000 ?        Ss   Nov01   0:05 /sbin/init\n' +
          'demo      2311  0.2  0.3 812000 28000 ?        Ssl  10:12   0:01 node server.js\n',
        code: 0
      }

    case 'du':
      return { out: `12M\t${norm(rest[rest.length - 1] ?? '.', ctx.cwd)}\n`, code: 0 }

    case 'export': {
      ctx.env = ctx.env ?? {}
      for (const item of rest) {
        const eq = item.indexOf('=')
        if (eq > 0) ctx.env[item.slice(0, eq)] = item.slice(eq + 1)
      }
      return { out: '', code: 0 }
    }

    case 'unset':
    case 'bind':
    case 'true':
      return { out: '', code: 0 }

    case 'false':
      return { out: '', code: 1 }

    case 'stty':
      if (rest.includes('-echo')) ctx.echo = false
      else if (rest.includes('echo')) ctx.echo = true
      return { out: '', code: 0 }

    case 'printf': {
      // Minimal printf: %s substitution and \n escapes.
      const [format = '', ...values] = rest
      let index = 0
      const out = format.replace(/%s/g, () => values[index++] ?? '').replace(/\\n/g, '\n')
      return { out, code: 0 }
    }

    case 'sleep':
      return { out: '', code: 0, sleepMs: Math.round(Number(rest[0] ?? 0) * 1000) }

    // Test hook: `exitcode 3` sets $? without printing anything.
    case 'exitcode':
      return { out: '', code: Number(rest[0] ?? 0) }

    case 'clear':
      return { out: '\x1b[2J\x1b[H', code: 0 }

    case 'exit':
    case 'logout':
      return { out: '', code: 0, exit: true }

    // Test hook: closes the shell channel without an exit-status, which is
    // what a dropped channel looks like to client-side auto-recovery.
    case 'drop':
      return { out: '', code: 0, drop: true }

    default:
      return { out: `bash: ${cmd}: command not found\n`, code: 127 }
  }
}

// ---------------------------------------------------------------- ssh server

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  console.log('[mock] client connected')

  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) {
        ctx.accept()
        return
      }
      if (ctx.method === 'none') {
        ctx.reject(['password'])
        return
      }
      ctx.reject(['password'])
    })
    .on('ready', () => {
      console.log('[mock] client authenticated')
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        const ctx = { cwd: HOME, env: {}, lastCode: 0, echo: true }

        session.on('pty', (accept) => {
          if (accept) accept()
        })
        session.on('window-change', (accept) => {
          if (accept) accept()
        })
        session.on('env', (accept) => {
          if (accept) accept()
        })

        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          console.log(`[mock] exec: ${info.command}`)
          const result = runCommand(info.command, { ...ctx })
          if (result.out) stream.write(result.out)
          stream.exit(result.code ?? 0)
          stream.end()
        })

        session.on('shell', (accept) => {
          const stream = accept()
          let line = ''
          const prompt = () =>
            `\x1b[32m${USER}@mock-ssh\x1b[0m:\x1b[34m${displayPath(ctx.cwd)}\x1b[0m$ `
          stream.write('Welcome to AIShell mock server (in-memory, demo/test).\r\n')
          stream.write(prompt())

          // Input that arrives while a command sleeps is queued like a tty's
          // type-ahead buffer; Ctrl+C ends the sleep and discards it.
          let sleeping = false
          let queue = ''
          let sleepTimer = null
          const echo = (text) => {
            if (ctx.echo) stream.write(text)
          }
          const showPrompt = () => {
            if (ctx.echo) stream.write(prompt())
          }
          const wake = () => {
            sleepTimer = null
            sleeping = false
            showPrompt()
            const input = queue
            queue = ''
            if (input) handle(input)
          }
          const handle = (text) => {
            for (let i = 0; i < text.length; i++) {
              const ch = text[i]
              if (sleeping) {
                const ctrlC = text.indexOf('\x03', i)
                if (ctrlC === -1) {
                  queue += text.slice(i)
                  return
                }
                clearTimeout(sleepTimer)
                stream.write('^C\n')
                ctx.lastCode = 130
                queue = ''
                wake()
                handle(text.slice(ctrlC + 1))
                return
              }
              if (ch === '\x1b') {
                // Skip ANSI escape sequences (arrow keys, bracketed paste markers).
                const rest = text.slice(i)
                const match = rest.match(/^\x1b\[[0-9;?]*[A-Za-z~]|^\x1b\][^\x07]*\x07/)
                if (match) i += match[0].length - 1
                continue
              }
              if (ch === '\r' || ch === '\n') {
                echo('\r\n')
                const command = line.trim()
                line = ''
                if (!command) {
                  showPrompt()
                  continue
                }
                const result = runCommand(command, ctx)
                if (result.out) {
                  stream.write(ctx.echo ? result.out.replace(/\n/g, '\r\n') : result.out)
                }
                if (result.drop) {
                  stream.end()
                  return
                }
                if (result.exit) {
                  stream.exit(0)
                  stream.end()
                  return
                }
                if (result.sleepMs) {
                  sleeping = true
                  sleepTimer = setTimeout(wake, result.sleepMs)
                  queue += (result.rest?.trim() ? `${result.rest}\n` : '') + text.slice(i + 1)
                  return
                }
                showPrompt()
                continue
              }
              if (ch === '\x7f' || ch === '\b') {
                if (line.length) {
                  line = line.slice(0, -1)
                  stream.write('\b \b')
                }
                continue
              }
              if (ch === '\x03') {
                echo('^C\r\n')
                line = ''
                showPrompt()
                continue
              }
              if (ch === '\x04') {
                stream.exit(0)
                stream.end()
                return
              }
              if (ch === '\x15') {
                line = ''
                stream.write('\r\x1b[K')
                stream.write(prompt())
                continue
              }
              if (ch === '\x0c') {
                stream.write('\x1b[2J\x1b[H')
                stream.write(prompt())
                continue
              }
              if (ch >= ' ') {
                line += ch
                echo(ch)
              }
            }
          }
          stream.on('data', (chunk) => handle(chunk.toString('utf8')))

          stream.on('close', () => {
            if (sleepTimer) clearTimeout(sleepTimer)
            console.log('[mock] shell closed')
          })
        })

        session.on('sftp', (accept) => {
          const sftp = accept()
          const handles = new Map()
          let handleSeq = 0
          const newHandle = (entry) => {
            const handle = Buffer.alloc(4)
            handle.writeUInt32BE(handleSeq, 0)
            handles.set(handleSeq, entry)
            handleSeq += 1
            return handle
          }
          const getHandle = (handle) =>
            handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined

          sftp
            .on('OPEN', (reqid, filename, flags) => {
              const target = norm(filename, ctx.cwd)
              const creating = Boolean(flags & OPEN_MODE.CREAT)
              const truncating = Boolean(flags & OPEN_MODE.TRUNC)
              const writing = Boolean(flags & OPEN_MODE.WRITE) || Boolean(flags & OPEN_MODE.APPEND)
              let entry = FS.get(target)
              if (!entry) {
                if (!creating) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
                putFile(target, '')
                entry = FS.get(target)
              }
              if (entry.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
              if (truncating) entry.content = Buffer.alloc(0)
              sftp.handle(reqid, newHandle({ kind: 'file', path: target, entry, writing }))
            })
            .on('READ', (reqid, handle, offset, length) => {
              const item = getHandle(handle)
              if (!item || item.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
              if (offset >= item.entry.content.length) return sftp.status(reqid, STATUS_CODE.EOF)
              sftp.data(reqid, item.entry.content.subarray(offset, offset + length))
            })
            .on('WRITE', (reqid, handle, offset, data) => {
              const item = getHandle(handle)
              if (!item || item.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
              const end = offset + data.length
              if (end > item.entry.content.length) {
                const grown = Buffer.alloc(end)
                item.entry.content.copy(grown)
                item.entry.content = grown
              }
              data.copy(item.entry.content, offset)
              item.entry.mtime = Math.floor(Date.now() / 1000)
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('FSTAT', (reqid, handle) => {
              const item = getHandle(handle)
              if (!item) return sftp.status(reqid, STATUS_CODE.FAILURE)
              sftp.attrs(reqid, attrsOf(item.entry))
            })
            .on('FSETSTAT', (reqid, handle, attrs) => {
              const item = getHandle(handle)
              if (!item) return sftp.status(reqid, STATUS_CODE.FAILURE)
              if (typeof attrs.mode === 'number') {
                item.entry.mode = (item.entry.mode & 0o170000) | (attrs.mode & 0o7777)
              }
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('CLOSE', (reqid, handle) => {
              const item = getHandle(handle)
              if (item) handles.delete(handle.readUInt32BE(0))
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('OPENDIR', (reqid, filename) => {
              const target = norm(filename, ctx.cwd)
              const entry = FS.get(target)
              if (!entry || entry.type !== 'dir') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              sftp.handle(reqid, newHandle({ kind: 'dir', path: target, sent: false }))
            })
            .on('READDIR', (reqid, handle) => {
              const item = getHandle(handle)
              if (!item || item.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
              if (item.sent) return sftp.status(reqid, STATUS_CODE.EOF)
              item.sent = true
              const names = children(item.path).map((child) => ({
                filename: child.name,
                longname: `${permString(child.entry.mode)} 1 ${USER} ${USER} ${
                  child.entry.type === 'file' ? child.entry.content.length : 4096
                } Nov  4 12:00 ${child.name}`,
                attrs: attrsOf(child.entry)
              }))
              sftp.name(reqid, names)
            })
            .on('LSTAT', (reqid, filename) => {
              const attrs = statAttrs(norm(filename, ctx.cwd))
              if (!attrs) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              sftp.attrs(reqid, attrs)
            })
            .on('STAT', (reqid, filename) => {
              const attrs = statAttrs(norm(filename, ctx.cwd))
              if (!attrs) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              sftp.attrs(reqid, attrs)
            })
            .on('REMOVE', (reqid, filename) => {
              const target = norm(filename, ctx.cwd)
              const entry = FS.get(target)
              if (!entry || entry.type !== 'file') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              FS.delete(target)
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('MKDIR', (reqid, filename, attrs) => {
              const target = norm(filename, ctx.cwd)
              if (FS.has(target)) return sftp.status(reqid, STATUS_CODE.FAILURE)
              putDir(target, attrs?.mode ? attrs.mode & 0o777 : 0o755)
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('RMDIR', (reqid, filename) => {
              const target = norm(filename, ctx.cwd)
              if (!isDir(target) || children(target).length) {
                return sftp.status(reqid, STATUS_CODE.FAILURE)
              }
              FS.delete(target)
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('RENAME', (reqid, oldPath, newPath) => {
              if (!movePath(norm(oldPath, ctx.cwd), norm(newPath, ctx.cwd))) {
                return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              }
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('SETSTAT', (reqid, filename, attrs) => {
              const entry = FS.get(norm(filename, ctx.cwd))
              if (!entry) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              if (typeof attrs.mode === 'number') {
                entry.mode = (entry.mode & 0o170000) | (attrs.mode & 0o7777)
              }
              if (typeof attrs.mtime === 'number') entry.mtime = attrs.mtime
              sftp.status(reqid, STATUS_CODE.OK)
            })
            .on('REALPATH', (reqid, filename) => {
              const target = norm(filename, ctx.cwd)
              sftp.name(reqid, [{ filename: target, longname: target, attrs: statAttrs(target) ?? undefined }])
            })
            .on('EXTENDED', (reqid) => {
              sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
            })
        })
      })
    })
    .on('error', (err) => {
      console.error('[mock] client error:', err.message)
    })
    .on('close', () => console.log('[mock] client disconnected'))
})

server.on('error', (err) => {
  console.error('[mock] server error:', err.message)
})

server.listen(PORT, HOST, () => {
  console.log(`[mock] SSH server ready on ${HOST}:${PORT}`)
  console.log(`[mock] login: ${USER} / ${PASSWORD}`)
  console.log('[mock] filesystem is in-memory; restart resets it')
})

process.on('SIGINT', () => {
  console.log('\n[mock] shutting down')
  server.close()
  process.exit(0)
})
