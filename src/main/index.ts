import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { applyThemeChrome, resolveTheme, windowChrome } from './theme'
import { SessionStore } from './store/SessionStore'
import { SshManager } from './ssh/SshManager'
import { PtyManager } from './pty/PtyManager'
import { AgentManager } from './agents/AgentManager'
import { ActivityLog } from './mcp/activity'
import { ToolRegistry } from './mcp/tools'
import { McpServer } from './mcp/server'
import { AuditStore } from './audit/AuditStore'
import { MonitorService } from './monitor/MonitorService'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let store: SessionStore | null = null
let ssh: SshManager | null = null
let agents: AgentManager | null = null
let mcp: McpServer | null = null
let audit: AuditStore | null = null
let monitor: MonitorService | null = null
let auditReady: Promise<number> = Promise.resolve(0)

const DEFAULT_AUDIT_RETENTION_DAYS = 90

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  const chrome = windowChrome(resolveTheme(store?.getSettings().theme ?? 'dark'))
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'AIShell',
    // Dev builds run under electron.exe, so point the window at our own icon;
    // packaged builds inherit the icon embedded in the exe.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    backgroundColor: chrome.color,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: chrome.color, symbolColor: chrome.symbolColor, height: 40 }
        : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow = win

  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => void warnIfAuditOversize())
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' && !app.isPackaged) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function warnIfAuditOversize(): Promise<void> {
  if (!audit) return
  await auditReady
  const info = await audit.info().catch(() => null)
  if (!info?.oversize) return
  send('app:notice', {
    level: 'warn',
    message: `审计日志已占用 ${(info.totalBytes / 1024 / 1024).toFixed(0)} MB，可在设置 → 安全中缩短保留期，或导出后手动清理。`
  })
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.aishell.app')
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  store = new SessionStore()
  // Keep the window chrome (and renderer UI) in sync when the OS theme flips
  // while `theme` is set to `system`.
  nativeTheme.on('updated', () => {
    if (store?.getSettings().theme !== 'system') return
    const resolved = resolveTheme('system')
    applyThemeChrome(resolved)
    send('theme:changed', { resolved })
  })
  ssh = new SshManager(store, send)
  const pty = new PtyManager()
  const activity = new ActivityLog(send)
  audit = new AuditStore(
    () => store!.getSettings().auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    (message) => send('app:notice', { level: 'error', message })
  )
  const auditStore = audit
  const tools = new ToolRegistry(ssh, store, activity, audit, (agentSessionId) =>
    agents?.getRuntimeById(agentSessionId)
  )
  mcp = new McpServer(tools, (event) => {
    const session = store?.getSession(event.sessionId)
    const runtime = event.agentSessionId
      ? agents?.getRuntimeById(event.agentSessionId)
      : undefined
    auditStore.recordBash({
      sessionId: event.sessionId,
      sessionName: session?.name,
      host: session ? `${session.username}@${session.host}:${session.port}` : undefined,
      connId: event.connId,
      agentSessionId: event.agentSessionId,
      profileId: runtime?.profileId,
      command: event.command,
      cwd: event.cwd,
      transport: event.transport,
      hookSessionId: event.hookSessionId
    })
  })

  ssh.onAgentShellChange = (connId, sessionId, open, reason) => {
    const session = store!.getSession(sessionId)
    auditStore.recordNote({
      kind: 'shell',
      sessionId,
      sessionName: session?.name,
      host: session ? `${session.host}:${session.port}` : undefined,
      action: open ? 'open' : 'close',
      reason,
      payload: { connId }
    })
    send('agent:shell', { connId, sessionId, open, reason })
  }

  try {
    await mcp.start()
  } catch (err) {
    console.error('[mcp] failed to start', err)
  }

  agents = new AgentManager(store, ssh, pty, mcp, audit, send)
  monitor = new MonitorService(ssh, send)
  registerIpc({ store, ssh, agents, mcp, activity, audit, monitor })

  auditReady = audit.prune().catch((err) => {
    console.warn('[audit] prune failed', err)
    return 0
  })

  createWindow()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[app] bootstrap failed', err)
    app.exit(1)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    monitor?.dispose()
    agents?.disposeAll()
    ssh?.disposeAll()
    audit?.dispose()
    void mcp?.stop()
  })
}
