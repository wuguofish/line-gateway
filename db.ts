/**
 * SQLite persistence for inbound LINE messages.
 *
 * Persisting each inbound event lets `fetch_messages` work beyond the
 * scope of a single process — plugin restarts and multi-session setups
 * no longer lose the scrollback. See schema.sql for layout notes.
 *
 * Writes are cheap (one row per inbound), so the dispatcher can call
 * `insertMessage` synchronously without batching.
 */

import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Idempotent `ALTER TABLE ADD COLUMN` — SQLite has no `ADD COLUMN IF NOT
 * EXISTS`, so existing databases (created before a column existed) need
 * this instead of `CREATE TABLE IF NOT EXISTS` catching up on its own.
 * Fresh databases already get the column from schema.sql's CREATE TABLE,
 * so this is a no-op for them (PRAGMA table_info already lists it).
 */
function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

/**
 * One-time (self-correcting, safe to run every startup) backfill for
 * rows archived BEFORE the image_set_* columns existed. ensureColumn()
 * only adds the columns for future INSERTs — it can't retroactively
 * populate old rows — but their raw_json already has the imageSet data,
 * so we parse it back out here. Bounded to image rows with the column
 * still NULL, so after the first run this is an empty-result no-op.
 */
function backfillImageSetColumns(db: Database): number {
  const rows = db.query<{ id: string; raw_json: string }, []>(
    `SELECT id, raw_json FROM messages WHERE message_type = 'image' AND image_set_id IS NULL`,
  ).all()
  if (rows.length === 0) return 0

  const update = db.query(
    `UPDATE messages SET image_set_id = ?, image_set_index = ?, image_set_total = ? WHERE id = ?`,
  )
  let updated = 0
  const runBackfill = db.transaction(() => {
    for (const row of rows) {
      let parsed: { message?: { imageSet?: { id?: unknown; index?: unknown; total?: unknown } } }
      try {
        parsed = JSON.parse(row.raw_json)
      } catch {
        continue // malformed raw_json — leave the row alone
      }
      const imageSet = parsed.message?.imageSet
      if (imageSet && typeof imageSet.id === 'string') {
        update.run(
          imageSet.id,
          typeof imageSet.index === 'number' ? imageSet.index : null,
          typeof imageSet.total === 'number' ? imageSet.total : null,
          row.id,
        )
        updated++
      }
    }
  })
  runBackfill()
  return updated
}

export function openDatabase(path: string): Database {
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)

  ensureColumn(db, 'messages', 'image_set_id', 'image_set_id TEXT')
  ensureColumn(db, 'messages', 'image_set_index', 'image_set_index INTEGER')
  ensureColumn(db, 'messages', 'image_set_total', 'image_set_total INTEGER')
  ensureColumn(db, 'messages', 'is_bot', 'is_bot INTEGER NOT NULL DEFAULT 0')
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_image_set ON messages(image_set_id, image_set_index)')
  // Partial index for the default "inbound only" reads. Without it the
  // is_bot filter turns the chat-wide catch-up query (no chat_id, order
  // by time) into a full table scan — measured at 200ms on a 136k-row
  // archive where the plain index answered in under a millisecond.
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_inbound_time ON messages(received_at DESC) WHERE is_bot = 0')

  const backfilled = backfillImageSetColumns(db)
  if (backfilled > 0) {
    process.stderr.write('line-gateway: backfilled image_set_id/index/total for ' + backfilled + ' archived image(s)\n')
  }

  return db
}

export interface MessageRow {
  id: string
  chat_id: string
  sender_user_id: string | null
  message_type: string
  text: string | null
  line_ts: number | null
  received_at: string
  raw_json: string
  image_set_id: string | null
  image_set_index: number | null
  image_set_total: number | null
  /** 1 for messages the bot sent, 0 for inbound webhook messages. */
  is_bot: number
}

// Mirror of the subset of the LINE webhook event shape we actually use
// for persistence. Kept narrow so incomplete payloads (tests, future LINE
// event types we don't model yet) still round-trip through `raw_json`.
export interface InboundMessageEvent {
  type: string
  timestamp?: number
  source?: {
    type?: 'user' | 'group' | 'room' | string
    userId?: string
    groupId?: string
    roomId?: string
  }
  message?: {
    id?: string
    type?: string
    text?: string
    /** Present when sent as part of a multi-image "album" share. */
    imageSet?: {
      id?: string
      index?: number
      total?: number
    }
  }
  [k: string]: unknown
}

// Prefer groupId/roomId as the chat_id so multi-person chats are bucketed
// correctly; fall back to userId for DMs. Returns null when nothing usable
// is present (system events etc.) — caller will skip insertion in that case.
export function extractChatId(event: InboundMessageEvent): string | null {
  const src = event.source
  if (!src) return null
  if (src.groupId) return src.groupId
  if (src.roomId) return src.roomId
  if (src.userId) return src.userId
  return null
}

/**
 * Insert a message event. No-op when:
 *   - event is not a `message` type
 *   - message lacks an id (can't dedupe)
 *   - no chat_id derivable from source
 * Returns the row id on insert, null when skipped.
 *
 * Duplicate LINE ids (webhook retries) are swallowed via INSERT OR IGNORE;
 * the first write wins so Claude's scrollback sees the original delivery time.
 */
export function insertMessage(
  db: Database,
  event: InboundMessageEvent,
  receivedAt: string,
): string | null {
  if (event.type !== 'message') return null
  const msg = event.message
  if (!msg?.id) return null
  const chatId = extractChatId(event)
  if (!chatId) return null

  const imageSet = msg.imageSet
  const row = {
    id: msg.id,
    chat_id: chatId,
    sender_user_id: event.source?.userId ?? null,
    message_type: msg.type ?? 'unknown',
    text: typeof msg.text === 'string' ? msg.text : null,
    line_ts: typeof event.timestamp === 'number' ? event.timestamp : null,
    received_at: receivedAt,
    raw_json: JSON.stringify(event),
    image_set_id: typeof imageSet?.id === 'string' ? imageSet.id : null,
    image_set_index: typeof imageSet?.index === 'number' ? imageSet.index : null,
    image_set_total: typeof imageSet?.total === 'number' ? imageSet.total : null,
  }

  db.query(`
    INSERT OR IGNORE INTO messages
      (id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json,
       image_set_id, image_set_index, image_set_total)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.chat_id, row.sender_user_id,
    row.message_type, row.text, row.line_ts,
    row.received_at, row.raw_json,
    row.image_set_id, row.image_set_index, row.image_set_total,
  )
  return row.id
}

/**
 * Archive a message the bot just sent, keyed by the id LINE returned in
 * `sentMessages[]`. Rows land in the same table as inbound messages so
 * quoted-message lookups and get_content resolve them without knowing
 * which direction a message travelled; `is_bot = 1` keeps them out of
 * the readers that mean "what did people say to us".
 *
 * `raw_json` is synthesised rather than copied from a webhook — no
 * webhook exists for our own sends — so it carries only what LINE gave
 * us back. Notably there is no quoteToken: LINE issues those for
 * inbound messages only, so `reply(quote_message_id: <a bot message>)`
 * still cannot quote us.
 */
export function insertBotMessage(
  db: Database,
  msg: { id: string; chat_id: string; message_type: string; text: string | null },
  sentAt: string,
  lineTs: number,
): string {
  const rawJson = JSON.stringify({
    type: 'bot_message',
    timestamp: lineTs,
    source: { type: 'bot' },
    message: { id: msg.id, type: msg.message_type, text: msg.text ?? undefined },
  })

  db.query(`
    INSERT OR IGNORE INTO messages
      (id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json, is_bot)
    VALUES
      (?, ?, NULL, ?, ?, ?, ?, ?, 1)
  `).run(msg.id, msg.chat_id, msg.message_type, msg.text, lineTs, sentAt, rawJson)
  return msg.id
}

export interface FetchMessagesOptions {
  chat_id?: string
  /** Upper bound on rows returned. Defaults to 50; hard cap at 500. */
  limit?: number
  /** Only include rows with received_at > this ISO timestamp. */
  since?: string
  /** With since, resume after this id when timestamps are equal. */
  after_id?: string
  /** Defaults to recent-first; catch-up uses oldest-first pagination. */
  order?: 'asc' | 'desc'
  /**
   * Include messages the bot sent. Off by default so every existing
   * caller keeps seeing an inbound-only log — a handler replaying this
   * archive would otherwise process its own words as if they were new.
   */
  include_bot?: boolean
}

/**
 * Recent-first list of stored messages. Caller can constrain by chat
 * and/or time window. Capping `limit` at 500 keeps pathological requests
 * from dumping the whole archive into Claude's context.
 */
export function fetchMessages(db: Database, opts: FetchMessagesOptions = {}): MessageRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)

  const clauses: string[] = []
  const args: (string | number)[] = []
  if (!opts.include_bot) clauses.push('is_bot = 0')
  if (opts.chat_id) {
    clauses.push('chat_id = ?')
    args.push(opts.chat_id)
  }
  if (opts.since && opts.after_id !== undefined) {
    clauses.push('(received_at > ? OR (received_at = ? AND id > ?))')
    args.push(opts.since, opts.since, opts.after_id)
  } else if (opts.since) {
    clauses.push('received_at > ?')
    args.push(opts.since)
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
  const order = opts.order === 'asc' ? 'ASC' : 'DESC'
  args.push(limit)

  return db.query<MessageRow, (string | number)[]>(`
    SELECT id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json,
           image_set_id, image_set_index, image_set_total, is_bot
    FROM messages
    ${where}
    ORDER BY received_at ${order}, id ${order}
    LIMIT ?
  `).all(...args)
}

/**
 * Return chat_ids that someone messaged us in since the given ISO ts.
 * Bot rows are excluded on purpose: this gates send_image on "a human
 * talked to us recently", and our own outbound would otherwise hold that
 * gate open by itself.
 */
export function recentChatIds(db: Database, since: string): string[] {
  const rows = db.query<{ chat_id: string }, [string]>(`
    SELECT DISTINCT chat_id FROM messages
    WHERE received_at > ? AND is_bot = 0
  `).all(since)
  return rows.map(r => r.chat_id)
}

/** Quick lookup: has the archive ever seen this LINE message id? */
export function hasMessageId(db: Database, id: string): boolean {
  const r = db.query<{ n: number }, [string]>(
    'SELECT 1 AS n FROM messages WHERE id = ? LIMIT 1',
  ).get(id)
  return !!r
}

/** Full row lookup for quoted-message enrichment. Null when absent. */
export function getMessageById(db: Database, id: string): MessageRow | null {
  const r = db.query<MessageRow, [string]>(`
    SELECT id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json,
           image_set_id, image_set_index, image_set_total, is_bot
    FROM messages WHERE id = ? LIMIT 1
  `).get(id)
  return r ?? null
}

/**
 * All archived messages sharing the same `imageSet.id`, ordered by their
 * position in the album. Used so `get_content` on any one member of a
 * multi-image LINE share can return the whole set instead of just the
 * message the caller happened to reference.
 */
export function getImageSetMessages(db: Database, imageSetId: string): MessageRow[] {
  return db.query<MessageRow, [string]>(`
    SELECT id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json,
           image_set_id, image_set_index, image_set_total, is_bot
    FROM messages WHERE image_set_id = ? ORDER BY image_set_index ASC
  `).all(imageSetId)
}

/**
 * Resolve a message id to its inbound quoteToken, pulled from the
 * archived raw_json (LINE sets `message.quoteToken` on every inbound
 * message — insertMessage already persists the whole event). Callers
 * use this so they can quote-reply by message_id instead of having to
 * carry the opaque quoteToken string themselves. Returns null when the
 * message isn't archived, or the archived event has no quoteToken.
 */
export function getQuoteToken(db: Database, messageId: string): string | null {
  const row = getMessageById(db, messageId)
  if (!row) return null
  try {
    const parsed = JSON.parse(row.raw_json) as { message?: { quoteToken?: unknown } }
    const qt = parsed.message?.quoteToken
    return typeof qt === 'string' && qt ? qt : null
  } catch {
    return null
  }
}

export function countMessages(db: Database, chat_id?: string): number {
  if (chat_id) {
    const r = db.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?',
    ).get(chat_id)
    return r?.n ?? 0
  }
  const r = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM messages').get()
  return r?.n ?? 0
}
