import { test, expect, describe } from 'bun:test'
import { formatInbound, formatPermissionBody } from '../plugin-inbound'

describe('formatInbound', () => {
  test('returns null for non-message events', () => {
    expect(formatInbound({ type: 'follow', source: { type: 'user', userId: 'U1' } })).toBeNull()
  })

  test('returns null when message id missing', () => {
    expect(formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { type: 'text', text: 'hi' },
    })).toBeNull()
  })

  test('plain text DM formats content and meta', () => {
    const n = formatInbound({
      type: 'message',
      timestamp: 1_700_000_000_000,
      source: { type: 'user', userId: 'Uabc' },
      message: { id: 'm1', type: 'text', text: 'hi there' },
    })
    expect(n).not.toBeNull()
    expect(n!.content).toBe('hi there')
    expect(n!.meta.chat_id).toBe('Uabc')
    expect(n!.meta.message_id).toBe('m1')
    expect(n!.meta.source_type).toBe('user')
    expect(n!.meta.ts).toMatch(/\+08:00$/)
  })

  test('exposes message quoteToken as meta.quote_token', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'group', userId: 'Uabc', groupId: 'Cg' },
      message: { id: 'm1', type: 'text', text: '幫我看', quoteToken: 'qtok-xyz' },
    })
    expect(n!.meta.quote_token).toBe('qtok-xyz')
  })

  test('omits quote_token when message has none', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'text', text: 'hi' },
    })
    expect(n!.meta.quote_token).toBeUndefined()
  })

  test('group message uses groupId as chat_id', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'group', userId: 'Uabc', groupId: 'Cgroup' },
      message: { id: 'm1', type: 'text', text: 'yo' },
    }, { now: () => new Date('2026-01-01T00:00:00Z') })
    expect(n!.meta.chat_id).toBe('Cgroup')
    expect(n!.meta.source_type).toBe('group')
  })

  test('file type generates a get_content hint', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'file', fileName: 'report.pdf', fileSize: 204_800 } as any,
    })
    expect(n!.content).toContain('[FILE: report.pdf')
    expect(n!.content).toContain('200 KB')
    expect(n!.content).toContain('get_content(message_id: "m1")')
  })

  test('image type generates a generic hint', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'image' },
    })
    expect(n!.content).toContain('[IMAGE')
    expect(n!.content).toContain('get_content')
  })

  test('enrichment populates quoted_* fields in meta (gateway archive hit)', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'text', text: '阿宇', quotedMessageId: 'm0' },
    }, {
      enrichment: {
        quoted_message_id: 'm0',
        quoted_user: 'Uwang',
        quoted_ts: '2026-04-18T21:36:00.000+08:00',
        quoted_type: 'text',
        quoted_text: '叫我姐-90分',
      },
    })
    // content stays clean — no inline prefix anymore
    expect(n!.content).toBe('阿宇')
    expect(n!.meta.quoted_message_id).toBe('m0')
    expect(n!.meta.quoted_user).toBe('Uwang')
    expect(n!.meta.quoted_text).toBe('叫我姐-90分')
    expect(n!.meta.quoted_type).toBe('text')
  })

  test('enrichment with only quoted_message_id still surfaces id (archive miss)', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'text', text: 'ok', quotedMessageId: 'm0' },
    }, {
      enrichment: { quoted_message_id: 'm0', quoted_absent_from_archive: true },
    })
    expect(n!.meta.quoted_message_id).toBe('m0')
    expect(n!.meta.quoted_text).toBeUndefined()
    expect(n!.meta.quoted_user).toBeUndefined()
  })

  test('message with quotedMessageId but no enrichment leaves meta quoted_* empty', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'text', text: 'hm', quotedMessageId: 'm0' },
    })
    expect(n!.meta.quoted_message_id).toBeUndefined()
  })

  test('displayName hook populates user_name', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'text', text: 'hi' },
    }, { displayName: () => 'Alice' })
    expect(n!.meta.user_name).toBe('Alice')
  })
})

describe('formatInbound LINE inline emoji', () => {
  test('text with one inline emoji surfaces [EMOJI:productId/emojiId]', () => {
    // LINE webhook emoji shape: index/length point at a placeholder
    // substring (e.g. "(love)") that LINE renders as an emoji image.
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: {
        id: 'm1',
        type: 'text',
        text: 'Hello (love)',
        emojis: [{ index: 6, length: 6, productId: 'pkg1', emojiId: 'e001' }],
      },
    })
    expect(n!.content).toBe('Hello [EMOJI:pkg1/e001]')
  })

  test('multiple emojis are surfaced in order, no index drift', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: {
        id: 'm1',
        type: 'text',
        text: '(a)b(c)d(e)',
        emojis: [
          { index: 0, length: 3, productId: 'p', emojiId: 'a' },
          { index: 4, length: 3, productId: 'p', emojiId: 'c' },
          { index: 8, length: 3, productId: 'p', emojiId: 'e' },
        ],
      },
    })
    expect(n!.content).toBe('[EMOJI:p/a]b[EMOJI:p/c]d[EMOJI:p/e]')
  })

  test('out-of-order emojis (gateway should still produce stable output)', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: {
        id: 'm1',
        type: 'text',
        text: '(a)b(c)',
        emojis: [
          { index: 4, length: 3, productId: 'p', emojiId: 'c' },
          { index: 0, length: 3, productId: 'p', emojiId: 'a' },
        ],
      },
    })
    expect(n!.content).toBe('[EMOJI:p/a]b[EMOJI:p/c]')
  })

  test('text without emojis array is left unchanged', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: { id: 'm1', type: 'text', text: 'plain text only' },
    })
    expect(n!.content).toBe('plain text only')
  })

  test('emoji with missing productId/emojiId is silently skipped', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: {
        id: 'm1',
        type: 'text',
        text: '(x)(y)',
        emojis: [
          { index: 0, length: 3, productId: 'p', emojiId: 'x' },
          { index: 3, length: 3 } as any,  // missing productId/emojiId
        ],
      },
    })
    // First emoji surfaced; second left as raw placeholder.
    expect(n!.content).toBe('[EMOJI:p/x](y)')
  })

  test('emoji index overflowing the text is silently skipped', () => {
    const n = formatInbound({
      type: 'message',
      source: { type: 'user', userId: 'U1' },
      message: {
        id: 'm1',
        type: 'text',
        text: 'abc',
        emojis: [{ index: 100, length: 5, productId: 'p', emojiId: 'e' }],
      },
    })
    expect(n!.content).toBe('abc')
  })
})

describe('formatPermissionBody', () => {
  test('embeds tool name + request id + quick-reply hint', () => {
    const body = formatPermissionBody({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run a shell command',
      input_preview: 'ls -la',
    })
    expect(body).toContain('Bash')
    expect(body).toContain('Run a shell command')
    expect(body).toContain('ls -la')
    expect(body).toContain('y abcde')
    expect(body).toContain('n abcde')
  })

  test('truncates oversize input_preview with ellipsis and clamps to 5000', () => {
    const huge = 'x'.repeat(10_000)
    const body = formatPermissionBody({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run a shell command',
      input_preview: huge,
    })
    expect(body.length).toBeLessThanOrEqual(5000)
    expect(body).toContain('…')
    expect(body).toContain('y abcde')  // footer preserved
  })
})

describe('formatInbound user_name wiring', () => {
  const baseEvent = {
    type: 'message',
    timestamp: 1700000000000,
    source: { type: 'user' as const, userId: 'Utsunu' },
    message: { id: 'm1', type: 'text', text: 'hi' },
  }

  test('prefers enrichment.user_name (gateway-cached) over callback', () => {
    const n = formatInbound(baseEvent, {
      enrichment: { user_name: 'TsunuFromCache' },
      displayName: () => 'TsunuFromCallback',
    })
    expect(n?.meta.user_name).toBe('TsunuFromCache')
  })

  test('falls back to deps.displayName callback when enrichment lacks user_name', () => {
    const n = formatInbound(baseEvent, {
      enrichment: { quoted_message_id: 'q1' },  // quote enrichment but no user_name
      displayName: () => 'TsunuFromCallback',
    })
    expect(n?.meta.user_name).toBe('TsunuFromCallback')
  })

  test('leaves user_name undefined when neither enrichment nor callback supplies one', () => {
    const n = formatInbound(baseEvent, {})
    expect(n?.meta.user_name).toBeUndefined()
  })
})
