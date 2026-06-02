# CLAUDE.md — line-gateway

Local daemon + stdio plugin pair that bridges LINE Messaging API and
Claude Code. This file is for the AI who
works on the code — read before writing.

## Why a daemon

LINE's webhook is inbound HTTPS, which forces one port listener per
machine. Previous architecture (`claude-line-channel`)
tied the webhook listener to the stdio MCP plugin process — so when a
second Claude Code session tried to enable the plugin, bun crashed on
port contention. Gateway hoists the webhook out of the plugin.

## Architecture (short)

- **Gateway** (`main.ts` → `gateway.ts`): single `Bun.serve` on loopback
  port 3456. Routes `/webhook` (POST → LINE event parsing, persistence,
  push to handler), `/ws` (WebSocket upgrade for plugins), `/healthz`.
- **Plugin** (not yet written): stdio MCP server spawned per Claude
  Code session. Opens WSS to Gateway. MCP tools (`reply`/`push`/...)
  forward to Gateway as `api_request` frames.
- **Handler** (`handler.ts`): the one session currently designated to
  receive LINE inbound messages. Others can still push, but do not
  receive inject. Grace period on disconnect before forfeiture.
- **Permission relay**: LINE permission-request `y <id>` / `n <id>`
  replies are intercepted by Gateway and routed back only to the
  originating plugin via `permission_reply` frames (not to the handler
  inbox).

## Layout

```
main.ts                  daemon entry
gateway.ts               Bun.serve HTTP + WS
connections.ts           cc_session_id -> ServerWebSocket
handler.ts               claim / release / grace-period state
protocol.ts              WSS frame types (source of truth)
tests/                   bun:test unit suites (pure logic only)
scratch/                 manual smoke scripts (bun:test + WebSocket
                         client currently hangs — integration runs here)
```

## bun:test WebSocket hang

`new WebSocket()` inside a `test(...)` body currently hangs `bun test`
(tested on bun 1.3.11). The daemon works fine under `bun main.ts` —
scratch/smoke-ws.ts exercises the full round-trip. If a future bun
release fixes this, migrate `scratch/smoke-ws.ts` to
`tests/gateway.test.ts` with the existing helper.

## Commits

Kept in the repo root (not `mcp-servers/`-level) — line-gateway stands
on its own, same as `../switchboard/`. No remote yet; init + push when
Phase A is wrapping up.
