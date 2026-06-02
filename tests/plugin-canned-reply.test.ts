import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  decideCannedReply,
  loadNotifiedIds,
  persistNotifiedId,
  formatDmCannedText,
  formatGroupCannedText,
} from '../plugin-canned-reply'
import type { LineMessageEvent, GateResult } from '../plugin-access'

function mkEvent(
  source: LineMessageEvent['source'],
  type: 'message' | 'follow' = 'message',
): LineMessageEvent {
  return {
    type,
    timestamp: 1700000000000,
    source,
    message: { id: 'm1', type: 'text', text: 'hello' },
  }
}

const drop = (reason: string): GateResult => ({ action: 'drop', reason })
const deliver: GateResult = { action: 'deliver', access: { dmPolicy: 'allowlist', allowFrom: [], groups: {} } }

describe('decideCannedReply: trigger conditions', () => {
  test('user not on allowFrom → reply with userId', () => {
    const ev = mkEvent({ type: 'user', userId: 'Uabc123' })
    const d = decideCannedReply(ev, drop('user not on allowFrom'), new Set())
    expect(d.shouldReply).toBe(true)
    expect(d.chat_id).toBe('Uabc123')
    expect(d.source_id).toBe('Uabc123')
    expect(d.text).toContain('Uabc123')
    expect(d.text).toContain('使用者ID')
  })

  test('group not in access.json → reply with groupId', () => {
    const ev = mkEvent({ type: 'group', userId: 'Usender', groupId: 'Cgroup1' })
    const d = decideCannedReply(ev, drop('group not in access.json'), new Set())
    expect(d.shouldReply).toBe(true)
    expect(d.chat_id).toBe('Cgroup1')
    expect(d.source_id).toBe('Cgroup1')
    expect(d.text).toContain('Cgroup1')
    expect(d.text).toContain('群組ID')
  })

  test('room source uses roomId', () => {
    const ev = mkEvent({ type: 'room', userId: 'Usender', roomId: 'Rroom1' })
    const d = decideCannedReply(ev, drop('group not in access.json'), new Set())
    expect(d.shouldReply).toBe(true)
    expect(d.chat_id).toBe('Rroom1')
    expect(d.source_id).toBe('Rroom1')
  })
})

describe('decideCannedReply: skip conditions', () => {
  test('deliver action never replies', () => {
    const ev = mkEvent({ type: 'user', userId: 'Uabc' })
    expect(decideCannedReply(ev, deliver, new Set()).shouldReply).toBe(false)
  })

  test('dmPolicy disabled does not reply (operator turned it off)', () => {
    const ev = mkEvent({ type: 'user', userId: 'Uabc' })
    expect(decideCannedReply(ev, drop('dmPolicy disabled'), new Set()).shouldReply).toBe(false)
  })

  test('requireMention not satisfied does not reply (avoid group spam)', () => {
    const ev = mkEvent({ type: 'group', userId: 'Usender', groupId: 'Callowed' })
    expect(decideCannedReply(ev, drop('requireMention not satisfied'), new Set()).shouldReply).toBe(false)
  })

  test('sender not in group allowFrom does not reply (group is allowed, partial-allow is intentional)', () => {
    const ev = mkEvent({ type: 'group', userId: 'Ubad', groupId: 'Callowed' })
    expect(decideCannedReply(ev, drop('sender not in group allowFrom'), new Set()).shouldReply).toBe(false)
  })

  test('unknown drop reason does not reply (default-deny)', () => {
    const ev = mkEvent({ type: 'user', userId: 'Uabc' })
    expect(decideCannedReply(ev, drop('something else'), new Set()).shouldReply).toBe(false)
  })

  test('non-message event without source does not reply', () => {
    const ev = mkEvent(undefined, 'follow')
    expect(decideCannedReply(ev, drop('user not on allowFrom'), new Set()).shouldReply).toBe(false)
  })

  test('user source missing userId does not reply', () => {
    const ev = mkEvent({ type: 'user' })
    expect(decideCannedReply(ev, drop('user not on allowFrom'), new Set()).shouldReply).toBe(false)
  })

  test('group source missing groupId does not reply', () => {
    const ev = mkEvent({ type: 'group', userId: 'Usender' })
    expect(decideCannedReply(ev, drop('group not in access.json'), new Set()).shouldReply).toBe(false)
  })
})

describe('decideCannedReply: dedupe', () => {
  test('userId already in notifiedIds → skip', () => {
    const ev = mkEvent({ type: 'user', userId: 'Uabc' })
    const set = new Set(['Uabc'])
    expect(decideCannedReply(ev, drop('user not on allowFrom'), set).shouldReply).toBe(false)
  })

  test('groupId already in notifiedIds → skip', () => {
    const ev = mkEvent({ type: 'group', userId: 'Usender', groupId: 'Cgroup' })
    const set = new Set(['Cgroup'])
    expect(decideCannedReply(ev, drop('group not in access.json'), set).shouldReply).toBe(false)
  })

  test('different ids in set don\'t affect a new sender', () => {
    const ev = mkEvent({ type: 'user', userId: 'Unew' })
    const set = new Set(['Uother'])
    expect(decideCannedReply(ev, drop('user not on allowFrom'), set).shouldReply).toBe(true)
  })
})

describe('formatDmCannedText / formatGroupCannedText', () => {
  test('DM template includes id and instructs to contact admin', () => {
    const t = formatDmCannedText('Uxyz')
    expect(t).toContain('Uxyz')
    expect(t).toContain('使用者ID')
    expect(t).toContain('管理員')
    expect(t).toContain('白名單')
  })

  test('group template includes id and instructs to contact admin', () => {
    const t = formatGroupCannedText('Cxyz')
    expect(t).toContain('Cxyz')
    expect(t).toContain('群組ID')
    expect(t).toContain('管理員')
    expect(t).toContain('白名單')
  })
})

describe('loadNotifiedIds / persistNotifiedId', () => {
  let dir: string
  let logPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canned-reply-test-'))
    logPath = join(dir, 'notified-ids.log')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('missing file returns empty Set without error', () => {
    const set = loadNotifiedIds(logPath)
    expect(set.size).toBe(0)
  })

  test('persist + reload round-trip preserves ids', () => {
    persistNotifiedId(logPath, 'Uone')
    persistNotifiedId(logPath, 'Ctwo')
    persistNotifiedId(logPath, 'Rthree')
    const set = loadNotifiedIds(logPath)
    expect(set.size).toBe(3)
    expect(set.has('Uone')).toBe(true)
    expect(set.has('Ctwo')).toBe(true)
    expect(set.has('Rthree')).toBe(true)
  })

  test('blank lines and surrounding whitespace are tolerated', () => {
    writeFileSync(logPath, '\n  Uone\n\nCtwo  \n\n')
    const set = loadNotifiedIds(logPath)
    expect(set.size).toBe(2)
    expect(set.has('Uone')).toBe(true)
    expect(set.has('Ctwo')).toBe(true)
  })

  test('persist appends newline-terminated line', () => {
    persistNotifiedId(logPath, 'Uone')
    expect(readFileSync(logPath, 'utf8')).toBe('Uone\n')
    persistNotifiedId(logPath, 'Utwo')
    expect(readFileSync(logPath, 'utf8')).toBe('Uone\nUtwo\n')
  })
})
