# line-gateway

A LINE Messaging API bridge for Claude Code that several sessions on one
machine can share. A single Bun daemon owns the webhook and talks to LINE;
each Claude Code session runs a small stdio MCP plugin that connects to the
daemon over WebSocket. Every session can send to LINE, and one session at a
time — the *handler* — receives inbound messages as Claude Code
[channel](https://code.claude.com/docs/en/channels) events.

```
LINE platform ──HTTPS tunnel──▶ gateway daemon ◀──WebSocket── plugin (stdio MCP) ── Claude Code session
                                127.0.0.1:3456 ◀──WebSocket── plugin (stdio MCP) ── Claude Code session
```

- **Gateway** (`main.ts`, `gateway.ts`): verifies the webhook signature,
  archives every event in SQLite, forwards inbound messages to the handler,
  and makes the LINE API calls for all plugins.
- **Plugin** (`plugin-main.ts`, `plugin.ts`): an MCP server named `line`. It
  exposes the tools below, filters inbound messages through `access.json`,
  delivers the ones that pass as `notifications/claude/channel`, and relays
  Claude Code permission prompts to LINE.
- **Handler seat** (`handler.ts`): one session receives inbound messages. A
  plugin claims the seat when it connects if nobody holds it;
  `claim_handler(force: true)` takes it over. When the handler disconnects,
  the seat is held for 30 seconds so a quick reconnect keeps it.

## Requirements

- [Bun](https://bun.sh)
- A LINE Messaging API channel: its channel access token and channel secret
- A public HTTPS tunnel to the daemon port (for example cloudflared), so
  LINE can reach `/webhook`
- Claude Code with channels, which are a research preview and need a
  claude.ai login or a Console API key

## Setup

1. Install dependencies:

   ```sh
   bun install
   ```

2. Put the credentials in `<state dir>/.env`. The state dir defaults to
   `~/.claude/channels/line`. Real environment variables override the file.

   ```
   LINE_CHANNEL_ACCESS_TOKEN=...
   LINE_CHANNEL_SECRET=...
   # Optional: the tunnel's public origin, needed for send_image with a local file
   LINE_GATEWAY_PUBLIC_URL=https://line.example.com
   ```

3. Write `<state dir>/access.json` (see [Access control](#access-control)).

4. Start the daemon:

   ```sh
   bun main.ts
   ```

   On Windows, `install-task.ps1` registers a Task Scheduler task that runs
   `start-daemon.ps1` at logon. That script starts the daemon hidden and
   writes `daemon.out.log` and `daemon.err.log` next to it. On other
   platforms, run `bun main.ts` under your service manager.

5. Point the tunnel at `http://127.0.0.1:3456` and set the channel's webhook
   URL in the LINE Developers console to `https://<your host>/webhook`.
   Expose only `/webhook` and `/static/` (plus `/healthz` if you want an
   external health check). The other routes have no authentication and rely
   on the loopback bind, so keep them off the tunnel.

6. Register the plugin with Claude Code, for example in the `mcpServers` of
   your settings:

   ```json
   "line": {
     "type": "stdio",
     "command": "bun",
     "args": ["/path/to/line-gateway/plugin-main.ts"]
   }
   ```

   Start the session that should receive LINE messages with the channel
   enabled:

   ```sh
   claude --dangerously-load-development-channels server:line
   ```

   Sessions started without the flag can still send with the tools, but
   receive nothing. Set `LINE_GATEWAY_AUTO_CLAIM=0` in the plugin env for
   those sessions, so they do not take the handler seat away from the session
   that listens.

## Configuration

Daemon:

| Variable | Default | Purpose |
|---|---|---|
| `LINE_GATEWAY_PORT` | `3456` | HTTP and WebSocket port, bound to `127.0.0.1` |
| `LINE_STATE_DIR` | `~/.claude/channels/line` | Where `.env`, `access.json` and runtime state live |
| `LINE_CHANNEL_ACCESS_TOKEN` | none | LINE API token. Without the token and the secret, `/webhook` answers 503 and sending fails |
| `LINE_CHANNEL_SECRET` | none | Verifies the `x-line-signature` header on `/webhook` |
| `LINE_GATEWAY_PUBLIC_URL` | none | Public origin of the tunnel; `send_image(file_path)` builds the image URL that LINE fetches from it |

Plugin:

| Variable | Default | Purpose |
|---|---|---|
| `LINE_GATEWAY_URL` | `ws://127.0.0.1:3456/ws` | Daemon WebSocket |
| `LINE_STATE_DIR` | `~/.claude/channels/line` | Reads `access.json`; `get_content` saves files to `inbox/` |
| `LINE_GATEWAY_AUTO_CLAIM` | on | Set to `0` or `false` to skip claiming the handler seat on connect |
| `CLAUDE_SESSION_ID`, then `CLAUDE_CODE_SESSION_ID` | none | The session identity the daemon tracks the handler by. Without either, the plugin connects as `anon-<pid>` and a restart cannot reclaim the seat |

The state dir also holds `messages.db` (the message archive), `uploads/`
(images for `send_image`, deleted after 24 hours), `inbox/` and a few
`*.log` files.

## Access control

The daemon archives everything; the plugin decides what reaches Claude. It
reads `access.json` again for every message, so edits apply without a
restart.

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["U<owner user id>", "U<another user id>"],
  "groups": {
    "C<group id>": { "requireMention": true }
  },
  "mentionPatterns": ["@MyBot"]
}
```

- `dmPolicy`: `allowlist`, or `disabled` to drop every message, groups
  included.
- `allowFrom`: user IDs allowed to send direct messages. An empty list lets
  anyone through. The first entry is the owner, who receives permission
  prompts.
- `groups`: only listed groups and rooms are delivered. A group can carry its
  own `allowFrom`. With `requireMention`, a group message is delivered only
  when it quote-replies the bot or matches one of `mentionPatterns`
  (case-insensitive regular expressions).
- A sender or group that is not allowed gets one fixed reply, in Traditional
  Chinese, showing their ID so the owner can add it. Their IDs are also logged
  to `unknown-dms.log` and `unknown-groups.log`.

## MCP tools

| Tool | What it does |
|---|---|
| `reply(chat_id, text, quote_message_id?, quote_token?, mention_user_ids?)` | Sends text. Uses the reply token while it is fresh (30 s), otherwise a push message. Long text is split into 5000-character messages, up to 5 per call. Mentions go out as one message, up to 20 users |
| `reply_all(chat_id, text)` | Sends one message that mentions everyone in the group |
| `get_content(message_id)` | Text messages come from the archive. Media is downloaded to `inbox/`, and images up to 5 MB are also returned inline. An album returns all of its images |
| `get_emoji(productId, emojiId)` | Returns a LINE emoji as an inline PNG |
| `send_image(chat_id, image_url?, preview_url?, file_path?)` | Sends an image from a public URL or a local `file_path`. A local file is uploaded to the daemon and served from `/static/`, which needs `LINE_GATEWAY_PUBLIC_URL` |
| `upload_file(file_url, file_name?, expire_minutes?)` | Re-uploads a file to gofile.io and returns the download page, a random password and the expiry (default 30 minutes) |
| `fetch_messages(chat_id?, limit?, since?, include_bot?)` | Reads the archive, 50 rows by default and 500 at most |
| `claim_handler(force?)` | Takes the handler seat for this session |
| `release_handler()` | Gives the seat up |

## Permission relay

When Claude Code needs a tool permission in the listening session, the
plugin pushes the prompt to the owner with Allow and Deny buttons, which send
`y <id>` or `n <id>`. Only a 1:1 text from the owner counts as an answer. The
answer goes back to the session that asked, never to the handler's inbox,
and a request expires after 10 minutes.

## Limitations

- One machine. The daemon binds to loopback only, and the sessions it serves
  run on the same machine.
- One handler at a time. Messages that arrive while nobody holds the seat, or
  during the 30-second grace period, are archived but not delivered, and
  LINE is not asked to retry. A session that reclaims its seat gets a notice
  about the gap; `fetch_messages` reads what it missed.
- Only `/webhook` is authenticated. `/ws`, `/upload`, `/content` and `/emoji`
  must stay off the tunnel.
- `send_image` only works for chats that had a human message in the last 24
  hours, and it is always sent as a push message.
- `upload_file` sends the file to a third-party host, gofile.io.
- Timestamps use a fixed `+08:00` offset.
- The cross-machine Switchboard relay (`send` to `<peer>:<alias>`) is not
  part of this public version.

## Development

```sh
bun test            # unit tests; network calls are mocked
bun run typecheck
```

`scratch/` holds manual smoke scripts. Some start their own gateway on a
spare port, and others need a running daemon. `bun:test` hangs when a test
opens a real `WebSocket`, so the end-to-end WebSocket check lives in
`scratch/smoke-ws.ts`:

```sh
LINE_GATEWAY_PORT=13458 bun main.ts &
LINE_GATEWAY_PORT=13458 bun scratch/smoke-ws.ts
```

## License

MIT © 2026 wuguofish
