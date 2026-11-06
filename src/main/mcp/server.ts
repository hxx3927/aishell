import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { McpScope, ToolRegistry } from './tools'
import { TOOL_INSTRUCTIONS } from './tools'

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 4 * 1024 * 1024

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

/** A local-shell command reported by an agent hook (never blocks the agent). */
export interface BashHookEvent {
  sessionId: string
  agentSessionId?: string
  connId?: string
  command: string
  cwd?: string
  transport?: string
  hookSessionId?: string
}

export class McpServer {
  private server: Server | null = null
  private port = 0
  readonly token = randomBytes(32).toString('hex')

  constructor(
    private readonly registry: ToolRegistry,
    private readonly onBashHook?: (event: BashHookEvent) => void
  ) {}

  async start(): Promise<number> {
    if (this.server) return this.port
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error('[mcp] request failed', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    console.log(`[mcp] listening on 127.0.0.1:${this.port} token=${this.token}`)
    return this.port
  }

  getPort(): number {
    return this.port
  }

  /**
   * Scoped endpoint for a session. `agentSessionId` tags calls with the agent
   * that made them; `connId` binds them to one connection instance.
   */
  getUrl(sessionId: string, agentSessionId?: string, connId?: string): string {
    const scope = encodeURIComponent(sessionId)
    const params = new URLSearchParams()
    if (agentSessionId) params.set('agent', agentSessionId)
    if (connId) params.set('conn', connId)
    const query = params.size ? `?${params.toString()}` : ''
    return `http://127.0.0.1:${this.port}/mcp/${scope}${query}`
  }

  /**
   * Records a local-shell command reported by an agent hook. Always answers 200
   * so a hook can fail open: losing an audit line must never block the agent.
   */
  private async handleBashHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (!this.isAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const body = await readBody(req).catch(() => null)
    if (body === null) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    try {
      const event = JSON.parse(body) as BashHookEvent
      if (typeof event?.sessionId === 'string' && typeof event?.command === 'string') {
        this.onBashHook?.(event)
      }
    } catch {
      // Malformed hook payloads are ignored; the hook still exits 0.
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/hook/bash') {
      await this.handleBashHook(req, res)
      return
    }

    if (!url.pathname.startsWith('/mcp')) {
      res.writeHead(404)
      res.end()
      return
    }

    if (!this.isAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (req.method === 'GET') {
      res.writeHead(405, { allow: 'POST, DELETE' })
      res.end()
      return
    }

    if (req.method === 'DELETE') {
      res.writeHead(200)
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }

    const scope: McpScope = {
      sessionId: decodeURIComponent(url.pathname.slice('/mcp'.length).replace(/^\//, '')),
      agentSessionId: url.searchParams.get('agent') || undefined,
      connId: url.searchParams.get('conn') || undefined
    }
    const body = await readBody(req).catch((err: Error) => {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
      return null
    })
    if (body === null) return

    let message: JsonRpcRequest
    try {
      message = JSON.parse(body) as JsonRpcRequest
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    // Notifications: no id, no response body.
    if (message.id === undefined || message.id === null) {
      await this.dispatch(message, scope).catch(() => undefined)
      res.writeHead(202)
      res.end()
      return
    }

    const response = await this.dispatch(message, scope)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18'
    }
    if (message.method === 'initialize') headers['mcp-session-id'] = randomUUID()
    res.writeHead(200, headers)
    res.end(JSON.stringify(response))
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const provided = Buffer.from(header.slice('Bearer '.length).trim())
    const expected = Buffer.from(this.token)
    if (provided.length !== expected.length) return false
    return timingSafeEqual(provided, expected)
  }

  private async dispatch(
    message: JsonRpcRequest,
    scope: McpScope
  ): Promise<Record<string, unknown>> {
    const id = message.id ?? null
    try {
      const result = await this.handleMethod(message, scope)
      return { jsonrpc: '2.0', id, result }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: (err as Error).message ?? 'Internal error' }
      }
    }
  }

  private async handleMethod(message: JsonRpcRequest, scope: McpScope): Promise<unknown> {
    const params = message.params ?? {}
    switch (message.method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '')
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOLS[0],
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: { name: 'aishell', version: '0.1.0' },
          instructions: TOOL_INSTRUCTIONS
        }
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {}
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: this.registry.list() }
      case 'tools/call': {
        const name = String(params.name ?? '')
        const args =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {}
        if (!name) throw new Error('缺少工具名')
        try {
          const result = await this.registry.call(name, args, scope)
          return {
            content: [{ type: 'text', text: formatResult(result) }],
            structuredContent: toStructuredContent(result)
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `错误：${(err as Error).message}` }],
            isError: true
          }
        }
      }
      case 'resources/list':
        return { resources: [] }
      case 'prompts/list':
        return { prompts: [] }
      default:
        throw new Error(`未实现的方法：${message.method}`)
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/**
 * The MCP spec requires `structuredContent` to be a JSON object. Clients such as
 * Claude Code validate that and drop the whole result when a tool returns an
 * array, so wrap non-object payloads instead of trusting the cast.
 */
function toStructuredContent(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return { items: result }
  if (result && typeof result === 'object') return result as Record<string, unknown>
  return { value: result ?? null }
}

function formatResult(result: unknown): string {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (typeof obj.stdout === 'string' || typeof obj.stderr === 'string') {
      const parts: string[] = []
      parts.push(`exit code: ${obj.code ?? 'null'}`)
      if (obj.stdout) parts.push(`stdout:\n${obj.stdout}`)
      if (obj.stderr) parts.push(`stderr:\n${obj.stderr}`)
      if (obj.truncated) parts.push('(输出已截断)')
      return parts.join('\n')
    }
  }
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
