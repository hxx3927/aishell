import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentProfile,
  KnownHost,
  Session,
  SessionInput,
  Settings
} from '@shared/types'
import { writeFileAtomic } from '../util'

const DEFAULT_PROFILES: AgentProfile[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', kind: 'claude', enabled: true },
  { id: 'codex', label: 'Codex', command: 'codex', kind: 'codex', enabled: true },
  {
    id: 'custom',
    label: '自定义 Agent',
    command: '',
    args: [],
    kind: 'custom',
    enabled: false
  }
]

const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  theme: 'dark',
  groups: ['默认'],
  agentProfiles: DEFAULT_PROFILES,
  claudeStrictMcp: false,
  showHiddenFiles: false
}

interface SecretsFile {
  version: 1
  items: Record<string, string>
}

interface KnownHostsFile {
  version: 1
  items: KnownHost[]
}

export class SessionStore {
  readonly dir: string
  private sessions: Session[] = []
  private settings: Settings = structuredClone(DEFAULT_SETTINGS)
  private secrets: Record<string, string> = {}
  private memorySecrets = new Map<string, string>()
  private knownHosts: KnownHost[] = []
  private encryptionAvailable = false

  constructor() {
    this.dir = app.getPath('userData')
    this.load()
  }

  private get sessionsFile(): string {
    return join(this.dir, 'sessions.json')
  }

  private get settingsFile(): string {
    return join(this.dir, 'settings.json')
  }

  private get secretsFile(): string {
    return join(this.dir, 'secrets.json')
  }

  private get knownHostsFile(): string {
    return join(this.dir, 'known-hosts.json')
  }

  private load(): void {
    this.encryptionAvailable = safeStorage.isEncryptionAvailable()

    try {
      if (existsSync(this.sessionsFile)) {
        const raw = JSON.parse(readFileSync(this.sessionsFile, 'utf8'))
        if (Array.isArray(raw?.sessions)) {
          this.sessions = raw.sessions
          let repaired = false
          this.sessions = this.sessions.map((session: Session) => {
            if (session.id) return session
            repaired = true
            return { ...session, id: randomUUID() }
          })
          if (repaired) void this.persistSessions()
        }
      }
    } catch (err) {
      console.error('[store] failed to load sessions', err)
    }

    try {
      if (existsSync(this.settingsFile)) {
        const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8'))
        this.settings = { ...DEFAULT_SETTINGS, ...raw }
        if (!Array.isArray(this.settings.agentProfiles) || !this.settings.agentProfiles.length) {
          this.settings.agentProfiles = structuredClone(DEFAULT_PROFILES)
        }
      }
    } catch (err) {
      console.error('[store] failed to load settings', err)
    }

    try {
      if (existsSync(this.secretsFile) && this.encryptionAvailable) {
        const raw = JSON.parse(readFileSync(this.secretsFile, 'utf8')) as SecretsFile
        this.secrets = raw.items ?? {}
      }
    } catch (err) {
      console.error('[store] failed to load secrets', err)
    }

    try {
      if (existsSync(this.knownHostsFile)) {
        const raw = JSON.parse(readFileSync(this.knownHostsFile, 'utf8')) as KnownHostsFile
        if (Array.isArray(raw?.items)) this.knownHosts = raw.items
      }
    } catch (err) {
      console.error('[store] failed to load known hosts', err)
    }
  }

  isEncryptionAvailable(): boolean {
    return this.encryptionAvailable
  }

  listSessions(): Session[] {
    return this.sessions
      .slice()
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  }

  getSession(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id)
  }

  async saveSession(input: SessionInput): Promise<Session> {
    const now = Date.now()
    const existing = input.id ? this.sessions.find((s) => s.id === input.id) : undefined
    const session: Session = {
      id: existing?.id ?? (input.id || randomUUID()),
      name: input.name.trim() || input.host,
      group: input.group?.trim() || '默认',
      host: input.host.trim(),
      port: Number(input.port) || 22,
      username: input.username.trim(),
      auth: {
        type: input.auth?.type ?? 'password',
        privateKeyPath: input.auth?.privateKeyPath
      },
      color: input.color,
      tags: input.tags,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: existing?.lastUsedAt ?? now
    }

    if (input.password) await this.setSecret(session.id, 'password', input.password)
    if (input.passphrase) await this.setSecret(session.id, 'passphrase', input.passphrase)

    if (existing) this.sessions = this.sessions.map((s) => (s.id === session.id ? session : s))
    else this.sessions.push(session)

    await this.persistSessions()
    return session
  }

  async touchSession(id: string): Promise<void> {
    const session = this.getSession(id)
    if (!session) return
    session.lastUsedAt = Date.now()
    await this.persistSessions()
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id)
    delete this.secrets[`${id}:password`]
    delete this.secrets[`${id}:passphrase`]
    this.memorySecrets.delete(`${id}:password`)
    this.memorySecrets.delete(`${id}:passphrase`)
    await Promise.all([this.persistSessions(), this.persistSecrets()])
  }

  getSettings(): Settings {
    return { ...structuredClone(this.settings), groups: this.groupNames() }
  }

  /** Every group name the UI should show: persisted names plus names found in sessions. */
  private groupNames(): string[] {
    const names = new Set<string>()
    for (const group of this.settings.groups ?? []) {
      const name = group.trim()
      if (name) names.add(name)
    }
    for (const session of this.sessions) {
      const name = session.group?.trim()
      if (name) names.add(name)
    }
    if (names.size === 0) names.add('默认')
    return Array.from(names)
  }

  async createGroup(name: string): Promise<string[]> {
    const group = name.trim()
    if (!group) throw new Error('分组名不能为空')
    const groups = this.groupNames()
    if (!groups.includes(group)) {
      await this.saveSettings({ groups: [...groups, group] })
    }
    return this.groupNames()
  }

  async renameGroup(
    from: string,
    to: string
  ): Promise<{ sessions: Session[]; groups: string[] }> {
    const source = from.trim()
    const target = to.trim()
    if (!target) throw new Error('分组名不能为空')
    if (!source || source === target) {
      return { sessions: this.listSessions(), groups: this.groupNames() }
    }
    let touched = false
    this.sessions = this.sessions.map((session) => {
      if (session.group !== source) return session
      touched = true
      return { ...session, group: target }
    })
    const groups = this.groupNames().filter((name) => name !== source)
    if (!groups.includes(target)) groups.push(target)
    if (touched) await this.persistSessions()
    await this.saveSettings({ groups })
    return { sessions: this.listSessions(), groups: this.groupNames() }
  }

  async deleteGroup(
    name: string
  ): Promise<{ sessions: Session[]; groups: string[] }> {
    const group = name.trim()
    if (group === '默认') throw new Error('默认分组不能删除')
    if (!group) return { sessions: this.listSessions(), groups: this.groupNames() }
    let touched = false
    this.sessions = this.sessions.map((session) => {
      if (session.group !== group) return session
      touched = true
      return { ...session, group: '默认' }
    })
    const groups = this.groupNames().filter((item) => item !== group)
    if (touched && !groups.includes('默认')) groups.push('默认')
    if (touched) await this.persistSessions()
    await this.saveSettings({ groups })
    return { sessions: this.listSessions(), groups: this.groupNames() }
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch }
    if (!Array.isArray(this.settings.agentProfiles)) {
      this.settings.agentProfiles = structuredClone(DEFAULT_PROFILES)
    }
    await writeFileAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2))
    return this.getSettings()
  }

  private secretKey(sessionId: string, kind: 'password' | 'passphrase'): string {
    return `${sessionId}:${kind}`
  }

  async setSecret(sessionId: string, kind: 'password' | 'passphrase', value: string): Promise<void> {
    const key = this.secretKey(sessionId, kind)
    if (!this.encryptionAvailable) {
      this.memorySecrets.set(key, value)
      return
    }
    this.secrets[key] = safeStorage.encryptString(value).toString('base64')
    await this.persistSecrets()
  }

  getSecret(sessionId: string, kind: 'password' | 'passphrase'): string | undefined {
    const key = this.secretKey(sessionId, kind)
    const memory = this.memorySecrets.get(key)
    if (memory !== undefined) return memory
    if (!this.encryptionAvailable) return undefined
    const encoded = this.secrets[key]
    if (!encoded) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch (err) {
      console.error('[store] failed to decrypt secret', err)
      return undefined
    }
  }

  hasSecret(sessionId: string, kind: 'password' | 'passphrase'): boolean {
    return this.getSecret(sessionId, kind) !== undefined
  }

  verifyHost(host: string, port: number, fingerprint: string): 'ok' | 'new' | 'mismatch' {
    const key = `${host}:${port}`
    const known = this.knownHosts.find((h) => h.key === key)
    if (!known) {
      this.knownHosts.push({ key, fingerprint, addedAt: Date.now() })
      void this.persistKnownHosts()
      return 'new'
    }
    return known.fingerprint === fingerprint ? 'ok' : 'mismatch'
  }

  getKnownHost(host: string, port: number): KnownHost | undefined {
    return this.knownHosts.find((h) => h.key === `${host}:${port}`)
  }

  listKnownHosts(): KnownHost[] {
    return this.knownHosts.slice()
  }

  async removeKnownHost(key: string): Promise<void> {
    this.knownHosts = this.knownHosts.filter((h) => h.key !== key)
    await this.persistKnownHosts()
  }

  private async persistSessions(): Promise<void> {
    await writeFileAtomic(
      this.sessionsFile,
      JSON.stringify({ version: 1, sessions: this.sessions }, null, 2)
    )
  }

  private async persistSecrets(): Promise<void> {
    if (!this.encryptionAvailable) return
    await writeFileAtomic(
      this.secretsFile,
      JSON.stringify({ version: 1, items: this.secrets } satisfies SecretsFile, null, 2)
    )
  }

  private async persistKnownHosts(): Promise<void> {
    await writeFileAtomic(
      this.knownHostsFile,
      JSON.stringify({ version: 1, items: this.knownHosts } satisfies KnownHostsFile, null, 2)
    )
  }
}
