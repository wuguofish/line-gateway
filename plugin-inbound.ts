/**
 * Shape a raw LINE webhook event into the `notifications/claude/channel`
 * notification the Claude Code channel plugin expects.
 *
 * Keeps formatting pure so behavior is unit-tested without the MCP
 * transport — the plugin takes this result and hands it to
 * `mcp.notification()`.
 */

import type { LineMessageEvent, InboundEnrichment } from './plugin-access'

export interface ChannelMeta {
  chat_id: string
  message_id: string
  user: string
  user_name?: string
  ts: string
  source_type: 'user' | 'group' | 'room'
  /**
   * Quote token for quoting THIS message in a later reply. Pass it back as
   * reply(quote_token: ...) so the reply renders with a quote box — useful
   * in busy groups to show which message is being answered. quoteTokens
   * never expire and are reusable within the same chat.
   */
  quote_token?: string
  /**
   * Quoted-message attributes. Only populated when the event carries a
   * quotedMessageId AND gateway resolved it from the archive. Claude
   * Code's channel plugin lifts meta keys into the `<channel>` tag's
   * XML attributes, so these surface directly in the model's context.
   */
  quoted_message_id?: string
  quoted_user?: string
  quoted_ts?: string
  quoted_type?: string
  quoted_text?: string
  /**
   * Present when the quoted message was one image of a multi-image LINE
   * "album" share, rendered as `"<index>/<total>"` (e.g. `"2/5"`) — a total
   * above 1 is the signal there are more images than this one to look at.
   * Call get_content(message_id) with quoted_message_id (or any other
   * member's id) to retrieve the whole set in one call.
   *
   * MUST stay a string. Claude Code's channel host lifts every meta key
   * into the `<channel>` tag's XML attributes, and a non-string value makes
   * it drop the whole notification silently — no error back to the plugin,
   * the message simply never reaches the model. Shipping this pair as
   * numbers (2026-07-18) swallowed every quote-reply to an album member
   * until 2026-07-27; every other meta field is a string for the same
   * reason. Don't add a numeric one.
   */
  quoted_image_set?: string
}

export interface ChannelNotification {
  content: string
  meta: ChannelMeta
}

export interface FormatInboundDeps {
  /**
   * Gateway-supplied archive lookup for the quoted message. The gateway
   * typically populates this from its SQLite archive (see webhook.ts
   * buildEnrichment); callers pass it through transparently.
   */
  enrichment?: InboundEnrichment
  /** Display-name lookup; returns null for unknown/new senders. */
  displayName?: (userId: string, sourceType: 'user' | 'group' | 'room', sourceId: string) => string | null
  /** Clock override for tests. */
  now?: () => Date
}

/**
 * Surface LINE inline (purchased / sticon) emojis as `[EMOJI:productId/emojiId]`
 * tags inside the user-visible text. Each LINE webhook `emojis[]` entry
 * marks a UTF-16 substring of `text` (e.g. `(love)`) that LINE renders
 * as an emoji image; replacing those placeholders gives Claude a stable,
 * descriptive token plus the ids needed to fetch the image via
 * `get_emoji(productId, emojiId)`.
 *
 * Replaces from highest index downward so earlier replacements don't
 * shift later indexes.
 */
export function replaceEmojiPlaceholders(
  text: string,
  emojis?: Array<{ index?: number; length?: number; productId?: string; emojiId?: string }>,
): string {
  if (!emojis || emojis.length === 0) return text
  const sorted = [...emojis].sort((a, b) => (b.index ?? 0) - (a.index ?? 0))
  let result = text
  for (const e of sorted) {
    if (typeof e.index !== 'number' || typeof e.length !== 'number') continue
    if (!e.productId || !e.emojiId) continue
    if (e.index < 0 || e.index + e.length > result.length) continue
    result = result.slice(0, e.index) + `[EMOJI:${e.productId}/${e.emojiId}]` + result.slice(e.index + e.length)
  }
  return result
}

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

/**
 * Returns null when the event doesn't carry enough information to form a
 * channel notification (e.g. follow events, missing source). Plugin
 * callers should skip those quietly.
 */
export function formatInbound(
  event: LineMessageEvent,
  deps: FormatInboundDeps = {},
): ChannelNotification | null {
  if (event.type !== 'message') return null
  const src = event.source
  const msg = event.message
  if (!src || !src.type || !msg?.id) return null

  const chat_id = src.type === 'user' ? (src.userId ?? '')
                : src.type === 'group' ? (src.groupId ?? '')
                : (src.roomId ?? '')
  if (!chat_id) return null

  const ts = event.timestamp
    ? toTaipeiISOString(new Date(event.timestamp))
    : toTaipeiISOString(deps.now ? deps.now() : new Date())

  const msgType = msg.type ?? 'unknown'
  let content: string
  if (msgType === 'text') {
    const raw = typeof msg.text === 'string' ? msg.text : ''
    content = replaceEmojiPlaceholders(raw, msg.emojis)
  } else if (msgType === 'file') {
    const fname = (msg as any).fileName ?? 'unknown'
    const fsize = typeof (msg as any).fileSize === 'number'
      ? ' (' + Math.round((msg as any).fileSize / 1024) + ' KB)'
      : ''
    content = '[FILE: ' + fname + fsize + ' — call get_content(message_id: "' + msg.id + '") to download]'
  } else {
    content = '[' + msgType.toUpperCase() + ' — call get_content(message_id: "' + msg.id + '") to view]'
  }

  const userId = src.userId ?? ''
  // Sender display name: prefer gateway-side cache (enrichment.user_name)
  // since plugin has no LINE token to look it up itself. `deps.displayName`
  // is kept as a test fallback / future extension point.
  const user_name = (deps.enrichment?.user_name)
    ?? (userId && deps.displayName
        ? deps.displayName(userId, src.type, chat_id) ?? undefined
        : undefined)

  const meta: ChannelMeta = {
    chat_id,
    message_id: msg.id,
    user: userId,
    user_name,
    ts,
    source_type: src.type,
  }

  // quoteToken for quoting this very message in a later reply.
  if (typeof msg.quoteToken === 'string' && msg.quoteToken) meta.quote_token = msg.quoteToken

  // Pull quoted-message context in from gateway enrichment when present.
  // We still set quoted_message_id even if gateway couldn't resolve the
  // body, so the model can decide to call fetch_messages if it matters.
  const enr = deps.enrichment
  if (enr?.quoted_message_id) {
    meta.quoted_message_id = enr.quoted_message_id
    if (enr.quoted_user) meta.quoted_user = enr.quoted_user
    if (enr.quoted_ts)   meta.quoted_ts   = enr.quoted_ts
    if (enr.quoted_type) meta.quoted_type = enr.quoted_type
    if (typeof enr.quoted_text === 'string') meta.quoted_text = enr.quoted_text
    // Rendered as a string on purpose — see ChannelMeta.quoted_image_set.
    if (typeof enr.quoted_image_set_total === 'number') {
      meta.quoted_image_set = typeof enr.quoted_image_set_index === 'number'
        ? enr.quoted_image_set_index + '/' + enr.quoted_image_set_total
        : '?/' + enr.quoted_image_set_total
    }
  }

  return { content, meta }
}

/**
 * Format a gateway catch-up notice (see CatchupNoticeFrame) as a channel
 * notification. Reuses the same `notifications/claude/channel` method the
 * host actually surfaces to the model (there is no separate "system"
 * notification capability registered) — so the content itself has to make
 * clear this isn't a real chat message: a synthetic chat_id/user that
 * can't be replied to by mistake, plus explicit instructions in the text.
 */
export function formatCatchupNotice(notice: { since: string; gap_ms: number; count: number }): ChannelNotification {
  const seconds = Math.round(notice.gap_ms / 1000)
  return {
    content:
      '[GATEWAY] Your connection to LINE was down for ~' + seconds + 's (since ' + notice.since + '). ' +
      notice.count + ' message(s) arrived during that window and were archived but never pushed to you — ' +
      'call fetch_messages(since: "' + notice.since + '") to review them. This is a system notice, not a chat message; do not reply to it.',
    meta: {
      chat_id: '__gateway_system__',
      message_id: 'catchup-' + notice.since,
      user: 'gateway',
      ts: notice.since,
      source_type: 'user',
    },
  }
}

/**
 * Format the "lost the automatic handler-claim race" system notice (see
 * GatewayClient's onAutoClaimFailed). Same reasoning as
 * formatCatchupNotice on why this rides `notifications/claude/channel`
 * with a synthetic sender instead of a dedicated method.
 */
export function formatAutoClaimFailedNotice(
  info: { reason?: string; previous_handler: string | null },
  deps: { now?: () => Date } = {},
): ChannelNotification {
  const ts = toTaipeiISOString(deps.now ? deps.now() : new Date())
  const holder = info.previous_handler ? `session "${info.previous_handler}"` : 'another session'
  return {
    content:
      '[GATEWAY] You reconnected to line-gateway but did NOT become the LINE handler — ' +
      holder + ' currently holds the seat' + (info.reason ? ` (${info.reason})` : '') + '. ' +
      'You will not receive inbound LINE messages until you claim it. If you are the intended ' +
      'operator right now, call claim_handler(force: true) to take over. If another duty session ' +
      'legitimately owns it, no action needed. This is a system notice, not a chat message; do not reply to it.',
    meta: {
      chat_id: '__gateway_system__',
      message_id: 'autoclaim-failed-' + ts,
      user: 'gateway',
      ts,
      source_type: 'user',
    },
  }
}

/**
 * Build the permission-request body delivered via LINE Push API with
 * Allow/Deny quick-reply buttons. Enforces LINE's 5000-char per-message
 * limit; truncates `input_preview` to fit and appends an ellipsis.
 */
export function formatPermissionBody(params: {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}): string {
  const header = '🔐 Permission: ' + params.tool_name + '\n\n' + params.description + '\n\nInput:\n'
  const footer = '\n\nReply "y ' + params.request_id + '" to allow, "n ' + params.request_id + '" to deny.'
  const budget = 5000 - header.length - footer.length
  const inputText = params.input_preview.length > budget
    ? params.input_preview.slice(0, Math.max(0, budget - 1)) + '…'
    : params.input_preview
  return (header + inputText + footer).slice(0, 5000)
}
