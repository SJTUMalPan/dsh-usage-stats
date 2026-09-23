#!/usr/bin/env node
/**
 * Cross-check the folded per-session totals against DSH's own `tokenUsage`
 * projection cache.
 *
 * The projection cache is a *periodic snapshot*, so a session that is still
 * being written is expected to run ahead of it. Comparing only the token
 * totals would therefore report phantom failures on live sessions. The check
 * below uses the projection's `seq` to separate the two cases:
 *
 *   - `exact`    — projection is current and agrees; the fold is correct.
 *   - `lagging`  — projection is behind the log, so it cannot corroborate.
 *   - `mismatch` — projection is current and disagrees. This is a real bug.
 *
 * Exit code is non-zero only for `mismatch`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { findLogs, loadSessions, sessionsRoot } from './lib/sessions.mjs'
import { readSessionEvents } from './lib/zstd.mjs'

const root = sessionsRoot(process.env, homedir())
const sessions = loadSessions(root, (m) => console.error('warn:', m))
/** Session id to its durable log path, used to read the log's own last seq. */
const logById = new Map(findLogs(root).map((log) => [log.split('/').at(-2), log]))

const cacheDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'session_projcache', 'sessions')
const projections = new Map()
for (const name of readdirSync(cacheDir)) {
  if (!name.endsWith('.json')) continue
  try {
    const record = JSON.parse(readFileSync(join(cacheDir, name), 'utf8'))
    const usage = record?.record?.rows?.tokenUsage
    if (usage) projections.set(name.slice(0, -5), usage)
  } catch { /* ignore unreadable cache entries */ }
}

/** Highest event seq present in a session log. */
function lastSeq(log) {
  const events = readSessionEvents(log, { readFileSync })
  return events.reduce((max, e) => Math.max(max, e.seq ?? 0), 0)
}

let exact = 0
let lagging = 0
let missing = 0
const mismatches = []

for (const session of sessions) {
  const projection = projections.get(session.id)
  if (!projection) { missing += 1; continue }

  const mine = session.steps.reduce(
    (acc, s) => ({
      uncached: acc.uncached + s.uncached,
      cache: acc.cache + s.cache,
      output: acc.output + s.output,
    }),
    { uncached: 0, cache: 0, output: 0 },
  )
  const totals = projection.val.totals
  const agrees =
    totals.uncachedInputTokens === mine.uncached &&
    totals.cacheReadTokens === mine.cache &&
    totals.outputTokens === mine.output

  if (agrees) { exact += 1; continue }

  const log = logById.get(session.id)
  if (log === undefined) { missing += 1; continue }
  if (projection.seq < lastSeq(log)) { lagging += 1; continue }
  mismatches.push({ id: session.id, projection: totals, mine })
}

console.log(`sessions folded      : ${sessions.length}`)
console.log(`projection cache size: ${projections.size}`)
console.log(`exact match          : ${exact}`)
console.log(`lagging (live)       : ${lagging}`)
console.log(`mismatch             : ${mismatches.length}`)
console.log(`no projection entry  : ${missing}`)
for (const m of mismatches.slice(0, 10)) {
  console.log('  MISMATCH', m.id)
  console.log('    projection', m.projection)
  console.log('    folded    ', m.mine)
}
process.exitCode = mismatches.length === 0 ? 0 : 1
