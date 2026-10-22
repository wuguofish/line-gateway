/**
 * HTTP handlers for the cross-machine peer transport (see peers.ts):
 *
 *   POST /peer/send   loopback only — the local Switchboard asks us to sign
 *                     an envelope and deliver it to a peer gateway
 *   POST /peer/inbox  public via tunnel — a peer gateway delivers a signed
 *                     envelope, which we hand to the local Switchboard
 *   GET  /peer/sessions  both: with `?peer=` from loopback it asks that peer
 *                     who is online there; signed and tunnelled it answers
 *                     with this machine's online Switchboard sessions
 *
 * Takes `fetch` and the clock as dependencies so both handlers run under
 * bun:test without a live server.
 */

import {
  buildEnvelope, parseOutboundRequest, readPeers, remoteSenderAlias, signedRequest,
  verifyInbound, ReplayGuard, DEFAULT_WINDOW_MS,
  signedSessionsQuery, verifySessionsQuery,
  PEER_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER,
  type PeersConfig,
} from './peers'

export interface PeerRoutesOptions {
  /** Path of peers.json; re-read per request. */
  peersFile: string
  /** Origin of the local Switchboard daemon that receives inbound envelopes. */
  switchboardUrl: string
  fetchImpl?: typeof fetch
  now?: () => number
  windowMs?: number
  /** Override the file read (tests). */
  readConfig?: () => PeersConfig
}

export const DEFAULT_SWITCHBOARD_URL = 'http://127.0.0.1:9876'

const PEER_TIMEOUT_MS = 15_000

/**
 * cloudflared stamps every tunnelled request with `cf-connecting-ip`, and a
 * client cannot strip it, so its presence means the request came from the
 * public side. Loopback-only routes refuse those.
 */
export function cameThroughTunnel(req: Request): boolean {
  return req.headers.has('cf-connecting-ip')
}

/**
 * A browser on this machine can be made to POST to loopback by any web
 * page. Browsers always attach `Origin` to cross-origin POSTs, and a JSON
 * content type forces a CORS preflight this server never answers, so both
 * checks together keep /peer/send to real local programs.
 */
export function looksLikeBrowserRequest(req: Request): boolean {
  if (req.headers.has('origin')) return true
  const type = req.headers.get('content-type') ?? ''
  return !type.toLowerCase().startsWith('application/json')
}

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/**
 * DNS rebinding lets a web page point its own hostname at 127.0.0.1, after
 * which the browser treats the gateway as same-origin and sends neither an
 * Origin header nor a preflight. Such requests still carry the attacker's
 * hostname in Host; a local program addresses the loopback literally.
 */
export function hasLoopbackHost(req: Request): boolean {
  const host = req.headers.get('host') ?? new URL(req.url).host
  return LOOPBACK_HOST_RE.test(host)
}

export function createPeerRoutes(opts: PeerRoutesOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const guard = new ReplayGuard(windowMs)
  const readConfig = opts.readConfig ?? (() => readPeers(opts.peersFile))

  async function handleSend(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    if (cameThroughTunnel(req)) return new Response('Not Found', { status: 404 })
    if (!hasLoopbackHost(req)) return Response.json({ error: 'address the gateway as 127.0.0.1' }, { status: 403 })
    if (looksLikeBrowserRequest(req)) return Response.json({ error: 'send JSON without an Origin header' }, { status: 403 })

    let body: unknown
    try { body = await req.json() } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 })
    }
    let outbound
    try { outbound = parseOutboundRequest(body) } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
    }

    const config = readConfig()
    if (!config.self) return Response.json({ error: 'peers.json has no "self"; cross-machine send is not configured' }, { status: 503 })
    const peer = config.peers[outbound.to_peer]
    if (!peer) {
      return Response.json({
        error: `unknown peer: ${outbound.to_peer}`,
        known_peers: Object.keys(config.peers),
      }, { status: 404 })
    }

    const envelope = buildEnvelope(outbound, config.self, new Date(now()))
    const signed = signedRequest(peer, config.self, envelope, now())
    let upstream: Response
    try {
      upstream = await fetchImpl(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      })
    } catch (err) {
      return Response.json({
        error: `peer ${outbound.to_peer} unreachable: ${err instanceof Error ? err.message : String(err)}`,
        envelope_id: envelope.id,
      }, { status: 502 })
    }
    const text = await upstream.text()
    let detail: unknown = text
    try { detail = JSON.parse(text) } catch {}
    if (!upstream.ok) {
      return Response.json({
        error: `peer ${outbound.to_peer} refused the envelope (HTTP ${upstream.status})`,
        detail,
        envelope_id: envelope.id,
      }, { status: 502 })
    }
    return Response.json({ ok: true, envelope_id: envelope.id, peer: outbound.to_peer, remote: detail })
  }

  async function handleInbox(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    const body = await req.text()
    const verdict = verifyInbound(
      readConfig(),
      {
        peer: req.headers.get(PEER_HEADER) ?? '',
        timestamp: req.headers.get(TIMESTAMP_HEADER) ?? '',
        signature: req.headers.get(SIGNATURE_HEADER) ?? '',
      },
      body,
      guard,
      now(),
      windowMs,
    )
    if (!verdict.ok) {
      process.stderr.write(`line-gateway: /peer/inbox rejected: ${verdict.reason}\n`)
      return Response.json({ error: verdict.reason }, { status: verdict.status })
    }

    const env = verdict.envelope
    let upstream: Response
    try {
      upstream = await fetchImpl(opts.switchboardUrl + '/external/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: remoteSenderAlias(env), to: env.to_alias, message: env.content }),
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      })
    } catch (err) {
      return Response.json({ error: `local switchboard unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 503 })
    }
    const text = await upstream.text()
    let detail: unknown = text
    try { detail = JSON.parse(text) } catch {}
    if (!upstream.ok) {
      // 400 from Switchboard is "no such alias here"; surface it as 404 so
      // the sender's error names the alias instead of the transport.
      const status = upstream.status === 400 ? 404 : 502
      return Response.json({ error: 'switchboard refused the message', detail }, { status })
    }
    process.stderr.write(`line-gateway: /peer/inbox ${remoteSenderAlias(env)} -> ${env.to_alias} (${env.id})\n`)
    return Response.json({ ok: true, envelope_id: env.id, switchboard: detail })
  }

  async function handleSessions(req: Request): Promise<Response> {
    if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
    const config = readConfig()
    const peerParam = new URL(req.url).searchParams.get('peer')

    if (peerParam !== null && !cameThroughTunnel(req)) {
      if (!hasLoopbackHost(req) || req.headers.has('origin')) return Response.json({ error: 'browser requests are not accepted here' }, { status: 403 })
      if (!config.self) return Response.json({ error: 'peers.json has no "self"; cross-machine queries are not configured' }, { status: 503 })
      const peer = config.peers[peerParam]
      if (!peer) return Response.json({ error: `unknown peer: ${peerParam}`, known_peers: Object.keys(config.peers) }, { status: 404 })
      const query = signedSessionsQuery(peer, config.self, now())
      let upstream: Response
      try {
        upstream = await fetchImpl(query.url, { method: 'GET', headers: query.headers, signal: AbortSignal.timeout(PEER_TIMEOUT_MS) })
      } catch (err) {
        return Response.json({ error: `peer ${peerParam} unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
      }
      const text = await upstream.text()
      let detail: unknown = text
      try { detail = JSON.parse(text) } catch {}
      if (!upstream.ok) return Response.json({ error: `peer ${peerParam} refused the query (HTTP ${upstream.status})`, detail }, { status: 502 })
      return Response.json(detail)
    }

    const verdict = verifySessionsQuery(config, {
      peer: req.headers.get(PEER_HEADER) ?? '',
      timestamp: req.headers.get(TIMESTAMP_HEADER) ?? '',
      signature: req.headers.get(SIGNATURE_HEADER) ?? '',
    }, now(), windowMs)
    if (!verdict.ok) {
      process.stderr.write(`line-gateway: /peer/sessions rejected: ${verdict.reason}\n`)
      return Response.json({ error: verdict.reason }, { status: verdict.status })
    }
    let upstream: Response
    try {
      upstream = await fetchImpl(opts.switchboardUrl + '/sessions', { method: 'GET', signal: AbortSignal.timeout(PEER_TIMEOUT_MS) })
    } catch (err) {
      return Response.json({ error: `local switchboard unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 503 })
    }
    if (!upstream.ok) return Response.json({ error: `local switchboard returned HTTP ${upstream.status}` }, { status: 502 })
    const body = await upstream.json() as { sessions?: unknown }
    return Response.json({ peer: config.self, sessions: Array.isArray(body.sessions) ? body.sessions : [] })
  }

  return { handleSend, handleInbox, handleSessions }
}
