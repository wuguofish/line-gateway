/**
 * Quick runtime check that the gateway's WS endpoint accepts hello/claim/ping
 * and echoes the right frames back. Not part of the test suite — just a
 * scratch file to sanity-check the daemon while bun:test WebSocket hangs
 * are diagnosed separately.
 *
 * Usage:
 *   LINE_GATEWAY_PORT=13458 bun main.ts &
 *   bun scratch/smoke-ws.ts
 */

const port = parseInt(process.env.LINE_GATEWAY_PORT ?? '13458', 10)
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

const frames: unknown[] = []
ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(String(ev.data))
  frames.push(frame)
  console.log('<-', frame)
})
ws.addEventListener('error', (ev) => {
  console.error('ws error', ev)
})
ws.addEventListener('close', (ev) => {
  console.log('ws closed', ev.code, ev.reason)
})

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', reject)
})
console.log('ws open')

const send = (o: unknown): void => ws.send(JSON.stringify(o))

send({ type: 'hello', cc_session_id: 'cc-smoke', pid: 111, plugin_version: '0.1.0' })
await Bun.sleep(150)
send({ type: 'claim' })
await Bun.sleep(150)
send({ type: 'ping' })
await Bun.sleep(150)
// Use fetch_messages so the smoke doesn't depend on LINE network — it's
// served directly from the local SQLite archive.
send({ type: 'api_request', req_id: 'r1', method: 'fetch_messages', args: { limit: 5 } })
await Bun.sleep(300)

console.log('--- collected', frames.length, 'frames ---')
ws.close()
await Bun.sleep(100)
process.exit(0)
