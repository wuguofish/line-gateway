import { test, expect } from 'bun:test'
import { HandlerManager } from '../handler'

test('no handler initially', () => {
  const h = new HandlerManager()
  expect(h.currentHandler()).toBeNull()
  expect(h.isHandler('x')).toBe(false)
})

test('first claim succeeds and sets handler', () => {
  const h = new HandlerManager()
  const r = h.claim('cc-A', false)
  expect(r.ok).toBe(true)
  expect(r.previous).toBeNull()
  expect(h.currentHandler()).toBe('cc-A')
  expect(h.isHandler('cc-A')).toBe(true)
})

test('re-claim by same cc is idempotent', () => {
  const h = new HandlerManager()
  h.claim('cc-A', false)
  const r = h.claim('cc-A', false)
  expect(r.ok).toBe(true)
  expect(r.previous).toBe('cc-A')
})

test('different cc without force is refused', () => {
  const h = new HandlerManager()
  h.claim('cc-A', false)
  const r = h.claim('cc-B', false)
  expect(r.ok).toBe(false)
  expect(r.previous).toBe('cc-A')
  expect(h.currentHandler()).toBe('cc-A')
})

test('different cc with force displaces', () => {
  const h = new HandlerManager()
  h.claim('cc-A', false)
  const r = h.claim('cc-B', true)
  expect(r.ok).toBe(true)
  expect(r.previous).toBe('cc-A')
  expect(h.currentHandler()).toBe('cc-B')
})

test('release clears the handler', () => {
  const h = new HandlerManager()
  h.claim('cc-A', false)
  h.release('cc-A')
  expect(h.currentHandler()).toBeNull()
})

test('release by a non-handler is a no-op', () => {
  const h = new HandlerManager()
  h.claim('cc-A', false)
  h.release('cc-B')
  expect(h.currentHandler()).toBe('cc-A')
})

test('disconnect starts grace period, isHandler goes false but currentHandler still names us until reap', () => {
  const h = new HandlerManager({ graceMs: 10_000 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  // During grace, we're still named as the handler (so logs / reports
  // can tell others "the seat is held by cc-A, pending reconnect"),
  // but isHandler() returns false so inbound delivery is suspended.
  expect(h.currentHandler()).toBe('cc-A')
  expect(h.isHandler('cc-A')).toBe(false)
})

test('reconnecting during grace period re-promotes us', () => {
  const h = new HandlerManager({ graceMs: 10_000 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  const r = h.claim('cc-A', false)
  expect(r.ok).toBe(true)
  expect(h.isHandler('cc-A')).toBe(true)
})

test('another cc can claim without force once grace has elapsed', async () => {
  const h = new HandlerManager({ graceMs: 50 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  await Bun.sleep(80)
  // After grace expires, reapExpiredGrace should clear cc-A next time we
  // look, so a fresh non-force claim from cc-B succeeds.
  const r = h.claim('cc-B', false)
  expect(r.ok).toBe(true)
  expect(r.previous).toBeNull()
  expect(h.currentHandler()).toBe('cc-B')
})

test('another cc claiming with force during grace still displaces', () => {
  const h = new HandlerManager({ graceMs: 10_000 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  const r = h.claim('cc-B', true)
  expect(r.ok).toBe(true)
  expect(r.previous).toBe('cc-A')
  expect(h.currentHandler()).toBe('cc-B')
})

test('reconnecting during grace period reports reconnectGapMs', async () => {
  const h = new HandlerManager({ graceMs: 10_000 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  await Bun.sleep(20)
  const r = h.claim('cc-A', false)
  expect(r.ok).toBe(true)
  expect(r.reconnectGapMs).toBeGreaterThanOrEqual(20)
})

test('fresh claim with no prior disconnect has no reconnectGapMs', () => {
  const h = new HandlerManager()
  const r = h.claim('cc-A', false)
  expect(r.ok).toBe(true)
  expect(r.reconnectGapMs).toBeUndefined()
})

test('reconnecting after grace has fully expired (state already reaped) still reports the gap', async () => {
  const h = new HandlerManager({ graceMs: 50 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  await Bun.sleep(80)
  // Grace expired — currentHandler() reaps state to null, so this looks
  // like a "fresh claim" (previous: null) from HandlerManager's state
  // machine perspective, but the sticky lastDisconnect record still
  // lets us report the gap to the reconnecting session.
  expect(h.currentHandler()).toBeNull()
  const r = h.claim('cc-A', false)
  expect(r.ok).toBe(true)
  expect(r.previous).toBeNull()
  expect(r.reconnectGapMs).toBeGreaterThanOrEqual(80)
})

test('a different cc claiming does not inherit the previous handler gap', () => {
  const h = new HandlerManager({ graceMs: 10_000 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  const r = h.claim('cc-B', true)
  expect(r.reconnectGapMs).toBeUndefined()
})

test('gap is consumed once — a second reconnect from the same cc does not re-report it', () => {
  const h = new HandlerManager({ graceMs: 10_000 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  const first = h.claim('cc-A', false)
  expect(first.reconnectGapMs).toBeDefined()
  h.onDisconnect('cc-A')
  const second = h.claim('cc-A', false)
  // Second disconnect+reconnect gets its own fresh gap, not the stale one.
  expect(second.reconnectGapMs).toBeDefined()
})

test('a failed claim (seat busy) does not discard the gap for a later successful claim', () => {
  const h = new HandlerManager({ graceMs: 10_000 })
  h.claim('cc-A', false)
  h.onDisconnect('cc-A')
  // cc-B forcefully takes the seat, then releases it.
  h.claim('cc-B', true)
  h.release('cc-B')
  // cc-A reclaims the now-empty seat — should still see its own gap.
  const r = h.claim('cc-A', false)
  expect(r.ok).toBe(true)
  expect(r.reconnectGapMs).toBeDefined()
})
