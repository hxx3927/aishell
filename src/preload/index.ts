import { contextBridge, ipcRenderer } from 'electron'
import type { AishellApi, EventChannel, EventMap } from '../shared/api'

const EVENT_CHANNELS: EventChannel[] = [
  'ssh:state',
  'term:data',
  'term:exit',
  'agent:state',
  'agent:data',
  'agent:exit',
  'agent:shell',
  'activity:event',
  'sftp:transfer',
  'app:notice',
  'monitor:sample'
]

function on<K extends EventChannel>(
  channel: K,
  callback: (payload: EventMap[K]) => void
): () => void {
  if (!EVENT_CHANNELS.includes(channel)) return () => undefined
  const listener = (_event: Electron.IpcRendererEvent, payload: EventMap[K]): void => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AishellApi = {
  getState: () => ipcRenderer.invoke('app:getState'),

  sessions: {
    save: (input) => ipcRenderer.invoke('session:save', input),
    remove: (sessionId) => ipcRenderer.invoke('session:delete', sessionId)
  },

  groups: {
    create: (name) => ipcRenderer.invoke('group:create', name),
    rename: (from, to) => ipcRenderer.invoke('group:rename', from, to),
    remove: (name) => ipcRenderer.invoke('group:remove', name)
  },

  ssh: {
    connect: (connId, sessionId) => ipcRenderer.invoke('ssh:connect', connId, sessionId),
    disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    disconnectConn: (connId) => ipcRenderer.invoke('ssh:disconnectConn', connId),
    ping: (sessionId) => ipcRenderer.invoke('ssh:ping', sessionId),
    info: (sessionId) => ipcRenderer.invoke('ssh:info', sessionId)
  },

  term: {
    open: (connId, cols, rows, fresh) =>
      ipcRenderer.invoke('term:open', connId, cols, rows, fresh),
    input: (connId, data) => ipcRenderer.invoke('term:input', connId, data),
    resize: (connId, cols, rows) => ipcRenderer.invoke('term:resize', connId, cols, rows),
    close: (connId) => ipcRenderer.invoke('term:close', connId)
  },

  sftp: {
    list: (sessionId, path) => ipcRenderer.invoke('sftp:list', sessionId, path),
    realpath: (sessionId, path) => ipcRenderer.invoke('sftp:realpath', sessionId, path),
    home: (sessionId) => ipcRenderer.invoke('sftp:home', sessionId),
    readFile: (sessionId, path) => ipcRenderer.invoke('sftp:readFile', sessionId, path),
    writeFile: (sessionId, path, content) =>
      ipcRenderer.invoke('sftp:writeFile', sessionId, path, content),
    createFile: (sessionId, path) => ipcRenderer.invoke('sftp:createFile', sessionId, path),
    mkdir: (sessionId, path) => ipcRenderer.invoke('sftp:mkdir', sessionId, path),
    rename: (sessionId, from, to) => ipcRenderer.invoke('sftp:rename', sessionId, from, to),
    remove: (sessionId, path, recursive) =>
      ipcRenderer.invoke('sftp:delete', sessionId, path, recursive),
    chmod: (sessionId, path, mode) => ipcRenderer.invoke('sftp:chmod', sessionId, path, mode),
    upload: (sessionId, localPath, remotePath) =>
      ipcRenderer.invoke('sftp:upload', sessionId, localPath, remotePath),
    download: (sessionId, remotePath, localPath) =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath, localPath),
    cancelTransfer: (transferId) => ipcRenderer.invoke('sftp:cancelTransfer', transferId)
  },

  local: {
    home: () => ipcRenderer.invoke('local:home'),
    roots: () => ipcRenderer.invoke('local:roots'),
    list: (path, showHidden) => ipcRenderer.invoke('local:list', path, showHidden),
    mkdir: (path) => ipcRenderer.invoke('local:mkdir', path),
    rename: (from, to) => ipcRenderer.invoke('local:rename', from, to),
    remove: (path, recursive) => ipcRenderer.invoke('local:delete', path, recursive),
    reveal: (path) => ipcRenderer.invoke('local:reveal', path),
    copy: (from, to) => ipcRenderer.invoke('local:copy', from, to)
  },

  agent: {
    probe: (command) => ipcRenderer.invoke('agent:probe', command),
    launch: (sessionId, profileId, name, cols, rows) =>
      ipcRenderer.invoke('agent:launch', sessionId, profileId, name, cols, rows),
    resume: (agentSessionId, cols, rows) =>
      ipcRenderer.invoke('agent:resume', agentSessionId, cols, rows),
    history: (sessionId) => ipcRenderer.invoke('agent:history', sessionId),
    titles: (sessionId) => ipcRenderer.invoke('agent:titles', sessionId),
    forget: (agentSessionId) => ipcRenderer.invoke('agent:forget', agentSessionId),
    list: (sessionId) => ipcRenderer.invoke('agent:list', sessionId),
    stop: (agentSessionId) => ipcRenderer.invoke('agent:stop', agentSessionId),
    reconnect: (agentSessionId) => ipcRenderer.invoke('agent:reconnect', agentSessionId),
    input: (agentSessionId, data) => ipcRenderer.invoke('agent:input', agentSessionId, data),
    resize: (agentSessionId, cols, rows) =>
      ipcRenderer.invoke('agent:resize', agentSessionId, cols, rows)
  },

  monitor: {
    start: (sessionId, intervalMs) => ipcRenderer.invoke('monitor:start', sessionId, intervalMs),
    stop: (sessionId) => ipcRenderer.invoke('monitor:stop', sessionId),
    stopAll: () => ipcRenderer.invoke('monitor:stopAll'),
    pause: (sessionId, paused) => ipcRenderer.invoke('monitor:pause', sessionId, paused),
    sampleNow: (sessionId) => ipcRenderer.invoke('monitor:sampleNow', sessionId)
  },

  activity: {
    list: (sessionId) => ipcRenderer.invoke('activity:list', sessionId)
  },

  agentShell: {
    close: (connId) => ipcRenderer.invoke('agentShell:close', connId)
  },

  audit: {
    query: (query) => ipcRenderer.invoke('audit:query', query),
    info: () => ipcRenderer.invoke('audit:info'),
    openDir: () => ipcRenderer.invoke('audit:openDir'),
    export: (query, format) => ipcRenderer.invoke('audit:export', query, format),
    today: () => ipcRenderer.invoke('audit:today')
  },

  settings: {
    save: (patch) => ipcRenderer.invoke('settings:save', patch)
  },

  hosts: {
    remove: (key) => ipcRenderer.invoke('hosts:remove', key)
  },

  dialog: {
    pickKey: () => ipcRenderer.invoke('dialog:pickKey'),
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory')
  },

  mcp: {
    info: () => ipcRenderer.invoke('mcp:info')
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
    copyDiagnostics: () => ipcRenderer.invoke('shell:copyDiagnostics')
  },

  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text)
  },

  on
}

contextBridge.exposeInMainWorld('aishell', api)
