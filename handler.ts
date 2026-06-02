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
  } {
    this.reapExpiredGrace()
    const previous = this.state?.cc_session_id ?? null

    if (!this.state) {
      this.state = { cc_session_id, disconnected_at: null }
      return { ok: true, previous: null }
    }

    if (this.state.cc_session_id === cc_session_id) {
      // Already us — reconnect-style re-claim.
      this.state.disconnected_at = null
      return { ok: true, previous }
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
      this.state.disconnected_at = Date.now()
    }
  }

  /** Private: drop the handler if its disconnected_at is older than grace. */
  private reapExpiredGrace(): void {
    if (!this.state || this.state.disconnected_at === null) return
    if (Date.now() - this.state.disconnected_at >= this.graceMs) {
      this.state = null
    }
  }
}
