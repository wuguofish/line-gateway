/**
 * Runtime smoke for /webhook: spin up a gateway with a stub LineConfig
 * (fake secret, no real credentials), simulate a LINE webhook POST with
 * a correctly-HMAC-signed body, and confirm it dispatches as expected.
 * Verifies the full HTTP-layer glue that unit tests skip.
 *
 *   bun scratch/smoke-webhook.ts
 */

import { createHmac } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startGateway } from '../gateway'
import { loadLineConfig } from '../env'

const PORT = 13459
const SECRET = 'smoke-secret-xyz'

const stateDir = mkdtempSync(join(tmpdir(), 'line-gateway-smoke-'))
writeFileSync(join(stateDir, '.env'),
  `LINE_CHANNEL_ACCESS_TOKEN=smoke-token\nLINE_CHANNEL_SECRET=${SECRET}\n`,
  { mode: 0o600 })
writeFileSync(join(stateDir, 'access.json'),
  JSON.stringify({ allowFrom: ['Uowner'] }))

const cfg = loadLineConfig({ stateDir })
console.log('configured:', cfg.configured)

const handle = startGateway({ port: PORT, lineConfig: cfg })

const base = `http://127.0.0.1:${PORT}`

try {
  // 1. healthz
  const health = await (await fetch(`${base}/healthz`)).json() as any
  console.log('healthz:', health)

  // 2. webhook without signature -> 401
  const unsigned = await fetch(`${base}/webhook`, {
    method: 'POST',
    body: '{"events":[]}',
  })
  console.log('unsigned:', unsigned.status)

  // 3. webhook with bad signature -> 401
  const bad = await fetch(`${base}/webhook`, {
    method: 'POST',
    body: '{"events":[]}',
    headers: { 'x-line-signature': 'bogus' },
  })
  console.log('bad sig:', bad.status)

  // 4. webhook with correct signature, no handler -> 200 + dropped
  const body = JSON.stringify({
    events: [{
      type: 'message',
      source: { type: 'user', userId: 'Uowner' },
      message: { type: 'text', text: 'hi', id: 'm1' },
    }],
  })
  const sig = createHmac('sha256', SECRET).update(body).digest('base64')
  const ok = await fetch(`${base}/webhook`, {
    method: 'POST',
    body,
    headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
  })
  const summary = await ok.json() as any
  console.log('signed (no handler):', ok.status, summary)
  if (summary.dropped_no_handler !== 1) {
    throw new Error('expected dropped_no_handler=1, got ' + JSON.stringify(summary))
  }
  if (summary.archived !== 1) {
    throw new Error('expected archived=1, got ' + JSON.stringify(summary))
  }

  // 5. archive survives: fetch_messages via handle.db
  const { fetchMessages } = await import('../db')
  const rows = fetchMessages(handle.db)
  console.log('archived rows:', rows.length, rows[0] && { id: rows[0].id, text: rows[0].text })
  if (rows.length !== 1 || rows[0]!.text !== 'hi') {
    throw new Error('archive verification failed: ' + JSON.stringify(rows))
  }

  console.log('\nALL SMOKES PASSED')
} finally {
  await handle.stop()
  try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
}
process.exit(0)
