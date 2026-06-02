import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  safeFilename, validateMessageId, gatewayHttpFromWs, getContent,
} from '../plugin-get-content'

describe('safeFilename', () => {
  test('strips path separators and control chars', () => {
    expect(safeFilename('a/b\\c', 'fb')).toBe('a_b_c')
    expect(safeFilename('\x00bad', 'fb')).toBe('_bad')
  })
  test('guards against Windows reserved names', () => {
    expect(safeFilename('CON.txt', 'fb')).toBe('_CON.txt')
    expect(safeFilename('nul', 'fb')).toBe('_nul')
  })
  test('strips leading dots', () => {
    expect(safeFilename('..secret', 'fb')).toBe('_secret')
  })
  test('caps length at 128 chars', () => {
    const huge = 'a'.repeat(200)
    expect(safeFilename(huge, 'fb').length).toBe(128)
  })
  test('falls back when input is empty', () => {
    expect(safeFilename('', 'FB')).toBe('FB')
  })
})

describe('validateMessageId', () => {
  test('accepts numeric ids', () => {
    expect(() => validateMessageId('12345678901234')).not.toThrow()
  })
  test('rejects non-numeric ids', () => {
    expect(() => validateMessageId('abc')).toThrow(/invalid message_id/)
    expect(() => validateMessageId('1234; DROP TABLE')).toThrow()
    expect(() => validateMessageId('')).toThrow()
  })
})

describe('gatewayHttpFromWs', () => {
  test('ws://host:port/ws → http://host:port', () => {
    expect(gatewayHttpFromWs('ws://127.0.0.1:3456/ws')).toBe('http://127.0.0.1:3456')
  })
  test('wss://host → https://host', () => {
    expect(gatewayHttpFromWs('wss://example.org:8443/ws')).toBe('https://example.org:8443')
  })
})

describe('getContent', () => {
  let inboxDir: string
  beforeEach(() => {
    inboxDir = mkdtempSync(join(tmpdir(), 'plugin-get-content-test-'))
  })
  afterEach(() => {
    try { rmSync(inboxDir, { recursive: true, force: true }) } catch {}
  })

  const mkFetcher = (opts: {
    ok?: boolean
    status?: number
    body?: Uint8Array
    contentType?: string
    contentLength?: number
  }) => {
    const fetcher: any = async (_url: string, _init?: RequestInit) => {
      const status = opts.status ?? 200
      const ok = opts.ok ?? (status >= 200 && status < 300)
      const bytes = opts.body ?? new Uint8Array([1, 2, 3, 4])
      return {
        ok,
        status,
        headers: {
          get(name: string): string | null {
            const n = name.toLowerCase()
            if (n === 'content-type')  return opts.contentType  ?? 'application/octet-stream'
            if (n === 'content-length') return String(opts.contentLength ?? bytes.byteLength)
            return null
          },
        },
        body: new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(bytes); c.close() },
        }),
        async text() { return new TextDecoder().decode(bytes) },
      }
    }
    return fetcher as typeof fetch
  }

  test('saves binary to inbox and returns a text note for non-image', async () => {
    const fetcher = mkFetcher({ contentType: 'application/pdf', body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) })
    const r = await getContent('1234567890', {
      inboxDir, gatewayHttpUrl: 'http://127.0.0.1:3456', fetcher,
    })
    expect(r.content).toHaveLength(1)
    expect((r.content[0] as any).type).toBe('text')
    expect(r.savedPath).toBe(join(inboxDir, '1234567890'))
    expect(existsSync(r.savedPath)).toBe(true)
    expect(readFileSync(r.savedPath).length).toBe(4)
    expect(r.bytes).toBe(4)
  })

  test('inlines base64 for small images', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const fetcher = mkFetcher({ contentType: 'image/png', body: png })
    const r = await getContent('9876543210', {
      inboxDir, gatewayHttpUrl: 'http://127.0.0.1:3456', fetcher,
    })
    // text + image blocks
    expect(r.content).toHaveLength(2)
    expect((r.content[0] as any).type).toBe('text')
    const img = r.content[1] as any
    expect(img.type).toBe('image')
    expect(img.mimeType).toBe('image/png')
    expect(Buffer.from(img.data, 'base64')).toEqual(Buffer.from(png))
  })

  test('uses filename override', async () => {
    const fetcher = mkFetcher({ contentType: 'image/jpeg', body: new Uint8Array([1, 2, 3]) })
    const r = await getContent('1111', {
      inboxDir, gatewayHttpUrl: 'http://127.0.0.1:3456', filename: 'photo.jpg', fetcher,
    })
    expect(r.savedPath.endsWith('photo.jpg')).toBe(true)
  })

  test('rejects message_id that is not numeric', async () => {
    const fetcher = mkFetcher({})
    await expect(
      getContent('oops; DROP', { inboxDir, gatewayHttpUrl: 'http://127.0.0.1:3456', fetcher }),
    ).rejects.toThrow(/invalid message_id/)
  })

  test('surfaces gateway errors as a thrown error', async () => {
    const fetcher = mkFetcher({ ok: false, status: 502 })
    await expect(
      getContent('1234', { inboxDir, gatewayHttpUrl: 'http://127.0.0.1:3456', fetcher }),
    ).rejects.toThrow(/gateway returned 502/)
  })

  test('rejects when declared content-length exceeds maxBytes', async () => {
    const fetcher = mkFetcher({ contentLength: 10_000_000 })
    await expect(
      getContent('1234', {
        inboxDir, gatewayHttpUrl: 'http://127.0.0.1:3456',
        maxBytes: 1_000_000, fetcher,
      }),
    ).rejects.toThrow(/content too large/)
  })

  test('large image above maxInlineBytes does not inline base64', async () => {
    const fetcher = mkFetcher({ contentType: 'image/jpeg', body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })
    const r = await getContent('1234', {
      inboxDir, gatewayHttpUrl: 'http://127.0.0.1:3456',
      maxInlineBytes: 4, fetcher,
    })
    expect(r.content).toHaveLength(1)  // just the text note, no image block
    expect((r.content[0] as any).text).toContain('too large to inline')
  })
})
