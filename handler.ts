/**
 * Handler-claim state: at most one cc_session_id is the "handler" at a
 * time. The handler is the session that receives LINE inbound events as
 * `<channel source="line" ...>` injections. Non-handler plugins can still
 * send push/reply tool calls but do not receive inbound pushes.
 *
 * Grace period: if the handler's WSS connection drops, we don't release
 * immediately — a brief reconnect window avoids ping-ponging the handler
 * title during transient disconnects.
 */

export interface HandlerState {
  cc_session_id: string
  /** null while connection is live; timestamp when the grace period started. */
  disconnected_at: number | null
}

const DEFAULT_GRACE_MS = 30_000

export class HandlerManager {
  private state: HandlerState | null = null
  private graceMs: number
  /**
   * Sticky record of the most recent disconnect, independent of `state`
   * so a reconnect *after* grace has already expired (state already
   * nulled by reapExpiredGrace) can still learn it missed a window and
   * how large it was. Consumed (cleared) the first time the same
   * cc_session_id successfully claims again — see `claim()`.
   */
  private lastDisconnect: { cc_session_id: string; at: number } | null = null

  constructor(opts: { graceMs?: number } = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  }

  currentHandler(): string | null {
    this.reapExpiredGrace()
    return this.state?.cc_session_id ?? null
  }

  isHandler(cc_session_id: string): boolean {
    this.reapExpiredGrace()
    return this.state?.cc_session_id === cc_session_id && this.state?.disconnected_at === null
  }

  /**
   * Attempt to claim handler for a cc_session_id. Returns the outcome plus
   * who the previous handler was (for logging / reporting back).
   */
  claim(cc_session_id: string, force: boolean): {
    ok: boolean
    reason?: string
    previous: string | null
    /**
     * Present only when this claim is the SAME session reclaiming after
     * a disconnect — ms elapsed since that disconnect. Delivery was
     * suspended for the whole gap (see isHandler above), so the caller
     * can use this to decide whether a catch-up notice is warranted.
     */
    reconnectGapMs?: number
  } {
    this.reapExpiredGrace()
    const previous = this.state?.cc_session_id ?? null

    // Only consume (clear) the sticky gap record on a branch that actually
    // grants cc_session_id the seat — a failed claim (seat busy, below)
    // must leave it intact so a later successful claim can still report it.
    if (!this.state) {
      const reconnectGapMs = this.consumeGapFor(cc_session_id)
      this.state = { cc_session_id, disconnected_at: null }
      return { ok: true, previous: null, ...(reconnectGapMs !== undefined ? { reconnectGapMs } : {}) }
    }

    if (this.state.cc_session_id === cc_session_id) {
      // Already us — reconnect-style re-claim.
      const reconnectGapMs = this.consumeGapFor(cc_session_id)
      this.state.disconnected_at = null
      return { ok: true, previous, ...(reconnectGapMs !== undefined ? { reconnectGapMs } : {}) }
    }

    if (this.state.disconnected_at !== null || force) {
      // Grace-expired earlier but reapExpiredGrace didn't clear yet, or
      // caller is forcing.
      this.state = { cc_session_id, disconnected_at: null }
      return { ok: true, previous }
    }

    return {
      ok: false,
      reason: `handler is currently ${previous} — pass force:true to take over`,
      previous,
    }
  }

  /** Plugin voluntarily gives up the title. */
  release(cc_session_id: string): void {
    if (this.state?.cc_session_id === cc_session_id) {
      this.state = null
    }
  }

  /** Called from the WebSocket close handler — starts grace period. */
  onDisconnect(cc_session_id: string): void {
    if (this.state?.cc_session_id === cc_session_id && this.state.disconnected_at === null) {
      const at = Date.now()
      this.state.disconnected_at = at
      this.lastDisconnect = { cc_session_id, at }
    }
  }

  /** Private: drop the handler if its disconnected_at is older than grace. */
  private reapExpiredGrace(): void {
    if (!this.state || this.state.disconnected_at === null) return
    if (Date.now() - this.state.disconnected_at >= this.graceMs) {
      this.state = null
    }
  }

  /**
   * Private: if the given session has a pending disconnect record, return
   * the elapsed gap and clear the record (one-shot — a later unrelated
   * claim from the same session shouldn't re-report an old gap).
   */
  private consumeGapFor(cc_session_id: string): number | undefined {
    if (this.lastDisconnect?.cc_session_id !== cc_session_id) return undefined
    const gap = Date.now() - this.lastDisconnect.at
    this.lastDisconnect = null
    return gap
  }
}
