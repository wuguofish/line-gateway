# line-gateway

Local-only LINE bridge for multi-session Claude Code. Runs as a single Bun
daemon that owns the webhook port and brokers between LINE's Messaging API
and per-session stdio plugins over WebSocket — so multiple Claude Code
sessions on the same machine can share one LINE channel without the port
3456 contention that `claude-line-channel`'s stdio-only design runs into.

## Status

**Phase A — skeleton:** Gateway daemon accepts plugin WSS connections,
handles `hello` / `claim` / `release` / `ping`, tracks the handler (with
grace-period reconnect), and exposes `/healthz` and `/webhook` HTTP
endpoints. LINE API calls and webhook signature verification / event
routing are stubs for now.

Next up: LINE API proxying, webhook signature verify + inbound push,
permission routing table, plugin-side implementation.

## Run

```sh
bun install
bun main.ts                     # foreground, dev port 3457
LINE_GATEWAY_PORT=3456 bun main.ts   # cutover port (only after the legacy
                                     # claude-line-channel is stopped — it
                                     # also binds 3456)
```

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LINE_GATEWAY_PORT` | `3457` | Port for both `/webhook` (POST) and `/ws` (WebSocket upgrade). Default is 3457 so dev work doesn't collide with legacy `claude-line-channel` (3456). Set to `3456` at final cutover. |

## Test

Pure unit tests (handler claim logic, connection registry):

```sh
bun test
```

End-to-end WebSocket smoke (run against a live daemon):

```sh
LINE_GATEWAY_PORT=13458 bun main.ts &
LINE_GATEWAY_PORT=13458 bun scratch/smoke-ws.ts
```

`bun:test` with `new WebSocket()` inside a test body currently hangs the
test runner without printing results, so integration tests live in
`scratch/` for now and are exercised manually.

## License

MIT © 2026 wuguofish
