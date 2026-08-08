import { test, expect, describe, beforeEach } from 'bun:test'
import { GatewayClient, type WsLike, type WsFactory } from '../gateway-client'

type Listener<T = unknown> = (ev: T) => void

class FakeWs implements WsLike {
  readyState = 0  // CONNECTING
  sent: string[] = []
  private listeners = new Map<string, Listener[]>()
  closed = false

  send(data: string): void { this.sent.push(data) }
  close(code: number = 1000, reason: string = ''): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.emit('close', { code, reason })
  }
  // WsLike's addEventListener is typed as an overloaded method; FakeWs just
  // stashes into a map regardless of event name. Cast through `as any` to
  // satisfy the narrow overload signature without splitting into variants.
  addEventListener = ((event: string, handler: Listener): void => {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event)!.push(handler)
  }) as unknown as WsLike['addEventListener']
  emit(event: string, ev?: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(ev)
  }
  open(): void {
    this.readyState = 1
    this.emit('open')
  }
  messageJson(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) })
  }
}

function makeFactory(): { factory: WsFactory; latest(): FakeWs } {
  let latest: FakeWs | null = null
  const factory: WsFactory = () => {
    latest = new FakeWs()
    return latest
  }
  return { factory, latest: () => latest! }
}

describe('GatewayClient', () => {
  let factoryHolder: ReturnType<typeof makeFactory>
  beforeEach(() => { factoryHolder = makeFactory() })

  test('sends hello on open', () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    const sent = factoryHolder.latest().sent.map(s => JSON.parse(s))
    expect(sent).toEqual([
      { type: 'hello', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1' },
    ])
    c.stop()
  })

  test('claimOnConnect sends claim right after hello', () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      claimOnConnect: true,
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    const sent = factoryHolder.latest().sent.map(s => JSON.parse(s))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ type: 'claim', force: false })
    c.stop()
  })

  test('hello_ack + claim_ack flip handler() flag', () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    expect(c.handler()).toBe(false)
    ws.messageJson({ type: 'hello_ack', is_handler: false, current_handler: null, gateway_version: '0.1' })
    expect(c.handler()).toBe(false)
    ws.messageJson({ type: 'claim_ack', ok: true, previous_handler: null })
    expect(c.handler()).toBe(true)
    c.stop()
  })

  test('apiRequest resolves on matching api_response', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()

    const p = c.apiRequest('fetch_messages', { limit: 5 })
    // Grab the req_id we just sent and echo a response.
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]!)
    ws.messageJson({ type: 'api_response', req_id: sent.req_id, ok: true, result: { messages: [] } })
    expect(await p).toEqual({ messages: [] })
    c.stop()
  })

  test('apiRequest rejects on !ok response', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    const p = c.apiRequest('reply', { chat_id: 'U0', text: 'hi' })
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]!)
    ws.messageJson({ type: 'api_response', req_id: sent.req_id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
    c.stop()
  })

  test('apiRequest times out', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      apiTimeoutMs: 50,
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    await expect(c.apiRequest('ping' as any, {})).rejects.toThrow(/timed out/)
    c.stop()
  })

  test('inbound frame fires onInbound callback', () => {
    const seen: unknown[] = []
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      onInbound: (e) => seen.push(e),
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    factoryHolder.latest().messageJson({ type: 'inbound', event: { id: 'EVENT' } })
    expect(seen).toEqual([{ id: 'EVENT' }])
    c.stop()
  })

  test('permission_reply fires onPermissionReply', () => {
    const seen: any[] = []
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      onPermissionReply: (p) => seen.push(p),
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    factoryHolder.latest().messageJson({ type: 'permission_reply', request_id: 'abcde', behavior: 'allow' })
    expect(seen).toEqual([{ request_id: 'abcde', behavior: 'allow' }])
    c.stop()
  })

  test('catchup_notice fires onCatchupNotice callback', () => {
    const seen: any[] = []
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      onCatchupNotice: (n) => seen.push(n),
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    factoryHolder.latest().messageJson({ type: 'catchup_notice', since: '2026-07-18T18:38:00.000+08:00', gap_ms: 125_000, count: 11 })
    expect(seen).toEqual([{ since: '2026-07-18T18:38:00.000+08:00', gap_ms: 125_000, count: 11 }])
    c.stop()
  })

  test('claimOnConnect losing the race fires onAutoClaimFailed', () => {
    const seen: any[] = []
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      claimOnConnect: true,
      onAutoClaimFailed: (info) => seen.push(info),
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    // No pendingClaim exists — claimOnConnect's claim() is fire-and-forget —
    // so this ack must be routed to onAutoClaimFailed, not silently dropped.
    factoryHolder.latest().messageJson({
      type: 'claim_ack', ok: false,
      reason: 'handler is currently cc-other — pass force:true to take over',
      previous_handler: 'cc-other',
    })
    expect(seen).toEqual([{ reason: 'handler is currently cc-other — pass force:true to take over', previous_handler: 'cc-other' }])
    expect(c.handler()).toBe(false)
    c.stop()
  })

  test('a successful claimWithAck does not spuriously fire onAutoClaimFailed', async () => {
    const seen: any[] = []
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      onAutoClaimFailed: (info) => seen.push(info),
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    const p = c.claimWithAck(false)
    ws.messageJson({ type: 'claim_ack', ok: false, reason: 'busy', previous_handler: 'cc-other' })
    await p
    // This ack had a pendingClaim (explicit claimWithAck) — it must resolve
    // that promise, not the auto-claim-failed path.
    expect(seen).toEqual([])
    c.stop()
  })

  test('handler_lost clears handler flag and fires callback', () => {
    const seen: any[] = []
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      onHandlerLost: (d) => seen.push(d),
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    ws.messageJson({ type: 'claim_ack', ok: true, previous_handler: null })
    expect(c.handler()).toBe(true)
    ws.messageJson({ type: 'handler_lost', displaced_by: 'cc-other' })
    expect(c.handler()).toBe(false)
    expect(seen).toEqual(['cc-other'])
    c.stop()
  })

  test('pending apiRequest rejects when client is stopped', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    const p = c.apiRequest('fetch_messages', {})
    c.stop()
    await expect(p).rejects.toThrow(/stopped/)
  })

  test('close without stop schedules a reconnect', async () => {
    let factoryCalls = 0
    const wsList: FakeWs[] = []
    const factory: WsFactory = () => {
      factoryCalls++
      const w = new FakeWs()
      wsList.push(w)
      return w
    }
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      reconnectBaseMs: 10, maxReconnectMs: 10,
      wsFactory: factory,
    })
    c.start()
    wsList[0]!.open()
    expect(factoryCalls).toBe(1)
    wsList[0]!.close(1006, 'bye')
    await Bun.sleep(30)
    expect(factoryCalls).toBeGreaterThanOrEqual(2)
    c.stop()
  })

  test('non-JSON frame is dropped without crashing', () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    factoryHolder.latest().emit('message', { data: 'not json' })
    // If we didn't throw, we're good.
    expect(true).toBe(true)
    c.stop()
  })

  test('claimWithAck resolves with ok=true on success', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    const p = c.claimWithAck(false)
    const lastSent = JSON.parse(ws.sent[ws.sent.length - 1]!)
    expect(lastSent).toEqual({ type: 'claim', force: false })
    ws.messageJson({ type: 'claim_ack', ok: true, previous_handler: null })
    expect(await p).toEqual({ ok: true, previous_handler: null })
    expect(c.handler()).toBe(true)
    c.stop()
  })

  test('claimWithAck forwards force=true', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    const p = c.claimWithAck(true)
    const lastSent = JSON.parse(ws.sent[ws.sent.length - 1]!)
    expect(lastSent).toEqual({ type: 'claim', force: true })
    ws.messageJson({ type: 'claim_ack', ok: true, previous_handler: 'cc-other' })
    expect(await p).toEqual({ ok: true, previous_handler: 'cc-other' })
    c.stop()
  })

  test('claimWithAck resolves with ok=false + reason on rejection', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    const p = c.claimWithAck(false)
    ws.messageJson({
      type: 'claim_ack',
      ok: false,
      reason: 'handler is currently anon-3800 — pass force:true to take over',
      previous_handler: 'anon-3800',
    })
    const result = await p
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('force:true')
    expect(result.previous_handler).toBe('anon-3800')
    expect(c.handler()).toBe(false)
    c.stop()
  })

  test('claimWithAck rejects on timeout', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    await expect(c.claimWithAck(false, 30)).rejects.toThrow(/timed out/)
    c.stop()
  })

  test('claimWithAck rejects when called twice in a row', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    const p1 = c.claimWithAck(false)
    await expect(c.claimWithAck(true)).rejects.toThrow(/already in progress/)
    ws.messageJson({ type: 'claim_ack', ok: true, previous_handler: null })
    await p1
    c.stop()
  })

  test('claimWithAck rejects when client is stopped mid-flight', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      wsFactory: factoryHolder.factory,
    })
    c.start()
    factoryHolder.latest().open()
    const p = c.claimWithAck(false)
    c.stop()
    await expect(p).rejects.toThrow(/stopped/)
  })

  test('claimOnConnect ack does not interfere with later claimWithAck', async () => {
    const c = new GatewayClient({
      log: () => {},
      url: 'ws://x', cc_session_id: 'cc-1', pid: 42, plugin_version: '0.1',
      claimOnConnect: true,
      wsFactory: factoryHolder.factory,
    })
    c.start()
    const ws = factoryHolder.latest()
    ws.open()
    // The auto-claim ACK arrives without any pending claimWithAck.
    ws.messageJson({ type: 'claim_ack', ok: false, reason: 'busy', previous_handler: 'cc-other' })
    expect(c.handler()).toBe(false)
    // User then explicitly forces — should resolve cleanly.
    const p = c.claimWithAck(true)
    ws.messageJson({ type: 'claim_ack', ok: true, previous_handler: 'cc-other' })
    expect(await p).toEqual({ ok: true, previous_handler: 'cc-other' })
    expect(c.handler()).toBe(true)
    c.stop()
  })
})
