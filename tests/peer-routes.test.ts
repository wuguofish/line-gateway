import { test, expect, describe } from 'bun:test'
import { createPeerRoutes, cameThroughTunnel } from '../peer-routes'
import { buildEnvelope, signedRequest, signedSessionsQuery, type PeersConfig } from '../peers'

const SECRET = 'correct-horse-battery-staple'
const NOW = 1_700_000_000_000

const officeConfig: PeersConfig = {
  self: 'office',
  peers: { home: { url: 'https://line-home.example', secret: SECRET } },
}
const homeConfig: PeersConfig = {
  self: 'home',
  peers: { office: { url: 'https://line-office.example', secret: SECRET } },
}

interface Captured { url: string; init: RequestInit }

/** A fetch that records calls and answers from a table keyed by URL prefix. */
function fakeFetch(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: Captured[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const key = Object.keys(answers).find(prefix => url.startsWith(prefix))
    if (!key) throw new Error('connection refused')
    return answers[key]!()
  }) as typeof fetch
  return { impl, calls }
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3456' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('cameThroughTunnel', () => {
  test('is true only when cloudflared stamped the request', () => {
    expect(cameThroughTunnel(post('/x', {}))).toBe(false)
    expect(cameThroughTunnel(post('/x', {}, { 'cf-connecting-ip': '203.0.113.9' }))).toBe(true)
  })
})

describe('POST /peer/send', () => {
  const outbound = { to_peer: 'home', to_alias: '家裡阿宇', from_alias: 'LINE總機', content: '明天的會議改到下午兩點' }

  test('signs an envelope and posts it to the peer inbox', async () => {
    const remote = fakeFetch({ 'https://line-home.example/peer/inbox': () => Response.json({ ok: true, envelope_id: 'x' }) })
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: remote.impl, now: () => NOW, readConfig: () => officeConfig })
    const res = await routes.handleSend(post('/peer/send', outbound))
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; peer: string; envelope_id: string }
    expect(json.ok).toBe(true)
    expect(json.peer).toBe('home')

    expect(remote.calls).toHaveLength(1)
    const call = remote.calls[0]!
    expect(call.url).toBe('https://line-home.example/peer/inbox')
    const headers = call.init.headers as Record<string, string>
    expect(headers['x-peer-name']).toBe('office')
    expect(headers['x-peer-timestamp']).toBe(String(NOW))
    expect(headers['x-peer-signature']).toMatch(/^[A-Za-z0-9+/=]+$/)
    const env = JSON.parse(call.init.body as string)
    expect(env).toMatchObject({ from_machine: 'office', from_alias: 'LINE總機', to_alias: '家裡阿宇', content: '明天的會議改到下午兩點', id: json.envelope_id })
  })

  test('refuses requests that arrived through the tunnel', async () => {
    const remote = fakeFetch({})
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: remote.impl, readConfig: () => officeConfig })
    const res = await routes.handleSend(post('/peer/send', outbound, { 'cf-connecting-ip': '203.0.113.9' }))
    expect(res.status).toBe(404)
    expect(remote.calls).toHaveLength(0)
  })

  test('refuses browser-shaped requests: an Origin header or a non-JSON content type', async () => {
    const remote = fakeFetch({})
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: remote.impl, readConfig: () => officeConfig })
    expect((await routes.handleSend(post('/peer/send', outbound, { origin: 'https://evil.example' }))).status).toBe(403)
    const plain = new Request('http://127.0.0.1:3456/peer/send', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(outbound) })
    expect((await routes.handleSend(plain)).status).toBe(403)
    expect(remote.calls).toHaveLength(0)
  })

  test('refuses a rebound hostname even when the request otherwise looks local', async () => {
    const remote = fakeFetch({})
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: remote.impl, readConfig: () => officeConfig })
    const rebound = new Request('http://evil.example:3456/peer/send', { method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.example:3456' }, body: JSON.stringify(outbound) })
    expect((await routes.handleSend(rebound)).status).toBe(403)
    const reboundQuery = new Request('http://evil.example:3456/peer/sessions?peer=home', { headers: { host: 'evil.example:3456' } })
    expect((await routes.handleSessions(reboundQuery)).status).toBe(403)
    expect(remote.calls).toHaveLength(0)
  })

  test('names the known peers when the target peer is unknown', async () => {
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: fakeFetch({}).impl, readConfig: () => officeConfig })
    const res = await routes.handleSend(post('/peer/send', { ...outbound, to_peer: 'cabin' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ known_peers: ['home'] })
  })

  test('reports 503 when peers.json is absent and 502 when the peer is unreachable or refuses', async () => {
    const unconfigured = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: fakeFetch({}).impl, readConfig: () => ({ self: '', peers: {} }) })
    expect((await unconfigured.handleSend(post('/peer/send', outbound))).status).toBe(503)

    const unreachable = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: fakeFetch({}).impl, readConfig: () => officeConfig })
    const down = await unreachable.handleSend(post('/peer/send', outbound))
    expect(down.status).toBe(502)
    expect((await down.json() as { error: string }).error).toContain('unreachable')

    const refusing = createPeerRoutes({
      peersFile: '', switchboardUrl: 'http://sb', readConfig: () => officeConfig,
      fetchImpl: fakeFetch({ 'https://line-home.example': () => Response.json({ error: 'switchboard refused the message' }, { status: 404 }) }).impl,
    })
    const refused = await refusing.handleSend(post('/peer/send', outbound))
    expect(refused.status).toBe(502)
    expect(await refused.json()).toMatchObject({ detail: { error: 'switchboard refused the message' } })
  })

  test('rejects malformed bodies with 400', async () => {
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: fakeFetch({}).impl, readConfig: () => officeConfig })
    expect((await routes.handleSend(post('/peer/send', 'not json'))).status).toBe(400)
    expect((await routes.handleSend(post('/peer/send', { to_peer: 'home' }))).status).toBe(400)
  })
})

describe('POST /peer/inbox', () => {
  /** What the office gateway would send to the home gateway. */
  function fromOffice(content = 'hello', nowMs = NOW) {
    const env = buildEnvelope({ to_peer: 'home', to_alias: '家裡阿宇', from_alias: 'LINE總機', content }, 'office', new Date(nowMs))
    const signed = signedRequest(homeConfig.peers.office!, 'office', env, nowMs)
    return { env, request: post('/peer/inbox', signed.body, signed.headers) }
  }

  test('verifies the envelope and hands it to the local Switchboard as machine:alias', async () => {
    const local = fakeFetch({ 'http://sb/external/send': () => Response.json({ message_id: 'm1', delivered_notification: true }) })
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: local.impl, now: () => NOW, readConfig: () => homeConfig })
    const { env, request } = fromOffice('明天的會議改到下午兩點')
    const res = await routes.handleInbox(request)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, envelope_id: env.id, switchboard: { message_id: 'm1' } })

    expect(local.calls).toHaveLength(1)
    expect(JSON.parse(local.calls[0]!.init.body as string)).toEqual({ from: 'office:LINE總機', to: '家裡阿宇', message: '明天的會議改到下午兩點' })
  })

  test('rejects a bad signature, an unknown peer and a replay without touching Switchboard', async () => {
    const local = fakeFetch({ 'http://sb/external/send': () => Response.json({ message_id: 'm1', delivered_notification: true }) })
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: local.impl, now: () => NOW, readConfig: () => homeConfig })

    const tampered = fromOffice()
    const bad = new Request(tampered.request, { headers: { ...Object.fromEntries(tampered.request.headers), 'x-peer-signature': 'nope' } })
    expect((await routes.handleInbox(bad)).status).toBe(401)

    const stranger = fromOffice()
    const unknown = new Request(stranger.request, { headers: { ...Object.fromEntries(stranger.request.headers), 'x-peer-name': 'cabin' } })
    expect((await routes.handleInbox(unknown)).status).toBe(401)

    const { request } = fromOffice()
    const replay = request.clone()
    expect((await routes.handleInbox(request)).status).toBe(200)
    expect((await routes.handleInbox(replay)).status).toBe(409)
    expect(local.calls).toHaveLength(1)
  })

  test('maps an unknown local alias to 404 and a dead Switchboard to 503', async () => {
    const noAlias = createPeerRoutes({
      peersFile: '', switchboardUrl: 'http://sb', now: () => NOW, readConfig: () => homeConfig,
      fetchImpl: fakeFetch({ 'http://sb/external/send': () => Response.json({ error: 'unknown target: 家裡阿宇' }, { status: 400 }) }).impl,
    })
    const res = await noAlias.handleInbox(fromOffice().request)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ detail: { error: 'unknown target: 家裡阿宇' } })

    const dead = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', now: () => NOW, readConfig: () => homeConfig, fetchImpl: fakeFetch({}).impl })
    expect((await dead.handleInbox(fromOffice().request)).status).toBe(503)
  })
})

describe('GET /peer/sessions', () => {
  function get(path: string, headers: Record<string, string> = {}): Request {
    return new Request('http://127.0.0.1:3456' + path, { method: 'GET', headers })
  }

  test('from loopback with ?peer= signs a query to the peer and relays its answer', async () => {
    const remote = fakeFetch({ 'https://line-home.example/peer/sessions': () => Response.json({ peer: 'home', sessions: [{ alias: '家裡阿宇', client_kind: 'claude_code', online: true }] }) })
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: remote.impl, now: () => NOW, readConfig: () => officeConfig })
    const res = await routes.handleSessions(get('/peer/sessions?peer=home'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ peer: 'home', sessions: [{ alias: '家裡阿宇', client_kind: 'claude_code', online: true }] })
    const headers = remote.calls[0]!.init.headers as Record<string, string>
    expect(headers['x-peer-name']).toBe('office')
    expect(headers['x-peer-timestamp']).toBe(String(NOW))
    expect(headers['x-peer-signature']).toBeTruthy()
  })

  test('a browser-originated loopback query is refused', async () => {
    const remote = fakeFetch({})
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: remote.impl, readConfig: () => officeConfig })
    expect((await routes.handleSessions(get('/peer/sessions?peer=home', { origin: 'https://evil.example' }))).status).toBe(403)
    expect(remote.calls).toHaveLength(0)
  })

  test('a query signed by office cannot be reflected back at office', async () => {
    const local = fakeFetch({ 'http://sb/sessions': () => Response.json({ sessions: [] }) })
    const office = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: local.impl, now: () => NOW, readConfig: () => officeConfig })
    const captured = signedSessionsQuery(homeConfig.peers.office!, 'office', NOW)
    const reflected = get('/peer/sessions', { ...captured.headers, 'x-peer-name': 'home', 'cf-connecting-ip': '203.0.113.9' })
    expect((await office.handleSessions(reflected)).status).toBe(401)
    expect(local.calls).toHaveLength(0)
  })

  test('unknown peer and unreachable peer are reported', async () => {
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: fakeFetch({}).impl, readConfig: () => officeConfig })
    expect((await routes.handleSessions(get('/peer/sessions?peer=cabin'))).status).toBe(404)
    expect((await routes.handleSessions(get('/peer/sessions?peer=home'))).status).toBe(502)
  })

  test('a signed tunnelled query is answered from the local Switchboard', async () => {
    const local = fakeFetch({ 'http://sb/sessions': () => Response.json({ sessions: [{ alias: 'LINE總機', client_kind: 'claude_code', online: true }] }) })
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: local.impl, now: () => NOW, readConfig: () => homeConfig })
    const query = signedSessionsQuery(homeConfig.peers.office!, 'office', NOW)
    const res = await routes.handleSessions(get('/peer/sessions', { ...query.headers, 'cf-connecting-ip': '203.0.113.9' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ peer: 'home', sessions: [{ alias: 'LINE總機', client_kind: 'claude_code', online: true }] })
  })

  test('an unsigned or badly signed query gets 401 and never reaches Switchboard', async () => {
    const local = fakeFetch({ 'http://sb/sessions': () => Response.json({ sessions: [] }) })
    const routes = createPeerRoutes({ peersFile: '', switchboardUrl: 'http://sb', fetchImpl: local.impl, now: () => NOW, readConfig: () => homeConfig })
    expect((await routes.handleSessions(get('/peer/sessions', { 'cf-connecting-ip': '203.0.113.9' }))).status).toBe(401)
    const query = signedSessionsQuery(homeConfig.peers.office!, 'office', NOW)
    expect((await routes.handleSessions(get('/peer/sessions', { ...query.headers, 'x-peer-signature': 'nope' }))).status).toBe(401)
    expect(local.calls).toHaveLength(0)
  })
})
