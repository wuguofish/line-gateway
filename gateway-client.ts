/**
 * Plugin-side WebSocket client for the gateway daemon.
 *
 * Responsibilities:
 *   - Connect to ws://127.0.0.1:<port>/ws, say `hello`, optionally `claim`.
 *   - Match `api_request` → `api_response` by req_id (Promise-based RPC).
 *   - Surface `inbound` / `permission_reply` / `handler_lost` frames to the
 *     owning plugin via callbacks.
 *   - Reconnect with exponential backoff, re-hello, re-claim.
 *
 * Intentionally decoupled from the MCP SDK — easier to unit-test with a
 * mock WebSocket than to stand up an stdio transport.
 */

import { randomUUID } from 'crypto'
import type {
  PluginToGateway,
  GatewayToPlugin,
  ApiRequestFrame,
  ApiResponseFrame,
  InboundFrame,
} from './protocol'

// Minimal surface of WebSocket used by this module — makes the class
// testable by passing a fake that emits open/message/close instead of
// dragging in a real network connection.
export interface WsLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(event: 'open', handler: () => void): void
  addEventListener(event: 'message', handler: (ev: { data: string | Uint8Array }) => void): void
  addEventListener(event: 'close', handler: (ev: { code: number; reason: string }) => void): void
  addEventListener(event: 'error', handler: (ev: unknown) => void): void
}

export type WsFactory = (url: string) => WsLike

const defaultFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike

export interface GatewayClientOptions {
  url: string
  cc_session_id: string
  pid: number
  plugin_version: string
  /** If true, send `claim` right after hello so we receive inbound frames. */
  claimOnConnect?: boolean
  /** Override reconnect behavior for tests. */
  wsFactory?: WsFactory
  /** Initial reconnect delay; doubles up to maxReconnectMs. Default 500. */
  reconnectBaseMs?: number
  maxReconnectMs?: number
  /** Default timeout for api_request -> api_response round-trip. */
  apiTimeoutMs?: number
  /** Hook for every inbound LINE event. */
  onInbound?: (event: unknown, enrichment?: InboundFrame['enrichment']) => void
  /** Hook for every permission reply arriving for our own push_permission. */
  onPermissionReply?: (p: { request_id: string; behavior: 'allow' | 'deny' }) => void
  /** Fired when gateway kicks us out of the handler seat. */
  onHandlerLost?: (displaced_by: string | null) => void
  /** Plain log sink (stderr by default). */
  log?: (msg: string) => void
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Result of an awaited claim — mirrors the `claim_ack` frame shape. */
export interface ClaimAckResult {
  ok: boolean
  reason?: string
  previous_handler: string | null
}

interface PendingClaim {
  resolve: (result: ClaimAckResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class GatewayClient {
  private ws: WsLike | null = null
  private readonly opts: Required<Omit<GatewayClientOptions,
    'onInbound' | 'onPermissionReply' | 'onHandlerLost' | 'log' | 'wsFactory'
  >> & {
    onInbound?: GatewayClientOptions['onInbound']
    onPermissionReply?: GatewayClientOptions['onPermissionReply']
    onHandlerLost?: GatewayClientOptions['onHandlerLost']
    log: (msg: string) => void
    wsFactory: WsFactory
  }
  private readonly pending = new Map<string, PendingCall>()
  private pendingClaim: PendingClaim | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private isHandler = false

  constructor(options: GatewayClientOptions) {
    this.opts = {
      url: options.url,
      cc_session_id: options.cc_session_id,
      pid: options.pid,
      plugin_version: options.plugin_version,
      claimOnConnect: options.claimOnConnect ?? false,
      reconnectBaseMs: options.reconnectBaseMs ?? 500,
      maxReconnectMs: options.maxReconnectMs ?? 30_000,
      apiTimeoutMs: options.apiTimeoutMs ?? 60_000,
      onInbound: options.onInbound,
      onPermissionReply: options.onPermissionReply,
      onHandlerLost: options.onHandlerLost,
      log: options.log ?? ((m) => process.stderr.write('line-gateway-plugin: ' + m + '\n')),
      wsFactory: options.wsFactory ?? defaultFactory,
    }
  }

  start(): void {
    this.stopped = false
    this.openSocket()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.failAllPending(new Error('gateway client stopped'))
    if (this.pendingClaim) {
      clearTimeout(this.pendingClaim.timer)
      this.pendingClaim.reject(new Error('gateway client stopped'))
      this.pendingClaim = null
    }
    try { this.ws?.close(1000, 'client stop') } catch {}
    this.ws = null
  }

  /** True once a handler seat is held and we can route inbound to Claude. */
  handler(): boolean {
    return this.isHandler
  }

  /**
   * Send an api_request and wait for its api_response. Resolves with the
   * response `result` on ok, rejects with `error` on !ok. Rejects with
   * timeout if the gateway takes longer than apiTimeoutMs.
   */
  async apiRequest(
    method: ApiRequestFrame['method'],
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const req_id = randomUUID()
    const frame: ApiRequestFrame = { type: 'api_request', req_id, method, args }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id)
        reject(new Error(`api_request(${method}) timed out after ${this.opts.apiTimeoutMs}ms`))
      }, this.opts.apiTimeoutMs)
      this.pending.set(req_id, { resolve, reject, timer })
      try {
        this.sendFrame(frame)
      } catch (e) {
        this.pending.delete(req_id)
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Advance the handler-claim state machine. Fire-and-forget. */
  claim(force = false): void {
    this.sendFrame({ type: 'claim', force })
  }

  /**
   * Send a claim and await the next `claim_ack`. Use this from MCP tool
   * handlers so the caller learns whether the seat was granted.
   *
   * Only one claim can be in-flight at a time — concurrent calls reject
   * with "claim already in progress". `claimOnConnect` ACKs that arrive
   * with no pending awaiter just update `isHandler` silently.
   */
  async claimWithAck(force = false, timeoutMs = 5_000): Promise<ClaimAckResult> {
    if (this.pendingClaim) {
      throw new Error('claim already in progress')
    }
    return new Promise<ClaimAckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClaim = null
        reject(new Error(`claim timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingClaim = { resolve, reject, timer }
      try {
        this.sendFrame({ type: 'claim', force })
      } catch (e) {
        clearTimeout(timer)
        this.pendingClaim = null
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  release(): void {
    this.sendFrame({ type: 'release' })
  }

  // --- internals ------------------------------------------------------------

  private sendFrame(frame: PluginToGateway): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error('gateway WS not open')
    }
    this.ws.send(JSON.stringify(frame))
  }

  private openSocket(): void {
    const ws = this.opts.wsFactory(this.opts.url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0
      this.opts.log('connected to ' + this.opts.url)
      try {
        this.sendFrame({
          type: 'hello',
          cc_session_id: this.opts.cc_session_id,
          pid: this.opts.pid,
          plugin_version: this.opts.plugin_version,
        })
        if (this.opts.claimOnConnect) this.claim(false)
      } catch (e) {
        this.opts.log('hello send failed: ' + (e instanceof Error ? e.message : String(e)))
      }
    })

    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)
      let frame: GatewayToPlugin
      try { frame = JSON.parse(raw) } catch {
        this.opts.log('non-JSON frame dropped')
        return
      }
      this.handleFrame(frame)
    })

    ws.addEventListener('close', (ev) => {
      this.opts.log(`ws closed code=${ev.code} reason=${ev.reason || '<none>'}`)
      this.isHandler = false
      this.ws = null
      if (!this.stopped) this.scheduleReconnect()
    })

    ws.addEventListener('error', (ev) => {
      this.opts.log('ws error: ' + String((ev as any)?.message ?? ev))
      // close event will follow; reconnection is scheduled there.
    })
  }

  private handleFrame(frame: GatewayToPlugin): void {
    switch (frame.type) {
      case 'hello_ack':
        this.isHandler = frame.is_handler
        return
      case 'claim_ack':
        if (frame.ok) this.isHandler = true
        if (this.pendingClaim) {
          clearTimeout(this.pendingClaim.timer)
          this.pendingClaim.resolve({
            ok: frame.ok,
            reason: frame.reason,
            previous_handler: frame.previous_handler ?? null,
          })
          this.pendingClaim = null
        }
        return
      case 'inbound':
        this.opts.onInbound?.(frame.event, frame.enrichment)
        return
      case 'permission_reply':
        this.opts.onPermissionReply?.({ request_id: frame.request_id, behavior: frame.behavior })
        return
      case 'handler_lost':
        this.isHandler = false
        this.opts.onHandlerLost?.(frame.displaced_by)
        return
      case 'pong':
        return
      case 'api_response':
        this.settleApiResponse(frame)
        return
    }
  }

  private settleApiResponse(frame: ApiResponseFrame): void {
    const pending = this.pending.get(frame.req_id)
    if (!pending) return
    this.pending.delete(frame.req_id)
    clearTimeout(pending.timer)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(new Error(frame.error ?? 'api_request failed'))
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.opts.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.opts.maxReconnectMs,
    )
    this.reconnectAttempt++
    this.opts.log(`reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.openSocket()
    }, delay)
  }
}
