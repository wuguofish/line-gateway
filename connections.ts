/**
 * In-memory registry of active plugin WSS connections.
 *
 * A plugin calls `hello` after opening its WebSocket; that turns the raw
 * ServerWebSocket into a tracked Connection entry keyed by cc_session_id.
 * Gateway code that needs to push frames to a specific session (handler
 * inbound delivery, permission_reply routing, api_response) looks the
 * connection up here.
 *
 * Kept deliberately simple — no persistence: if the gateway restarts all
 * plugins have to re-connect and re-hello.
 */

import type { ServerWebSocket } from 'bun'
import type { GatewayToPlugin } from './protocol'

export interface ConnectionData {
  cc_session_id: string
  pid: number
  plugin_version: string
  connected_at: number
}

export interface Connection {
  ws: ServerWebSocket<ConnectionData>
  data: ConnectionData
}

export class ConnectionRegistry {
  private byCcSessionId = new Map<string, Connection>()

  /**
   * Called on a `hello` frame. Returns the newly-added Connection, and
   * displaces any prior connection with the same cc_session_id (that prior
   * one gets its WebSocket closed — protocol says plugins are 1-per-session).
   */
  add(ws: ServerWebSocket<ConnectionData>, data: ConnectionData): Connection {
    const existing = this.byCcSessionId.get(data.cc_session_id)
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4000, 'superseded by new connection with same cc_session_id')
      } catch {}
    }
    const conn: Connection = { ws, data }
    this.byCcSessionId.set(data.cc_session_id, conn)
    return conn
  }

  /**
   * Called from the WebSocket close handler to clean up. Returns true when
   * the entry was actually removed — i.e. `ws` was the live connection and
   * has now been evicted. Returns false when `ws` is already stale (a
   * re-hello swapped us out earlier); the caller should treat that as
   * "still connected" and skip any disconnect-side effects like starting
   * a handler grace period.
   */
  remove(cc_session_id: string, ws: ServerWebSocket<ConnectionData>): boolean {
    const existing = this.byCcSessionId.get(cc_session_id)
    if (existing && existing.ws === ws) {
      this.byCcSessionId.delete(cc_session_id)
      return true
    }
    return false
  }

  get(cc_session_id: string): Connection | undefined {
    return this.byCcSessionId.get(cc_session_id)
  }

  all(): Connection[] {
    return Array.from(this.byCcSessionId.values())
  }

  send(cc_session_id: string, frame: GatewayToPlugin): boolean {
    const conn = this.byCcSessionId.get(cc_session_id)
    if (!conn) return false
    try {
      conn.ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  /** Close all connections; called on daemon shutdown. */
  closeAll(reason = 'gateway shutting down'): void {
    for (const conn of this.byCcSessionId.values()) {
      try { conn.ws.close(1001, reason) } catch {}
    }
    this.byCcSessionId.clear()
  }
}
