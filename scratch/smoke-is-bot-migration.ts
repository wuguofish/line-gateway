/**
 * 拿正式封存庫的副本實測 is_bot migration：確認 ALTER TABLE 在 185MB、
 * 數十萬列的真實資料上跑得完，而且既有列都落在 is_bot = 0。
 *
 * 用法：先把 messages.db（含 -wal/-shm）複製到別處，再把副本路徑傳進來。
 * 絕對不要指向 C:\Users\ATone\.claude\channels\line 底下的正本。
 */
import { openDatabase, fetchMessages, recentChatIds } from '../db'

const path = process.argv[2]
if (!path) throw new Error('請給資料庫副本的路徑')
if (path.includes('.claude') && path.includes('channels')) {
  throw new Error('拒絕：這看起來是正式封存庫，請改用副本')
}

const t0 = Date.now()
const db = openDatabase(path)
console.log('openDatabase 耗時', Date.now() - t0, 'ms')

const cols = db.query<{ name: string }, []>('PRAGMA table_info(messages)').all().map(c => c.name)
console.log('欄位:', cols.join(', '))

const total = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM messages').get()!.n
const bots = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM messages WHERE is_bot = 1').get()!.n
console.log('總列數', total, '／標成 bot 的', bots)

const t1 = Date.now()
const rows = fetchMessages(db, { limit: 5 })
console.log('fetchMessages(limit 5) 耗時', Date.now() - t1, 'ms，拿到', rows.length, '列')

const t2 = Date.now()
const chats = recentChatIds(db, '2026-09-13T00:00:00.000+08:00')
console.log('recentChatIds 耗時', Date.now() - t2, 'ms，', chats.length, '個 chat')
