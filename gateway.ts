/**
 * Gateway daemon core: one Bun.serve handling both the LINE webhook
 * endpoint and the plugin WSS endpoint on the same loopback port.
 *
 * This file wires the HTTP + WS surface; business-logic modules (webhook
 * signature verification, LINE API calls, permission routing) plug in
 * as they get implemented.
 */

import type { Server, ServerWebSocket } from 'bun'
import type { Database } from 'bun:sqlite'
import { join } from 'path'
import { ConnectionRegistry, type ConnectionData } from './connections'
import { HandlerManager } from './handler'
import { parseFrame, type PluginToGateway, type GatewayToPlugin } from './protocol'
import { PermissionRouter } from './permissions'
import { verifySignature, dispatch } from './webhook'
import { readAccess } from './access'
import type { LineConfig } from './env'
import { openDatabase, fetchMessages, recentChatIds, getMessageById } from './db'
import { saveUpload, resolveStaticPath, sweepUploads, DEFAULT_TTL_MS as UPLOADS_TTL_MS } from './uploads'
import {
  ReplyTokenCache, SentIdSet, DisplayNameCache, sendTextReplyPreferred,
  sendMentionAllReplyPreferred, pushText,
  pushPermission, sendImage, markAsRead, getContentStream, getEmojiImageStream,
  getStickerImageStream, stickerIdFromRawJson, fetchWithTimeout,
  getProfile, getGroupMemberProfile, getRoomMemberProfile,
  type ChunkMode, type GetContentStream,
} from './line-api'

export const GATEWAY_VERSION = '0.1.0'

export interface GatewayOptions {
  port: number
  /** Grace period (ms) before a disconnected handler forfeits the title. */
  handlerGraceMs?: number
  /**
   * Optional LINE config. When absent, /webhook returns 503 and
   * push_permission fails fast. The WSS surface still works so plugin
   * dev can proceed without credentials.
   */
  lineConfig?: LineConfig
  /** Override permission TTL (defaults to PermissionRouter's 10 min). */
  permissionTtlMs?: number
  /**
   * Optional override for the message archive path. Defaults to
   * `<stateDir>/messages.db` when lineConfig is present, `:memory:`
   * otherwise so dev without credentials doesn't leave stray files.
   */
  dbPath?: string
  /** `send_image` allow-window — chat must have inbound within this ms. */
  sendImageAllowWindowMs?: number
}

export interface GatewayHandle {
  server: Server<ConnectionData>
  registry: ConnectionRegistry
  handlers: HandlerManager
  permissions: PermissionRouter
  db: Database
  replyTokens: ReplyTokenCache
  sentIds: SentIdSet
  stop(): Promise<void>
}

// Default "recent enough to be a known chat" window for send_image.
// Original plugin used session-scoped KNOWN_CHAT_IDS; with multi-session
// sharing one archive, a time window is the sensible equivalent.
const DEFAULT_SEND_IMAGE_ALLOW_WINDOW_MS = 24 * 60 * 60 * 1000

export function startGateway(opts: GatewayOptions): GatewayHandle {
  const registry = new ConnectionRegistry()
  const handlers = new HandlerManager({ graceMs: opts.handlerGraceMs })
  const permissions = new PermissionRouter({ ttlMs: opts.permissionTtlMs })
  const replyTokens = new ReplyTokenCache()
  const sentIds = new SentIdSet()
  const lineConfig = opts.lineConfig

  // DisplayNameCache — only populated when LINE credentials are configured,
  // since profile lookups need the bot token. The fetcher dispatches to
  // the correct LINE endpoint based on source type (1-to-1 / group / room)
  // so per-group nicknames override the default displayName.
  const displayNames = lineConfig?.configured
    ? new DisplayNameCache(async (userId, source, chatId) => {
        const token = lineConfig.token!
        let profile = null
        if (source === 'group') {
          profile = await getGroupMemberProfile(chatId, userId, token)
        } else if (source === 'room') {
          profile = await getRoomMemberProfile(chatId, userId, token)
        } else {
          profile = await getProfile(userId, token)
        }
        return profile?.displayName ?? null
      })
    : undefined

  const dbPath = opts.dbPath
    ?? (lineConfig ? join(lineConfig.stateDir, 'messages.db') : ':memory:')
  const db = openDatabase(dbPath)

  const sendImageWindowMs = opts.sendImageAllowWindowMs ?? DEFAULT_SEND_IMAGE_ALLOW_WINDOW_MS

  const send = (ws: ServerWebSocket<ConnectionData>, frame: GatewayToPlugin): void => {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // Connection dropped; onclose will handle cleanup.
    }
  }

  const server = Bun.serve<ConnectionData>({
    hostname: '127.0.0.1',
    port: opts.port,
    // WSS is long-lived — disable idle cutoff so Bun doesn't close connections
    // during natural quiet periods between LINE events.
    idleTimeout: 0,

    fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname === '/ws') {
        // Capture cc_session_id from the query so we have *something* for
        // logging even before the hello frame arrives. hello will overwrite.
        const ccHint = url.searchParams.get('cc_session_id') ?? ''
        const upgraded = server.upgrade(req, {
          data: {
            cc_session_id: ccHint,
            pid: 0,
            plugin_version: '',
            connected_at: Date.now(),
          } satisfies ConnectionData,
        })
        return upgraded ? undefined : new Response('WS upgrade failed', { status: 400 })
      }

      if (url.pathname === '/webhook' && req.method === 'POST') {
        if (!lineConfig || !lineConfig.configured) {
          return new Response('LINE credentials not configured', { status: 503 })
        }
        return (async () => {
          const body = await req.text()
          const sig = req.headers.get('x-line-signature') ?? ''
          if (!verifySignature(body, sig, lineConfig.secret!)) {
            return new Response('Unauthorized', { status: 401 })
          }
          let payload: unknown
          try { payload = JSON.parse(body) } catch {
            return new Response('Bad Request', { status: 400 })
          }
          // access.json is re-read per webhook so `allowFrom[0]` edits
          // take effect without a gateway restart.
          const snapshot = readAccess(lineConfig.accessFile)
          const summary = dispatch(payload as any, {
            registry,
            handlers,
            permissions,
            primaryOwner: () => snapshot.primaryOwner,
            db,
            replyTokens,
            sentIds,
            displayNames,
          })
          return Response.json({ ok: true, ...summary })
        })()
      }

      // Loopback-only binary proxy for LINE media. Gateway holds the
      // channel token, plugin does not — so the plugin fetches media via
      // this endpoint and then inlines or saves the bytes as appropriate.
      // Path: /content/<numeric-message-id>. Only numeric ids are
      // accepted — a strict regex defends against accidentally proxying
      // arbitrary URL segments if the plugin mis-interpolates.
      const contentMatch = url.pathname.match(/^\/content\/(\d{1,32})$/)
      if (contentMatch && req.method === 'GET') {
        if (!lineConfig || !lineConfig.configured) {
          return new Response('LINE credentials not configured', { status: 503 })
        }
        const messageId = contentMatch[1]!
        return (async () => {
          try {
            const stream = await resolveContentStream(messageId, lineConfig.token!, db)
            return new Response(stream.body, {
              status: 200,
              headers: {
                'content-type': stream.contentType,
                ...(stream.contentLength > 0
                  ? { 'content-length': String(stream.contentLength) }
                  : {}),
              },
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return new Response('content fetch failed: ' + msg, { status: 502 })
          }
        })()
      }

      // POST /upload — accept multipart `image=<file>` from plugins, store
      // under `<stateDir>/uploads/<hash>.<ext>`, return JSON with the
      // `static_path` and (if `LINE_GATEWAY_PUBLIC_URL` is set) a fully
      // qualified `public_url` LINE can fetch via `send_image`.
      if (url.pathname === '/upload' && req.method === 'POST') {
        if (!lineConfig) {
          return new Response('uploads disabled (no LINE config / state dir)', { status: 503 })
        }
        return (async () => {
          try {
            const formData = await req.formData()
            const result = await saveUpload({
              formData,
              uploadsDir: lineConfig.uploadsDir,
            })
            const publicUrl = lineConfig.publicBaseUrl
              ? lineConfig.publicBaseUrl + result.staticPath
              : null
            return Response.json({
              hash: result.hash,
              ext: result.ext,
              content_type: result.contentType,
              bytes: result.bytes,
              static_path: result.staticPath,
              public_url: publicUrl,
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return new Response('upload failed: ' + msg, { status: 400 })
          }
        })()
      }

      // GET /static/<hash>.<ext> — serve a previously uploaded image. No
      // auth: this is the URL LINE itself fetches when the chat opens.
      // LINE caches into its own CDN after the first hit, so a subsequent
      // sweep here doesn't break already-delivered messages.
      if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
        if (!lineConfig) return new Response('Not Found', { status: 404 })
        const resolved = resolveStaticPath(lineConfig.uploadsDir, url.pathname)
        if (!resolved) return new Response('Not Found', { status: 404 })
        return (async () => {
          const file = Bun.file(resolved.path)
          if (!(await file.exists())) {
            return new Response('Not Found', { status: 404 })
          }
          return new Response(file, {
            status: 200,
            headers: {
              'content-type': resolved.contentType,
              'cache-control': 'public, max-age=86400, immutable',
            },
          })
        })()
      }

      // Loopback-only proxy for LINE inline emoji (sticonshop CDN).
      // Path shape: /emoji/<24-hex-productId>/<emojiId>. CDN itself is
      // public, but routing through the gateway keeps the binary off
      // WSS frames (consistent with /content) and concentrates LINE
      // URL knowledge in one place.
      const emojiMatch = url.pathname.match(/^\/emoji\/([a-f0-9]{24})\/([A-Za-z0-9_-]{1,16})$/)
      if (emojiMatch && req.method === 'GET') {
        const productId = emojiMatch[1]!
        const emojiId = emojiMatch[2]!
        return (async () => {
          try {
            const stream = await getEmojiImageStream(productId, emojiId)
            return new Response(stream.body, {
              status: 200,
              headers: {
                'content-type': stream.contentType,
                ...(stream.contentLength > 0
                  ? { 'content-length': String(stream.contentLength) }
                  : {}),
              },
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return new Response('emoji fetch failed: ' + msg, { status: 502 })
          }
        })()
      }

      if (url.pathname === '/healthz') {
        return Response.json({
          ok: true,
          version: GATEWAY_VERSION,
          configured: !!lineConfig?.configured,
        })
      }

      return new Response('Not Found', { status: 404 })
    },

    websocket: {
      idleTimeout: 0,
      maxPayloadLength: 1024 * 1024,
      backpressureLimit: 1024 * 1024,

      open(_ws) {
        // No-op; registry entry is deferred to the hello frame because we
        // need the authoritative cc_session_id and plugin_version from
        // there, not from URL query params.
      },

      message(ws, raw) {
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
        const frame = parseFrame<PluginToGateway>(text)
        if (!frame) return

        switch (frame.type) {
          case 'hello': {
            ws.data.cc_session_id = frame.cc_session_id
            ws.data.pid = frame.pid
            ws.data.plugin_version = frame.plugin_version
            registry.add(ws, { ...ws.data })
            send(ws, {
              type: 'hello_ack',
              is_handler: handlers.isHandler(frame.cc_session_id),
              current_handler: handlers.currentHandler(),
              gateway_version: GATEWAY_VERSION,
            })
            process.stderr.write(
              'line-gateway: hello cc=' + frame.cc_session_id +
              ' pid=' + frame.pid +
              ' plugin=' + frame.plugin_version +
              ' handler=' + (handlers.currentHandler() ?? '<none>') + '\n',
            )
            break
          }

          case 'claim': {
            if (!ws.data.cc_session_id) {
              send(ws, { type: 'claim_ack', ok: false, reason: 'hello before claim' })
              process.stderr.write('line-gateway: claim rejected — hello before claim\n')
              break
            }
            const previous = handlers.currentHandler()
            const outcome = handlers.claim(ws.data.cc_session_id, frame.force === true)
            send(ws, {
              type: 'claim_ack',
              ok: outcome.ok,
              reason: outcome.reason,
              previous_handler: outcome.previous,
            })
            process.stderr.write(
              'line-gateway: claim cc=' + ws.data.cc_session_id +
              ' force=' + (frame.force === true) +
              ' ok=' + outcome.ok +
              ' previous=' + (previous ?? '<none>') +
              (outcome.reason ? ' reason=' + outcome.reason : '') + '\n',
            )
            // If we displaced someone else, let them know.
            if (outcome.ok && previous && previous !== ws.data.cc_session_id) {
              registry.send(previous, {
                type: 'handler_lost',
                displaced_by: ws.data.cc_session_id,
              })
            }
            break
          }

          case 'release': {
            if (ws.data.cc_session_id) handlers.release(ws.data.cc_session_id)
            break
          }

          case 'ping': {
            send(ws, { type: 'pong' })
            break
          }

          case 'api_request': {
            void handleApiRequest(ws, frame, {
              lineConfig,
              db,
              replyTokens,
              sentIds,
              permissions,
              sendImageWindowMs,
            }).then(
              response => send(ws, response),
              err => send(ws, {
                type: 'api_response', req_id: frame.req_id, ok: false,
                error: err instanceof Error ? err.message : String(err),
              }),
            )
            break
          }
        }
      },

      close(ws) {
        const cc = ws.data.cc_session_id
        if (!cc) return
        // Only start the handler grace period when *this specific* ws was
        // the live registry entry. A re-hello from the same cc (plugin
        // restart / /mcp reconnect) displaces the old socket, which then
        // fires a late close event — without this guard we'd start a
        // grace period on the already-reclaimed handler seat, and reap it
        // after 30 s while the plugin is actually still connected.
        const wasLive = registry.remove(cc, ws)
        if (wasLive) handlers.onDisconnect(cc)
        process.stderr.write(
          'line-gateway: close cc=' + cc +
          ' wasLive=' + wasLive +
          ' handler=' + (handlers.currentHandler() ?? '<none>') + '\n',
        )
      },

      drain(_ws) {
        // Backpressure relieved — future queued pushes could flush here.
      },
    },
  })

  // Background sweep for /uploads. Runs hourly. Cheap (one readdir +
  // unlinkSync per stale entry) and we don't bother awaiting it.
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  if (lineConfig?.uploadsDir) {
    sweepTimer = setInterval(() => {
      try {
        const removed = sweepUploads({ uploadsDir: lineConfig.uploadsDir, ttlMs: UPLOADS_TTL_MS })
        if (removed > 0) {
          process.stderr.write('line-gateway: uploads sweep removed ' + removed + ' files\n')
        }
      } catch (e) {
        process.stderr.write('line-gateway: uploads sweep failed: ' + e + '\n')
      }
    }, 60 * 60 * 1000)
  }

  const stop = async (): Promise<void> => {
    if (sweepTimer) clearInterval(sweepTimer)
    registry.closeAll()
    await server.stop(true)
    try { db.close() } catch {}
  }

  return { server, registry, handlers, permissions, db, replyTokens, sentIds, stop }
}

// ---------------------------------------------------------------------------
// api_request dispatch
// ---------------------------------------------------------------------------

interface ApiRequestDeps {
  lineConfig: LineConfig | undefined
  db: Database
  replyTokens: ReplyTokenCache
  sentIds: SentIdSet
  permissions: PermissionRouter
  sendImageWindowMs: number
}

function ok(req_id: string, result: unknown): GatewayToPlugin {
  return { type: 'api_response', req_id, ok: true, result }
}
function fail(req_id: string, error: string): GatewayToPlugin {
  return { type: 'api_response', req_id, ok: false, error }
}

/**
 * Unified content fetcher for both `/content/<id>` proxy and the
 * `get_content` api_request HEAD probe. Sticker messages live on LINE's
 * public CDN (the Messaging API returns 400 for sticker binaries), so we
 * peek at the archived `message_type` and route accordingly. Non-sticker
 * messages (or sticker rows missing from the archive) fall through to
 * the regular LINE Data API path.
 */
export async function resolveContentStream(
  messageId: string,
  token: string,
  db: Database,
): Promise<GetContentStream> {
  const row = getMessageById(db, messageId)
  if (row && row.message_type === 'sticker') {
    const stickerId = stickerIdFromRawJson(row.raw_json)
    if (stickerId) return getStickerImageStream(stickerId)
  }
  return getContentStream(messageId, token)
}

async function handleApiRequest(
  ws: ServerWebSocket<ConnectionData>,
  frame: Extract<PluginToGateway, { type: 'api_request' }>,
  deps: ApiRequestDeps,
): Promise<GatewayToPlugin> {
  const args = frame.args ?? {}
  const method = frame.method
  const cc = ws.data.cc_session_id

  if (!cc) return fail(frame.req_id, 'hello before api_request')

  // fetch_messages is pure-local — doesn't need credentials.
  if (method === 'fetch_messages') {
    const chat_id = typeof args.chat_id === 'string' ? args.chat_id : undefined
    const limit   = typeof args.limit   === 'number' ? args.limit   : undefined
    const since   = typeof args.since   === 'string' ? args.since   : undefined
    const rows = fetchMessages(deps.db, { chat_id, limit, since })
    return ok(frame.req_id, { messages: rows })
  }

  if (!deps.lineConfig || !deps.lineConfig.configured) {
    return fail(frame.req_id, method + ': LINE credentials not configured')
  }
  const token = deps.lineConfig.token!

  const chunkLimit: number = typeof args.chunkLimit === 'number' ? args.chunkLimit : 5000
  const chunkMode: ChunkMode = args.chunkMode === 'length' ? 'length' : 'newline'

  try {
    switch (method) {
      case 'reply': {
        const chat_id = requireStr(args.chat_id, 'reply.chat_id')
        const text    = requireStr(args.text, 'reply.text')
        const quoteToken = typeof args.quote_token === 'string' ? args.quote_token : undefined
        const mentionUserIds = Array.isArray(args.mention_user_ids)
          ? args.mention_user_ids.filter((x): x is string => typeof x === 'string')
          : undefined
        const r = await sendTextReplyPreferred(chat_id, text, token, {
          chunkLimit, chunkMode, replyTokens: deps.replyTokens, sentIds: deps.sentIds,
          quoteToken, mentionUserIds,
        })
        return ok(frame.req_id, r)
      }

      case 'push': {
        const to   = requireStr(args.to, 'push.to')
        const text = requireStr(args.text, 'push.text')
        await pushText(to, text, token, { chunkLimit, chunkMode, sentIds: deps.sentIds })
        return ok(frame.req_id, { method: 'push' })
      }

      case 'reply_all': {
        const chat_id = requireStr(args.chat_id, 'reply_all.chat_id')
        const text    = requireStr(args.text, 'reply_all.text')
        const r = await sendMentionAllReplyPreferred(chat_id, text, token, {
          replyTokens: deps.replyTokens, sentIds: deps.sentIds,
        })
        return ok(frame.req_id, r)
      }

      case 'send_image': {
        const chat_id   = requireStr(args.chat_id, 'send_image.chat_id')
        const image_url = requireStr(args.image_url, 'send_image.image_url')
        const preview   = typeof args.preview_url === 'string' ? args.preview_url : image_url
        const allowed = isRecentChat(deps.db, chat_id, deps.sendImageWindowMs)
        if (!allowed) {
          return fail(frame.req_id,
            'send_image rejected: chat_id "' + chat_id +
            '" has no inbound in the last 24h. Only send images to chats that recently messaged the bot.')
        }
        await sendImage(chat_id, image_url, preview, token, deps.sentIds)
        return ok(frame.req_id, { method: 'send_image' })
      }

      case 'push_permission': {
        const to = requireStr(args.to, 'push_permission.to')
        const body = requireStr(args.body, 'push_permission.body')
        const request_id = requireStr(args.request_id, 'push_permission.request_id')
        // Register the routing entry *before* the push so a fast user reply
        // can't race us and hit an unknown request_id.
        deps.permissions.register(request_id, cc)
        try {
          await pushPermission(to, body, request_id, token, deps.sentIds)
        } catch (e) {
          deps.permissions.pop(request_id)  // unwind on failure
          throw e
        }
        return ok(frame.req_id, { method: 'push_permission' })
      }

      case 'get_content': {
        const message_id = requireStr(args.message_id, 'get_content.message_id')
        // HEAD-style probe: just pull the content-type + length without
        // reading the body. Plugin then GETs /content/<id> on loopback to
        // stream the bytes — keeping the LINE token server-side and the
        // WSS frames lean (binary never crosses WSS).
        const stream = await resolveContentStream(message_id, token, deps.db)
        try { await stream.body.cancel() } catch {}
        return ok(frame.req_id, {
          content_type: stream.contentType,
          content_length: stream.contentLength,
        })
      }

      case 'get_emoji': {
        // Same probe pattern as get_content: HEAD-style validation, then
        // plugin downloads the bytes via the loopback /emoji proxy.
        const productId = requireStr(args.productId, 'get_emoji.productId')
        const emojiId = requireStr(args.emojiId, 'get_emoji.emojiId')
        const stream = await getEmojiImageStream(productId, emojiId)
        try { await stream.body.cancel() } catch {}
        return ok(frame.req_id, {
          content_type: stream.contentType,
          content_length: stream.contentLength,
        })
      }

      case 'mark_as_read' as any: {
        // Optional convenience; matches LINE's /chat/markAsRead endpoint.
        const markToken = requireStr(args.token, 'mark_as_read.token')
        await markAsRead(markToken, token)
        return ok(frame.req_id, { method: 'mark_as_read' })
      }

      case 'upload_file': {
        // Path safety (realpathSync containment) lives in the plugin because
        // the plugin is the one with local fs access. Gateway only offers
        // the gofile.io HTTPS round-trip.
        const file_url = requireStr(args.file_url, 'upload_file.file_url')
        const file_name = typeof args.file_name === 'string' ? args.file_name : 'file'
        const expireMinutes = typeof args.expire_minutes === 'number' ? args.expire_minutes : 30
        if (expireMinutes < 1 || expireMinutes > 10080) {
          return fail(frame.req_id, 'upload_file: expire_minutes must be between 1 and 10080')
        }
        const result = await uploadToGofile(file_url, file_name, expireMinutes)
        return ok(frame.req_id, result)
      }

      default:
        return fail(frame.req_id, 'unknown api_request method: ' + method)
    }
  } catch (e) {
    return fail(frame.req_id, e instanceof Error ? e.message : String(e))
  }
}

function requireStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(field + ' must be a non-empty string')
  }
  return v
}

function isRecentChat(db: Database, chatId: string, windowMs: number): boolean {
  // received_at is a Taipei-offset ISO string (`...+08:00`); for a correct
  // lexicographic compare, build the cutoff in the same format.
  const cutoffDate = new Date(Date.now() - windowMs)
  const tpe = new Date(cutoffDate.getTime() + 8 * 3600 * 1000)
    .toISOString().replace('Z', '+08:00')
  return recentChatIds(db, tpe).includes(chatId)
}

// --- gofile.io upload -------------------------------------------------------

interface GofileResult {
  download_page: string
  password: string
  expires_in_minutes: number
}

async function uploadToGofile(fileUrl: string, fileName: string, expireMinutes: number): Promise<GofileResult> {
  const { randomBytes } = await import('crypto')
  const pw = randomBytes(12).toString('base64url')

  // Fetch the file bytes first so gofile sees a Blob body.
  const src = await fetchWithTimeout(fileUrl, { method: 'GET' }, 60_000)
  if (!src.ok) throw new Error('upload_file: fetching source URL failed: HTTP ' + src.status)
  const blob = await src.blob()

  const serverRes = await fetchWithTimeout('https://api.gofile.io/servers')
  if (!serverRes.ok) throw new Error('gofile: could not get upload server (HTTP ' + serverRes.status + ')')
  const serverData = (await serverRes.json() as any).data
  const uploadServer = serverData.servers?.[0]?.name
  if (!uploadServer) throw new Error('gofile: no upload server available')

  const form = new FormData()
  form.append('file', blob, fileName)
  const upRes = await fetchWithTimeout(
    'https://' + uploadServer + '.gofile.io/contents/uploadfile',
    { method: 'POST', body: form },
    60_000,
  )
  if (!upRes.ok) throw new Error('gofile upload failed: HTTP ' + upRes.status)
  const up = (await upRes.json() as any).data

  const expiry = Math.floor(Date.now() / 1000) + expireMinutes * 60
  const headers = { 'Content-Type': 'application/json' }
  const pwRes = await fetchWithTimeout('https://api.gofile.io/contents/' + up.parentFolder + '/update', {
    method: 'PUT', headers,
    body: JSON.stringify({ token: up.guestToken, attribute: 'password', attributeValue: pw }),
  })
  if (!pwRes.ok) throw new Error('gofile: failed to set password (HTTP ' + pwRes.status + ')')
  const expRes = await fetchWithTimeout('https://api.gofile.io/contents/' + up.parentFolder + '/update', {
    method: 'PUT', headers,
    body: JSON.stringify({ token: up.guestToken, attribute: 'expiry', attributeValue: expiry }),
  })
  if (!expRes.ok) throw new Error('gofile: failed to set expiry (HTTP ' + expRes.status + ')')

  return {
    download_page: up.downloadPage,
    password: pw,
    expires_in_minutes: expireMinutes,
  }
}
