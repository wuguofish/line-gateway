import { test, expect, describe } from 'bun:test'
import {
  splitText, ReplyTokenCache, SentIdSet,
  stickerIdFromRawJson, getStickerImageStream, getEmojiImageStream,
  getProfile, DisplayNameCache,
  buildMentionAllMessage, buildMentionUserMessage, textMessages,
  MENTION_ALL_MAX_LEN, MAX_MENTIONS,
} from '../line-api'

describe('splitText', () => {
  test('returns single chunk when under limit', () => {
    expect(splitText('hello', 100, 'newline')).toEqual(['hello'])
  })

  test('length mode splits at exact limit', () => {
    const out = splitText('abcdefghij', 4, 'length')
    expect(out).toEqual(['abcd', 'efgh', 'ij'])
  })

  test('newline mode prefers paragraph break', () => {
    const text = 'AAA\n\nBBB\n\nCCC'
    const out = splitText(text, 6, 'newline')
    // Should break on the \n\n before BBB
    expect(out.length).toBeGreaterThan(1)
    expect(out[0]).toBe('AAA')
  })

  test('newline mode falls back to line then space', () => {
    const text = 'word-one word-two word-three'
    const out = splitText(text, 10, 'newline')
    expect(out.every(c => c.length <= 10)).toBe(true)
    // No chunk should start with a leading newline after split strip
    expect(out.every(c => !c.startsWith('\n'))).toBe(true)
  })

  test('newline mode with no break points falls back to length cut', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaa' // 26 chars, no break points
    const out = splitText(text, 10, 'newline')
    expect(out).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaaa'])
  })
})

describe('buildMentionAllMessage', () => {
  test('wraps text with {everyone} placeholder and mention-all substitution', () => {
    const m = buildMentionAllMessage('晚上 22:45 記得領草莓喔！')
    expect(m.type).toBe('textV2')
    expect(m.text).toBe('{everyone} 晚上 22:45 記得領草莓喔！')
    expect(m.substitution).toEqual({
      everyone: { type: 'mention', mentionee: { type: 'all' } },
    })
  })

  test('rejects text containing a literal { (no documented escape)', () => {
    expect(() => buildMentionAllMessage('reward at {time}')).toThrow(/must not contain/)
  })

  test('rejects text containing a literal }', () => {
    expect(() => buildMentionAllMessage('done }')).toThrow(/must not contain/)
  })

  test('rejects a message longer than the cap', () => {
    const long = 'a'.repeat(MENTION_ALL_MAX_LEN)  // + "{everyone} " prefix pushes over
    expect(() => buildMentionAllMessage(long)).toThrow(/too long/)
  })

  test('accepts a message exactly at the cap', () => {
    const prefixLen = '{everyone} '.length
    const body = 'a'.repeat(MENTION_ALL_MAX_LEN - prefixLen)
    const m = buildMentionAllMessage(body)
    expect(m.text.length).toBe(MENTION_ALL_MAX_LEN)
  })

  test('attaches quoteToken when provided', () => {
    expect(buildMentionAllMessage('hi', 'qtok-1').quoteToken).toBe('qtok-1')
  })

  test('omits quoteToken when not provided', () => {
    expect(buildMentionAllMessage('hi').quoteToken).toBeUndefined()
  })
})

describe('buildMentionUserMessage', () => {
  const UID_A = 'U' + 'a'.repeat(32)
  const UID_B = 'U' + 'b'.repeat(32)

  test('prepends one placeholder per user and maps substitutions', () => {
    const m = buildMentionUserMessage('你的圖好了', [UID_A, UID_B])
    expect(m.type).toBe('textV2')
    expect(m.text).toBe('{m0} {m1} 你的圖好了')
    expect(m.substitution).toEqual({
      m0: { type: 'mention', mentionee: { type: 'user', userId: UID_A } },
      m1: { type: 'mention', mentionee: { type: 'user', userId: UID_B } },
    })
  })

  test('attaches quoteToken when provided', () => {
    expect(buildMentionUserMessage('hi', [UID_A], 'qtok-9').quoteToken).toBe('qtok-9')
  })

  test('rejects an empty user list', () => {
    expect(() => buildMentionUserMessage('hi', [])).toThrow(/must not be empty/)
  })

  test('rejects more than MAX_MENTIONS users', () => {
    const many = Array.from({ length: MAX_MENTIONS + 1 }, () => UID_A)
    expect(() => buildMentionUserMessage('hi', many)).toThrow(/at most/)
  })

  test('rejects a malformed userId', () => {
    expect(() => buildMentionUserMessage('hi', ['not-a-uid'])).toThrow(/invalid mention userId/)
  })

  test('rejects text containing a literal brace', () => {
    expect(() => buildMentionUserMessage('at {x}', [UID_A])).toThrow(/must not contain/)
  })
})

describe('textMessages', () => {
  test('attaches quoteToken to the first chunk only', () => {
    expect(textMessages(['a', 'b', 'c'], 'qt')).toEqual([
      { type: 'text', text: 'a', quoteToken: 'qt' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
    ])
  })

  test('no quoteToken field when none provided', () => {
    expect(textMessages(['a', 'b'])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
  })
})

describe('ReplyTokenCache', () => {
  test('store + consume returns token and deletes', () => {
    const cache = new ReplyTokenCache({ now: () => 1000 })
    cache.store('chat-1', 'tok-abc')
    expect(cache.size()).toBe(1)
    expect(cache.consume('chat-1')).toBe('tok-abc')
    expect(cache.size()).toBe(0)
    expect(cache.consume('chat-1')).toBeNull()
  })

  test('consume returns null for unknown chat', () => {
    const cache = new ReplyTokenCache()
    expect(cache.consume('unknown')).toBeNull()
  })

  test('consume returns null when expired', () => {
    let t = 1000
    const cache = new ReplyTokenCache({ ttlMs: 100, now: () => t })
    cache.store('chat-1', 'tok-abc')
    t = 2000
    expect(cache.consume('chat-1')).toBeNull()
    expect(cache.size()).toBe(0)
  })

  test('peek does not delete fresh token', () => {
    const cache = new ReplyTokenCache({ now: () => 1000 })
    cache.store('chat-1', 'tok-abc')
    expect(cache.peek('chat-1')).toBe('tok-abc')
    expect(cache.peek('chat-1')).toBe('tok-abc')
    expect(cache.size()).toBe(1)
  })

  test('peek cleans up expired token', () => {
    let t = 1000
    const cache = new ReplyTokenCache({ ttlMs: 100, now: () => t })
    cache.store('chat-1', 'tok-abc')
    t = 2000
    expect(cache.peek('chat-1')).toBeNull()
    expect(cache.size()).toBe(0)
  })

  test('store overwrites existing entry', () => {
    const cache = new ReplyTokenCache({ now: () => 1000 })
    cache.store('chat-1', 'tok-old')
    cache.store('chat-1', 'tok-new')
    expect(cache.size()).toBe(1)
    expect(cache.consume('chat-1')).toBe('tok-new')
  })
})

describe('SentIdSet', () => {
  test('add + has', () => {
    const s = new SentIdSet()
    s.add('m1')
    expect(s.has('m1')).toBe(true)
    expect(s.has('m2')).toBe(false)
  })

  test('recordFromResponseText extracts all ids from sentMessages[]', () => {
    const s = new SentIdSet()
    s.recordFromResponseText(JSON.stringify({ sentMessages: [{ id: 'a' }, { id: 'b' }] }))
    expect(s.has('a')).toBe(true)
    expect(s.has('b')).toBe(true)
    expect(s.size()).toBe(2)
  })

  test('recordFromResponseText tolerates malformed bodies', () => {
    const s = new SentIdSet()
    s.recordFromResponseText('not json')
    s.recordFromResponseText(JSON.stringify({}))
    s.recordFromResponseText(JSON.stringify({ sentMessages: 'nope' }))
    s.recordFromResponseText(JSON.stringify({ sentMessages: [{ id: 123 }] }))  // non-string id skipped
    expect(s.size()).toBe(0)
  })

  test('eviction keeps size at or below max (FIFO)', () => {
    const s = new SentIdSet({ max: 3 })
    s.add('a'); s.add('b'); s.add('c'); s.add('d')
    expect(s.size()).toBe(3)
    expect(s.has('a')).toBe(false)   // oldest evicted
    expect(s.has('d')).toBe(true)
  })

  test('re-adding an existing id refreshes recency', () => {
    const s = new SentIdSet({ max: 3 })
    s.add('a'); s.add('b'); s.add('c')
    s.add('a')                        // touch 'a' — b is now oldest
    s.add('d')
    expect(s.has('a')).toBe(true)
    expect(s.has('b')).toBe(false)
  })
})

describe('stickerIdFromRawJson', () => {
  const makeRaw = (msg: unknown) => JSON.stringify({ type: 'message', message: msg })

  test('returns stickerId for a well-formed sticker event', () => {
    const raw = makeRaw({ id: 'm1', type: 'sticker', stickerId: '51626494', packageId: '11537' })
    expect(stickerIdFromRawJson(raw)).toBe('51626494')
  })

  test('returns null for non-sticker message types', () => {
    expect(stickerIdFromRawJson(makeRaw({ type: 'text', text: 'hi' }))).toBeNull()
    expect(stickerIdFromRawJson(makeRaw({ type: 'image', id: 'm2' }))).toBeNull()
  })

  test('returns null when stickerId is missing', () => {
    expect(stickerIdFromRawJson(makeRaw({ type: 'sticker', packageId: '1' }))).toBeNull()
  })

  test('rejects non-numeric stickerId (defence-in-depth)', () => {
    expect(stickerIdFromRawJson(makeRaw({ type: 'sticker', stickerId: '../evil' }))).toBeNull()
    expect(stickerIdFromRawJson(makeRaw({ type: 'sticker', stickerId: 123 }))).toBeNull()
  })

  test('returns null on malformed JSON', () => {
    expect(stickerIdFromRawJson('{not json')).toBeNull()
  })
})

describe('getStickerImageStream', () => {
  const mkFetcher = (opts: { ok?: boolean; status?: number; contentType?: string; body?: Uint8Array }) => {
    return (async (url: string | URL, _init?: RequestInit) => {
      const status = opts.status ?? 200
      const ok = opts.ok ?? (status >= 200 && status < 300)
      const bytes = opts.body ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const urlStr = typeof url === 'string' ? url : url.toString()
      return {
        ok, status,
        url: urlStr,
        headers: {
          get(name: string): string | null {
            const n = name.toLowerCase()
            if (n === 'content-type')   return opts.contentType ?? 'image/png'
            if (n === 'content-length') return String(bytes.byteLength)
            return null
          },
        },
        body: new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(bytes); c.close() },
        }),
        async text() { return new TextDecoder().decode(bytes) },
      } as unknown as Response
    }) as typeof fetch
  }

  test('hits the sticker CDN and streams the body through', async () => {
    let seenUrl = ''
    const fetcher = (async (url: string | URL) => {
      seenUrl = typeof url === 'string' ? url : url.toString()
      return (await mkFetcher({ contentType: 'image/png' })(url))
    }) as typeof fetch

    const s = await getStickerImageStream('51626494', { fetcher })
    expect(seenUrl).toContain('stickershop.line-scdn.net')
    expect(seenUrl).toContain('51626494')
    expect(seenUrl).toMatch(/sticker\.png$/)
    expect(s.contentType).toBe('image/png')
    const reader = s.body.getReader()
    const first = await reader.read()
    expect(first.value?.byteLength).toBeGreaterThan(0)
  })

  test('rejects non-numeric stickerId before any fetch', async () => {
    let called = false
    const fetcher = (async () => { called = true; throw new Error('should not call') }) as unknown as typeof fetch
    await expect(getStickerImageStream('bogus', { fetcher })).rejects.toThrow(/invalid stickerId/)
    expect(called).toBe(false)
  })

  test('surfaces non-ok CDN response as a thrown error', async () => {
    const fetcher = mkFetcher({ ok: false, status: 404 })
    await expect(getStickerImageStream('123', { fetcher })).rejects.toThrow(/HTTP 404/)
  })
})

describe('getEmojiImageStream', () => {
  const mkFetcher = (opts: { ok?: boolean; status?: number; contentType?: string; body?: Uint8Array }) => {
    return (async (url: string | URL, _init?: RequestInit) => {
      const status = opts.status ?? 200
      const ok = opts.ok ?? (status >= 200 && status < 300)
      const bytes = opts.body ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const urlStr = typeof url === 'string' ? url : url.toString()
      return {
        ok, status, url: urlStr,
        headers: {
          get(name: string): string | null {
            const n = name.toLowerCase()
            if (n === 'content-type')   return opts.contentType ?? 'image/png'
            if (n === 'content-length') return String(bytes.byteLength)
            return null
          },
        },
        body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }),
        async text() { return new TextDecoder().decode(bytes) },
      } as unknown as Response
    }) as typeof fetch
  }

  test('hits the sticonshop CDN with productId / emojiId', async () => {
    let seenUrl = ''
    const fetcher = (async (url: string | URL) => {
      seenUrl = typeof url === 'string' ? url : url.toString()
      return (await mkFetcher({ contentType: 'image/png' })(url))
    }) as typeof fetch
    const s = await getEmojiImageStream('5ac1bfd5040ab15980c9b435', '001', { fetcher })
    expect(seenUrl).toContain('sticonshop')
    expect(seenUrl).toContain('5ac1bfd5040ab15980c9b435')
    expect(seenUrl).toContain('001.png')
    expect(s.contentType).toBe('image/png')
  })

  test('rejects non-hex productId before any fetch', async () => {
    let called = false
    const fetcher = (async () => { called = true; throw new Error('should not call') }) as unknown as typeof fetch
    await expect(getEmojiImageStream('NOT_A_HEX', '001', { fetcher })).rejects.toThrow(/invalid productId/)
    expect(called).toBe(false)
  })

  test('rejects illegal emojiId before any fetch', async () => {
    let called = false
    const fetcher = (async () => { called = true; throw new Error('should not call') }) as unknown as typeof fetch
    await expect(getEmojiImageStream('5ac1bfd5040ab15980c9b435', '../../etc/passwd', { fetcher })).rejects.toThrow(/invalid emojiId/)
    expect(called).toBe(false)
  })

  test('surfaces non-ok CDN response as a thrown error', async () => {
    const fetcher = mkFetcher({ ok: false, status: 404 })
    await expect(getEmojiImageStream('5ac1bfd5040ab15980c9b435', '001', { fetcher })).rejects.toThrow(/HTTP 404/)
  })
})

describe('getProfile', () => {
  const mkJsonFetcher = (opts: { ok?: boolean; status?: number; body?: unknown }) => {
    return (async (_u: string | URL, _init?: RequestInit) => {
      const status = opts.status ?? 200
      const ok = opts.ok ?? (status >= 200 && status < 300)
      return {
        ok, status,
        headers: { get() { return null } },
        async json() { return opts.body },
        async text() { return JSON.stringify(opts.body ?? null) },
      } as unknown as Response
    }) as typeof fetch
  }

  const VALID_UID = 'U' + 'a'.repeat(32)

  test('returns parsed profile on 200', async () => {
    const fetcher = mkJsonFetcher({
      body: { displayName: 'Tsunu', userId: VALID_UID },
    })
    const p = await getProfile(VALID_UID, 'tok', { fetcher })
    expect(p).toEqual({ displayName: 'Tsunu', userId: VALID_UID })
  })

  test('returns null on 404 (bot not friended etc.)', async () => {
    const fetcher = mkJsonFetcher({ ok: false, status: 404 })
    expect(await getProfile(VALID_UID, 'tok', { fetcher })).toBeNull()
  })

  test('rejects malformed userId without fetching', async () => {
    let called = false
    const fetcher = (async () => { called = true; throw new Error('nope') }) as unknown as typeof fetch
    expect(await getProfile('bogus', 'tok', { fetcher })).toBeNull()
    expect(called).toBe(false)
  })

  test('returns null when response body is missing required fields', async () => {
    const fetcher = mkJsonFetcher({ body: { userId: VALID_UID } }) // missing displayName
    expect(await getProfile(VALID_UID, 'tok', { fetcher })).toBeNull()
  })
})

describe('DisplayNameCache', () => {
  const UID_A = 'U' + 'a'.repeat(32)
  const UID_B = 'U' + 'b'.repeat(32)

  test('prefetch populates entry, subsequent get() hits', async () => {
    const calls: string[] = []
    const cache = new DisplayNameCache(async (uid) => { calls.push(uid); return 'name-' + uid.slice(1, 4) })
    expect(cache.get(UID_A)).toBeNull()
    await cache.prefetch(UID_A, 'user', UID_A)
    expect(cache.get(UID_A)).toBe('name-aaa')
    expect(calls).toEqual([UID_A])
  })

  test('TTL expiry forces a re-fetch', async () => {
    let clock = 1000
    let callCount = 0
    const cache = new DisplayNameCache(
      async () => { callCount++; return 'n' },
      { ttlMs: 100, now: () => clock },
    )
    await cache.prefetch(UID_A, 'user', UID_A)
    expect(cache.get(UID_A)).toBe('n')
    clock += 200  // past TTL
    expect(cache.get(UID_A)).toBeNull()
    await cache.prefetch(UID_A, 'user', UID_A)
    expect(callCount).toBe(2)
  })

  test('already-fresh prefetch is a no-op', async () => {
    let callCount = 0
    const cache = new DisplayNameCache(async () => { callCount++; return 'n' })
    await cache.prefetch(UID_A, 'user', UID_A)
    await cache.prefetch(UID_A, 'user', UID_A)
    await cache.prefetch(UID_A, 'user', UID_A)
    expect(callCount).toBe(1)
  })

  test('inflight dedupe: concurrent prefetch only fetches once', async () => {
    let callCount = 0
    const gate = Promise.withResolvers<string>()
    const cache = new DisplayNameCache(async () => { callCount++; return await gate.promise })
    const p1 = cache.prefetch(UID_A, 'user', UID_A)
    const p2 = cache.prefetch(UID_A, 'user', UID_A)
    const p3 = cache.prefetch(UID_A, 'user', UID_A)
    gate.resolve('same-name')
    await Promise.all([p1, p2, p3])
    expect(callCount).toBe(1)
    expect(cache.get(UID_A)).toBe('same-name')
  })

  test('fetcher returning null leaves entry absent (no negative caching)', async () => {
    let callCount = 0
    const cache = new DisplayNameCache(async () => { callCount++; return null })
    await cache.prefetch(UID_A, 'user', UID_A)
    expect(cache.get(UID_A)).toBeNull()
    await cache.prefetch(UID_A, 'user', UID_A)  // tries again, still null
    expect(callCount).toBe(2)
  })

  test('fetcher throws are swallowed, entry left absent', async () => {
    const cache = new DisplayNameCache(async () => { throw new Error('network down') })
    await cache.prefetch(UID_A, 'user', UID_A)  // must not throw
    expect(cache.get(UID_A)).toBeNull()
  })

  test('LRU eviction respects maxSize', async () => {
    const cache = new DisplayNameCache(async (uid) => uid, { maxSize: 2 })
    const UIDS = [0, 1, 2, 3].map(i => 'U' + String(i).repeat(32))
    for (const u of UIDS) await cache.prefetch(u, 'user', u)
    expect(cache.size()).toBe(2)
    expect(cache.get(UIDS[0]!)).toBeNull()  // evicted
    expect(cache.get(UIDS[3]!)).toBe(UIDS[3])
  })

  test('get() touches an entry to keep it fresh against LRU', async () => {
    const cache = new DisplayNameCache(async (uid) => uid, { maxSize: 2 })
    await cache.prefetch(UID_A, 'user', UID_A)
    await cache.prefetch(UID_B, 'user', UID_B)
    // touch A so B becomes the eviction candidate
    cache.get(UID_A)
    const UID_C = 'U' + 'c'.repeat(32)
    await cache.prefetch(UID_C, 'user', UID_C)
    expect(cache.get(UID_A)).toBe(UID_A)
    expect(cache.get(UID_B)).toBeNull()
    expect(cache.get(UID_C)).toBe(UID_C)
  })
})
