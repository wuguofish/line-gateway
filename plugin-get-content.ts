/**
 * Plugin-side get_content: fetch binary media from gateway's loopback
 * proxy, stream to the inbox directory, and (for small images) inline as
 * a base64 image block so Claude can see it directly.
 *
 * The gateway holds the LINE channel token; the plugin never does. This
 * module runs over plain HTTP (loopback only), not WSS — keeps binary
 * payloads off the per-message WSS cap and avoids large base64 hops.
 */

import { join, sep } from 'path'
import { mkdirSync, statSync, unlinkSync } from 'fs'

const DEFAULT_MAX_BYTES        = 100 * 1024 * 1024  // 100 MB hard cap
const DEFAULT_MAX_INLINE_BYTES =   5 * 1024 * 1024  // inline if ≤ 5 MB

export interface GetContentOptions {
  inboxDir: string
  gatewayHttpUrl: string
  /** Optional override for output filename. */
  filename?: string
  /** Override size caps for tests. */
  maxBytes?: number
  maxInlineBytes?: number
  /** HTTP fetcher hook for tests; defaults to global fetch. */
  fetcher?: typeof fetch
}

// MCP content-block shape used by the tool result.
export type ContentBlock =
  | { type: 'text';  text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface GetContentResult {
  /** Content blocks the caller should put into the MCP tool response. */
  content: ContentBlock[]
  /** Absolute path where the binary was written. */
  savedPath: string
  contentType: string
  bytes: number
}

/** Sanitize a user-supplied filename — strips path separators, control
 *  chars, Windows reserved names, and caps the length. */
export function safeFilename(raw: string, fallback: string): string {
  let out = raw
    .replace(/[/\\]/g, '_')
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 128)
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
  if (reserved.test(out)) out = '_' + out
  if (!out) out = fallback
  return out
}

export function validateMessageId(id: string): void {
  if (!/^\d{1,32}$/.test(id)) {
    throw new Error('get_content: invalid message_id (must be numeric LINE message ID)')
  }
}

export async function getContent(
  messageId: string,
  opts: GetContentOptions,
): Promise<GetContentResult> {
  validateMessageId(messageId)
  const maxBytes        = opts.maxBytes        ?? DEFAULT_MAX_BYTES
  const maxInlineBytes  = opts.maxInlineBytes  ?? DEFAULT_MAX_INLINE_BYTES
  const fetcher         = opts.fetcher         ?? fetch

  try { mkdirSync(opts.inboxDir, { recursive: true, mode: 0o700 }) } catch {}

  const url = opts.gatewayHttpUrl.replace(/\/+$/, '') + '/content/' + encodeURIComponent(messageId)
  const res = await fetcher(url, { method: 'GET' })
  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch {}
    throw new Error('get_content: gateway returned ' + res.status + (body ? ' — ' + body.slice(0, 200) : ''))
  }

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  const declaredLen = Number(res.headers.get('content-length') ?? '0')
  if (declaredLen > maxBytes) {
    throw new Error('get_content: content too large (' + declaredLen + ' bytes, max ' + maxBytes + ')')
  }

  const filename = safeFilename(opts.filename ?? messageId, messageId)
  const dest = join(opts.inboxDir, filename)

  const body = res.body
  if (!body) throw new Error('get_content: gateway response had no body')

  // Stream to disk so we never hold the full payload in RAM during download.
  const writer = Bun.file(dest).writer()
  let written = 0
  try {
    const reader = body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      written += value.byteLength
      if (written > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error('get_content: content exceeded max size (' + maxBytes + ' bytes)')
      }
      writer.write(value)
    }
    await writer.end()
  } catch (e) {
    try { await writer.end() } catch {}
    try { unlinkSync(dest) } catch {}
    throw e
  }

  // Defensive: confirm on-disk size matches written counter. Avoids a
  // silent partial-write showing up later as a corrupt inline image.
  try {
    const st = statSync(dest)
    if (st.size !== written) {
      throw new Error('get_content: on-disk size mismatch (' + st.size + ' vs ' + written + ')')
    }
  } catch (e) {
    try { unlinkSync(dest) } catch {}
    throw e
  }

  const blocks: ContentBlock[] = []
  if (contentType.startsWith('image/') && written <= maxInlineBytes) {
    const buf = Buffer.from(await Bun.file(dest).arrayBuffer())
    const b64 = buf.toString('base64')
    blocks.push({ type: 'text',  text: 'Saved to ' + dest + ' (' + contentType + ', ' + written + ' bytes)' })
    blocks.push({ type: 'image', data: b64, mimeType: contentType })
  } else {
    const note = contentType.startsWith('image/')
      ? ' — image too large to inline (>' + maxInlineBytes + ' bytes)'
      : ''
    blocks.push({ type: 'text', text: 'Saved to ' + dest + ' (' + contentType + ', ' + written + ' bytes)' + note })
  }

  return { content: blocks, savedPath: dest, contentType, bytes: written }
}

export interface GetEmojiOptions {
  gatewayHttpUrl: string
  /** Hard cap; LINE inline emoji are tiny in practice. */
  maxBytes?: number
  /** HTTP fetcher hook for tests; defaults to global fetch. */
  fetcher?: typeof fetch
}

/**
 * Fetch a LINE inline emoji image via the gateway loopback proxy and
 * return it inline as a base64 image block. Unlike `getContent` we never
 * touch disk — emoji files are tiny (typically a few KB) and the only
 * caller is "show this emoji to the model".
 */
export async function getEmoji(
  productId: string,
  emojiId: string,
  opts: GetEmojiOptions,
): Promise<{ content: ContentBlock[]; contentType: string; bytes: number }> {
  if (!/^[a-f0-9]{24}$/.test(productId)) {
    throw new Error('get_emoji: invalid productId (expected 24 lowercase hex chars)')
  }
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(emojiId)) {
    throw new Error('get_emoji: invalid emojiId')
  }

  const maxBytes = opts.maxBytes ?? (1 * 1024 * 1024)  // 1 MB hard cap
  const fetcher  = opts.fetcher  ?? fetch

  const url = opts.gatewayHttpUrl.replace(/\/+$/, '')
    + '/emoji/' + encodeURIComponent(productId) + '/' + encodeURIComponent(emojiId)
  const res = await fetcher(url, { method: 'GET' })
  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch {}
    throw new Error('get_emoji: gateway returned ' + res.status + (body ? ' — ' + body.slice(0, 200) : ''))
  }

  const contentType = res.headers.get('content-type') ?? 'image/png'
  const declaredLen = Number(res.headers.get('content-length') ?? '0')
  if (declaredLen > maxBytes) {
    throw new Error('get_emoji: content too large (' + declaredLen + ' bytes, max ' + maxBytes + ')')
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > maxBytes) {
    throw new Error('get_emoji: content exceeded max size (' + maxBytes + ' bytes)')
  }
  const b64 = buf.toString('base64')

  return {
    content: [
      { type: 'text', text: 'LINE inline emoji ' + productId + '/' + emojiId + ' (' + contentType + ', ' + buf.byteLength + ' bytes)' },
      { type: 'image', data: b64, mimeType: contentType },
    ],
    contentType,
    bytes: buf.byteLength,
  }
}

/**
 * Upload a local image file to gateway `/upload` and return the
 * pre-built static URL details. Plugin uses this to wrap
 * `send_image(file_path)`: read the file, hand it to gateway, then
 * call the existing api_request `send_image` with the resulting
 * `public_url`.
 */
export interface UploadResult {
  hash: string
  ext: string
  content_type: string
  bytes: number
  static_path: string
  /** Absolute URL LINE can fetch. `null` if gateway has no LINE_GATEWAY_PUBLIC_URL configured. */
  public_url: string | null
}

export interface UploadImageOptions {
  gatewayHttpUrl: string
  /** Override fetcher for tests. Defaults to global fetch. */
  fetcher?: typeof fetch
}

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
}

export async function uploadImageFile(
  filePath: string,
  opts: UploadImageOptions,
): Promise<UploadResult> {
  // Defer extension sniff to file metadata; let the gateway re-validate
  // the content-type so a bad caller can't lie us into serving foo.exe
  // as image/png.
  const ext = (filePath.split('.').pop() ?? '').toLowerCase()
  const mime = IMAGE_EXT_TO_MIME[ext]
  if (!mime) {
    throw new Error('send_image: unsupported file extension (' + ext + '). Use png/jpg/webp/gif.')
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    throw new Error('send_image: file not found: ' + filePath)
  }
  const bytes = await file.arrayBuffer()

  const form = new FormData()
  form.append('image', new Blob([bytes], { type: mime }), 'image.' + ext)

  const fetcher = opts.fetcher ?? fetch
  const url = opts.gatewayHttpUrl.replace(/\/+$/, '') + '/upload'
  const res = await fetcher(url, { method: 'POST', body: form })
  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch {}
    throw new Error('send_image upload: gateway returned ' + res.status + (body ? ' — ' + body.slice(0, 200) : ''))
  }
  return await res.json() as UploadResult
}

/** Convert `ws://host:port/ws` to `http://host:port` for the binary proxy. */
export function gatewayHttpFromWs(wsUrl: string): string {
  // strip any path, swap scheme
  const u = new URL(wsUrl)
  const scheme = u.protocol === 'wss:' ? 'https:' : 'http:'
  return scheme + '//' + u.host
}
