/**
 * LINE credentials and state-directory layout.
 *
 * Reads the same `~/.claude/channels/line/` layout that
 * `claude-line-channel` uses, so the cutover day doesn't need to move
 * any files around — both plugins read from the same source of truth.
 *
 * TOKEN / SECRET are returned as null when missing instead of killing
 * the process; a gateway without credentials still answers WSS hello
 * frames so plugin-side development can proceed, but /webhook and
 * LINE API proxying will report configured = false.
 */

import { readFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface LineConfig {
  stateDir: string
  envFile: string
  accessFile: string
  inboxDir: string
  uploadsDir: string
  historyLog: string
  token: string | null
  secret: string | null
  /**
   * Public base URL of the gateway, exposed via tunnel (cloudflared/etc).
   * Used to build absolute URLs LINE can fetch — e.g. `<base>/static/<hash>.png`
   * for `send_image` with a local file. `null` when the gateway is
   * loopback-only; in that case `/upload` still works for diagnostics
   * but `send_image(file_path)` will fail at LINE-fetch time.
   */
  publicBaseUrl: string | null
  configured: boolean
}

export function loadLineConfig(opts: { stateDir?: string } = {}): LineConfig {
  const stateDir = opts.stateDir ?? process.env.LINE_STATE_DIR ??
    join(homedir(), '.claude', 'channels', 'line')
  const envFile   = join(stateDir, '.env')
  const accessFile = join(stateDir, 'access.json')
  const inboxDir  = join(stateDir, 'inbox')
  const uploadsDir = join(stateDir, 'uploads')
  const historyLog = join(stateDir, 'history.log')

  try { mkdirSync(inboxDir, { recursive: true, mode: 0o700 }) } catch {}
  try { mkdirSync(uploadsDir, { recursive: true, mode: 0o700 }) } catch {}
  try { chmodSync(stateDir, 0o700) } catch {}
  try { chmodSync(inboxDir, 0o700) } catch {}
  try { chmodSync(uploadsDir, 0o700) } catch {}

  // .env: each line KEY=VALUE. Real environment wins.
  try {
    chmodSync(envFile, 0o600)
  } catch {
    // No-op on Windows or when the file is missing.
  }

  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      // Tolerate Windows CRLF: `.` in JS regex does not match `\r`, so
      // `(.*)` would stop one short and `$` would fail to anchor — leaving
      // every credential silently unread. Stripping the trailing `\r`
      // before the match keeps the regex straightforward.
      const m = line.replace(/\r$/, '').match(/^(\w+)=(.*)$/)
      if (!m || process.env[m[1]!] !== undefined) continue
      const trimmed = m[2]!.trim()
      // Strip only matching quote pair.
      const pair = trimmed.match(/^(['"])(.*)\1$/)
      process.env[m[1]!] = pair ? pair[2]! : trimmed
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`line-gateway: could not read ${envFile}: ${err}\n`)
    }
  }

  const token  = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? null
  const secret = process.env.LINE_CHANNEL_SECRET ?? null
  const rawPub = process.env.LINE_GATEWAY_PUBLIC_URL ?? ''
  const publicBaseUrl = rawPub.trim().replace(/\/+$/, '') || null

  return {
    stateDir, envFile, accessFile, inboxDir, uploadsDir, historyLog,
    token, secret, publicBaseUrl,
    configured: !!(token && secret),
  }
}
