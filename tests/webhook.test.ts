import { test, expect } from 'bun:test'
import { createHmac } from 'crypto'
import { verifySignature, dispatch } from '../webhook'
import { ConnectionRegistry, type ConnectionData } from '../connections'
import { HandlerManager } from '../handler'
import { PermissionRouter } from '../permissions'
import { ReplyTokenCache, SentIdSet } from '../line-api'
import { openDatabase, fetchMessages, countMessages, insertMessage } from '../db'

// --- verifySignature --------------------------------------------------------

const SECRET = 'test-secret'

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64')
}

test('verifySignature accepts a valid signature', () => {
  const body = '{"events":[]}'
  expect(verifySignature(body, sign(body), SECRET)).toBe(true)
})

test('verifySignature rejects an invalid signature', () => {
  const body = '{"events":[]}'
  expect(verifySignature(body, 'bogus', SECRET)).toBe(false)
})

test('verifySignature rejects tampered body', () => {
  const sig = sign('{"events":[]}')
  expect(verifySignature('{"events":[1]}', sig, SECRET)).toBe(false)
})

test('verifySignature returns false for empty signature header', () => {
  expect(verifySignature('body', '', SECRET)).toBe(false)
})

// --- dispatch ---------------------------------------------------------------

function mockWs() {
  const sent: string[] = []
  const ws = {
    close() {},
    send(msg: string | Uint8Array) {
      sent.push(typeof msg === 'string' ? msg : new TextDecoder().decode(msg))
    },
    data: {} as ConnectionData,
  } as any
  return { ws, sent }
}

function setup(ownerUserId: string | null) {
  const registry = new ConnectionRegistry()
  const handlers = new HandlerManager()
  const permissions = new PermissionRouter()
  return {
    registry, handlers, permissions,
    deps: { registry, handlers, permissions, primaryOwner: () => ownerUserId },
  }
}

const mkConnData = (cc: string): ConnectionData => ({
  cc_session_id: cc, pid: 1, plugin_version: '0.1', connected_at: Date.now(),
})

test('dispatch routes a message to the current handler', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uabc' },
      message: { type: 'text', text: 'hi', id: '1' },
    }],
  }
  const r = dispatch(payload, s.deps)
  expect(r.routed_to_handler).toBe(1)
  expect(r.routed_as_permission_reply).toBe(0)
  expect(m.sent).toHaveLength(1)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.type).toBe('inbound')
})

test('dispatch drops inbound when nobody is the handler', () => {
  const s = setup(null)
  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uabc' },
      message: { type: 'text', text: 'hi', id: '1' },
    }],
  }
  const r = dispatch(payload, s.deps)
  expect(r.dropped_no_handler).toBe(1)
})

test('dispatch routes permission reply to the push_permission originator, not the handler', () => {
  const s = setup('Uowner')
  // Handler plugin — should NOT receive the permission reply.
  const h = mockWs()
  s.registry.add(h.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  // Originator plugin — the one that did push_permission earlier.
  const o = mockWs()
  s.registry.add(o.ws, mkConnData('cc-origin'))
  s.permissions.register('abcde', 'cc-origin')

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uowner' },
      message: { type: 'text', text: 'y abcde', id: '1' },
    }],
  }
  const r = dispatch(payload, s.deps)
  expect(r.routed_as_permission_reply).toBe(1)
  expect(r.routed_to_handler).toBe(0)
  // Handler got nothing.
  expect(h.sent).toHaveLength(0)
  // Originator got the permission_reply.
  expect(o.sent).toHaveLength(1)
  const frame = JSON.parse(o.sent[0]!)
  expect(frame.type).toBe('permission_reply')
  expect(frame.request_id).toBe('abcde')
  expect(frame.behavior).toBe('allow')
})

test('dispatch accepts deny-form permission reply', () => {
  const s = setup('Uowner')
  const o = mockWs()
  s.registry.add(o.ws, mkConnData('cc-origin'))
  s.permissions.register('zzzzz', 'cc-origin')

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uowner' },
      message: { type: 'text', text: 'NO zzzzz', id: '1' },
    }],
  }
  dispatch(payload, s.deps)
  const frame = JSON.parse(o.sent[0]!)
  expect(frame.behavior).toBe('deny')
})

test('permission reply from a non-owner is NOT treated as a decision (falls through to handler)', () => {
  const s = setup('Uowner')
  const h = mockWs()
  s.registry.add(h.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  s.permissions.register('abcde', 'cc-origin')  // still registered

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uimpostor' },
      message: { type: 'text', text: 'y abcde', id: '1' },
    }],
  }
  const r = dispatch(payload, s.deps)
  // Impostor's "y abcde" is delivered to the handler as ordinary chat,
  // the permission entry remains pending.
  expect(r.routed_to_handler).toBe(1)
  expect(r.routed_as_permission_reply).toBe(0)
  expect(s.permissions.size()).toBe(1)
})

test('permission reply for an unknown request_id is silently swallowed, not relayed', () => {
  const s = setup('Uowner')
  const h = mockWs()
  s.registry.add(h.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  // Note: no permissions.register — the request_id is unknown.

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uowner' },
      message: { type: 'text', text: 'y ghost', id: '1' },
    }],
  }
  const r = dispatch(payload, s.deps)
  expect(r.routed_as_permission_reply).toBe(1)
  // Handler must NOT see "y ghost" — leaking a stale permission code as
  // chat is worse than dropping.
  expect(r.routed_to_handler).toBe(0)
  expect(h.sent).toHaveLength(0)
})

test('dispatch handles an empty events array cleanly', () => {
  const s = setup(null)
  const r = dispatch({ events: [] }, s.deps)
  expect(r).toEqual({
    routed_to_handler: 0,
    routed_as_permission_reply: 0,
    dropped_no_handler: 0,
    archived: 0,
  })
})

test('dispatch archives inbound messages when db is provided', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  const deps = { ...s.deps, db, now: () => new Date('2026-04-17T02:00:00.000Z') }

  const payload = {
    events: [{
      type: 'message',
      timestamp: 1_700_000_000_000,
      source: { type: 'user', userId: 'Uabc' },
      message: { id: 'LINE-1', type: 'text', text: 'hi' },
    }],
  }
  const r = dispatch(payload, deps)
  expect(r.archived).toBe(1)
  expect(countMessages(db)).toBe(1)
  const rows = fetchMessages(db)
  expect(rows[0]!.text).toBe('hi')
  expect(rows[0]!.received_at.endsWith('+08:00')).toBe(true)
})

test('dispatch archives permission replies too (audit trail)', () => {
  const s = setup('Uowner')
  const o = mockWs()
  s.registry.add(o.ws, mkConnData('cc-origin'))
  s.permissions.register('abcde', 'cc-origin')
  const db = openDatabase(':memory:')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uowner' },
      message: { id: 'LINE-perm-1', type: 'text', text: 'y abcde' },
    }],
  }
  dispatch(payload, deps)
  // Even though the handler doesn't see it, the archive does.
  expect(countMessages(db)).toBe(1)
})

test('dispatch stores replyToken for message events', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const replyTokens = new ReplyTokenCache({ now: () => 1000 })
  const deps = { ...s.deps, replyTokens }

  const payload = {
    events: [{
      type: 'message',
      replyToken: 'rt-abc',
      source: { type: 'user', userId: 'Uabc' },
      message: { id: 'LINE-1', type: 'text', text: 'hi' },
    }],
  }
  dispatch(payload, deps)
  expect(replyTokens.consume('Uabc')).toBe('rt-abc')
})

test('dispatch stores replyToken keyed on group id for group messages', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const replyTokens = new ReplyTokenCache({ now: () => 1000 })
  const deps = { ...s.deps, replyTokens }

  const payload = {
    events: [{
      type: 'message',
      replyToken: 'rt-grp',
      source: { type: 'group', userId: 'Uabc', groupId: 'Cgroup' },
      message: { id: 'LINE-2', type: 'text', text: 'hi' },
    }],
  }
  dispatch(payload, deps)
  expect(replyTokens.consume('Cgroup')).toBe('rt-grp')
})

test('dispatch enriches inbound frame with quoted_is_bot_sent when SentIdSet hits', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const sentIds = new SentIdSet()
  sentIds.add('bot-sent-id')
  const deps = { ...s.deps, sentIds }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'group', userId: 'Uabc', groupId: 'Cgroup' },
      message: { id: 'm1', type: 'text', text: '好酷', quotedMessageId: 'bot-sent-id' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.type).toBe('inbound')
  expect(frame.enrichment.quoted_message_id).toBe('bot-sent-id')
  expect(frame.enrichment.quoted_is_bot_sent).toBe(true)
})

test('dispatch enriches with quoted_absent_from_archive=true when archive lacks the id', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'group', userId: 'Uabc', groupId: 'Cgroup' },
      message: { id: 'm1', type: 'text', text: '謝謝', quotedMessageId: 'phantom' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.quoted_absent_from_archive).toBe(true)
})

test('dispatch enriches inbound with quoted_text/user/ts from archive row', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  insertMessage(db, {
    type: 'message',
    timestamp: 1_700_000_000_000,
    source: { type: 'group', userId: 'Uwang', groupId: 'Cgroup' },
    message: { id: 'orig-1', type: 'text', text: '叫我姐-90分' },
  }, '2026-04-18T21:36:00.000+08:00')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'group', userId: 'Uatone', groupId: 'Cgroup' },
      message: { id: 'reply-1', type: 'text', text: '阿宇', quotedMessageId: 'orig-1' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.quoted_user).toBe('Uwang')
  expect(frame.enrichment.quoted_text).toBe('叫我姐-90分')
  expect(frame.enrichment.quoted_type).toBe('text')
  expect(frame.enrichment.quoted_ts).toBe('2026-04-18T21:36:00.000+08:00')
})

test('dispatch downgrades sticker/image quoted context to a label', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  insertMessage(db, {
    type: 'message',
    timestamp: 1_700_000_000_000,
    source: { type: 'group', userId: 'Uuser', groupId: 'Cgroup' },
    message: { id: 'sticker-1', type: 'sticker' },
  }, '2026-04-18T21:30:00.000+08:00')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'group', userId: 'Uother', groupId: 'Cgroup' },
      message: { id: 'reply-1', type: 'text', text: '哈哈', quotedMessageId: 'sticker-1' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.quoted_type).toBe('sticker')
  expect(frame.enrichment.quoted_text).toBe('[sticker]')
})

test('dispatch downgrades file with fileName preserved in the label', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  insertMessage(db, {
    type: 'message',
    timestamp: 1_700_000_000_000,
    source: { type: 'user', userId: 'Uuser' },
    message: { id: 'file-1', type: 'file', fileName: 'report.pdf' } as any,
  }, '2026-04-18T21:30:00.000+08:00')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uother' },
      message: { id: 'reply-1', type: 'text', text: '收到', quotedMessageId: 'file-1' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.quoted_text).toBe('[file: report.pdf]')
})

test('dispatch reports quoted_absent_from_archive=false when the quoted id IS in archive', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  insertMessage(db, {
    type: 'message',
    timestamp: 1_700_000_000_000,
    source: { type: 'user', userId: 'Uother' },
    message: { id: 'u-original', type: 'text', text: 'earlier' },
  }, '2026-04-17T10:00:00.000+08:00')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'group', userId: 'Uabc', groupId: 'Cgroup' },
      message: { id: 'm2', type: 'text', text: '+1', quotedMessageId: 'u-original' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.quoted_absent_from_archive).toBe(false)
})

test('dispatch surfaces quoted_image_set_index/total when quoting one image of an album', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  insertMessage(db, {
    type: 'message',
    timestamp: 1_700_000_000_000,
    source: { type: 'group', userId: 'Ulinbao', groupId: 'Cgroup' },
    message: { id: 'img-1', type: 'image', imageSet: { id: 'SET-A', index: 1, total: 3 } } as any,
  }, '2026-07-18T21:18:13.561+08:00')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'group', userId: 'Ulinbao', groupId: 'Cgroup' },
      message: { id: 'text-1', type: 'text', text: '阿宇！這邊！', quotedMessageId: 'img-1' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.quoted_type).toBe('image')
  expect(frame.enrichment.quoted_image_set_index).toBe(1)
  expect(frame.enrichment.quoted_image_set_total).toBe(3)
})

test('dispatch omits quoted_image_set_* when the quoted image is not part of a set', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  insertMessage(db, {
    type: 'message',
    timestamp: 1_700_000_000_000,
    source: { type: 'user', userId: 'Uuser' },
    message: { id: 'img-solo', type: 'image' },
  }, '2026-07-18T21:00:00.000+08:00')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uuser' },
      message: { id: 'text-1', type: 'text', text: '好看', quotedMessageId: 'img-solo' },
    }],
  }
  dispatch(payload, deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.quoted_image_set_index).toBeUndefined()
  expect(frame.enrichment.quoted_image_set_total).toBeUndefined()
})

test('dispatch omits enrichment when message has no quotedMessageId', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uabc' },
      message: { id: 'm1', type: 'text', text: 'hi' },
    }],
  }
  dispatch(payload, s.deps)
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment).toBeUndefined()
})

test('dispatch is idempotent on duplicate webhook deliveries (archive dedupes)', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const db = openDatabase(':memory:')
  const deps = { ...s.deps, db }

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uabc' },
      message: { id: 'LINE-DUPE', type: 'text', text: 'hi' },
    }],
  }
  dispatch(payload, deps)
  dispatch(payload, deps)
  // Both calls route to handler, but archive stores only one row.
  expect(countMessages(db)).toBe(1)
})

// --- displayName enrichment ---------------------------------------------

import { DisplayNameCache } from '../line-api'

test('dispatch attaches user_name from DisplayNameCache when cache hit', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const displayNames = new DisplayNameCache(async () => 'Demo-cached')
  displayNames.put('UaliceUID', 'Alice')  // pre-seed

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'UaliceUID' },
      message: { id: 'm1', type: 'text', text: 'hi' },
    }],
  }
  dispatch(payload, { ...s.deps, displayNames })
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.user_name).toBe('Alice')
})

test('dispatch omits user_name when cache missing the sender', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const displayNames = new DisplayNameCache(async () => 'never-resolved')

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uunseen' },
      message: { id: 'm1', type: 'text', text: 'hi' },
    }],
  }
  dispatch(payload, { ...s.deps, displayNames })
  const frame = JSON.parse(m.sent[0]!)
  // first-ever sighting → cache miss → user_name absent, but enrichment
  // itself should be absent too since there's no quote either
  expect(frame.enrichment).toBeUndefined()
})

test('dispatch combines quote-reply enrichment with user_name', () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const sentIds = new SentIdSet()
  sentIds.add('bot-said-this')
  const displayNames = new DisplayNameCache(async () => 'x')
  displayNames.put('Uquoter', 'Quoter-Name')

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uquoter' },
      message: { id: 'm1', type: 'text', text: 'hi', quotedMessageId: 'bot-said-this' },
    }],
  }
  dispatch(payload, { ...s.deps, sentIds, displayNames })
  const frame = JSON.parse(m.sent[0]!)
  expect(frame.enrichment.user_name).toBe('Quoter-Name')
  expect(frame.enrichment.quoted_message_id).toBe('bot-said-this')
  expect(frame.enrichment.quoted_is_bot_sent).toBe(true)
})

test('dispatch prefetches displayName for unseen senders (fire-and-forget)', async () => {
  const s = setup(null)
  const m = mockWs()
  s.registry.add(m.ws, mkConnData('cc-handler'))
  s.handlers.claim('cc-handler', false)
  const calls: string[] = []
  const displayNames = new DisplayNameCache(async (uid) => { calls.push(uid); return 'name-' + uid })

  const payload = {
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Unewuser' },
      message: { id: 'm1', type: 'text', text: 'hi' },
    }],
  }
  dispatch(payload, { ...s.deps, displayNames })
  // First event: cache miss, but prefetch was kicked off
  await new Promise(r => setTimeout(r, 10))
  expect(calls).toContain('Unewuser')

  // Second event from same user: now populated
  m.sent.length = 0
  dispatch(payload, { ...s.deps, displayNames })
  const frame2 = JSON.parse(m.sent[0]!)
  expect(frame2.enrichment.user_name).toBe('name-Unewuser')
})
