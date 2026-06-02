/**
 * Local-disk upload store for `send_image(file_path)`.
 *
 * Plugin POSTs multipart `image=<file>` to gateway `/upload`. We persist
 * to `<stateDir>/uploads/<random-hash>.<ext>` with a long expiry, so
 * LINE can fetch the image once via `<publicBaseUrl>/static/<hash>.<ext>`.
 * LINE mirrors fetched images to its own CDN and never re-fetches, so a
 * later TTL sweep here does not affect already-delivered messages.
 */

import { join } from 'path'
import { mkdirSync, statSync, unlinkSync, readdirSync } from 'fs'
import { randomBytes } from 'crypto'

/** LINE Push Image rejects original > 10 MB; cap at 10 MiB to be safe. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
/** Default sweep TTL — long enough that LINE has fetched & mirrored. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000  // 24h

/**
 * Whitelist of MIME types we'll accept and the canonical extension we
 * write to disk. Keep narrow so plugin can't be tricked into uploading
 * arbitrary binaries we then serve back as image/*.
 */
const MIME_TO_EXT: Record<string, 'png' | 'jpg' | 'webp' | 'gif'> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/webp': 'webp',
  'image/gif':  'gif',
}

const EXT_TO_MIME: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
}

export interface SaveResult {
  hash: string
  ext: string
  contentType: string
  bytes: number
  staticPath: string  // "/static/<hash>.<ext>" — relative path under publicBaseUrl
}

/** Generate a 16-byte hex hash; collision-proof for our scale. */
export function newUploadHash(): string {
  return randomBytes(16).toString('hex')
}

/** Resolve an upload extension into its canonical content-type, or null. */
export function contentTypeForExt(ext: string): string | null {
  return EXT_TO_MIME[ext.toLowerCase()] ?? null
}

/**
 * Persist a multipart upload to disk. Throws on:
 *   - missing file part
 *   - unknown / non-image MIME type
 *   - body too large (declared OR actual)
 */
export async function saveUpload(opts: {
  formData: FormData
  uploadsDir: string
  maxBytes?: number
  /** Override hash for tests. */
  hash?: string
}): Promise<SaveResult> {
  const file = opts.formData.get('image')
  if (!file || !(file instanceof Blob)) {
    throw new Error('upload: missing or non-file `image` field')
  }

  const declaredType = (file.type || '').toLowerCase()
  const ext = MIME_TO_EXT[declaredType]
  if (!ext) {
    throw new Error('upload: unsupported content-type (' + (declaredType || 'unknown') + ')')
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  if (file.size > maxBytes) {
    throw new Error('upload: file too large (' + file.size + ' bytes, max ' + maxBytes + ')')
  }

  try { mkdirSync(opts.uploadsDir, { recursive: true, mode: 0o700 }) } catch {}

  const hash = opts.hash ?? newUploadHash()
  const filename = hash + '.' + ext
  const dest = join(opts.uploadsDir, filename)
  const arrayBuf = await file.arrayBuffer()

  // Re-check actual byte length against the cap; declared `size` could lie.
  if (arrayBuf.byteLength > maxBytes) {
    throw new Error('upload: file too large after read (' + arrayBuf.byteLength + ' bytes)')
  }

  await Bun.write(dest, arrayBuf)
  return {
    hash,
    ext,
    contentType: EXT_TO_MIME[ext]!,
    bytes: arrayBuf.byteLength,
    staticPath: '/static/' + filename,
  }
}

/**
 * Strict resolver for `/static/<hash>.<ext>` GETs. Returns the absolute
 * disk path or `null` for invalid shapes — never lets the request name
 * traverse outside `uploadsDir`.
 */
export function resolveStaticPath(uploadsDir: string, requestPath: string):
  | { path: string; contentType: string }
  | null {
  const m = requestPath.match(/^\/static\/([a-f0-9]{32})\.([a-z]{3,4})$/)
  if (!m) return null
  const hash = m[1]!
  const ext = m[2]!
  const contentType = EXT_TO_MIME[ext]
  if (!contentType) return null
  return { path: join(uploadsDir, hash + '.' + ext), contentType }
}

/**
 * Delete uploads older than ttlMs. Safe to call on a timer.
 * Returns number of files removed.
 */
export function sweepUploads(opts: {
  uploadsDir: string
  ttlMs?: number
  now?: () => number
}): number {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ? opts.now() : Date.now()
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(opts.uploadsDir)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!/^[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif)$/i.test(name)) continue
    const full = join(opts.uploadsDir, name)
    try {
      const st = statSync(full)
      if (now - st.mtimeMs > ttl) {
        unlinkSync(full)
        removed++
      }
    } catch {
      // race or permission: skip
    }
  }
  return removed
}
