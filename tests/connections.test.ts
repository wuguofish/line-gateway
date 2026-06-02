import { test, expect } from 'bun:test'
import { ConnectionRegistry, type ConnectionData } from '../connections'

// Minimal ServerWebSocket stand-in — just enough surface area for the
// registry's hot paths. Real test of the full WS round-trip lives in
// scratch/smoke-ws.ts (run manually against a live daemon) until we
// untangle bun:test's hang with WebSocket clients.
function mockWs(opts: { onClose?: (code: number, reason: string) => void; onSend?: (msg: string) => void } = {}) {
  let closed = false
  let closeCode: number | undefined
  let closeReason: string | undefined
  const sent: string[] = []
  const ws = {
    close(code: number, reason: string) {
      closed = true
      closeCode = code
      closeReason = reason
      opts.onClose?.(code, reason)
    },
    send(msg: string | Uint8Array) {
      const s = typeof msg === 'string' ? msg : new TextDecoder().decode(msg)
      sent.push(s)
      opts.onSend?.(s)
    },
    data: {} as ConnectionData,
  } as any
  return {
    ws,
    get closed() { return closed },
    get closeCode() { return closeCode },
    get closeReason() { return closeReason },
    sent,
  }
}

const mkData = (cc: string, pid = 1): ConnectionData => ({
  cc_session_id: cc,
  pid,
  plugin_version: '0.1.0',
  connected_at: Date.now(),
})

test('add tracks by cc_session_id and get returns it', () => {
  const r = new ConnectionRegistry()
  const m = mockWs()
  const conn = r.add(m.ws, mkData('cc-1'))
  expect(conn.data.cc_session_id).toBe('cc-1')
  expect(r.get('cc-1')).toBe(conn)
  expect(r.get('cc-unknown')).toBeUndefined()
})

test('add replacing the same cc_session_id closes the prior ws', () => {
  const r = new ConnectionRegistry()
  const a = mockWs()
  const b = mockWs()
  r.add(a.ws, mkData('cc-dup'))
  r.add(b.ws, mkData('cc-dup'))
  expect(a.closed).toBe(true)
  expect(a.closeCode).toBe(4000)
  expect(a.closeReason).toContain('superseded')
  expect(r.get('cc-dup')?.ws).toBe(b.ws)
})

test('add replacing a different cc_session_id does not touch unrelated entries', () => {
  const r = new ConnectionRegistry()
  const a = mockWs()
  const b = mockWs()
  r.add(a.ws, mkData('cc-A'))
  r.add(b.ws, mkData('cc-B'))
  expect(a.closed).toBe(false)
  expect(r.all()).toHaveLength(2)
})

test('remove only deletes if the ws still matches (race safety)', () => {
  const r = new ConnectionRegistry()
  const a = mockWs()
  const b = mockWs()
  r.add(a.ws, mkData('cc-race'))
  r.add(b.ws, mkData('cc-race')) // displaces a
  // A late onclose for the old ws should NOT evict b's entry.
  r.remove('cc-race', a.ws)
  expect(r.get('cc-race')?.ws).toBe(b.ws)
  // Closing the current one does evict.
  r.remove('cc-race', b.ws)
  expect(r.get('cc-race')).toBeUndefined()
})

test('remove returns true only when the ws was the live entry', () => {
  const r = new ConnectionRegistry()
  const a = mockWs()
  const b = mockWs()
  r.add(a.ws, mkData('cc-race'))
  r.add(b.ws, mkData('cc-race'))
  // stale ws — its late close shouldn't look like a real disconnect
  expect(r.remove('cc-race', a.ws)).toBe(false)
  // live ws
  expect(r.remove('cc-race', b.ws)).toBe(true)
  // once evicted, subsequent removes are no-ops
  expect(r.remove('cc-race', b.ws)).toBe(false)
})

test('send stringifies the frame to the target connection', () => {
  const r = new ConnectionRegistry()
  const m = mockWs()
  r.add(m.ws, mkData('cc-send'))
  const ok = r.send('cc-send', { type: 'pong' })
  expect(ok).toBe(true)
  expect(m.sent).toHaveLength(1)
  expect(JSON.parse(m.sent[0]!)).toEqual({ type: 'pong' })
})

test('send returns false when the target is not registered', () => {
  const r = new ConnectionRegistry()
  expect(r.send('cc-missing', { type: 'pong' })).toBe(false)
})

test('closeAll hangs up everyone and empties the registry', () => {
  const r = new ConnectionRegistry()
  const a = mockWs(), b = mockWs()
  r.add(a.ws, mkData('cc-A'))
  r.add(b.ws, mkData('cc-B'))
  r.closeAll('bye')
  expect(a.closed).toBe(true)
  expect(b.closed).toBe(true)
  expect(a.closeReason).toBe('bye')
  expect(r.all()).toHaveLength(0)
})
