/**
 * Plugin-side access control — ported from
 * `claude-line-channel/server.ts`'s `loadAccess` + `gate`.
 *
 * The gateway doesn't filter inbound by access policy (it archives and
 * routes everything). The plugin applies the filter before injecting the
 * channel notification into Claude Code, so a drop here means Claude
 * never sees the message.
 *
 * Kept as a pure function so tests don't need a state directory.
 */

import { readFileSync, appendFileSync } from 'fs'
import { join } from 'path'

export interface GroupPolicy {
  requireMention: boolean
  allowFrom: string[]
}

export interface Access {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  mentionPatterns?: string[]
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  fullAccess?: boolean
}

const DEFAULT_ACCESS: Access = {
  dmPolicy: 'allowlist',
  allowFrom: [],
  groups: {},
}

export function loadAccess(accessFile: string): Access {
  try {
    const raw = readFileSync(accessFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy === 'disabled' ? 'disabled' : 'allowlist',
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom.filter(x => typeof x === 'string') : [],
      groups: typeof parsed.groups === 'object' && parsed.groups
        ? Object.fromEntries(
            Object.entries(parsed.groups).map(([k, v]) => [k, {
              requireMention: !!(v as any)?.requireMention,
              allowFrom: Array.isArray((v as any)?.allowFrom)
                ? (v as any).allowFrom.filter((x: any) => typeof x === 'string')
                : [],
            }]),
          )
        : {},
      mentionPatterns: Array.isArray(parsed.mentionPatterns) ? parsed.mentionPatterns as string[] : undefined,
      textChunkLimit: typeof parsed.textChunkLimit === 'number' ? parsed.textChunkLimit : undefined,
      chunkMode: parsed.chunkMode === 'length' ? 'length' : 'newline',
      fullAccess: !!parsed.fullAccess,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write('line-gateway-plugin: could not read ' + accessFile + ': ' + err + '\n')
    }
    return DEFAULT_ACCESS
  }
}

export interface LineSource {
  type: 'user' | 'group' | 'room'
  userId?: string
  groupId?: string
  roomId?: string
}

export interface LineMessageEvent {
  type: string
  timestamp?: number
  replyToken?: string
  source?: LineSource
  message?: {
    id?: string
    type?: string
    text?: string
    quotedMessageId?: string
    /** Quote token for quoting THIS message in a later reply. */
    quoteToken?: string
    mention?: {
      mentionees?: Array<{ userId?: string }>
    }
    /**
     * Inline LINE emoji (purchased / sticon set). Each entry tells you the
     * UTF-16 substring (`index`+`length`) of `text` that LINE renders as
     * an emoji image; the substring itself is a placeholder like `(emoji)`.
     */
    emojis?: Array<{
      index?: number
      length?: number
      productId?: string
      emojiId?: string
    }>
    [k: string]: unknown
  }
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop'; reason: string }

export interface InboundEnrichment {
  quoted_message_id?: string
  quoted_is_bot_sent?: boolean
  quoted_absent_from_archive?: boolean
  quoted_user?: string
  quoted_ts?: string
  quoted_type?: string
  quoted_text?: string
  /** Present when the quoted message was part of a multi-image LINE album share. */
  quoted_image_set_index?: number
  quoted_image_set_total?: number
  /** Sender's LINE displayName, resolved server-side by gateway cache. */
  user_name?: string
}

export interface GateContext {
  access: Access
  /** Bot's own user id if known — used for @mention detection. */
  botUserId?: string | null
  /**
   * Append to unknown-groups.log / unknown-dms.log. Noop-safe; loggers
   * should dedupe themselves if desired.
   */
  logUnknown?: (kind: 'dm' | 'group', id: string) => void
  /**
   * Gateway-side facts we can't derive locally: was the quoted message
   * sent by the bot, or at least absent from the inbound archive?
   * Used by `isMentioned` to treat a quote-reply as a mention even when
   * no @mention or text pattern matches.
   */
  enrichment?: InboundEnrichment
}

const UNKNOWN_RE = /^[A-Za-z0-9_-]+$/

export function gate(event: LineMessageEvent, ctx: GateContext): GateResult {
  if (event.type !== 'message') return { action: 'drop', reason: 'non-message event' }
  const src = event.source
  if (!src) return { action: 'drop', reason: 'no source' }

  const access = ctx.access
  if (access.dmPolicy === 'disabled') return { action: 'drop', reason: 'dmPolicy disabled' }

  if (src.type === 'user') {
    if (!src.userId) return { action: 'drop', reason: 'user source missing userId' }
    if (access.allowFrom.length > 0 && !access.allowFrom.includes(src.userId)) {
      if (UNKNOWN_RE.test(src.userId)) ctx.logUnknown?.('dm', src.userId)
      return { action: 'drop', reason: 'user not on allowFrom' }
    }
    return { action: 'deliver', access }
  }

  const chatId = src.type === 'group' ? src.groupId : src.roomId
  if (!chatId) return { action: 'drop', reason: 'group/room missing id' }

  const policy = access.groups[chatId]
  if (!policy) {
    if (UNKNOWN_RE.test(chatId)) ctx.logUnknown?.('group', chatId)
    return { action: 'drop', reason: 'group not in access.json' }
  }

  if (policy.allowFrom.length > 0 && (!src.userId || !policy.allowFrom.includes(src.userId))) {
    return { action: 'drop', reason: 'sender not in group allowFrom' }
  }

  if (policy.requireMention) {
    if (!isMentioned(event, access.mentionPatterns ?? [], ctx.botUserId ?? null, ctx.enrichment)) {
      return { action: 'drop', reason: 'requireMention not satisfied' }
    }
  }

  return { action: 'deliver', access }
}

export function isMentioned(
  event: LineMessageEvent,
  patterns: string[],
  botUserId: string | null,
  enrichment?: InboundEnrichment,
): boolean {
  // Direct @mention check
  if (botUserId) {
    const mentionees = event.message?.mention?.mentionees ?? []
    if (mentionees.some(m => m.userId === botUserId)) return true
  }
  // Quote-reply-to-bot check. Preferred signal: SentIdSet hit (gateway
  // saw us send this id). Fallback: the quoted id isn't in the archive,
  // which implies bot origin because only user webhooks populate the
  // archive. Either way, treat a quote-reply to the bot as a mention.
  if (event.message?.quotedMessageId && enrichment) {
    if (enrichment.quoted_is_bot_sent) return true
    if (enrichment.quoted_absent_from_archive) return true
  }
  // Text pattern fallback
  const text = event.message?.text ?? ''
  for (const pat of patterns) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch { /* bad pattern — ignore */ }
  }
  return false
}

/** Append one id per line to a log file. Noop on fs errors. */
export function appendUnknownLogger(stateDir: string) {
  const dms = join(stateDir, 'unknown-dms.log')
  const groups = join(stateDir, 'unknown-groups.log')
  // In-process dedupe so a noisy sender doesn't fill the log.
  const seen = new Set<string>()
  return (kind: 'dm' | 'group', id: string) => {
    const key = kind + ':' + id
    if (seen.has(key)) return
    seen.add(key)
    try {
      appendFileSync(kind === 'dm' ? dms : groups, id + '\n', { mode: 0o600 })
    } catch { /* best effort */ }
  }
}
