import { test, expect } from 'bun:test'
import { PermissionRouter } from '../permissions'

test('register + pop returns the cc_session_id', () => {
  const r = new PermissionRouter()
  r.register('abcde', 'cc-A')
  expect(r.pop('abcde')).toBe('cc-A')
})

test('pop removes the entry (second pop returns null)', () => {
  const r = new PermissionRouter()
  r.register('abcde', 'cc-A')
  r.pop('abcde')
  expect(r.pop('abcde')).toBeNull()
})

test('pop of unknown request returns null', () => {
  const r = new PermissionRouter()
  expect(r.pop('never-registered')).toBeNull()
})

test('expired entry is dropped on pop', async () => {
  const r = new PermissionRouter({ ttlMs: 20 })
  r.register('abcde', 'cc-A')
  await Bun.sleep(40)
  expect(r.pop('abcde')).toBeNull()
})

test('sweep removes expired entries without touching fresh ones', async () => {
  const r = new PermissionRouter({ ttlMs: 20 })
  r.register('old1', 'cc-A')
  r.register('old2', 'cc-A')
  await Bun.sleep(40)
  r.register('fresh', 'cc-B')
  const removed = r.sweep()
  expect(removed).toBe(2)
  expect(r.size()).toBe(1)
  expect(r.pop('fresh')).toBe('cc-B')
})

test('register with the same request_id overwrites (last writer wins)', () => {
  const r = new PermissionRouter()
  r.register('abcde', 'cc-A')
  r.register('abcde', 'cc-B')
  expect(r.pop('abcde')).toBe('cc-B')
})
