import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * Local workspace shared by every agent window of one server. Claude Code keys
 * its project (and conversation history) by the working directory, so sharing
 * this path is what puts the windows of a server in one project.
 */
export function sessionWorkspacePath(userData: string, sessionId: string): string {
  return join(userData, 'workspaces', sessionId)
}

/**
 * Per-window files inside a shared workspace: MCP config, launcher, session
 * metadata and the isolated Codex home. Kept separate so parallel windows never
 * overwrite each other's MCP URL or token.
 */
export function agentFilesPath(workspace: string, agentSessionId: string): string {
  const safeAgentId = agentSessionId.replace(/[^a-zA-Z0-9_-]/g, '')
  return join(workspace, '.aishell', 'agents', safeAgentId || 'agent')
}

export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

export function remoteJoin(base: string, name: string): string {
  if (!base || base === '/') return `/${name}`
  return `${base.replace(/\/+$/, '')}/${name}`
}

export function remoteDirname(p: string): string {
  const clean = p.replace(/\/+$/, '') || '/'
  const idx = clean.lastIndexOf('/')
  if (idx <= 0) return '/'
  return clean.slice(0, idx)
}

export function remoteBasename(p: string): string {
  const clean = p.replace(/\/+$/, '')
  const idx = clean.lastIndexOf('/')
  return idx === -1 ? clean : clean.slice(idx + 1)
}

export function normalizeRemotePath(p: string): string {
  const posix = toPosixPath(p.trim() || '.')
  const parts: string[] = []
  for (const seg of posix.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`.replace(/\/+/g, '/') || '/'
}

/** Quote a path for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Quote an argv element for cmd.exe on Windows. */
export function quoteWinArg(value: string): string {
  if (value === '') return '""'
  if (!/[\s"&<>|^%]/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

export function formatPermissions(mode: number): string {
  const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-'
  const bits = ['r', 'w', 'x']
  let out = type
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (mode >> shift) & 0o7
    for (let b = 0; b < 3; b++) out += triad & (1 << (2 - b)) ? bits[b] : '-'
  }
  return out
}

export function isDangerousCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim().toLowerCase()
  const patterns = [
    /rm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/,
    /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$)/,
    /\bmkfs(\.\w+)?\b/,
    /\bdd\b[^\n]*\bof=\/dev\//,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bpoweroff\b/,
    /\bhalt\b/,
    /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/,
    /\bchmod\s+-R\s+777\s+\/(\s|$)/,
    /\bchown\s+-R\b[^\n]*\s+\/(\s|$)/
  ]
  return patterns.some((re) => re.test(normalized))
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
