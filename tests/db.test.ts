import { test, expect, describe, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  openDatabase, insertMessage, insertBotMessage, fetchMessages,
  recentChatIds, countMessages, extractChatId, getQuoteToken,
  getImageSetMessages, getMessageById,
  type InboundMessageEvent,
} from '../db'

function makeEvent(overrides: Partial<InboundMessageEvent> & { id?: string; chatType?: 'user' | 'group' | 'room' } = {}): InboundMessageEvent {
  const { id, chatType, ...rest } = overrides
  const src = chatType === 'group' ? { type: 'group', userId: 'U1', groupId: 'C1' }
            : chatType === 'room'  ? { type: 'room',  userId: 'U1', roomId: 'R1' }
            :                        { type: 'user',  userId: 'U1' }
  return {
    type: 'message',
    timestamp: 1700000000000,
    source: src,
    message: { id: id ?? 'msg-1', type: 'text', text: 'hi' },
    ...rest,
  }
}

describe('extractChatId', () => {
  test('prefers groupId over userId', () => {
    expect(extractChatId(makeEvent({ chatType: 'group' }))).toBe('C1')
  })
  test('prefers roomId over userId', () => {
    expect(extractChatId(makeEvent({ chatType: 'room' }))).toBe('R1')
  })
  test('falls back to userId for DMs', () => {
    expect(extractChatId(makeEvent())).toBe('U1')
  })
  test('returns null when source is missing', () => {
    expect(extractChatId({ type: 'message' })).toBeNull()
  })
})

describe('insertMessage + fetchMessages', () => {
  let db: Database
  beforeEach(() => { db = openDatabase(':memory:') })

  test('inserts a text message and reads it back', () => {
    const now = '2026-04-17T10:00:00.000+08:00'
    const id = insertMessage(db, makeEvent({ id: 'm1' }), now)
    expect(id).toBe('m1')
    const rows = fetchMessages(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('m1')
    expect(rows[0]!.text).toBe('hi')
    expect(rows[0]!.chat_id).toBe('U1')
    expect(rows[0]!.sender_user_id).toBe('U1')
    expect(rows[0]!.message_type).toBe('text')
  })

  test('skips non-message events', () => {
    const id = insertMessage(db, { type: 'follow', source: { type: 'user', userId: 'U1' } }, '2026-04-17T10:00:00.000+08:00')
    expect(id).toBeNull()
    expect(countMessages(db)).toBe(0)
  })

  test('skips events with no message id', () => {
    const id = insertMessage(db, { type: 'message', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: 'x' } }, 'now')
    expect(id).toBeNull()
  })

  test('duplicate LINE id is ignored (webhook retry dedupe)', () => {
    const now = '2026-04-17T10:00:00.000+08:00'
    insertMessage(db, makeEvent({ id: 'm1' }), now)
    insertMessage(db, makeEvent({ id: 'm1', message: { id: 'm1', type: 'text', text: 'changed' } as any }), '2026-04-17T11:00:00.000+08:00')
    const rows = fetchMessages(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('hi')           // first write wins
    expect(rows[0]!.received_at).toBe(now)
  })

  test('fetchMessages filters by chat_id', () => {
    insertMessage(db, makeEvent({ id: 'm-dm',    chatType: 'user'  }), '2026-04-17T10:00:00.000+08:00')
    insertMessage(db, makeEvent({ id: 'm-group', chatType: 'group' }), '2026-04-17T10:01:00.000+08:00')
    const group = fetchMessages(db, { chat_id: 'C1' })
    expect(group.map(r => r.id)).toEqual(['m-group'])
  })

  test('fetchMessages orders newest first', () => {
    insertMessage(db, makeEvent({ id: 'a' }), '2026-04-17T10:00:00.000+08:00')
    insertMessage(db, makeEvent({ id: 'b' }), '2026-04-17T11:00:00.000+08:00')
    insertMessage(db, makeEvent({ id: 'c' }), '2026-04-17T10:30:00.000+08:00')
    const rows = fetchMessages(db)
    expect(rows.map(r => r.id)).toEqual(['b', 'c', 'a'])
  })

  test('fetchMessages limit is clamped to 1..500', () => {
    for (let i = 0; i < 3; i++) {
      insertMessage(db, makeEvent({ id: 'm' + i }), `2026-04-17T10:0${i}:00.000+08:00`)
    }
    expect(fetchMessages(db, { limit: 0 })).toHaveLength(1)     // clamp low end
    expect(fetchMessages(db, { limit: 1000 })).toHaveLength(3)  // still <=500
  })

  test('since filter excludes earlier rows', () => {
    insertMessage(db, makeEvent({ id: 'a' }), '2026-04-17T10:00:00.000+08:00')
    insertMessage(db, makeEvent({ id: 'b' }), '2026-04-17T11:00:00.000+08:00')
    const rows = fetchMessages(db, { since: '2026-04-17T10:30:00.000+08:00' })
    expect(rows.map(r => r.id)).toEqual(['b'])
  })

  test('oldest-first composite cursor paginates equal timestamps without gaps', () => {
    const ts = '2026-04-17T10:00:00.000+08:00'
    for (const id of ['a', 'b', 'c']) insertMessage(db, makeEvent({ id }), ts)

    const first = fetchMessages(db, { since: ts, after_id: '', order: 'asc', limit: 2 })
    expect(first.map((row) => row.id)).toEqual(['a', 'b'])
    const second = fetchMessages(db, {
      since: first[1]!.received_at,
      after_id: first[1]!.id,
      order: 'asc',
      limit: 2,
    })
    expect(second.map((row) => row.id)).toEqual(['c'])
  })

  test('recentChatIds returns DISTINCT chat ids after cutoff', () => {
    insertMessage(db, makeEvent({ id: 'a', chatType: 'user'  }), '2026-04-17T10:00:00.000+08:00')
    insertMessage(db, makeEvent({ id: 'b', chatType: 'group' }), '2026-04-17T11:00:00.000+08:00')
    insertMessage(db, makeEvent({ id: 'c', chatType: 'group' }), '2026-04-17T11:01:00.000+08:00')
    const ids = recentChatIds(db, '2026-04-17T10:30:00.000+08:00')
    expect(ids.sort()).toEqual(['C1'])
  })

  test('raw_json round-trips the original event', () => {
    const ev = makeEvent({ id: 'm1' })
    insertMessage(db, ev, '2026-04-17T10:00:00.000+08:00')
    const rows = fetchMessages(db)
    expect(JSON.parse(rows[0]!.raw_json)).toEqual(ev as any)
  })
})

describe('imageSet columns + getImageSetMessages', () => {
  let db: Database
  beforeEach(() => { db = openDatabase(':memory:') })

  function makeImage(id: string, setId: string, index: number, total: number): InboundMessageEvent {
    return {
      type: 'message',
      source: { type: 'group', userId: 'U1', groupId: 'C1' },
      message: { id, type: 'image', imageSet: { id: setId, index, total } } as any,
    }
  }

  test('insertMessage persists image_set_id/index/total', () => {
    insertMessage(db, makeImage('m1', 'SET-A', 1, 3), '2026-07-18T21:18:13.000+08:00')
    const rows = fetchMessages(db)
    expect(rows[0]!.image_set_id).toBe('SET-A')
    expect(rows[0]!.image_set_index).toBe(1)
    expect(rows[0]!.image_set_total).toBe(3)
  })

  test('non-imageSet messages leave the columns null', () => {
    insertMessage(db, makeEvent({ id: 'm1' }), '2026-07-18T10:00:00.000+08:00')
    const rows = fetchMessages(db)
    expect(rows[0]!.image_set_id).toBeNull()
    expect(rows[0]!.image_set_index).toBeNull()
    expect(rows[0]!.image_set_total).toBeNull()
  })

  test('getImageSetMessages returns the whole set ordered by index, ignoring other sets', () => {
    insertMessage(db, makeImage('m3', 'SET-A', 3, 3), '2026-07-18T21:18:14.394+08:00')
    insertMessage(db, makeImage('m1', 'SET-A', 1, 3), '2026-07-18T21:18:13.561+08:00')
    insertMessage(db, makeImage('m2', 'SET-A', 2, 3), '2026-07-18T21:18:13.762+08:00')
    insertMessage(db, makeImage('other', 'SET-B', 1, 1), '2026-07-18T21:19:00.000+08:00')
    const set = getImageSetMessages(db, 'SET-A')
    expect(set.map(r => r.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('getImageSetMessages returns empty array for an unknown set id', () => {
    expect(getImageSetMessages(db, 'NOPE')).toEqual([])
  })

  test('opening a pre-existing database created before image_set columns existed migrates cleanly', () => {
    // Simulate a database from before this schema change: same messages
    // table but WITHOUT the three new columns, populated with one row.
    const path = join(tmpdir(), 'line-gateway-test-migration.db')
    try { unlinkSync(path) } catch {}
    const oldDb = new Database(path)
    oldDb.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_user_id TEXT,
        message_type TEXT NOT NULL, text TEXT, line_ts INTEGER,
        received_at TEXT NOT NULL, raw_json TEXT NOT NULL
      )
    `)
    oldDb.query(`INSERT INTO messages (id, chat_id, message_type, received_at, raw_json) VALUES (?, ?, ?, ?, ?)`)
      .run('pre-existing', 'C1', 'text', '2026-07-01T00:00:00.000+08:00', '{}')
    oldDb.close()

    // Re-opening via openDatabase() must not throw, must add the columns,
    // and must leave the pre-existing row intact.
    const migrated = openDatabase(path)
    const rows = fetchMessages(migrated)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('pre-existing')
    expect(rows[0]!.image_set_id).toBeNull()
    migrated.close()

    // A second open (idempotency — ensureColumn must not re-ALTER and throw).
    let reopened: Database | undefined
    expect(() => { reopened = openDatabase(path) }).not.toThrow()
    reopened?.close()

    try { unlinkSync(path) } catch {}
  })

  test('reopening backfills image_set columns for image rows archived before the migration', () => {
    // Simulate a pre-migration database: old-shape table, one image row
    // whose raw_json carries imageSet data that predates the columns.
    const path = join(tmpdir(), 'line-gateway-test-backfill.db')
    try { unlinkSync(path) } catch {}
    const oldDb = new Database(path)
    oldDb.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_user_id TEXT,
        message_type TEXT NOT NULL, text TEXT, line_ts INTEGER,
        received_at TEXT NOT NULL, raw_json TEXT NOT NULL
      )
    `)
    const rawEvent = JSON.stringify({
      type: 'message',
      source: { type: 'group', groupId: 'C1', userId: 'U1' },
      message: { id: 'old-img-1', type: 'image', imageSet: { id: 'SET-OLD', index: 2, total: 3 } },
    })
    oldDb.query(`INSERT INTO messages (id, chat_id, sender_user_id, message_type, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('old-img-1', 'C1', 'U1', 'image', '2026-07-18T21:18:13.000+08:00', rawEvent)
    // A non-image row and a malformed-json image row should be left alone,
    // not crash the backfill.
    oldDb.query(`INSERT INTO messages (id, chat_id, sender_user_id, message_type, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('old-text-1', 'C1', 'U1', 'text', '2026-07-18T21:18:00.000+08:00', '{}')
    oldDb.query(`INSERT INTO messages (id, chat_id, sender_user_id, message_type, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('old-img-bad', 'C1', 'U1', 'image', '2026-07-18T21:18:20.000+08:00', 'not json')
    oldDb.close()

    const migrated = openDatabase(path)
    const set = getImageSetMessages(migrated, 'SET-OLD')
    expect(set).toHaveLength(1)
    expect(set[0]!.id).toBe('old-img-1')
    expect(set[0]!.image_set_index).toBe(2)
    expect(set[0]!.image_set_total).toBe(3)

    // Re-opening again must not re-touch (or throw on) the already-backfilled
    // row or the malformed one.
    migrated.close()
    let reopened: Database | undefined
    expect(() => { reopened = openDatabase(path) }).not.toThrow()
    reopened?.close()

    try { unlinkSync(path) } catch {}
  })
})

describe('getQuoteToken', () => {
  let db: Database
  beforeEach(() => { db = openDatabase(':memory:') })

  test('resolves message_id to the archived quoteToken', () => {
    insertMessage(db, {
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'text', text: 'hi', quoteToken: 'qtok-xyz' } as any,
    }, '2026-04-17T10:00:00.000+08:00')
    expect(getQuoteToken(db, 'm1')).toBe('qtok-xyz')
  })

  test('returns null when message_id is not archived', () => {
    expect(getQuoteToken(db, 'missing')).toBeNull()
  })

  test('returns null when the archived message has no quoteToken', () => {
    insertMessage(db, makeEvent({ id: 'm1' }), '2026-04-17T10:00:00.000+08:00')
    expect(getQuoteToken(db, 'm1')).toBeNull()
  })
})

describe('insertBotMessage', () => {
  let db: Database
  const SENT_AT = '2026-09-14T12:00:00.000+08:00'
  beforeEach(() => {
    db = openDatabase(':memory:')
    insertBotMessage(db, { id: 'bot-1', chat_id: 'C1', message_type: 'text', text: '我在' },
      SENT_AT, 1757822400000)
  })

  test('archives the message flagged as ours', () => {
    const row = getMessageById(db, 'bot-1')
    expect(row!.is_bot).toBe(1)
    expect(row!.text).toBe('我在')
    expect(row!.chat_id).toBe('C1')
    expect(row!.sender_user_id).toBeNull()
  })

  test('inbound messages stay flagged as not ours', () => {
    insertMessage(db, makeEvent({ id: 'in-1' }), SENT_AT)
    expect(getMessageById(db, 'in-1')!.is_bot).toBe(0)
  })

  test('fetchMessages hides our own messages by default', () => {
    insertMessage(db, makeEvent({ id: 'in-1' }), SENT_AT)
    expect(fetchMessages(db).map(r => r.id)).toEqual(['in-1'])
  })

  test('include_bot returns them alongside inbound', () => {
    insertMessage(db, makeEvent({ id: 'in-1' }), SENT_AT)
    const ids = fetchMessages(db, { include_bot: true }).map(r => r.id).sort()
    expect(ids).toEqual(['bot-1', 'in-1'])
  })

  test('our own message does not open the send_image window on its own', () => {
    expect(recentChatIds(db, '2026-09-14T00:00:00.000+08:00')).toEqual([])
  })

  test('a human message does open it', () => {
    insertMessage(db, makeEvent({ id: 'in-1', chatType: 'group' }), SENT_AT)
    expect(recentChatIds(db, '2026-09-14T00:00:00.000+08:00')).toEqual(['C1'])
  })

  test('resending the same LINE id is ignored', () => {
    insertBotMessage(db, { id: 'bot-1', chat_id: 'C1', message_type: 'text', text: '改過的' },
      SENT_AT, 1757822400000)
    expect(getMessageById(db, 'bot-1')!.text).toBe('我在')
  })
})
