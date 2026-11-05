/**
 * MCP JSON-RPC smoke test against the running AIShell app.
 *
 *   AISHELL_MCP_URL=http://127.0.0.1:PORT/mcp/<sessionId> \
 *   AISHELL_MCP_TOKEN=<token> node scripts/mcp-smoke.mjs [write]
 *
 * "write" additionally calls write_file and verifies the result.
 * "shell" exercises the persistent shell (open, state persistence, timeout,
 * interrupt, close). AIShell is record-only: nothing blocks on an approval
 * dialog, every call is written to the audit log.
 */
const url = process.env.AISHELL_MCP_URL
const token = process.env.AISHELL_MCP_TOKEN
if (!url || !token) {
  console.error('set AISHELL_MCP_URL and AISHELL_MCP_TOKEN')
  process.exit(1)
}

let seq = 0
const results = []

async function rpc(method, params = {}, options = {}) {
  const id = ++seq
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (!options.unauthorized) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body, headers: Object.fromEntries(response.headers) }
}

async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  const body = result.body
  if (body?.error) throw new Error(`${name}: ${body.error.message}`)
  const payload = body?.result
  if (payload?.isError) throw new Error(`${name}: ${payload.content?.[0]?.text}`)
  return { text: payload?.content?.[0]?.text, structured: payload?.structuredContent }
}

function record(name, value) {
  results.push({ name, ...value })
}

// 1. Unauthorized request must be rejected.
{
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  })
  record('unauthorized', { status: response.status, rejected: response.status === 401 })
}

// 2. Handshake.
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'aishell-smoke', version: '0.0.1' }
})
record('initialize', {
  status: init.status,
  server: init.body?.result?.serverInfo,
  protocolVersion: init.body?.result?.protocolVersion,
  sessionHeader: Boolean(init.headers['mcp-session-id']),
  hasInstructions: Boolean(init.body?.result?.instructions)
})

// Notification (no id) -> 202
{
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  record('initializedNotification', { status: response.status })
}

// 3. Tool discovery.
const list = await rpc('tools/list', {})
const tools = list.body?.result?.tools ?? []
record('tools/list', { count: tools.length, names: tools.map((t) => t.name) })

// 4. Read-only tools.
const info = await callTool('session_info')
record('session_info', { structured: info.structured })

const exec = await callTool('exec', { command: 'whoami && df -h' })
record('exec', { text: exec.text?.slice(0, 300) })

const listing = await callTool('exec', { command: 'ls -la /home/demo' })
record('list_via_exec', { text: listing.text?.slice(0, 300) })

const read = await callTool('exec', { command: 'head -c 200 /home/demo/readme.txt' })
record('read_via_exec', { text: read.text?.slice(0, 200) })

// structuredContent must be a record; a raw array is rejected by strict clients.
const sessions = await callTool('list_sessions')
record('structured_content_is_object', {
  isObject:
    sessions.structured !== undefined &&
    sessions.structured !== null &&
    !Array.isArray(sessions.structured) &&
    typeof sessions.structured === 'object',
  keys: sessions.structured && typeof sessions.structured === 'object'
    ? Object.keys(sessions.structured)
    : null
})

// 5. Optional file write.
if (process.argv.includes('write')) {
  const write = await callTool('write_file', {
    path: '/home/demo/mcp-write-test.txt',
    content: 'written through aishell mcp\n'
  })
  record('write_file', { text: write.text?.slice(0, 200) })
  const verify = await callTool('exec', { command: 'cat /home/demo/mcp-write-test.txt' })
  record('write_verify', { text: verify.text?.slice(0, 200) })
}

// 6. Persistent shell.
if (process.argv.includes('shell')) {
  const opened = await callTool('shell_open')
  record('shell_open', { structured: opened.structured })

  const cd = await callTool('shell_run', { command: 'cd /var/log && pwd' })
  record('shell_run_cd', { text: cd.text })

  await callTool('shell_run', { command: 'export AI_MARK=sentinel-ok' })
  const env = await callTool('shell_run', { command: 'echo "$AI_MARK"' })
  record('shell_run_env_persists', { text: env.text })

  const persistent = await callTool('shell_run', { command: 'pwd' })
  record('shell_run_cwd_persists', { text: persistent.text })

  const failed = await callTool('shell_run', { command: 'ls /definitely-not-here' })
  record('shell_run_failure', { text: failed.text })

  const slow = await callTool('shell_run', { command: 'sleep 3; echo finished', timeout_sec: 1 })
  record('shell_run_timeout', { text: slow.text, structured: slow.structured })
  const rest = await callTool('shell_read', { timeout_sec: 10 })
  record('shell_read', { text: rest.text, structured: rest.structured })

  const closed = await callTool('shell_close')
  record('shell_close', { structured: closed.structured })
}

console.log(JSON.stringify(results, null, 2))
