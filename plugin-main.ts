#!/usr/bin/env bun
/**
 * Plugin binary — Claude Code spawns this per session as a stdio MCP server.
 * Reads LINE_GATEWAY_URL (ws://127.0.0.1:PORT/ws), CLAUDE_SESSION_ID from the
 * environment. Falls back to the shared state dir for paths.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import { createPlugin } from './plugin'

const DEFAULT_URL = 'ws://127.0.0.1:3456/ws'

function readPluginVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch { return '0.0.0' }
}

const gatewayUrl = process.env.LINE_GATEWAY_URL ?? DEFAULT_URL
const ccSessionId = process.env.CLAUDE_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID ?? ''
const stateDir = process.env.LINE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'line')
const pluginVersion = readPluginVersion()
// Opt OUT only — default stays true so every existing duty session's
// config keeps working unchanged. A session that loads this plugin but
// isn't the intended LINE duty session should set this to '0'/'false' so
// it doesn't silently win the handler seat on a gateway-restart race.
const autoClaim = process.env.LINE_GATEWAY_AUTO_CLAIM !== '0' && process.env.LINE_GATEWAY_AUTO_CLAIM !== 'false'

if (!ccSessionId) {
  process.stderr.write(
    'line-gateway-plugin: warning: CLAUDE_SESSION_ID not set — gateway will treat this plugin as anonymous.\n',
  )
}

const { mcp, stop } = createPlugin({
  gatewayUrl,
  ccSessionId: ccSessionId || 'anon-' + process.pid,
  pluginVersion,
  stateDir,
  autoClaim,
})

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write(
  `line-gateway-plugin ${pluginVersion}: stdio connected, gateway=${gatewayUrl}, cc=${ccSessionId || '(anon)'}\n`,
)

// Graceful stop on stdio close — Claude Code signals this by closing stdin.
process.stdin.on('close', () => { void stop().finally(() => process.exit(0)) })
process.on('SIGINT',  () => { void stop().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void stop().finally(() => process.exit(0)) })
