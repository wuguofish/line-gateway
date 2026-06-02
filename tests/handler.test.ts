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
