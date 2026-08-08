/**
 * WSS frame definitions between line-gateway daemon and per-session plugin.
 *
 * Every frame is a single JSON object with a `type` discriminator. These
 * types are the source of truth for protocol shape; plugin and gateway
 * both import from here so drift is caught at compile time.
 *
 * See DESIGN.md for the architectural context.
 */

// --- Plugin -> Gateway ------------------------------------------------------

export interface HelloFrame {
  type: 'hello'
  cc_session_id: string
  pid: number
  plugin_version: string
}

export interface ClaimFrame {
  type: 'claim'
  /** If another plugin is currently handler, force=true displaces it. */
  force?: boolean
}

export interface ReleaseFrame {
  type: 'release'
}

export interface PingFrame {
  type: 'ping'
}

/**
 * Generic LINE-API call routed through the gateway. `method` matches the
 * MCP tool name (reply / reply_all / push / send_image / get_content /
 * upload_file / fetch_messages), with one extra virtual method
 * `push_permission` that also registers the request_id -> plugin mapping
 * for later reply routing.
 */
export interface ApiRequestFrame {
  type: 'api_request'
  req_id: string
  method:
    | 'reply'
    | 'reply_all'
    | 'push'
    | 'send_image'
    | 'get_content'
    | 'get_emoji'
    | 'upload_file'
    | 'fetch_messages'
    | 'push_permission'
  args: Record<string, unknown>
}

export type PluginToGateway =
  | HelloFrame
  | ClaimFrame
  | ReleaseFrame
  | PingFrame
  | ApiRequestFrame

// --- Gateway -> Plugin ------------------------------------------------------

export interface HelloAckFrame {
  type: 'hello_ack'
  is_handler: boolean
  current_handler: string | null
  gateway_version: string
}

export interface ClaimAckFrame {
  type: 'claim_ack'
  ok: boolean
  reason?: string
  previous_handler?: string | null
}

export interface InboundFrame {
  type: 'inbound'
  /** Raw LINE webhook event; see https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects */
  event: unknown
  /**
   * Optional server-side enrichment derived from state the plugin can't
   * see on its own — primarily "was this a quote-reply to something
   * this bot sent?" so the plugin's gate() can treat it as a mention.
   */
  enrichment?: {
    /** Present only when the event carries `message.quotedMessageId`. */
    quoted_message_id?: string
    /** True when the quoted id is in SentIdSet (bot sent it via this gateway). */
    quoted_is_bot_sent?: boolean
    /**
     * True when the quoted id is NOT present in the inbound archive — a
     * weaker signal that the quoted message is probably from the bot,
     * because the archive only stores user-sent webhook inbounds.
     */
    quoted_absent_from_archive?: boolean
    /**
     * Archive-resolved context about the quoted message. Populated only
     * when `quoted_message_id` is present AND found in the inbound
     * archive. Non-text messages are downgraded to a bracketed label
     * (e.g. `[image]`, `[sticker]`, `[file: <name>]`) so the recipient
     * can still act on the context.
     */
    quoted_user?: string
    quoted_ts?: string
    quoted_type?: string
    quoted_text?: string
    /**
     * Present when the quoted message was part of a multi-image "album"
     * share (LINE imageSet) — lets the recipient know there are more
     * images than the one being quoted, retrievable via get_content on
     * any member of the set.
     */
    quoted_image_set_index?: number
    quoted_image_set_total?: number
    /**
     * Sender's LINE displayName, resolved server-side via the gateway's
     * DisplayNameCache (TTL'd). Empty on first-ever sighting of a
     * userId; populated from the second message onward once the cache
     * prefetch has completed. Plugin surfaces this as
     * `<channel user_name="...">` so Claude doesn't need to cross-reference
     * a userId-to-name table every turn.
     */
    user_name?: string
  }
}

/**
 * Result of a primary-owner permission reply. Sent only to the plugin that
 * originally issued the push_permission api_request — Gateway keeps a
 * request_id -> connection mapping for this.
 */
export interface PermissionReplyFrame {
  type: 'permission_reply'
  request_id: string
  behavior: 'allow' | 'deny'
}

export interface PongFrame {
  type: 'pong'
}

export interface HandlerLostFrame {
  type: 'handler_lost'
  displaced_by: string | null
}

export interface ApiResponseFrame {
  type: 'api_response'
  req_id: string
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * Sent right after a successful `claim` when the claiming session was
 * previously the handler and its connection had been down long enough
 * that inbound delivery was suspended (see HandlerManager.isHandler).
 * Anything archived during that window was persisted but never pushed —
 * this tells the reconnecting session so it can `fetch_messages` instead
 * of silently missing a backlog.
 */
export interface CatchupNoticeFrame {
  type: 'catchup_notice'
  /** Taipei-offset ISO timestamp marking the start of the missed window. */
  since: string
  /** Wall-clock duration of the disconnect gap, in ms. */
  gap_ms: number
  /** Count of archived messages received during the gap. */
  count: number
}

export type GatewayToPlugin =
  | HelloAckFrame
  | ClaimAckFrame
  | InboundFrame
  | PermissionReplyFrame
  | PongFrame
  | HandlerLostFrame
  | ApiResponseFrame
  | CatchupNoticeFrame

// --- Type guards ------------------------------------------------------------

export function isFrame(x: unknown): x is { type: string } {
  return !!x && typeof x === 'object' && typeof (x as any).type === 'string'
}

export function parseFrame<T extends { type: string }>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw)
    if (isFrame(parsed)) return parsed as T
    return null
  } catch {
    return null
  }
}
