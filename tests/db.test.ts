import { test, expect, describe, beforeEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  openDatabase, insertMessage, fetchMessages,
  recentChatIds, countMessages, extractChatId,
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
