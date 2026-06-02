/**
 * Request-id → cc_session_id routing for permission replies.
 *
 * When a plugin issues `api_request(method: 'push_permission', ...)`,
 * Gateway remembers which cc_session_id is waiting on the answer.
 * Later, when the primary owner replies `y <id>` / `n <id>` on LINE,
 * the matching cc_session_id is popped out and the permission_reply
 * frame goes only to that plugin.
 *
 * Retention: entries expire after TTL (default 10 min) so a forgotten
 * request doesn't pin memory forever. An explicit pop removes it in
 * O(1); a periodic sweep catches the rest.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000

interface Entry {
  cc_session_id: string
  created_at: number
}

export class PermissionRouter {
  private entries = new Map<string, Entry>()
  private ttlMs: number

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  /** Register a pending request. Called when push_permission lands. */
  register(request_id: string, cc_session_id: string): void {
    this.entries.set(request_id, { cc_session_id, created_at: Date.now() })
  }

  /**
   * Retrieve and remove — called when we successfully match a LINE
   * reply to a pending request. Returns null if unknown or expired.
   */
  pop(request_id: string): string | null {
    const e = this.entries.get(request_id)
    if (!e) return null
    this.entries.delete(request_id)
    if (Date.now() - e.created_at > this.ttlMs) return null
    return e.cc_session_id
  }

  /** Remove expired entries. Safe to call on a timer. */
  sweep(): number {
    const cutoff = Date.now() - this.ttlMs
    let removed = 0
    for (const [id, e] of this.entries) {
      if (e.created_at < cutoff) {
        this.entries.delete(id)
        removed++
      }
    }
    return removed
  }

  size(): number {
    return this.entries.size
  }
}
