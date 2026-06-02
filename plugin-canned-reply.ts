/**
 * Canned reply for senders that fall outside the access policy.
 *
 * When `gate()` drops a message because the source isn't on the allowlist,
 * we send a one-shot LINE reply that contains the source's userId/groupId
 * so the sender can forward it to the bot operator and get added.
 *
 * Two reasons trigger a reply, the rest stay silent:
 *
 *   - `'user not on allowFrom'`        — DM from an unknown userId
 *   - `'group not in access.json'`     — bot added to a fresh group/room
 *
 * Skipped on purpose:
 *
 *   - `'dmPolicy disabled'`            — operator turned DMs off; don't argue
 *   - `'requireMention not satisfied'` — would spam group chats
 *   - `'sender not in group allowFrom'` — group is allowed; partial-allow is
 *                                          intentional, replying confuses things
 *   - non-message events / missing source — nothing to reply to
 *
 * Dedupe is permanent: a `notified-ids.log` file (one source-id per line)
 * lives next to access.json. Loaded into a Set on plugin startup; each
 * triggered reply appends the id and updates the Set, so a noisy sender
 * gets exactly one canned reply across all daemon restarts.
 */

import { readFileSync, appendFileSync } from 'fs'
import type { LineMessageEvent, GateResult } from './plugin-access'

const REPLIABLE_REASONS = new Set<string>([
  'user not on allowFrom',
  'group not in access.json',
])

export interface CannedReplyDecision {
  shouldReply: boolean
  /** chat_id to pass into the reply api_request (LINE source id). */
  chat_id?: string
  /** Pre-formatted Chinese-language canned text. */
  text?: string
  /** Identifier to record in the notified-ids store after a successful send. */
  source_id?: string
}

const NO_REPLY: CannedReplyDecision = { shouldReply: false }

/**
 * Pure decision function — given the gate result and the current notified
 * set, returns the canned-reply payload (if any). Caller is responsible for
 * actually sending the reply and persisting the id afterward.
 */
export function decideCannedReply(
  event: LineMessageEvent,
  gateResult: GateResult,
  notifiedIds: ReadonlySet<string>,
): CannedReplyDecision {
  if (gateResult.action !== 'drop') return NO_REPLY
  if (!REPLIABLE_REASONS.has(gateResult.reason)) return NO_REPLY

  const src = event.source
  if (!src) return NO_REPLY

  if (src.type === 'user') {
    const uid = src.userId
    if (!uid) return NO_REPLY
    if (notifiedIds.has(uid)) return NO_REPLY
    return {
      shouldReply: true,
      chat_id: uid,
      text: formatDmCannedText(uid),
      source_id: uid,
    }
  }

  // group / room
  const id = src.type === 'group' ? src.groupId : src.roomId
  if (!id) return NO_REPLY
  if (notifiedIds.has(id)) return NO_REPLY
  return {
    shouldReply: true,
    chat_id: id,
    text: formatGroupCannedText(id),
    source_id: id,
  }
}

export function formatDmCannedText(userId: string): string {
  return `您的使用者ID \`${userId}\`\n尚未加入白名單，若有使用需求，\n請聯絡此 LINE Bot 的管理員`
}

export function formatGroupCannedText(groupOrRoomId: string): string {
  return `此群組ID \`${groupOrRoomId}\`\n尚未加入白名單，若有使用需求，\n請聯絡此 LINE Bot 的管理員`
}

/**
 * Read the persisted notified-ids store. Missing file is fine (empty Set);
 * other read errors are logged but treated as "start fresh" — better to
 * occasionally re-notify than to crash the plugin on startup.
 */
export function loadNotifiedIds(notifiedIdsLog: string): Set<string> {
  const set = new Set<string>()
  try {
    const raw = readFileSync(notifiedIdsLog, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) set.add(trimmed)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        'line-gateway-plugin: could not read ' + notifiedIdsLog + ': ' + err + '\n',
      )
    }
  }
  return set
}

/**
 * Append a notified id. Best-effort: the in-memory Set is updated by the
 * caller before this runs, so a transient fs error here only means one
 * extra notification on the next restart, never a duplicate within the
 * current session.
 */
export function persistNotifiedId(notifiedIdsLog: string, id: string): void {
  try {
    appendFileSync(notifiedIdsLog, id + '\n', { mode: 0o600 })
  } catch {
    // best effort — Set guards against duplicates this session
  }
}
