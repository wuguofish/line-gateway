import { test, expect, describe, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  saveUpload, resolveStaticPath, sweepUploads,
  newUploadHash, contentTypeForExt, DEFAULT_MAX_BYTES,
} from '../uploads'

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'line-gateway-uploads-test-'))
}

function makeFormData(opts: { type?: string; bytes?: Uint8Array; field?: string }): FormData {
  const fd = new FormData()
  const bytes = opts.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const field = opts.field ?? 'image'
  if (opts.type === undefined) {
    // Skip the file altogether (test: missing field).
    return fd
  }
  fd.append(field, new Blob([bytes as BlobPart], { type: opts.type }), 'foo.bin')
  return fd
}

describe('newUploadHash', () => {
  test('produces 32 hex characters', () => {
    const h = newUploadHash()
    expect(h).toMatch(/^[a-f0-9]{32}$/)
  })

  test('two consecutive calls do not collide', () => {
    expect(newUploadHash()).not.toBe(newUploadHash())
  })
})

describe('contentTypeForExt', () => {
  test('maps known extensions to mime types', () => {
    expect(contentTypeForExt('png')).toBe('image/png')
    expect(contentTypeForExt('JPG')).toBe('image/jpeg')
    expect(contentTypeForExt('webp')).toBe('image/webp')
  })

  test('returns null for unknown extensions', () => {
    expect(contentTypeForExt('exe')).toBeNull()
  })
})

describe('saveUpload', () => {
  let dir: string
  beforeEach(() => { dir = mkTmpDir() })

  test('persists a PNG upload and returns metadata', async () => {
    const result = await saveUpload({
      formData: makeFormData({ type: 'image/png' }),
      uploadsDir: dir,
      hash: 'a'.repeat(32),
    })
    expect(result.hash).toBe('a'.repeat(32))
    expect(result.ext).toBe('png')
    expect(result.contentType).toBe('image/png')
    expect(result.bytes).toBe(4)
    expect(result.staticPath).toBe('/static/' + 'a'.repeat(32) + '.png')
    expect(existsSync(join(dir, 'a'.repeat(32) + '.png'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('JPEG and WEBP map to canonical extensions', async () => {
    const j = await saveUpload({
      formData: makeFormData({ type: 'image/jpeg' }),
      uploadsDir: dir,
      hash: 'b'.repeat(32),
    })
    expect(j.ext).toBe('jpg')
    const w = await saveUpload({
      formData: makeFormData({ type: 'image/webp' }),
      uploadsDir: dir,
      hash: 'c'.repeat(32),
    })
    expect(w.ext).toBe('webp')
    rmSync(dir, { recursive: true, force: true })
  })

  test('rejects upload with no `image` field', async () => {
    await expect(saveUpload({
      formData: makeFormData({}),
      uploadsDir: dir,
    })).rejects.toThrow(/missing or non-file/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('rejects unsupported content-type without writing anything', async () => {
    await expect(saveUpload({
      formData: makeFormData({ type: 'application/zip' }),
      uploadsDir: dir,
    })).rejects.toThrow(/unsupported content-type/)
    expect(require('fs').readdirSync(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  test('rejects oversize upload before writing', async () => {
    const huge = new Uint8Array(DEFAULT_MAX_BYTES + 1)
    await expect(saveUpload({
      formData: makeFormData({ type: 'image/png', bytes: huge }),
      uploadsDir: dir,
    })).rejects.toThrow(/too large/)
    expect(require('fs').readdirSync(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('resolveStaticPath', () => {
  test('accepts a well-formed /static/<hash>.<ext> path', () => {
    const r = resolveStaticPath('/u', '/static/' + 'a'.repeat(32) + '.png')
    expect(r).not.toBeNull()
    expect(r!.contentType).toBe('image/png')
    expect(r!.path.endsWith('.png')).toBe(true)
  })

  test('rejects path-traversal attempts', () => {
    expect(resolveStaticPath('/u', '/static/../etc/passwd')).toBeNull()
    expect(resolveStaticPath('/u', '/static/' + 'a'.repeat(32) + '/../bad.png')).toBeNull()
  })

  test('rejects unknown extension', () => {
    expect(resolveStaticPath('/u', '/static/' + 'a'.repeat(32) + '.exe')).toBeNull()
  })

  test('rejects wrong hash length', () => {
    expect(resolveStaticPath('/u', '/static/abc.png')).toBeNull()
  })
})

describe('sweepUploads', () => {
  let dir: string
  beforeEach(() => { dir = mkTmpDir() })

  test('removes files older than ttl', () => {
    const old = join(dir, 'a'.repeat(32) + '.png')
    const fresh = join(dir, 'b'.repeat(32) + '.png')
    writeFileSync(old, new Uint8Array([1]))
    writeFileSync(fresh, new Uint8Array([1]))
    // Backdate `old` by 2 hours.
    const past = Date.now() - 2 * 60 * 60 * 1000
    require('fs').utimesSync(old, past / 1000, past / 1000)

    const removed = sweepUploads({ uploadsDir: dir, ttlMs: 60 * 60 * 1000 })
    expect(removed).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('ignores non-upload filenames', () => {
    writeFileSync(join(dir, 'random.txt'), 'hi')
    const removed = sweepUploads({ uploadsDir: dir, ttlMs: 0 })
    expect(removed).toBe(0)
    expect(existsSync(join(dir, 'random.txt'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns 0 when uploads dir does not exist', () => {
    const removed = sweepUploads({ uploadsDir: '/nonexistent/uploads', ttlMs: 0 })
    expect(removed).toBe(0)
  })
})
