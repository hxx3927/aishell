/**
 * Turns Electron's "Error invoking remote method 'local:list': Error: EPERM…"
 * into a message a user can act on.
 */
export function describeFsError(err: unknown, path: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/EPERM|EACCES/.test(raw)) return `没有权限访问「${path}」`
  if (/ENOENT/.test(raw)) return `路径不存在：「${path}」`
  if (/ENOTDIR/.test(raw)) return `「${path}」不是目录`
  if (/EBUSY/.test(raw)) return `「${path}」正被其他程序占用`
  if (/EEXIST/.test(raw)) return `「${path}」已存在`
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function posixJoin(base: string, name: string): string {
  if (!base || base === '/') return `/${name}`
  return `${base.replace(/\/+$/, '')}/${name}`
}

export function posixDirname(p: string): string {
  const clean = p.replace(/\/+$/, '') || '/'
  const idx = clean.lastIndexOf('/')
  if (idx <= 0) return '/'
  return clean.slice(0, idx)
}

export function localJoin(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  if (/^[A-Za-z]:[\\/]?$/.test(base)) return `${base.replace(/[\\/]?$/, '')}${sep}${name}`
  if (base === '/') return `/${name}`
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`
}

export function localDirname(p: string): string {
  const clean = p.replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'))
  if (idx < 0) return p
  if (idx === 0) return '/'
  if (/^[A-Za-z]:$/.test(clean.slice(0, idx))) return `${clean.slice(0, idx)}\\`
  return clean.slice(0, idx)
}

export function fileName(p: string): string {
  const clean = p.replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'))
  return idx === -1 ? clean : clean.slice(idx + 1)
}

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx + 1).toLowerCase()
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
