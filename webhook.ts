/**
 * LINE webhook receiver: verify HMAC-SHA256 signature (constant-time),
 * parse the payload, and forward each event to the handler plugin as
 * an `inbound` WSS frame.
 *
 * Signature spec: LINE Messaging API signs the raw body with the
 * channel secret using HMAC-SHA256, base64-encoded. The server must
 * verify timing-safely to avoid side-channel leaks.
 * https://developers.line.biz/en/reference/messaging-api/#signature-validation
 *
 * Permission-reply pre-check: if the text is `y <id>` / `n <id>` from the
 * primary owner, route to the plugin that issued push_permission rather
 * than letting it reach the handler inbox as a normal message.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { Database } from 'bun:sqlite'
import type { ConnectionRegistry } from './connections'
import type { HandlerManager } from './handler'
import type { PermissionRouter } from './permissions'
import type { GatewayToPlugin, InboundFrame } from './protocol'
import type { ReplyTokenCache, SentIdSet, DisplayNameCache } from './line-api'
import { insertMessage, hasMessageId, getMessageById } from './db'

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature) return false
  const expected = createHmac('sha256', secret).update(body).digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export interface WebhookDeps {
  registry: ConnectionRegistry
  handlers: HandlerManager
  permissions: PermissionRouter
  /** allowFrom[0] from access.json — the only user whose y/n replies count as permission decisions. */
  primaryOwner(): string | null
  /**
   * Optional archive + token cache side-effects. Pure-logic webhook tests
   * leave these out; the production gateway wires both in.
   */
  db?: Database
  replyTokens?: ReplyTokenCache
  /** Known-sent message ids (populated by our own push/reply calls). */
  sentIds?: SentIdSet
  /**
   * Optional display-name cache. When provided, dispatch() fires a
   * best-effort prefetch for each event's sender, and buildEnrichment()
   * attaches the cached name to `enrichment.user_name`. First sighting
   * of a new userId misses the cache silently — the prefetch populates
   * it for the next message.
   */
  displayNames?: DisplayNameCache
  /** Clock hook so tests can pin received_at deterministically. */
  now?: () => Date
}

interface LineSource {
  type: 'user' | 'group' | 'room'
  userId?: string
  groupId?: string
  roomId?: string
}

interface LineMessageEvent {
  type: string
  timestamp?: number
  replyToken?: string
  source?: LineSource
  message?: {
    id?: string
    type?: string
    text?: string
    quotedMessageId?: string
    [k: string]: unknown
  }
  [k: string]: unknown
}

interface LineWebhookPayload {
  destination?: string
  events?: LineMessageEvent[]
}

// ISO-8601 with explicit Asia/Taipei +08:00 offset — consistent with
// claude-line-channel so history.log and gateway DB read the same.
function toTaipeiISOString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3, hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.${get('fractionalSecond')}+08:00`
}

export interface DispatchResult {
  routed_to_handler: number
  routed_as_permission_reply: number
  dropped_no_handler: number
  archived: number
}

/**
 * Dispatch a parsed webhook payload. Pure routing — no network I/O, no
 * signature work (that's the caller's job). Accepts unknown rather than
 * a strict LineWebhookPayload so real-world payload surprises don't
 * crash us, and so tests don't need to cast through the nominal types.
 */
export function dispatch(
  payload: unknown,
  deps: WebhookDeps,
): DispatchResult {
  const result: DispatchResult = {
    routed_to_handler: 0,
    routed_as_permission_reply: 0,
    dropped_no_handler: 0,
    archived: 0,
  }

  const events = Array.isArray((payload as LineWebhookPayload)?.events)
    ? (payload as LineWebhookPayload).events as LineMessageEvent[]
    : []
  const now = deps.now ?? (() => new Date())
  const receivedAt = toTaipeiISOString(now())

  for (const ev of events) {
    // Archive before routing so permission replies are also stored (operator
    // can audit y/n history even though they don't land in the handler inbox).
    if (deps.db) {
      const inserted = insertMessage(deps.db, ev as any, receivedAt)
      if (inserted) result.archived++
    }

    // Cache the reply token so api_request `reply` can use the free path.
    if (deps.replyTokens && ev.type === 'message' && ev.replyToken) {
      const chatId = chatIdOf(ev)
      if (chatId) deps.replyTokens.store(chatId, ev.replyToken)
    }

    // Permission-reply pre-check: owner DMing `y <id>` / `n <id>` goes
    // straight to the plugin that issued the corresponding push_permission,
    // never to the handler's inbox.
    const matched = tryPermissionReply(ev, deps)
    if (matched) {
      result.routed_as_permission_reply++
      continue
    }

    const handler = deps.handlers.currentHandler()
    if (!handler || !deps.handlers.isHandler(handler)) {
      // Either nobody is handler or we're in the grace-period after a
      // disconnect. Inbound is held until someone reclaims; this counter
      // lets tests assert the drop explicitly.
      result.dropped_no_handler++
      continue
    }
    // Best-effort sender displayName prefetch. Fire-and-forget: the first
    // message from a brand-new user misses (prefetch is still in flight
    // when buildEnrichment runs); subsequent messages hit the cache.
    if (deps.displayNames) {
      const uid = ev.source?.userId
      const src = ev.source?.type
      const chat = chatIdOf(ev)
      if (uid && src && chat) void deps.displayNames.prefetch(uid, src, chat)
    }

    const frame: InboundFrame = { type: 'inbound', event: ev }
    const enrichment = buildEnrichment(ev, deps)
    if (enrichment) frame.enrichment = enrichment
    const sent = deps.registry.send(handler, frame)
    if (sent) result.routed_to_handler++
    else result.dropped_no_handler++
  }

  return result
}

function chatIdOf(ev: LineMessageEvent): string | null {
  const src = ev.source
  if (!src) return null
  return src.groupId ?? src.roomId ?? src.userId ?? null
}

/**
 * Build the inbound-frame enrichment: only populated when the event has
 * `message.quotedMessageId` and we have a way to resolve it. Two
 * signals, strongest first:
 *   - `quoted_is_bot_sent` — the id is in SentIdSet (we sent it via
 *     this gateway instance), so it's definitely a reply to the bot
 *   - `quoted_absent_from_archive` — the id is not in our inbound
 *     archive; with archive being a user-only log, absence is a
 *     reasonable proxy for "must be a bot message". Weaker signal
 *     because the archive is bounded by when gateway started
 */
function buildEnrichment(
  ev: LineMessageEvent,
  deps: WebhookDeps,
): InboundFrame['enrichment'] | undefined {
  const enr: NonNullable<InboundFrame['enrichment']> = {}

  // --- Quote-reply enrichment (pre-existing) --------------------------------
  const quoted = ev.message?.quotedMessageId
  if (typeof quoted === 'string' && quoted.length > 0) {
    enr.quoted_message_id = quoted
    if (deps.sentIds) enr.quoted_is_bot_sent = deps.sentIds.has(quoted)

    if (deps.db) {
      const row = getMessageById(deps.db, quoted)
      enr.quoted_absent_from_archive = row === null
      if (row) {
        if (row.sender_user_id) enr.quoted_user = row.sender_user_id
        if (row.received_at)    enr.quoted_ts   = row.received_at
        enr.quoted_type = row.message_type
        enr.quoted_text = renderQuotedPreview(row.message_type, row.text, row.raw_json)
      }
    }
  }

  // --- Sender display-name enrichment (new) ---------------------------------
  // Cache hit attaches the name; miss stays silent and the background
  // prefetch (kicked off in dispatch above) will populate next time.
  if (deps.displayNames) {
    const uid = ev.source?.userId
    if (uid) {
      const name = deps.displayNames.get(uid)
      if (name) enr.user_name = name
    }
  }

  return Object.keys(enr).length > 0 ? enr : undefined
}

function renderQuotedPreview(type: string, text: string | null, rawJson: string): string {
  if (type === 'text') return text ?? ''
  if (type === 'file') {
    try {
      const raw = JSON.parse(rawJson) as { message?: { fileName?: unknown } }
      const name = typeof raw.message?.fileName === 'string' ? raw.message.fileName : null
      return name ? `[file: ${name}]` : '[file]'
    } catch { return '[file]' }
  }
  return '[' + type + ']'
}

function tryPermissionReply(ev: LineMessageEvent, deps: WebhookDeps): boolean {
  if (ev.type !== 'message') return false
  if (ev.message?.type !== 'text') return false
  const src = ev.source
  if (!src || src.type !== 'user' || !src.userId) return false
  const owner = deps.primaryOwner()
  if (!owner || src.userId !== owner) return false

  const text = ev.message.text ?? ''
  const m = PERMISSION_REPLY_RE.exec(text)
  if (!m) return false

  const request_id = m[2]!.toLowerCase()
  const behavior: 'allow' | 'deny' = m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
  const target_cc = deps.permissions.pop(request_id)
  if (!target_cc) {
    // Owner replied for a request we don't know about (expired /
    // already resolved / other gateway instance). Swallow silently —
    // don't leak "y abcde" into the chat.
    return true
  }
  deps.registry.send(target_cc, {
    type: 'permission_reply',
    request_id,
    behavior,
  })
  return true
}
