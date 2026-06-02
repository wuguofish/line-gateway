/**
 * LINE Messaging API client — pure functions, no global state.
 *
 * Every call takes an explicit `token` so the daemon can (in theory) later
 * support multiple LINE channels. Reply-token caching is kept in a
 * separate `ReplyTokenCache` instance so it can be injected from tests.
 *
 * All outbound HTTP uses `fetchWithTimeout` to guarantee we never hang
 * the gateway when LINE is flaky.
 */

const LINE_API = 'https://api.line.me/v2/bot'
const LINE_DATA_API = 'https://api-data.line.me/v2/bot'

const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const DEFAULT_REPLY_TOKEN_TTL_MS = 30_000

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Emit the LINE response body to stderr for operator debug, but return a
// scrubbed one-line string to the caller — bodies can contain token
// fragments and we don't want them surfacing up to Claude's context.
export async function lineErrorSummary(res: Response, endpoint: string): Promise<string> {
  let body = ''
  try { body = await res.text() } catch {}
  process.stderr.write(`line-gateway: ${endpoint} failed: ${res.status} ${body}\n`)
  return `${endpoint} failed: HTTP ${res.status}`
}

// --- splitText --------------------------------------------------------------

export type ChunkMode = 'length' | 'newline'

export function splitText(text: string, limit: number, mode: ChunkMode): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para  = rest.lastIndexOf('\n\n', limit)
      const line  = rest.lastIndexOf('\n',   limit)
      const space = rest.lastIndexOf(' ',    limit)
      const best = para  >= 0 ? para
                 : line  >= 0 ? line
                 : space >= 0 ? space
                 : -1
      cut = best > 0 ? best : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// --- SentIdSet --------------------------------------------------------------

export interface SentIdSetOptions {
  /** Upper bound before FIFO eviction. Default 500. */
  max?: number
}

/**
 * Bounded LRU-ish set of LINE message ids sent by this gateway instance,
 * populated from `sentMessages[]` in Reply/Push API responses.
 *
 * Purpose: tell "user replied to a bot message" apart from "user replied
 * to another user's message". The webhook-only archive can tell the
 * second case by absence (quoted id not in DB → likely bot), but that's
 * imprecise after a restart. SentIdSet gives a precise positive signal.
 *
 * Insertion order is preserved in Map; evicting the oldest keeps the
 * working set recent without heap growth.
 */
export class SentIdSet {
  private readonly ids = new Map<string, true>()
  private readonly max: number

  constructor(opts: SentIdSetOptions = {}) {
    this.max = opts.max ?? 500
  }

  has(id: string): boolean { return this.ids.has(id) }

  add(id: string): void {
    if (this.ids.has(id)) { this.ids.delete(id); this.ids.set(id, true); return }
    this.ids.set(id, true)
    while (this.ids.size > this.max) {
      const first = this.ids.keys().next().value
      if (first) this.ids.delete(first)
      else break
    }
  }

  size(): number { return this.ids.size }

  /** Best-effort extraction of message ids from a Reply/Push API response body. */
  recordFromResponseText(body: string): void {
    try {
      const parsed = JSON.parse(body) as { sentMessages?: Array<{ id?: unknown }> }
      const arr = parsed.sentMessages
      if (!Array.isArray(arr)) return
      for (const m of arr) {
        if (typeof m?.id === 'string' && m.id.length > 0) this.add(m.id)
      }
    } catch { /* ignore malformed response bodies */ }
  }
}

// --- ReplyTokenCache --------------------------------------------------------

export interface ReplyTokenCacheOptions {
  ttlMs?: number
  now?: () => number
}

export class ReplyTokenCache {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts: ReplyTokenCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_REPLY_TOKEN_TTL_MS
    this.now = opts.now ?? (() => Date.now())
  }

  store(chatId: string, token: string): void {
    this.tokens.set(chatId, { token, expiresAt: this.now() + this.ttlMs })
  }

  /** Consume + delete. Returns null on miss or expired. */
  consume(chatId: string): string | null {
    const entry = this.tokens.get(chatId)
    if (!entry) return null
    this.tokens.delete(chatId)
    if (entry.expiresAt <= this.now()) return null
    return entry.token
  }

  /** Peek without consuming; returns null if expired. */
  peek(chatId: string): string | null {
    const entry = this.tokens.get(chatId)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(chatId)
      return null
    }
    return entry.token
  }

  size(): number {
    return this.tokens.size
  }
}

// --- Low-level POST helpers -------------------------------------------------

async function postLineJson(
  endpoint: string,
  body: unknown,
  token: string,
): Promise<Response> {
  return fetchWithTimeout(LINE_API + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
  })
}

// --- Reply / Push -----------------------------------------------------------

export interface TextSendOptions {
  chunkLimit: number
  chunkMode: ChunkMode
  /**
   * Optional cache to consult for a fresh reply token. When provided and
   * a non-expired token exists for chatId, the first batch is sent via
   * Reply API (free), and any remaining chunks fall back to Push.
   */
  replyTokens?: ReplyTokenCache
  /**
   * Optional set that records LINE-assigned message ids for every
   * successful send — used to recognise later webhook replies to the
   * bot's own messages.
   */
  sentIds?: SentIdSet
  /**
   * Quote-reply: quoteToken of the message to quote. Attached to the first
   * chunk only. quoteTokens never expire and are reusable, scoped to the
   * chat the quoted message belongs to.
   */
  quoteToken?: string
  /**
   * When non-empty, the message is sent as a textV2 that @-mentions these
   * userIds (single message, not chunked). Combinable with quoteToken.
   */
  mentionUserIds?: string[]
}

export interface TextSendResult {
  method: 'reply' | 'push' | 'mixed'
  chunks: number
}

/**
 * Preferred path: Reply API (free, token expires in 30s). Falls through
 * to Push API (counts quota) when no token or reply fails.
 *
 * Returns `mixed` when first ≤5 chunks went via reply and the remainder
 * via push — this happens for very long texts.
 */
export async function sendTextReplyPreferred(
  chatId: string,
  text: string,
  token: string,
  opts: TextSendOptions,
): Promise<TextSendResult> {
  // Mention path: textV2 single message (not chunked). quoteToken is carried
  // on the textV2 message itself.
  if (opts.mentionUserIds && opts.mentionUserIds.length > 0) {
    return sendSingleMessageReplyPreferred(
      chatId,
      buildMentionUserMessage(text, opts.mentionUserIds, opts.quoteToken),
      token,
      opts,
    )
  }

  const chunks = splitText(text, opts.chunkLimit, opts.chunkMode)
  const replyToken = opts.replyTokens?.consume(chatId) ?? null

  if (replyToken !== null) {
    const firstBatch = textMessages(chunks.slice(0, 5), opts.quoteToken)
    const res = await postLineJson('/message/reply', {
      replyToken,
      messages: firstBatch,
    }, token)
    if (res.ok) {
      if (opts.sentIds) {
        try { opts.sentIds.recordFromResponseText(await res.clone().text()) } catch {}
      }
      if (chunks.length > 5) {
        // Best-effort push of the tail. If this fails, surface an error —
        // caller decides how to message the user about the partial send.
        // No quoteToken on the tail — the quote already rode the first chunk.
        try {
          await pushText(chatId, chunks.slice(5).join('\n'), token, { ...opts, quoteToken: undefined })
        } catch (pushErr) {
          throw new Error(
            'partial send: first chunks delivered via Reply API, ' +
            'but push of remaining chunks failed: ' + (pushErr instanceof Error ? pushErr.message : String(pushErr)),
          )
        }
        return { method: 'mixed', chunks: chunks.length }
      }
      return { method: 'reply', chunks: chunks.length }
    }
    // Reply API rejected our token (expired / replayed) — log and fall through.
    await lineErrorSummary(res, 'LINE reply')
  }

  // Whole message via Push — quoteToken (if any) rides the first chunk.
  await pushText(chatId, text, token, opts)
  return { method: 'push', chunks: chunks.length }
}

export async function pushText(
  to: string,
  text: string,
  token: string,
  opts: { chunkLimit: number; chunkMode: ChunkMode; sentIds?: SentIdSet; quoteToken?: string },
): Promise<void> {
  const chunks = splitText(text, opts.chunkLimit, opts.chunkMode)
  // LINE allows up to 5 messages per push call.
  for (let i = 0; i < chunks.length; i += 5) {
    // quoteToken only on the very first message of the very first batch.
    const batch = textMessages(chunks.slice(i, i + 5), i === 0 ? opts.quoteToken : undefined)
    const res = await postLineJson('/message/push', { to, messages: batch }, token)
    if (!res.ok) throw new Error(await lineErrorSummary(res, 'LINE push'))
    if (opts.sentIds) {
      try { opts.sentIds.recordFromResponseText(await res.clone().text()) } catch {}
    }
  }
}

// --- textV2 mentions --------------------------------------------------------
//
// LINE text message (v2) lets a placeholder enclosed in {} be substituted by
// a mention. A mention (user-specific or "all") pushes a notification to the
// target, even to members who muted the chat (as long as they kept the
// per-member "notify when mentioned" setting on). Only meaningful in
// groups/rooms — a 1:1 chat has no other members.

/** Hard cap for a single textV2 mention message. Mention sends aren't chunked. */
export const MENTION_ALL_MAX_LEN = 5000
/** LINE allows at most 20 mentionees in one message. */
export const MAX_MENTIONS = 20

const USER_ID_RE = /^U[0-9a-f]{32}$/

type MentionTarget = { type: 'all' } | { type: 'user'; userId: string }

export interface TextV2MentionMessage {
  type: 'textV2'
  text: string
  substitution: Record<string, { type: 'mention'; mentionee: MentionTarget }>
  quoteToken?: string
}

// textV2 reserves `{` and `}` for placeholders. LINE documents no escape this
// gateway can rely on, so rather than risk silently mangling the message we
// reject any caller text containing them.
function assertNoBraces(text: string): void {
  if (text.includes('{') || text.includes('}')) {
    throw new Error(
      'reply: text must not contain "{" or "}" — textV2 reserves them for ' +
      'substitution placeholders and LINE documents no escape for literal braces',
    )
  }
}

function assertMentionLen(full: string): void {
  if (full.length > MENTION_ALL_MAX_LEN) {
    throw new Error(
      `reply: message too long (${full.length} > ${MENTION_ALL_MAX_LEN} chars); ` +
      'mention messages are not auto-chunked',
    )
  }
}

/**
 * Build a textV2 message that mentions all members — `{everyone} ` is
 * prepended to the caller's text. Pure + throwing, so it is unit-testable
 * without hitting the network.
 */
export function buildMentionAllMessage(text: string, quoteToken?: string): TextV2MentionMessage {
  assertNoBraces(text)
  const full = '{everyone} ' + text
  assertMentionLen(full)
  const msg: TextV2MentionMessage = {
    type: 'textV2',
    text: full,
    substitution: { everyone: { type: 'mention', mentionee: { type: 'all' } } },
  }
  if (quoteToken) msg.quoteToken = quoteToken
  return msg
}

/**
 * Build a textV2 message that mentions specific users. `{m0} {m1} ... ` is
 * prepended to the caller's text, one placeholder per userId. Rejects an
 * empty / oversized id list and malformed userIds.
 */
export function buildMentionUserMessage(
  text: string,
  userIds: string[],
  quoteToken?: string,
): TextV2MentionMessage {
  if (userIds.length === 0) throw new Error('reply: mention_user_ids must not be empty')
  if (userIds.length > MAX_MENTIONS) {
    throw new Error(`reply: at most ${MAX_MENTIONS} mentions per message (got ${userIds.length})`)
  }
  for (const uid of userIds) {
    if (!USER_ID_RE.test(uid)) {
      throw new Error(`reply: invalid mention userId "${uid}" (expected "U" + 32 hex chars)`)
    }
  }
  assertNoBraces(text)
  const placeholders = userIds.map((_, i) => '{m' + i + '}').join(' ')
  const full = placeholders + ' ' + text
  assertMentionLen(full)
  const substitution: TextV2MentionMessage['substitution'] = {}
  userIds.forEach((uid, i) => {
    substitution['m' + i] = { type: 'mention', mentionee: { type: 'user', userId: uid } }
  })
  const msg: TextV2MentionMessage = { type: 'textV2', text: full, substitution }
  if (quoteToken) msg.quoteToken = quoteToken
  return msg
}

/**
 * Build the `{type:'text'}` message array for a set of chunks, attaching an
 * optional quoteToken to the FIRST chunk only (LINE quotes one message).
 * Pure — unit-tested without the network.
 */
export function textMessages(
  chunks: string[],
  quoteToken?: string,
): Array<{ type: 'text'; text: string; quoteToken?: string }> {
  return chunks.map((t, i) =>
    i === 0 && quoteToken
      ? { type: 'text', text: t, quoteToken }
      : { type: 'text', text: t },
  )
}

/**
 * Send a single pre-built message object. Reply API first (free, token
 * expires in 30s), falling through to Push. Shared by mention sends.
 */
async function sendSingleMessageReplyPreferred(
  chatId: string,
  message: unknown,
  token: string,
  opts: { replyTokens?: ReplyTokenCache; sentIds?: SentIdSet },
): Promise<TextSendResult> {
  const replyToken = opts.replyTokens?.consume(chatId) ?? null
  if (replyToken !== null) {
    const res = await postLineJson('/message/reply', { replyToken, messages: [message] }, token)
    if (res.ok) {
      if (opts.sentIds) { try { opts.sentIds.recordFromResponseText(await res.clone().text()) } catch {} }
      return { method: 'reply', chunks: 1 }
    }
    await lineErrorSummary(res, 'LINE reply (textV2)')
  }
  const res = await postLineJson('/message/push', { to: chatId, messages: [message] }, token)
  if (!res.ok) throw new Error(await lineErrorSummary(res, 'LINE push (textV2)'))
  if (opts.sentIds) { try { opts.sentIds.recordFromResponseText(await res.clone().text()) } catch {} }
  return { method: 'push', chunks: 1 }
}

/**
 * Send an @all mention to a group/room. Single message (not chunked).
 */
export async function sendMentionAllReplyPreferred(
  chatId: string,
  text: string,
  token: string,
  opts: { replyTokens?: ReplyTokenCache; sentIds?: SentIdSet; quoteToken?: string } = {},
): Promise<TextSendResult> {
  return sendSingleMessageReplyPreferred(chatId, buildMentionAllMessage(text, opts.quoteToken), token, opts)
}

// --- Permission push --------------------------------------------------------

/**
 * Push a Claude-Code permission request with Allow / Deny quick-reply
 * buttons. The quick-reply text `y <id>` / `n <id>` is what the primary
 * owner's device types back on tap — the gateway's webhook dispatcher
 * intercepts those and forwards `permission_reply` frames to the
 * originating plugin. Not chunked — caller keeps body ≤ 5000 chars.
 */
export async function pushPermission(
  to: string,
  body: string,
  requestId: string,
  token: string,
  sentIds?: SentIdSet,
): Promise<void> {
  const message = {
    type: 'text',
    text: body,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '✅ Allow', text: 'y ' + requestId } },
        { type: 'action', action: { type: 'message', label: '❌ Deny',  text: 'n ' + requestId } },
      ],
    },
  }
  const res = await postLineJson('/message/push', { to, messages: [message] }, token)
  if (!res.ok) throw new Error(await lineErrorSummary(res, 'LINE push (permission)'))
  if (sentIds) {
    try { sentIds.recordFromResponseText(await res.clone().text()) } catch {}
  }
}

// --- sendImage --------------------------------------------------------------

export async function sendImage(
  to: string,
  originalUrl: string,
  previewUrl: string,
  token: string,
  sentIds?: SentIdSet,
): Promise<void> {
  const res = await postLineJson('/message/push', {
    to,
    messages: [{ type: 'image', originalContentUrl: originalUrl, previewImageUrl: previewUrl }],
  }, token)
  if (!res.ok) throw new Error(await lineErrorSummary(res, 'send_image'))
  if (sentIds) {
    try { sentIds.recordFromResponseText(await res.clone().text()) } catch {}
  }
}

// --- markAsRead -------------------------------------------------------------

export async function markAsRead(markAsReadToken: string, token: string): Promise<void> {
  try {
    const res = await postLineJson('/chat/markAsRead', { markAsReadToken }, token)
    if (!res.ok) process.stderr.write('line-gateway: markAsRead failed: ' + res.status + '\n')
  } catch (e) {
    process.stderr.write('line-gateway: markAsRead error: ' + e + '\n')
  }
}

// --- get_content (download binary) ------------------------------------------

export interface GetContentStream {
  contentType: string
  contentLength: number
  body: ReadableStream<Uint8Array>
}

/**
 * Kick off a binary download. Returns a stream so the caller can pipe to
 * disk without buffering the whole payload in memory. Throws on !ok.
 */
export async function getContentStream(messageId: string, token: string): Promise<GetContentStream> {
  if (!/^\d{1,32}$/.test(messageId)) {
    throw new Error('get_content: invalid message_id (must be numeric LINE message ID)')
  }
  const res = await fetchWithTimeout(
    LINE_DATA_API + '/message/' + encodeURIComponent(messageId) + '/content',
    { headers: { Authorization: 'Bearer ' + token } },
  )
  if (!res.ok) throw new Error(await lineErrorSummary(res, 'get_content'))
  const body = res.body
  if (!body) throw new Error('get_content: response body was null')
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  return { contentType, contentLength, body }
}

// Public sticker CDN — not in LINE's official docs but the URL format has
// been stable for years and does not require a bearer token. Used for
// inbound sticker messages, whose binary is NOT exposed by the Messaging
// API's /message/{id}/content endpoint (that returns 400 for stickers).
const LINE_STICKER_CDN = 'https://stickershop.line-scdn.net/stickershop/v1/sticker'

export interface GetStickerOptions {
  /** Injected fetcher for tests. Defaults to {@link fetchWithTimeout}. */
  fetcher?: typeof fetch
}

/**
 * Fetch the static PNG for a sticker id. Animated / popup stickers have
 * richer resource types but a static frame is enough for a vision model
 * to recognise the sticker — richer variants can be added later if
 * needed.
 */
export async function getStickerImageStream(
  stickerId: string,
  opts: GetStickerOptions = {},
): Promise<GetContentStream> {
  if (!/^\d{1,20}$/.test(stickerId)) {
    throw new Error('get_sticker: invalid stickerId (must be numeric)')
  }
  const url = LINE_STICKER_CDN + '/' + encodeURIComponent(stickerId) + '/android/sticker.png'
  const fetcher = opts.fetcher ?? ((u: string | URL, init?: RequestInit) => fetchWithTimeout(u, init))
  const res = await fetcher(url)
  if (!res.ok) throw new Error(await lineErrorSummary(res, 'get_sticker'))
  const body = res.body
  if (!body) throw new Error('get_sticker: response body was null')
  const contentType = res.headers.get('content-type') ?? 'image/png'
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  return { contentType, contentLength, body }
}

// LINE inline emoji CDN — public, no token required. Same project family
// as the sticker CDN and similarly stable.
const LINE_EMOJI_CDN = 'https://stickershop.line-scdn.net/sticonshop/v1/sticon'

export interface GetEmojiOptions {
  /** Injected fetcher for tests. Defaults to {@link fetchWithTimeout}. */
  fetcher?: typeof fetch
}

/**
 * Fetch the static PNG for a LINE inline (purchased / sticon) emoji.
 * `productId` identifies the emoji set (24 lowercase hex chars in
 * LINE's catalogue), `emojiId` the entry inside that set.
 */
export async function getEmojiImageStream(
  productId: string,
  emojiId: string,
  opts: GetEmojiOptions = {},
): Promise<GetContentStream> {
  if (!/^[a-f0-9]{24}$/.test(productId)) {
    throw new Error('get_emoji: invalid productId (expected 24 lowercase hex chars)')
  }
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(emojiId)) {
    throw new Error('get_emoji: invalid emojiId')
  }
  const url = LINE_EMOJI_CDN + '/' + encodeURIComponent(productId) + '/iPhone/' + encodeURIComponent(emojiId) + '.png'
  const fetcher = opts.fetcher ?? ((u: string | URL, init?: RequestInit) => fetchWithTimeout(u, init))
  const res = await fetcher(url)
  if (!res.ok) throw new Error(await lineErrorSummary(res, 'get_emoji'))
  const body = res.body
  if (!body) throw new Error('get_emoji: response body was null')
  const contentType = res.headers.get('content-type') ?? 'image/png'
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  return { contentType, contentLength, body }
}

// --- Profile lookup ---------------------------------------------------------
//
// LINE profile endpoints return `{displayName, userId, pictureUrl, statusMessage}`.
// For 1-to-1 DMs the sender profile is always readable via /profile/{userId}.
// For group / room messages the bot must query the group-scoped endpoint;
// this also honours per-group display-name overrides a member may set.

export interface LineProfile {
  displayName: string
  userId: string
  pictureUrl?: string
  statusMessage?: string
}

export interface FetchProfileOptions {
  /** Injected fetcher for tests. Defaults to {@link fetchWithTimeout}. */
  fetcher?: typeof fetch
}

export async function getProfile(
  userId: string,
  token: string,
  opts: FetchProfileOptions = {},
): Promise<LineProfile | null> {
  if (!/^U[0-9a-f]{32}$/.test(userId)) return null
  const fetcher = opts.fetcher ?? ((u: string | URL, init?: RequestInit) => fetchWithTimeout(u, init))
  const res = await fetcher(LINE_API + '/profile/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + token },
  })
  // 404 is a normal "bot isn't friended by this user" response — don't
  // treat that as an error to log, just return null so the cache can
  // skip them without noisy stderr.
  if (res.status === 404) return null
  if (!res.ok) {
    await lineErrorSummary(res, 'get_profile')
    return null
  }
  try {
    const body = await res.json() as Partial<LineProfile>
    if (typeof body.displayName !== 'string' || typeof body.userId !== 'string') return null
    return body as LineProfile
  } catch {
    return null
  }
}

export async function getGroupMemberProfile(
  groupId: string,
  userId: string,
  token: string,
  opts: FetchProfileOptions = {},
): Promise<LineProfile | null> {
  if (!/^C[0-9a-f]{32}$/.test(groupId)) return null
  if (!/^U[0-9a-f]{32}$/.test(userId)) return null
  const fetcher = opts.fetcher ?? ((u: string | URL, init?: RequestInit) => fetchWithTimeout(u, init))
  const res = await fetcher(
    LINE_API + '/group/' + encodeURIComponent(groupId) + '/member/' + encodeURIComponent(userId),
    { headers: { Authorization: 'Bearer ' + token } },
  )
  if (res.status === 404) return null
  if (!res.ok) {
    await lineErrorSummary(res, 'get_group_member_profile')
    return null
  }
  try {
    const body = await res.json() as Partial<LineProfile>
    if (typeof body.displayName !== 'string' || typeof body.userId !== 'string') return null
    return body as LineProfile
  } catch {
    return null
  }
}

export async function getRoomMemberProfile(
  roomId: string,
  userId: string,
  token: string,
  opts: FetchProfileOptions = {},
): Promise<LineProfile | null> {
  if (!/^R[0-9a-f]{32}$/.test(roomId)) return null
  if (!/^U[0-9a-f]{32}$/.test(userId)) return null
  const fetcher = opts.fetcher ?? ((u: string | URL, init?: RequestInit) => fetchWithTimeout(u, init))
  const res = await fetcher(
    LINE_API + '/room/' + encodeURIComponent(roomId) + '/member/' + encodeURIComponent(userId),
    { headers: { Authorization: 'Bearer ' + token } },
  )
  if (res.status === 404) return null
  if (!res.ok) {
    await lineErrorSummary(res, 'get_room_member_profile')
    return null
  }
  try {
    const body = await res.json() as Partial<LineProfile>
    if (typeof body.displayName !== 'string' || typeof body.userId !== 'string') return null
    return body as LineProfile
  } catch {
    return null
  }
}

// --- DisplayNameCache -------------------------------------------------------
//
// In-memory cache of LINE sender displayNames, populated by fire-and-forget
// prefetch from the webhook dispatcher. `get()` is synchronous so
// `buildEnrichment` stays synchronous; the first message from any unseen
// user will miss, the prefetch then populates the cache for next time.

export type DisplayNameSource = 'user' | 'group' | 'room'

export interface DisplayNameCacheOptions {
  /** Cache entry lifetime before a re-fetch is needed. Default 1 hour. */
  ttlMs?: number
  /** Max entries before LRU eviction. Default 500. */
  maxSize?: number
  /** Clock override for tests. */
  now?: () => number
}

export interface DisplayNameFetcher {
  (userId: string, source: DisplayNameSource, chatId: string): Promise<string | null>
}

export class DisplayNameCache {
  private readonly entries = new Map<string, { name: string; expiresAt: number }>()
  private readonly inflight = new Set<string>()
  private readonly ttlMs: number
  private readonly maxSize: number
  private readonly now: () => number

  constructor(
    private readonly fetcher: DisplayNameFetcher,
    opts: DisplayNameCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000
    this.maxSize = opts.maxSize ?? 500
    this.now = opts.now ?? (() => Date.now())
  }

  /** Synchronous lookup. Returns null on miss or expired entry. */
  get(userId: string): string | null {
    const e = this.entries.get(userId)
    if (!e) return null
    if (e.expiresAt < this.now()) {
      this.entries.delete(userId)
      return null
    }
    // touch for LRU
    this.entries.delete(userId)
    this.entries.set(userId, e)
    return e.name
  }

  /**
   * Seed the cache with a known name (e.g. test fixtures, or a resolved
   * value from another path). Respects size cap + TTL.
   */
  put(userId: string, name: string): void {
    if (this.entries.size >= this.maxSize && !this.entries.has(userId)) {
      const firstKey = this.entries.keys().next().value
      if (firstKey) this.entries.delete(firstKey)
    }
    this.entries.set(userId, { name, expiresAt: this.now() + this.ttlMs })
  }

  /**
   * Fire-and-forget prefetch. No-op when the cache is already fresh or a
   * fetch for this userId is already in flight. Never throws — a failing
   * fetch silently leaves the entry absent so the caller's next miss can
   * retry.
   */
  async prefetch(userId: string, source: DisplayNameSource, chatId: string): Promise<void> {
    const existing = this.entries.get(userId)
    if (existing && existing.expiresAt > this.now()) return
    if (this.inflight.has(userId)) return
    this.inflight.add(userId)
    try {
      const name = await this.fetcher(userId, source, chatId)
      if (name) this.put(userId, name)
    } catch {
      // swallow — best-effort cache
    } finally {
      this.inflight.delete(userId)
    }
  }

  /** Test helper: how many entries currently cached. */
  size(): number { return this.entries.size }
}

/**
 * Pick out the sticker id from a persisted raw_json row. Returns null
 * when the row isn't a sticker, JSON is malformed, or stickerId is
 * missing / non-numeric — caller falls back to the normal LINE Data API
 * path in that case.
 */
export function stickerIdFromRawJson(rawJson: string): string | null {
  try {
    const parsed = JSON.parse(rawJson) as { message?: { type?: unknown; stickerId?: unknown } }
    const msg = parsed.message
    if (!msg || msg.type !== 'sticker') return null
    if (typeof msg.stickerId !== 'string') return null
    if (!/^\d{1,20}$/.test(msg.stickerId)) return null
    return msg.stickerId
  } catch {
    return null
  }
}
