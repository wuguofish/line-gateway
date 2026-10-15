/**
 * 端對端驗「get_content 讀得回文字」：真的起一個 gateway、用真的 client
 * 打 api_request，確認封存裡的文字（bot 自己說的與別人說的都算）直接
 * 回來，不會再掉進 LINE 的 binary 路徑。
 *
 * 用假 token 和暫存資料庫：文字這條路在碰 LINE 之前就回傳了，真的走到
 * LINE 就代表分支沒生效——那時假 token 會讓它失敗，剛好把錯誤叫出來。
 */
import { startGateway } from '../gateway'
import { GatewayClient } from '../gateway-client'
import { insertBotMessage, insertMessage } from '../db'
import { tmpdir } from 'os'
import { join } from 'path'

const port = 3987
const dbPath = join(tmpdir(), 'smoke-get-content-' + Date.now() + '.db')
const gw = startGateway({
  port,
  dbPath,
  lineConfig: { configured: true, token: 'fake-token-never-used', secret: 'fake' } as any,
})

insertBotMessage(gw.db, { id: 'bot-said', chat_id: 'C1', message_type: 'text', text: '我在，剛剛那張圖我很喜歡' },
  '2026-09-14T12:00:00.000+08:00', 1757822400000)
insertMessage(gw.db, {
  type: 'message',
  timestamp: 1757822400000,
  source: { type: 'group', userId: 'Uvillager', groupId: 'C1' },
  message: { id: 'human-said', type: 'text', text: '早安' },
}, '2026-09-14T12:01:00.000+08:00')

const client = new GatewayClient({
  url: `ws://127.0.0.1:${port}/ws`,
  cc_session_id: 'smoke-session',
  pid: process.pid,
  plugin_version: 'smoke',
})
client.start()
await client.waitUntilReady()

let failures = 0
async function check(label: string, messageId: string, expected: string, expectBot: boolean) {
  const r = await client.apiRequest('get_content', { message_id: messageId }) as any
  const ok = r?.text === expected && r?.is_bot === expectBot
  console.log(ok ? 'PASS' : 'FAIL', label, '→', JSON.stringify(r))
  if (!ok) failures++
}

await check('bot 自己說過的話', 'bot-said', '我在，剛剛那張圖我很喜歡', true)
await check('村民說的話', 'human-said', '早安', false)

console.log(failures === 0 ? '全部通過' : failures + ' 項失敗')
// 直接結束，不走 gw.stop()：只要 client 還活著就會自動重連，而
// server.stop(true) 等不到連線收乾淨、那個 promise 不會 resolve
// （實測 45 秒不回來）。這是一次性腳本，行程退出就收乾淨了。
process.exit(failures === 0 ? 0 : 1)
