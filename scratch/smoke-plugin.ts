/**
 * End-to-end smoke: spin up gateway + plugin in-process (via stdio pipes)
 * and drive it like Claude Code would — listTools, callTool, and watch a
 * synthesised inbound webhook surface as a channel notification.
 *
 *   bun scratch/smoke-plugin.ts
 */

import { createHmac } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startGateway } from '../gateway'
import { loadLineConfig } from '../env'
import { createPlugin } from '../plugin'

const PORT = 13461
const SECRET = 'smoke-secret-plugin'

const stateDir = mkdtempSync(join(tmpdir(), 'line-gateway-smoke-plugin-'))
writeFileSync(join(stateDir, '.env'),
  `LINE_CHANNEL_ACCESS_TOKEN=smoke-token\nLINE_CHANNEL_SECRET=${SECRET}\n`,
  { mode: 0o600 })
writeFileSync(join(stateDir, 'access.json'),
  JSON.stringify({ allowFrom: ['Uowner'] }))

const cfg = loadLineConfig({ stateDir })
const gateway = startGateway({ port: PORT, lineConfig: cfg })

// --- Plugin side: MCP server + gateway client ---
const plugin = createPlugin({
  gatewayUrl: `ws://127.0.0.1:${PORT}/ws`,
  ccSessionId: 'cc-smoke-plugin',
  pluginVersion: '0.1.0',
  stateDir,
})

// Back the MCP server with an in-memory transport pair so we can drive it
// from an MCP Client in the same process (no stdio piping required).
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
await plugin.mcp.connect(serverTransport)

const client = new Client({ name: 'smoke-client', version: '0.0.1' })

// Capture notifications sent by the plugin as the gateway delivers events.
const received: Array<{ method: string; params: any }> = []
client.fallbackNotificationHandler = async (n) => {
  received.push({ method: n.method, params: (n as any).params })
}
await client.connect(clientTransport)

try {
  // Wait for gateway WS handshake + claim to land.
  await Bun.sleep(300)
  console.log('handler:', plugin.client.handler())
  if (!plugin.client.handler()) throw new Error('plugin never became handler')

  // 1. listTools
  const tools = await client.listTools()
  const names = tools.tools.map(t => t.name).sort()
  console.log('tools:', names)
  const expected = ['fetch_messages', 'get_content', 'reply', 'send_image', 'upload_file']
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error('tool list mismatch')
  }

  // 2. fetch_messages — gateway serves from in-memory DB (empty initially)
  const r0 = await client.callTool({ name: 'fetch_messages', arguments: { limit: 5 } })
  console.log('fetch_messages (empty):', r0.content)

  // 3. Simulate a LINE webhook inbound — gateway archives + forwards to plugin,
  //    plugin's onInbound gates it (Uowner is allowed) and fires a channel notification.
  const body = JSON.stringify({
    events: [{
      type: 'message',
      timestamp: Date.now(),
      source: { type: 'user', userId: 'Uowner' },
      message: { type: 'text', text: 'hello from smoke', id: 'LINE-smoke-1' },
    }],
  })
  const sig = createHmac('sha256', SECRET).update(body).digest('base64')
  const res = await fetch(`http://127.0.0.1:${PORT}/webhook`, {
    method: 'POST',
    body,
    headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
  })
  const summary = await res.json() as any
  console.log('webhook dispatch:', summary)
  if (summary.routed_to_handler !== 1 || summary.archived !== 1) {
    throw new Error('webhook dispatch did not route/archive as expected: ' + JSON.stringify(summary))
  }

  // Give the inbound a tick to round-trip through WS + plugin.
  await Bun.sleep(150)

  const channelMsgs = received.filter(r => r.method === 'notifications/claude/channel')
  console.log('channel notifications received:', channelMsgs.length)
  if (channelMsgs.length !== 1 || channelMsgs[0]!.params.content !== 'hello from smoke') {
    throw new Error('channel notification not delivered as expected: ' + JSON.stringify(channelMsgs))
  }
  if (channelMsgs[0]!.params.meta.chat_id !== 'Uowner') {
    throw new Error('meta.chat_id mismatch')
  }

  // 4. fetch_messages again — archive should now have the message
  const r1 = await client.callTool({ name: 'fetch_messages', arguments: {} })
  const payload = JSON.parse((r1.content as any[])[0].text)
  console.log('fetch_messages (after inbound):', payload.messages.length, 'rows')
  if (payload.messages.length !== 1) throw new Error('archive roundtrip missing')

  console.log('\nALL PLUGIN SMOKES PASSED')
} finally {
  await plugin.stop()
  await gateway.stop()
  try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
}
process.exit(0)
