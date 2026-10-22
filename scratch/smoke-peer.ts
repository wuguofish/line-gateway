/**
 * End-to-end smoke for the cross-machine peer transport, all on loopback:
 * two gateways ("office" and "home") pointing at each other, a Switchboard
 * behind "home", and one message pushed through office:/peer/send.
 *
 *   bun scratch/smoke-peer.ts
 *
 * Needs the Switchboard checkout (default ~/Switchboard, override with
 * SWITCHBOARD_REPO). Uses temporary state dirs and ports 13460-13462, so
 * the production daemons are untouched.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { startGateway } from '../gateway'
import { loadLineConfig } from '../env'
import { buildEnvelope, signedRequest } from '../peers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const OFFICE_PORT = 13460
const HOME_PORT = 13461
const HOME_SWITCHBOARD_PORT = 13462
const SECRET = 'smoke-shared-secret-0123456789'
const SWITCHBOARD_REPO = process.env.SWITCHBOARD_REPO ?? join(homedir(), 'Switchboard')

function stateDirFor(self: string, peer: string, peerPort: number): string {
  const dir = mkdtempSync(join(tmpdir(), `line-gateway-peer-${self}-`))
  writeFileSync(join(dir, '.env'), 'LINE_CHANNEL_ACCESS_TOKEN=smoke\nLINE_CHANNEL_SECRET=smoke\n', { mode: 0o600 })
  writeFileSync(join(dir, 'peers.json'), JSON.stringify({
    self,
    peers: { [peer]: { url: `http://127.0.0.1:${peerPort}`, secret: SECRET } },
  }), { mode: 0o600 })
  return dir
}

const officeDir = stateDirFor('office', 'home', HOME_PORT)
const homeDir = stateDirFor('home', 'office', OFFICE_PORT)
const switchboardDb = join(mkdtempSync(join(tmpdir(), 'switchboard-peer-')), 'switchboard.db')

const switchboard = Bun.spawn(['bun', 'main.ts'], {
  cwd: SWITCHBOARD_REPO,
  env: { ...process.env, SWITCHBOARD_PORT: String(HOME_SWITCHBOARD_PORT), SWITCHBOARD_DB: switchboardDb },
  stdout: 'ignore',
  stderr: 'ignore',
})

const office = startGateway({ port: OFFICE_PORT, lineConfig: loadLineConfig({ stateDir: officeDir }), dbPath: ':memory:' })
const home = startGateway({
  port: HOME_PORT,
  lineConfig: loadLineConfig({ stateDir: homeDir }),
  dbPath: ':memory:',
  switchboardUrl: `http://127.0.0.1:${HOME_SWITCHBOARD_PORT}`,
})

const homeSwitchboard = `http://127.0.0.1:${HOME_SWITCHBOARD_PORT}`
let failures = 0
const homeSession = new Client({ name: 'smoke-home', version: '0.1.0' }, { capabilities: {} })
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`)
  if (!ok) failures++
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await fetch(url); return } catch { await Bun.sleep(100) }
  }
  throw new Error(`${url} never came up`)
}

try {
  await waitFor(`${homeSwitchboard}/register`)

  // A session on the home machine that the office wants to reach: a real
  // MCP client, so the home Switchboard counts it as online.
  await homeSession.connect(new StreamableHTTPClientTransport(new URL(`${homeSwitchboard}/mcp`)))
  const registered = JSON.parse(((await homeSession.callTool({ name: 'register', arguments: { role: '家裡阿宇' } })).content as Array<{ text: string }>)[0]!.text) as { alias: string }
  check('home switchboard registered 家裡阿宇', registered.alias === '家裡阿宇')

  // Office Switchboard would call this; we stand in for it.
  const sent = await fetch(`http://127.0.0.1:${OFFICE_PORT}/peer/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to_peer: 'home', to_alias: '家裡阿宇', from_alias: 'LINE總機', content: '明天的會議改到下午兩點' }),
  })
  const sentJson = await sent.json() as { ok?: boolean; envelope_id?: string }
  check('office /peer/send delivered', sent.status === 200 && sentJson.ok === true, sentJson)

  const read = JSON.parse(((await homeSession.callTool({ name: 'read_messages', arguments: {} })).content as Array<{ text: string }>)[0]!.text) as { messages?: Array<{ sender_alias: string; content: string }> }
  const first = read.messages?.[0]
  check('home switchboard inbox has the message from office:LINE總機',
    first?.sender_alias === 'office:LINE總機' && first?.content === '明天的會議改到下午兩點', first)

  // Office asks home who is online there and gets prefixed-ready aliases.
  const who = await fetch(`http://127.0.0.1:${OFFICE_PORT}/peer/sessions?peer=home`)
  const whoJson = await who.json() as { peer?: string; sessions?: Array<{ alias: string }> }
  check('office /peer/sessions?peer=home lists 家裡阿宇',
    who.status === 200 && whoJson.peer === 'home' && !!whoJson.sessions?.some(s => s.alias === '家裡阿宇'), whoJson)

  // Unknown alias on the far side surfaces as a 502 with the reason.
  const nobody = await fetch(`http://127.0.0.1:${OFFICE_PORT}/peer/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to_peer: 'home', to_alias: '沒這個人', from_alias: 'LINE總機', content: 'x' }),
  })
  check('unknown remote alias is refused', nobody.status === 502, await nobody.json())

  // A tunnelled caller cannot use /peer/send.
  const viaTunnel = await fetch(`http://127.0.0.1:${OFFICE_PORT}/peer/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: '{}',
  })
  check('/peer/send refuses tunnelled requests', viaTunnel.status === 404)

  // Replaying a signed envelope is dropped.
  const env = buildEnvelope({ to_peer: 'home', to_alias: '家裡阿宇', from_alias: 'LINE總機', content: 'replay me' }, 'office')
  const signed = signedRequest({ url: `http://127.0.0.1:${HOME_PORT}`, secret: SECRET }, 'office', env)
  const firstTry = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body })
  const replay = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body })
  check('signed envelope accepted once, replay rejected', firstTry.status === 200 && replay.status === 409)

  const forged = await fetch(signed.url, { method: 'POST', headers: { ...signed.headers, 'x-peer-signature': 'nope' }, body: signed.body })
  check('bad signature rejected', forged.status === 401)
} finally {
  await homeSession.close().catch(() => {})
  await office.stop()
  await home.stop()
  switchboard.kill()
  rmSync(officeDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'smoke-peer: all checks passed' : `smoke-peer: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
