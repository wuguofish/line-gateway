/**
 * Zero-side-effect runtime check that the gateway dispatches the new
 * `reply_all` api_request to sendMentionAllReplyPreferred. We send a text
 * containing a literal "{", which buildMentionAllMessage rejects BEFORE any
 * LINE HTTP call — so a well-formed error ("must not contain") proves the
 * method is wired (not "unknown api_request method") without messaging a real
 * chat. chat_id is irrelevant: the throw happens before it's used.
 *
 * Usage (against the live daemon on 3456):
 *   bun scratch/smoke-reply-all.ts
 */

const port = parseInt(process.env.LINE_GATEWAY_PORT ?? '3456', 10)
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

let response: any = null
ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(String(ev.data))
  if (frame.type === 'api_response' && frame.req_id === 'ra1') response = frame
  console.log('<-', frame)
})

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', reject)
})

const send = (o: unknown): void => ws.send(JSON.stringify(o))
send({ type: 'hello', cc_session_id: 'cc-smoke-reply-all', pid: 222, plugin_version: '0.1.0' })
await Bun.sleep(150)
send({ type: 'api_request', req_id: 'ra1', method: 'reply_all', args: { chat_id: 'C_dispatch_probe', text: 'verify {brace} guard' } })
await Bun.sleep(500)

ws.close()
await Bun.sleep(100)

if (!response) {
  console.error('FAIL: no api_response received')
  process.exit(1)
}
const errStr = String(response.error ?? '')
if (response.ok === false && /must not contain/.test(errStr)) {
  console.log('PASS: reply_all dispatched + brace guard fired ->', errStr)
  process.exit(0)
}
if (/unknown api_request method/.test(errStr)) {
  console.error('FAIL: gateway does not know reply_all (daemon not restarted?) ->', errStr)
  process.exit(1)
}
console.error('FAIL: unexpected response ->', JSON.stringify(response))
process.exit(1)
