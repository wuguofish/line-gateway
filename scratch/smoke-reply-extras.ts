/**
 * Zero-side-effect runtime check that `reply` accepts and routes the new
 * `mention_user_ids` arg into the textV2 mention path. We pass a malformed
 * userId, which buildMentionUserMessage rejects BEFORE any LINE HTTP call —
 * a well-formed "invalid mention userId" error proves the arg is threaded
 * through (gateway → sendTextReplyPreferred → buildMentionUserMessage)
 * without messaging a real chat.
 *
 * Usage (against the live daemon on 3456):
 *   bun scratch/smoke-reply-extras.ts
 */

const port = parseInt(process.env.LINE_GATEWAY_PORT ?? '3456', 10)
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

let response: any = null
ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(String(ev.data))
  if (frame.type === 'api_response' && frame.req_id === 'rx1') response = frame
  console.log('<-', frame)
})

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', reject)
})

const send = (o: unknown): void => ws.send(JSON.stringify(o))
send({ type: 'hello', cc_session_id: 'cc-smoke-reply-extras', pid: 333, plugin_version: '0.1.0' })
await Bun.sleep(150)
send({
  type: 'api_request', req_id: 'rx1', method: 'reply',
  args: { chat_id: 'C_dispatch_probe', text: 'verify mention path', mention_user_ids: ['bad-uid'] },
})
await Bun.sleep(500)

ws.close()
await Bun.sleep(100)

if (!response) { console.error('FAIL: no api_response received'); process.exit(1) }
const errStr = String(response.error ?? '')
if (response.ok === false && /invalid mention userId/.test(errStr)) {
  console.log('PASS: reply routed mention_user_ids into textV2 path + guard fired ->', errStr)
  process.exit(0)
}
console.error('FAIL: unexpected response ->', JSON.stringify(response))
process.exit(1)
