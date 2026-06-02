import { test, expect, describe } from 'bun:test'
import { gate, isMentioned, type Access, type LineMessageEvent } from '../plugin-access'

const emptyAccess: Access = { dmPolicy: 'allowlist', allowFrom: [], groups: {} }

function mkEvent(overrides: Partial<LineMessageEvent> & { userId?: string; groupId?: string; text?: string; mentioneeId?: string; sourceType?: 'user' | 'group' | 'room' } = {}): LineMessageEvent {
  const { userId, groupId, text, mentioneeId, sourceType, ...rest } = overrides
  const type = sourceType ?? 'user'
  const source: any = type === 'user'
    ? { type: 'user', userId: userId ?? 'Uabc' }
    : { type: 'group', userId: userId ?? 'Uabc', groupId: groupId ?? 'Cgroup' }
  return {
    type: 'message',
    timestamp: 1700000000000,
    source,
    message: {
      id: 'm1',
      type: 'text',
      text: text ?? 'hello',
      ...(mentioneeId ? { mention: { mentionees: [{ userId: mentioneeId }] } } : {}),
    },
    ...rest,
  }
}

describe('gate: DM policy', () => {
  test('dmPolicy=disabled drops every source', () => {
    const a: Access = { ...emptyAccess, dmPolicy: 'disabled' }
    expect(gate(mkEvent(), { access: a }).action).toBe('drop')
    expect(gate(mkEvent({ sourceType: 'group' }), { access: a }).action).toBe('drop')
  })

  test('empty allowFrom means allow all DMs', () => {
    const r = gate(mkEvent(), { access: emptyAccess })
    expect(r.action).toBe('deliver')
  })

  test('non-empty allowFrom restricts DMs', () => {
    const a: Access = { ...emptyAccess, allowFrom: ['Uowner'] }
    expect(gate(mkEvent({ userId: 'Ubad' }), { access: a }).action).toBe('drop')
    expect(gate(mkEvent({ userId: 'Uowner' }), { access: a }).action).toBe('deliver')
  })

  test('unknown DM userId is logged via logUnknown hook', () => {
    const seen: string[] = []
    const a: Access = { ...emptyAccess, allowFrom: ['Uowner'] }
    gate(mkEvent({ userId: 'Ubad' }), {
      access: a,
      logUnknown: (kind, id) => seen.push(kind + ':' + id),
    })
    expect(seen).toEqual(['dm:Ubad'])
  })
})

describe('gate: group policy', () => {
  test('unknown group is dropped and logged', () => {
    const seen: string[] = []
    const r = gate(mkEvent({ sourceType: 'group', groupId: 'Cnew' }), {
      access: emptyAccess,
      logUnknown: (k, id) => seen.push(k + ':' + id),
    })
    expect(r.action).toBe('drop')
    expect(seen).toEqual(['group:Cnew'])
  })

  test('known group with no member restriction delivers', () => {
    const a: Access = {
      ...emptyAccess,
      groups: { 'Cgroup': { requireMention: false, allowFrom: [] } },
    }
    expect(gate(mkEvent({ sourceType: 'group' }), { access: a }).action).toBe('deliver')
  })

  test('group member allowFrom blocks non-members', () => {
    const a: Access = {
      ...emptyAccess,
      groups: { 'Cgroup': { requireMention: false, allowFrom: ['Uok'] } },
    }
    expect(gate(mkEvent({ sourceType: 'group', userId: 'Ubad' }), { access: a }).action).toBe('drop')
    expect(gate(mkEvent({ sourceType: 'group', userId: 'Uok' }), { access: a }).action).toBe('deliver')
  })

  test('requireMention drops non-mentioning messages', () => {
    const a: Access = {
      ...emptyAccess,
      groups: { 'Cgroup': { requireMention: true, allowFrom: [] } },
      mentionPatterns: ['\\bclaude\\b'],
    }
    expect(gate(mkEvent({ sourceType: 'group', text: 'random chat' }), { access: a }).action).toBe('drop')
    expect(gate(mkEvent({ sourceType: 'group', text: 'hey claude' }), { access: a }).action).toBe('deliver')
  })

  test('requireMention accepts explicit @mention of bot', () => {
    const a: Access = {
      ...emptyAccess,
      groups: { 'Cgroup': { requireMention: true, allowFrom: [] } },
    }
    const r = gate(mkEvent({ sourceType: 'group', mentioneeId: 'Ubot', text: 'yo' }), {
      access: a, botUserId: 'Ubot',
    })
    expect(r.action).toBe('deliver')
  })
})

describe('gate: malformed events', () => {
  test('non-message events are dropped', () => {
    const r = gate({ type: 'follow', source: { type: 'user', userId: 'U1' } }, { access: emptyAccess })
    expect(r.action).toBe('drop')
  })
  test('missing source drops', () => {
    expect(gate({ type: 'message', message: { id: 'm1' } }, { access: emptyAccess }).action).toBe('drop')
  })
  test('user event missing userId drops', () => {
    expect(gate({ type: 'message', source: { type: 'user' }, message: { id: 'm1' } } as any, { access: emptyAccess }).action).toBe('drop')
  })
  test('group event missing groupId drops', () => {
    expect(gate({ type: 'message', source: { type: 'group', userId: 'U1' }, message: { id: 'm1' } } as any, { access: emptyAccess }).action).toBe('drop')
  })
})

describe('isMentioned', () => {
  test('pattern matches case-insensitively', () => {
    expect(isMentioned(mkEvent({ text: 'hey Claude' }), ['\\bclaude\\b'], null)).toBe(true)
  })
  test('bad regex pattern is ignored silently', () => {
    expect(isMentioned(mkEvent({ text: 'hi' }), ['('], null)).toBe(false)
  })
  test('botUserId @mention takes precedence over text', () => {
    expect(isMentioned(mkEvent({ mentioneeId: 'Ubot', text: 'hi' }), [], 'Ubot')).toBe(true)
  })

  test('quote-reply with quoted_is_bot_sent=true counts as mention', () => {
    const ev: any = { ...mkEvent({ text: '好酷' }), message: { id: 'm1', type: 'text', text: '好酷', quotedMessageId: 'b0' } }
    expect(isMentioned(ev, [], null, { quoted_message_id: 'b0', quoted_is_bot_sent: true })).toBe(true)
  })

  test('quote-reply with quoted_absent_from_archive=true counts as mention', () => {
    const ev: any = { ...mkEvent({ text: '謝謝' }), message: { id: 'm1', type: 'text', text: '謝謝', quotedMessageId: 'b0' } }
    expect(isMentioned(ev, [], null, { quoted_message_id: 'b0', quoted_absent_from_archive: true })).toBe(true)
  })

  test('quote-reply to another user (in archive, not bot) is NOT a mention', () => {
    const ev: any = { ...mkEvent({ text: '+1' }), message: { id: 'm1', type: 'text', text: '+1', quotedMessageId: 'u0' } }
    expect(isMentioned(ev, [], null, { quoted_message_id: 'u0', quoted_is_bot_sent: false, quoted_absent_from_archive: false })).toBe(false)
  })

  test('quote-reply without enrichment falls back to text pattern only', () => {
    const ev: any = { ...mkEvent({ text: '+1' }), message: { id: 'm1', type: 'text', text: '+1', quotedMessageId: 'u0' } }
    expect(isMentioned(ev, ['阿宇'], null)).toBe(false)
  })
})

describe('gate: requireMention + enrichment', () => {
  test('group quote-reply to bot delivers (requireMention satisfied by enrichment)', () => {
    const a: Access = {
      ...emptyAccess,
      groups: { 'Cgroup': { requireMention: true, allowFrom: [] } },
      mentionPatterns: [],
    }
    const ev: any = {
      type: 'message',
      timestamp: 1700000000000,
      source: { type: 'group', userId: 'Uabc', groupId: 'Cgroup' },
      message: { id: 'm1', type: 'text', text: '好酷', quotedMessageId: 'b0' },
    }
    const r = gate(ev, {
      access: a,
      enrichment: { quoted_message_id: 'b0', quoted_is_bot_sent: true },
    })
    expect(r.action).toBe('deliver')
  })

  test('group quote-reply to another user still drops (requireMention not satisfied)', () => {
    const a: Access = {
      ...emptyAccess,
      groups: { 'Cgroup': { requireMention: true, allowFrom: [] } },
      mentionPatterns: [],
    }
    const ev: any = {
      type: 'message',
      timestamp: 1700000000000,
      source: { type: 'group', userId: 'Uabc', groupId: 'Cgroup' },
      message: { id: 'm1', type: 'text', text: '+1', quotedMessageId: 'u0' },
    }
    const r = gate(ev, {
      access: a,
      enrichment: { quoted_message_id: 'u0', quoted_is_bot_sent: false, quoted_absent_from_archive: false },
    })
    expect(r.action).toBe('drop')
  })
})
