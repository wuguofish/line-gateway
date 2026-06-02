/**
 * Thin reader over `access.json`, compatible with the existing
 * `claude-line-channel` schema so a cutover day doesn't need to touch
 * this file.
 *
 * For Phase B we only need `allowFrom[0]` (the primary owner for
 * permission replies) — other policy fields (dmPolicy, groups,
 * mentionPatterns, etc.) remain read by the plugin on its side and
 * are NOT re-implemented here.
 */

import { readFileSync } from 'fs'

export interface AccessSnapshot {
  /** First entry of allowFrom — the "primary owner" who can answer permission prompts. */
  primaryOwner: string | null
}

export function readAccess(accessFile: string): AccessSnapshot {
  try {
    const raw = readFileSync(accessFile, 'utf8')
    const parsed = JSON.parse(raw) as { allowFrom?: unknown }
    const allowFrom = Array.isArray(parsed.allowFrom) ? parsed.allowFrom : []
    const first = allowFrom.find(x => typeof x === 'string' && x.length > 0) as string | undefined
    return { primaryOwner: first ?? null }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`line-gateway: could not read ${accessFile}: ${err}\n`)
    }
    return { primaryOwner: null }
  }
}
