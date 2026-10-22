import { test, expect, describe } from 'bun:test'
import {
  parsePeers, signPeerBody, verifyPeerSignature, isTimestampFresh, ReplayGuard,
  parseOutboundRequest, buildEnvelope, parseEnvelope, remoteSenderAlias,
  signedRequest, verifyInbound, DEFAULT_WINDOW_MS,
  type PeersConfig,
} from '../peers'

const SECRET = 'correct-horse-battery-staple'

const config: PeersConfig = {
  self: 'office',
  peers: { home: { url: 'https://line-home.example', secret: SECRET } },
}

describe('parsePeers', () => {
  test('accepts a well-formed config and strips trailing slashes', () => {
    const parsed = parsePeers({ self: 'office', peers: { home: { url: 'https://h.example/', secret: SECRET } } })
    expect(parsed.self).toBe('office')
    expect(parsed.peers.home!.url).toBe('https://h.example')
  })

  test('rejects a self name that is not short lowercase', () => {
    expect(() => parsePeers({ self: 'Office Machine', peers: {} })).toThrow('self')
  })

  test('rejects a peer named like self', () => {
    expect(() => parsePeers({ self: 'office', peers: { office: { url: 'https://x', secret: SECRET } } })).toThrow('same name as self')
  })

  test('rejects a short secret and a non-http url', () => {
    expect(() => parsePeers({ self: 'office', peers: { home: { url: 'https://x', secret: 'short' } } })).toThrow('secret')
    expect(() => parsePeers({ self: 'office', peers: { home: { url: 'ftp://x', secret: SECRET } } })).toThrow('url')
  })
})

describe('signature', () => {
  test('round-trips', () => {
    const sig = signPeerBody(SECRET, '1700000000000', '{"a":1}')
    expect(verifyPeerSignature(SECRET, '1700000000000', '{"a":1}', sig)).toBe(true)
  })

  test('fails on a different timestamp, body or secret', () => {
    const sig = signPeerBody(SECRET, '1', 'body')
    expect(verifyPeerSignature(SECRET, '2', 'body', sig)).toBe(false)
    expect(verifyPeerSignature(SECRET, '1', 'body!', sig)).toBe(false)
    expect(verifyPeerSignature('other-secret-long-enough', '1', 'body', sig)).toBe(false)
    expect(verifyPeerSignature(SECRET, '1', 'body', '')).toBe(false)
  })
})

describe('isTimestampFresh', () => {
  test('accepts inside the window and rejects outside or garbage', () => {
    const now = 1_700_000_000_000
    expect(isTimestampFresh(String(now - 1000), now)).toBe(true)
    expect(isTimestampFresh(String(now - DEFAULT_WINDOW_MS - 1), now)).toBe(false)
    expect(isTimestampFresh(String(now + DEFAULT_WINDOW_MS + 1), now)).toBe(false)
    expect(isTimestampFresh('yesterday', now)).toBe(false)
  })
})

describe('ReplayGuard', () => {
  test('admits an id once and forgets it only after twice the window', () => {
    const guard = new ReplayGuard(1000)
    expect(guard.admit('m1', 0)).toBe(true)
    expect(guard.admit('m1', 500)).toBe(false)
    expect(guard.admit('m1', 1500)).toBe(false)
    expect(guard.admit('m1', 2001)).toBe(true)
  })
})

describe('envelopes', () => {
  test('parseOutboundRequest requires every field', () => {
    expect(() => parseOutboundRequest({})).toThrow('to_peer')
    expect(() => parseOutboundRequest({ to_peer: 'home' })).toThrow('to_alias')
    expect(() => parseOutboundRequest({ to_peer: 'home', to_alias: 'a' })).toThrow('from_alias')
    expect(() => parseOutboundRequest({ to_peer: 'home', to_alias: 'a', from_alias: 'b' })).toThrow('content')
    expect(parseOutboundRequest({ to_peer: 'home', to_alias: 'a', from_alias: 'b', content: 'hi' }).to_peer).toBe('home')
  })

  test('buildEnvelope stamps self, id and time; the receiver sees machine:alias', () => {
    const env = buildEnvelope({ to_peer: 'home', to_alias: '家裡阿宇', from_alias: '總機', content: 'hi' }, 'office', new Date(0))
    expect(env.from_machine).toBe('office')
    expect(env.sent_at).toBe('1970-01-01T00:00:00.000Z')
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(remoteSenderAlias(env)).toBe('office:總機')
    expect(parseEnvelope(JSON.parse(JSON.stringify(env)))).toEqual(env)
  })
})

describe('verifyInbound', () => {
  const now = 1_700_000_000_000
  function deliver(overrides: Partial<{ peer: string; timestamp: string; body: string; signature: string }> = {}) {
    const env = buildEnvelope({ to_peer: 'office', to_alias: '總機', from_alias: '家裡阿宇', content: 'hello' }, 'home', new Date(now))
    const req = signedRequest({ url: 'https://office.example', secret: SECRET }, 'home', env, now)
    const body = overrides.body ?? req.body
    return {
      env,
      headers: {
        peer: overrides.peer ?? 'home',
        timestamp: overrides.timestamp ?? String(now),
        signature: overrides.signature ?? signPeerBody(SECRET, overrides.timestamp ?? String(now), body),
      },
      body,
    }
  }

  test('accepts a signed envelope from a known peer', () => {
    const d = deliver()
    const verdict = verifyInbound(config, d.headers, d.body, new ReplayGuard(), now)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.envelope.id).toBe(d.env.id)
  })

  test('rejects an unknown peer, a stale timestamp and a bad signature', () => {
    const d = deliver()
    expect(verifyInbound(config, { ...d.headers, peer: 'stranger' }, d.body, new ReplayGuard(), now)).toMatchObject({ ok: false, status: 401, reason: 'unknown peer' })
    expect(verifyInbound(config, d.headers, d.body, new ReplayGuard(), now + DEFAULT_WINDOW_MS + 1)).toMatchObject({ ok: false, reason: 'stale timestamp' })
    expect(verifyInbound(config, { ...d.headers, signature: 'nope' }, d.body, new ReplayGuard(), now)).toMatchObject({ ok: false, reason: 'bad signature' })
  })

  test('rejects an envelope whose from_machine differs from the signing peer', () => {
    const forged = JSON.stringify({ ...JSON.parse(deliver().body), from_machine: 'other' })
    const d = deliver({ body: forged })
    expect(verifyInbound(config, d.headers, d.body, new ReplayGuard(), now)).toMatchObject({ ok: false, status: 400 })
  })

  test('rejects a replay of the same envelope', () => {
    const d = deliver()
    const guard = new ReplayGuard()
    expect(verifyInbound(config, d.headers, d.body, guard, now).ok).toBe(true)
    expect(verifyInbound(config, d.headers, d.body, guard, now)).toMatchObject({ ok: false, status: 409 })
  })

  test('rejects a replay of a clock-ahead envelope after the id would have aged out of one window', () => {
    const ahead = deliver({ timestamp: String(now + DEFAULT_WINDOW_MS) })
    const guard = new ReplayGuard()
    expect(verifyInbound(config, ahead.headers, ahead.body, guard, now).ok).toBe(true)
    const later = now + DEFAULT_WINDOW_MS + 1
    expect(verifyInbound(config, ahead.headers, ahead.body, guard, later)).toMatchObject({ ok: false, status: 409 })
  })
})
