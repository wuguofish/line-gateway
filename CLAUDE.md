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
  port 3456. Routes `/webhook` (POST → signature check, persistence,
  push to handler), `/ws` (WebSocket upgrade for plugins), `/content`,
  `/upload`, `/static`, `/emoji` and `/healthz`. Only `/webhook` is
  authenticated; the rest rely on the loopback bind.
- **Plugin** (`plugin-main.ts` → `plugin.ts`): stdio MCP server named
  `line`, spawned per Claude Code session. Opens a WebSocket to the
  Gateway. Its tools (`reply`, `reply_all`, `get_content`, `get_emoji`,
  `send_image`, `upload_file`, `fetch_messages`, `claim_handler`,
  `release_handler`) forward to the Gateway as `api_request` frames;
  inbound messages that pass `access.json` reach Claude as
  `notifications/claude/channel`.
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
gateway.ts               Bun.serve HTTP + WS, api_request dispatch
webhook.ts               signature check, event routing, permission-reply interception
line-api.ts              LINE Messaging API client
db.ts, schema.sql        SQLite message archive
uploads.ts               /upload and /static image store
permissions.ts           permission request id -> originating session
access.ts                owner lookup (allowFrom[0]) for the gateway
env.ts                   state dir, .env, credentials
connections.ts           cc_session_id -> ServerWebSocket
handler.ts               claim / release / grace-period state
protocol.ts              WSS frame types (source of truth)
plugin-main.ts           plugin entry (stdio MCP)
plugin.ts                MCP server: tools, channel notifications, permission relay
plugin-access.ts         access.json gate
plugin-inbound.ts        inbound event -> channel notification
plugin-get-content.ts    get_content download and inline images
plugin-canned-reply.ts   one-time reply to senders not on the allowlist
gateway-client.ts        plugin-side WebSocket client (reconnect, claim)
install-task.ps1         Windows logon task that runs start-daemon.ps1
tests/                   bun:test suites (network mocked; a few write to tmpdir)
scratch/                 manual smoke scripts (bun:test + WebSocket
                         client currently hangs — integration runs here)
```

## bun:test WebSocket hang

`new WebSocket()` inside a `test(...)` body currently hangs `bun test`
(tested on bun 1.3.11). The daemon works fine under `bun main.ts` —
scratch/smoke-ws.ts exercises the full round-trip. If a future bun
release fixes this, migrate `scratch/smoke-ws.ts` to
`tests/gateway.test.ts` with the existing helper.

## Repository

Remote: `https://github.com/wuguofish/line-gateway`. README.md is the
user-facing guide (setup, configuration, tools, limitations).
