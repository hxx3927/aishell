import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AuditQuery, LocalEntry, SessionInput, Settings } from '@shared/types'
import { applyThemeChrome } from './theme'
import type { SessionStore } from './store/SessionStore'
import type { SshManager } from './ssh/SshManager'
import type { AgentManager } from './agents/AgentManager'
import type { McpServer } from './mcp/server'
import type { ActivityLog } from './mcp/activity'
import type { AuditStore } from './audit/AuditStore'
import type { MonitorService } from './monitor/MonitorService'
import { dateKey } from './audit/AuditStore'

interface Deps {
  store: SessionStore
  ssh: SshManager
  agents: AgentManager
  mcp: McpServer
  activity: ActivityLog
  audit: AuditStore
  monitor: MonitorService
}

export function registerIpc(deps: Deps): void {
  const { store, ssh, agents, mcp, activity, audit, monitor } = deps

  ipcMain.handle('app:getState', () => ({
    sessions: store.listSessions(),
    settings: store.getSettings(),
    knownHosts: store.listKnownHosts(),
    mcpPort: mcp.getPort() || null,
    platform: process.platform,
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node
    },
    userDataPath: app.getPath('userData'),
    encryptionAvailable: store.isEncryptionAvailable(),
    agentShells: ssh.listAgentShells(),
    agents: agents.listAll()
  }))

  ipcMain.handle('session:save', (_e, input: SessionInput) => store.saveSession(input))
  ipcMain.handle('group:create', (_e, name: string) => store.createGroup(name))
  ipcMain.handle('group:rename', (_e, from: string, to: string) => store.renameGroup(from, to))
  ipcMain.handle('group:remove', (_e, name: string) => store.deleteGroup(name))
  ipcMain.handle('session:delete', async (_e, sessionId: string) => {
    monitor.stop(sessionId)
    agents.stopForSession(sessionId)
    ssh.disconnect(sessionId)
    await store.deleteSession(sessionId)
    return true
  })

  ipcMain.handle('ssh:connect', async (_e, connId: string, sessionId: string) => {
    await ssh.connect(connId, sessionId)
    return true
  })
  // Every instance of the session, plus its agent.
  ipcMain.handle('ssh:disconnect', (_e, sessionId: string) => {
    agents.stopForSession(sessionId)
    ssh.disconnectSession(sessionId)
    return true
  })
  // One terminal tab: agents have their own connections, so this only closes
  // the terminal's transport.
  ipcMain.handle('ssh:disconnectConn', (_e, connId: string) => {
    ssh.disconnect(connId)
    return true
  })
  ipcMain.handle('ssh:ping', (_e, sessionId: string) => ssh.ping(sessionId))
  ipcMain.handle('ssh:info', (_e, sessionId: string) => ssh.getSessionInfo(sessionId))

  ipcMain.handle(
    'term:open',
    (_e, connId: string, cols: number, rows: number, fresh?: boolean) =>
      ssh.openShell(connId, cols, rows, fresh)
  )
  ipcMain.handle('term:input', (_e, connId: string, data: string) => {
    ssh.write(connId, data)
    return true
  })
  ipcMain.handle('term:resize', (_e, connId: string, cols: number, rows: number) => {
    ssh.resize(connId, cols, rows)
    return true
  })
  ipcMain.handle('term:close', (_e, connId: string) => {
    ssh.closeShell(connId)
    return true
  })

  ipcMain.handle('sftp:list', (_e, sessionId: string, path: string) => ssh.listDir(sessionId, path))
  ipcMain.handle('sftp:realpath', (_e, sessionId: string, path: string) =>
    ssh.realpath(sessionId, path)
  )
  ipcMain.handle('sftp:home', async (_e, sessionId: string) => {
    const info = ssh.getHostInfo(sessionId)
    if (info.home) return info.home
    return ssh.realpath(sessionId, '.')
  })
  ipcMain.handle('sftp:readFile', (_e, sessionId: string, path: string) =>
    ssh.readFile(sessionId, path)
  )
  ipcMain.handle('sftp:writeFile', (_e, sessionId: string, path: string, content: string) =>
    ssh.writeFile(sessionId, path, content)
  )
  ipcMain.handle('sftp:createFile', (_e, sessionId: string, path: string) =>
    ssh.createFile(sessionId, path)
  )
  ipcMain.handle('sftp:mkdir', (_e, sessionId: string, path: string) =>
    ssh.mkdir(sessionId, path)
  )
  ipcMain.handle('sftp:rename', (_e, sessionId: string, from: string, to: string) =>
    ssh.renamePath(sessionId, from, to)
  )
  ipcMain.handle('sftp:delete', (_e, sessionId: string, path: string, recursive: boolean) =>
    ssh.deletePath(sessionId, path, recursive)
  )
  ipcMain.handle('sftp:chmod', (_e, sessionId: string, path: string, mode: number) =>
    ssh.chmod(sessionId, path, mode)
  )
  ipcMain.handle('sftp:upload', (_e, sessionId: string, localPath: string, remotePath: string) =>
    ssh.upload(sessionId, localPath, remotePath)
  )
  ipcMain.handle('sftp:download', (_e, sessionId: string, remotePath: string, localPath: string) =>
    ssh.download(sessionId, remotePath, localPath)
  )
  ipcMain.handle('sftp:cancelTransfer', (_e, transferId: string) =>
    ssh.cancelTransfer(transferId)
  )

  ipcMain.handle('local:home', () => homedir())
  ipcMain.handle('local:roots', () => localRoots())
  ipcMain.handle('local:list', (_e, path: string, showHidden: boolean) =>
    listLocal(path, showHidden)
  )
  ipcMain.handle('local:mkdir', async (_e, path: string) => {
    // Match the remote pane: an existing directory is an error rather than a
    // silent no-op.
    await fsp.mkdir(path)
  })
  ipcMain.handle('local:rename', async (_e, from: string, to: string) => {
    await fsp.rename(from, to)
  })
  ipcMain.handle('local:delete', async (_e, path: string, recursive: boolean) => {
    assertNotRoot(path)
    await fsp.rm(path, { recursive, force: false })
  })
  ipcMain.handle('local:reveal', async (_e, path: string) => {
    // Cancelled downloads delete their partial file, so fall back to opening
    // the containing folder when the item itself is gone.
    const exists = await fsp.access(path).then(() => true).catch(() => false)
    if (exists) shell.showItemInFolder(path)
    else await shell.openPath(dirname(path))
  })
  ipcMain.handle('local:copy', async (_e, from: string, to: string) => {
    const stats = await fsp.stat(from)
    if (stats.isDirectory()) {
      await fsp.cp(from, to, { recursive: true })
    } else {
      await fsp.copyFile(from, to)
    }
  })

  ipcMain.handle(
    'agent:launch',
    (_e, sessionId: string, profileId: string, name?: string, cols?: number, rows?: number) =>
      agents.launch(sessionId, profileId, name, cols, rows)
  )
  ipcMain.handle('agent:list', (_e, sessionId: string) => agents.list(sessionId))
  ipcMain.handle(
    'agent:resume',
    (_e, agentSessionId: string, cols?: number, rows?: number) =>
      agents.resume(agentSessionId, cols, rows)
  )
  ipcMain.handle('agent:history', (_e, sessionId: string) => agents.history(sessionId))
  ipcMain.handle('agent:titles', (_e, sessionId: string) => agents.titles(sessionId))
  ipcMain.handle('agent:forget', (_e, agentSessionId: string) => agents.forget(agentSessionId))
  ipcMain.handle('agent:stop', (_e, agentSessionId: string) => {
    agents.stop(agentSessionId)
    return true
  })
  ipcMain.handle('agent:reconnect', (_e, agentSessionId: string) =>
    agents.reconnect(agentSessionId)
  )
  ipcMain.handle('agent:input', (_e, agentSessionId: string, data: string) => {
    agents.write(agentSessionId, data)
    return true
  })
  ipcMain.handle('agent:resize', (_e, agentSessionId: string, cols: number, rows: number) => {
    agents.resize(agentSessionId, cols, rows)
    return true
  })

  ipcMain.handle('monitor:start', (_e, sessionId: string, intervalMs?: number) =>
    monitor.start(sessionId, intervalMs)
  )
  ipcMain.handle('monitor:stop', (_e, sessionId: string) => {
    monitor.stop(sessionId)
    return true
  })
  ipcMain.handle('monitor:stopAll', () => {
    monitor.stopAll()
    return true
  })
  ipcMain.handle('monitor:pause', (_e, sessionId: string, paused: boolean) => {
    monitor.pause(sessionId, paused)
    return true
  })
  ipcMain.handle('monitor:sampleNow', (_e, sessionId: string) => monitor.sampleNow(sessionId))

  ipcMain.handle('activity:list', (_e, sessionId?: string) => activity.list(sessionId))

  ipcMain.handle('agentShell:close', (_e, connId: string) =>
    ssh.closeAgentShell(connId, 'user')
  )

  ipcMain.handle('audit:query', (_e, query: AuditQuery) => audit.query(query))
  ipcMain.handle('audit:info', () => audit.info())
  ipcMain.handle('audit:openDir', async () => {
    const error = await shell.openPath(audit.dir)
    if (error) throw new Error(error)
    return true
  })
  ipcMain.handle('audit:export', async (_e, query: AuditQuery, format: 'jsonl' | 'csv') => {
    const win = BrowserWindow.getFocusedWindow()
    const name = `aishell-audit-${query.from}_${query.to}.${format}`
    const options = {
      title: '导出审计日志',
      defaultPath: join(app.getPath('downloads'), name),
      filters: [
        format === 'csv'
          ? { name: 'CSV', extensions: ['csv'] }
          : { name: 'JSON Lines', extensions: ['jsonl'] }
      ]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const count = await audit.exportTo(result.filePath, query, format)
    return { path: result.filePath, count }
  })
  ipcMain.handle('audit:today', () => dateKey(Date.now()))

  ipcMain.handle('settings:save', async (_e, patch: Partial<Settings>) => {
    const settings = await store.saveSettings(patch)
    if (patch.theme) applyThemeChrome(patch.theme)
    if (patch.auditRetentionDays !== undefined) void audit.prune().catch(() => 0)
    return settings
  })
  ipcMain.handle('hosts:remove', (_e, key: string) => store.removeKnownHost(key))

  ipcMain.handle('dialog:pickKey', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择私钥文件',
          properties: ['openFile', 'showHiddenFiles']
        })
      : await dialog.showOpenDialog({
          title: '选择私钥文件',
          properties: ['openFile', 'showHiddenFiles']
        })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择目录',
          properties: ['openDirectory', 'createDirectory']
        })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('mcp:info', () => ({ port: mcp.getPort(), running: mcp.getPort() > 0 }))

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return true
  })

  // The renderer is sandboxed, so its preload cannot import Electron's
  // clipboard module directly. Route clipboard access through the main process.
  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('clipboard:writeText', (_e, text: string) => clipboard.writeText(String(text)))
}

function assertNotRoot(path: string): void {
  if (/^[A-Za-z]:[\\/]?$/.test(path) || path === '/' || path === '') {
    throw new Error('拒绝删除磁盘根目录')
  }
}

async function listLocal(path: string, showHidden: boolean): Promise<LocalEntry[]> {
  const entries = await fsp.readdir(path, { withFileTypes: true })
  const results = await Promise.all(
    entries
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map(async (entry) => {
        const full = join(path, entry.name)
        try {
          const stats = await fsp.lstat(full)
          return {
            name: entry.name,
            path: full,
            isDir: entry.isDirectory(),
            isSymlink: entry.isSymbolicLink(),
            size: stats.size,
            mtime: stats.mtimeMs
          } satisfies LocalEntry
        } catch {
          return null
        }
      })
  )
  return results
    .filter((entry): entry is LocalEntry => entry !== null)
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

function localRoots(): Array<{ label: string; path: string }> {
  const roots: Array<{ label: string; path: string }> = [
    { label: '主目录', path: homedir() },
    { label: '桌面', path: join(homedir(), 'Desktop') },
    { label: '下载', path: join(homedir(), 'Downloads') }
  ].filter((root) => existsSync(root.path))

  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`
      if (existsSync(drive)) roots.push({ label: drive, path: drive })
    }
  } else {
    roots.push({ label: '/', path: '/' })
  }
  return roots
}

export { basename }
