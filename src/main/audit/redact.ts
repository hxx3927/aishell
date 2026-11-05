import { createHash } from 'node:crypto'

const MASK = '***'
const MAX_STRING = 8 * 1024

// A secret value: single-quoted, double-quoted or a bare word.
const VALUE = `('[^']*'|"[^"]*"|[^\\s'";&|]+)`

const RULES: Array<[RegExp, string]> = [
  // mysql -pSECRET (the password is glued to -p; "mysql -p" alone prompts)
  [new RegExp(`(\\b(?:mysql|mysqldump|mysqladmin|mariadb)\\b[^\\n;&|]*?\\s-p)${VALUE}`, 'gi'), `$1${MASK}`],
  // sshpass -p SECRET
  [new RegExp(`(\\bsshpass\\s+-p\\s*)${VALUE}`, 'gi'), `$1${MASK}`],
  // --password=SECRET, --token SECRET, --api-key=SECRET ...
  [
    new RegExp(
      `(--?(?:password|passwd|pass|pwd|token|secret|api[-_]?key|access[-_]?key|auth[-_]?token)(?:=|\\s+))${VALUE}`,
      'gi'
    ),
    `$1${MASK}`
  ],
  // DB_PASSWORD=SECRET, api_key: SECRET, "token": "SECRET"
  [
    new RegExp(
      `(\\b[\\w.-]*(?:password|passwd|_pwd|secret|token|api_?key|access_?key|private_?key)[\\w.-]*["']?\\s*[:=]\\s*)${VALUE}`,
      'gi'
    ),
    `$1${MASK}`
  ],
  // scheme://user:SECRET@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, `$1${MASK}$3`],
  // Authorization: Bearer SECRET
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${MASK}`],
  // echo SECRET | sudo -S
  [new RegExp(`(\\becho\\s+)${VALUE}(\\s*\\|\\s*sudo\\s+-S\\b)`, 'gi'), `$1${MASK}$3`]
]

/** Masks passwords, tokens and similar secrets in free-form text. */
export function redactText(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Redacts every string in a JSON-like value and caps long strings. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return capString(redactText(value), value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item)
    return out
  }
  return value
}

function capString(redacted: string, original: string): string {
  if (redacted.length <= MAX_STRING) return redacted
  const bytes = Buffer.byteLength(original)
  return `${redacted.slice(0, MAX_STRING)}\n…[已截断：共 ${bytes} 字节，sha256 ${sha256(original)}]`
}

/**
 * Keeps enough of a command's output to understand what happened without
 * storing all of it: short output verbatim, long output as head + tail.
 */
export function clipOutput(text: string, head = 1024, tail = 2048): string {
  const safe = redactText(text)
  if (safe.length <= head + tail) return safe
  const skipped = safe.length - head - tail
  return `${safe.slice(0, head)}\n…[省略 ${skipped} 字符]…\n${safe.slice(-tail)}`
}
