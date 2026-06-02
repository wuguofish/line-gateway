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

export function openDatabase(path: string): Database {
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
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

  const row = {
    id: msg.id,
    chat_id: chatId,
    sender_user_id: event.source?.userId ?? null,
    message_type: msg.type ?? 'unknown',
    text: typeof msg.text === 'string' ? msg.text : null,
    line_ts: typeof event.timestamp === 'number' ? event.timestamp : null,
    received_at: receivedAt,
    raw_json: JSON.stringify(event),
  }

  db.query(`
    INSERT OR IGNORE INTO messages
      (id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.chat_id, row.sender_user_id,
    row.message_type, row.text, row.line_ts,
    row.received_at, row.raw_json,
  )
  return row.id
}

export interface FetchMessagesOptions {
  chat_id?: string
  /** Upper bound on rows returned. Defaults to 50; hard cap at 500. */
  limit?: number
  /** Only include rows with received_at > this ISO timestamp. */
  since?: string
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
  if (opts.chat_id) {
    clauses.push('chat_id = ?')
    args.push(opts.chat_id)
  }
  if (opts.since) {
    clauses.push('received_at > ?')
    args.push(opts.since)
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
  args.push(limit)

  return db.query<MessageRow, (string | number)[]>(`
    SELECT id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json
    FROM messages
    ${where}
    ORDER BY received_at DESC, id DESC
    LIMIT ?
  `).all(...args)
}

/** Return chat_ids that received at least one message since the given ISO ts. */
export function recentChatIds(db: Database, since: string): string[] {
  const rows = db.query<{ chat_id: string }, [string]>(`
    SELECT DISTINCT chat_id FROM messages
    WHERE received_at > ?
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
    SELECT id, chat_id, sender_user_id, message_type, text, line_ts, received_at, raw_json
    FROM messages WHERE id = ? LIMIT 1
  `).get(id)
  return r ?? null
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
