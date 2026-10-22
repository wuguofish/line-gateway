/**
 * Cross-machine peer transport: lets the Switchboard on this machine reach
 * the Switchboard on another machine through the two gateways' public
 * tunnels.
 *
 *   Switchboard A ──loopback──▶ gateway A ──tunnel──▶ gateway B ──loopback──▶ Switchboard B
 *            send("home:alias")   /peer/send   HTTPS   /peer/inbox   /external/send
 *
 * Every hop that crosses the network is signed with a per-peer shared
 * secret (HMAC-SHA256 over `<timestamp>.<body>`), bounded to a time
 * window and de-duplicated by message id, so a replayed or forged request
 * never wakes a session. Everything here is pure except `readPeers`, so
 * the signing and verification rules are unit-tested without a server.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'

export interface PeerEntry {
  /** Where the other machine's gateway accepts `/peer/inbox`, origin only. */
  url: string
  secret: string
}

export interface PeersConfig {
  /** How this machine names itself to others; becomes the sender prefix on their side. */
  self: string
  peers: Record<string, PeerEntry>
}

/** Wire body of `POST /peer/inbox`, identical to what `/peer/send` accepts plus the stamped sender. */
export interface PeerEnvelope {
  id: string
  /** Peer name of the sending machine, as the receiver knows it. */
  from_machine: string
  from_alias: string
  to_alias: string
  content: string
  /** ISO 8601 UTC; the receiver rejects envelopes outside its time window. */
  sent_at: string
}

export const SIGNATURE_HEADER = 'x-peer-signature'
export const TIMESTAMP_HEADER = 'x-peer-timestamp'
export const PEER_HEADER = 'x-peer-name'

export const DEFAULT_WINDOW_MS = 5 * 60 * 1000

const PEER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function isValidPeerName(name: unknown): name is string {
  return typeof name === 'string' && PEER_NAME_RE.test(name)
}

/**
 * Reads peers.json; a missing file means "no peers" and is not an error.
 * Re-read per request, like access.json, so edits need no restart.
 */
export function readPeers(file: string): PeersConfig {
  const empty: PeersConfig = { self: '', peers: {} }
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`line-gateway: could not read ${file}: ${err}\n`)
    }
    return empty
  }
  try {
    return parsePeers(JSON.parse(raw))
  } catch (err) {
    process.stderr.write(`line-gateway: ${file} ignored: ${err instanceof Error ? err.message : err}\n`)
    return empty
  }
}

export function parsePeers(parsed: unknown): PeersConfig {
  if (!parsed || typeof parsed !== 'object') throw new Error('peers.json must be a JSON object')
  const obj = parsed as { self?: unknown; peers?: unknown }
  if (!isValidPeerName(obj.self)) throw new Error('peers.json: "self" must be a short lowercase name')
  const peers: Record<string, PeerEntry> = {}
  const rawPeers = obj.peers && typeof obj.peers === 'object' ? obj.peers as Record<string, unknown> : {}
  for (const [name, entry] of Object.entries(rawPeers)) {
    if (!isValidPeerName(name)) throw new Error(`peers.json: peer name "${name}" is not a short lowercase name`)
    if (name === obj.self) throw new Error(`peers.json: peer "${name}" has the same name as self`)
    const e = entry as { url?: unknown; secret?: unknown }
    if (typeof e?.url !== 'string' || !/^https?:\/\//.test(e.url)) throw new Error(`peers.json: peer "${name}" needs an http(s) url`)
    if (typeof e.secret !== 'string' || e.secret.length < 16) throw new Error(`peers.json: peer "${name}" needs a secret of at least 16 characters`)
    peers[name] = { url: e.url.replace(/\/+$/, ''), secret: e.secret }
  }
  return { self: obj.self, peers }
}

// --- Signing ---------------------------------------------------------------

export function signPeerBody(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(timestamp + '.' + body).digest('base64')
}

export function verifyPeerSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  if (!signature || !timestamp) return false
  const expected = Buffer.from(signPeerBody(secret, timestamp, body))
  const given = Buffer.from(signature)
  if (expected.length !== given.length) return false
  try {
    return timingSafeEqual(expected, given)
  } catch {
    return false
  }
}

export function isTimestampFresh(timestamp: string, nowMs: number, windowMs = DEFAULT_WINDOW_MS): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  return Math.abs(nowMs - ts) <= windowMs
}

/**
 * Remembers envelope ids so a replayed request is dropped. Ids are kept for
 * twice the timestamp window: a timestamp may run up to one window ahead of
 * our clock, so it stays fresh for up to two windows after first sight.
 */
export class ReplayGuard {
  private seen = new Map<string, number>()
  private readonly retainMs: number
  constructor(windowMs = DEFAULT_WINDOW_MS) {
    this.retainMs = windowMs * 2
  }

  /** Returns true the first time an id is seen, false on a replay. */
  admit(id: string, nowMs: number): boolean {
    this.sweep(nowMs)
    if (this.seen.has(id)) return false
    this.seen.set(id, nowMs)
    return true
  }

  private sweep(nowMs: number): void {
    for (const [id, at] of this.seen) {
      if (nowMs - at > this.retainMs) this.seen.delete(id)
    }
  }
}

// --- Envelopes -------------------------------------------------------------

export interface OutboundRequest {
  to_peer: string
  to_alias: string
  from_alias: string
  content: string
}

export function parseOutboundRequest(body: unknown): OutboundRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const to_peer = typeof b.to_peer === 'string' ? b.to_peer.trim() : ''
  const to_alias = typeof b.to_alias === 'string' ? b.to_alias.trim() : ''
  const from_alias = typeof b.from_alias === 'string' ? b.from_alias.trim() : ''
  const content = typeof b.content === 'string' ? b.content : ''
  if (!isValidPeerName(to_peer)) throw new Error('to_peer is required and must be a short lowercase name')
  if (!to_alias) throw new Error('to_alias is required')
  if (!from_alias) throw new Error('from_alias is required')
  if (!content) throw new Error('content is required')
  return { to_peer, to_alias, from_alias, content }
}

export function buildEnvelope(req: OutboundRequest, self: string, now: Date = new Date()): PeerEnvelope {
  return {
    id: randomUUID(),
    from_machine: self,
    from_alias: req.from_alias,
    to_alias: req.to_alias,
    content: req.content,
    sent_at: now.toISOString(),
  }
}

export function parseEnvelope(body: unknown): PeerEnvelope {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof b[k] === 'string' ? (b[k] as string).trim() : '')
  const env: PeerEnvelope = {
    id: str('id'),
    from_machine: str('from_machine'),
    from_alias: str('from_alias'),
    to_alias: str('to_alias'),
    content: typeof b.content === 'string' ? b.content : '',
    sent_at: str('sent_at'),
  }
  if (!env.id) throw new Error('id is required')
  if (!isValidPeerName(env.from_machine)) throw new Error('from_machine must be a short lowercase name')
  if (!env.from_alias) throw new Error('from_alias is required')
  if (!env.to_alias) throw new Error('to_alias is required')
  if (!env.content) throw new Error('content is required')
  return env
}

/** How the sender appears in the receiving Switchboard: `<machine>:<alias>`. */
export function remoteSenderAlias(env: PeerEnvelope): string {
  return env.from_machine + ':' + env.from_alias
}

/** Signed request parts for delivering an envelope to a peer gateway. */
export function signedRequest(peer: PeerEntry, self: string, env: PeerEnvelope, nowMs = Date.now()): { url: string; headers: Record<string, string>; body: string } {
  const body = JSON.stringify(env)
  const timestamp = String(nowMs)
  return {
    url: peer.url + '/peer/inbox',
    headers: {
      'content-type': 'application/json',
      [PEER_HEADER]: self,
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signPeerBody(peer.secret, timestamp, body),
    },
    body,
  }
}

/**
 * A peer asking who is online here signs `<timestamp>.sessions.<its name>`
 * instead of a body. Binding the sender's name keeps a captured query from
 * being reflected back at the machine that sent it. The read has no side
 * effect, so the time window alone bounds it and no envelope id is needed.
 */
export function sessionsQueryPayload(sender: string): string {
  return 'sessions.' + sender
}

export function signedSessionsQuery(peer: PeerEntry, self: string, nowMs = Date.now()): { url: string; headers: Record<string, string> } {
  const timestamp = String(nowMs)
  return {
    url: peer.url + '/peer/sessions',
    headers: {
      accept: 'application/json',
      [PEER_HEADER]: self,
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signPeerBody(peer.secret, timestamp, sessionsQueryPayload(self)),
    },
  }
}

export type QueryVerdict =
  | { ok: true; peer: string }
  | { ok: false; status: number; reason: string }

export function verifySessionsQuery(
  config: PeersConfig,
  headers: { peer: string; timestamp: string; signature: string },
  nowMs = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
): QueryVerdict {
  const peer = config.peers[headers.peer]
  if (!isValidPeerName(headers.peer) || !peer) return { ok: false, status: 401, reason: 'unknown peer' }
  if (!isTimestampFresh(headers.timestamp, nowMs, windowMs)) return { ok: false, status: 401, reason: 'stale timestamp' }
  if (!verifyPeerSignature(peer.secret, headers.timestamp, sessionsQueryPayload(headers.peer), headers.signature)) return { ok: false, status: 401, reason: 'bad signature' }
  return { ok: true, peer: headers.peer }
}

export type InboundVerdict =
  | { ok: true; envelope: PeerEnvelope; peer: string }
  | { ok: false; status: number; reason: string }

/**
 * Full inbound check for `/peer/inbox`: known peer, fresh timestamp, valid
 * signature, well-formed envelope, first sighting of its id.
 */
export function verifyInbound(
  config: PeersConfig,
  headers: { peer: string; timestamp: string; signature: string },
  body: string,
  guard: ReplayGuard,
  nowMs = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
): InboundVerdict {
  const peer = config.peers[headers.peer]
  if (!isValidPeerName(headers.peer) || !peer) return { ok: false, status: 401, reason: 'unknown peer' }
  if (!isTimestampFresh(headers.timestamp, nowMs, windowMs)) return { ok: false, status: 401, reason: 'stale timestamp' }
  if (!verifyPeerSignature(peer.secret, headers.timestamp, body, headers.signature)) return { ok: false, status: 401, reason: 'bad signature' }
  let envelope: PeerEnvelope
  try {
    envelope = parseEnvelope(JSON.parse(body))
  } catch (err) {
    return { ok: false, status: 400, reason: err instanceof Error ? err.message : 'bad envelope' }
  }
  if (envelope.from_machine !== headers.peer) return { ok: false, status: 400, reason: 'from_machine does not match signing peer' }
  if (!guard.admit(envelope.id, nowMs)) return { ok: false, status: 409, reason: 'replayed envelope' }
  return { ok: true, envelope, peer: headers.peer }
}
