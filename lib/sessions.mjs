/**
 * Session discovery and per-step usage folding.
 *
 * Ground truth is the durable session log. DSH records one `assistant/message`
 * event per completed model step carrying
 * `data.usage = {inputTokens, outputTokens, cacheReadTokens, reasoningTokens}`,
 * where `inputTokens` is the *cache-miss* portion only — `totalTokens` is
 * `inputTokens + cacheReadTokens + outputTokens`. Folding only the final
 * `assistant/message` per step avoids double counting the streaming
 * `assistant/chunk` usage samples, which report the same call.
 *
 * @module dsh-usage-stats/sessions
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents } from './zstd.mjs'

/**
 * Locate the durable session root.
 * @param {NodeJS.ProcessEnv} env - Environment to read `DSH_HOME` from.
 * @param {string} home - Fallback home directory.
 * @returns {string} Absolute path to the sessions root.
 */
export function sessionsRoot(env, home) {
  return join(env.DSH_HOME ?? join(home, '.dsh'), 'sessions')
}

/**
 * Enumerate every `session.v3.jsonl.zstd` log under a sessions root.
 * @param {string} root - Sessions root.
 * @returns {string[]} Absolute log paths.
 */
export function findLogs(root) {
  const logs = []
  let workspaces
  try {
    workspaces = readdirSync(root)
  } catch {
    return logs
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace)
    if (!isDir(workspaceDir)) continue
    for (const session of readdirSync(workspaceDir)) {
      const log = join(workspaceDir, session, 'session.v3.jsonl.zstd')
      if (isFile(log)) logs.push(log)
    }
  }
  return logs.sort()
}

/**
 * Check whether a path is a directory.
 * @param {string} path - Candidate path.
 * @returns {boolean} True for directories.
 */
function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Check whether a path is a regular file.
 * @param {string} path - Candidate path.
 * @returns {boolean} True for regular files.
 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Fold one session log into per-step usage records.
 *
 * The model is taken from the newest route-bearing event seen *before* each
 * step, so a session that switched models mid-flight is priced correctly.
 * `reasoningTokens` is reported for information only: it is already included
 * in `outputTokens` and must not be billed a second time.
 *
 * @param {string} log - Absolute log path.
 * @returns {object|null} Session record, or null when the log has no header.
 */
/**
 * 把日志里的字段强制成数字，非法值一律归 `null`。
 *
 * 为什么必须做：这些字段会经 payload 进仪表盘，并被 `lib/client.js` 拼进
 * `innerHTML`（数值位置未走 esc()）。会话日志写在 `DSH_HOME` 下、可被能写该目录的
 * 进程修改，原样透传就等于**同源存储型 XSS**（仪表盘与 DSH GUI 同源）。
 * 在解析层一次性转成数字，比在渲染层逐个补转义更彻底、也更难回归。
 *
 * 注意：缺失/非法都归 `null`（**不是 0**）——`null` 表示"没有这个信息"，
 * 折成 0 会污染统计语义（例如把未知轮次算成第 0 轮）。
 *
 * @param {unknown} value - 日志里的原始值。
 * @returns {number|null} 有限数字或 null。
 */
export function numericOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function foldSession(log) {
  const events = readSessionEvents(log, { readFileSync })
  const header = events.find((e) => e.type === 'session')
  if (header === undefined) return null

  const steps = []
  let model = null
  for (const event of events) {
    if (event.type === 'request/header') {
      model = event.data?.header?.config?.model ?? model
    } else if (event.type === 'request/context') {
      model = event.data?.model ?? model
    } else if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage == null) continue
      steps.push({
        turn: numericOrNull(event.data?.turn),
        step: numericOrNull(event.data?.step),
        time: event.time ?? null,
        at: event.time == null ? null : new Date(event.time),
        uncached: usage.inputTokens ?? 0,
        cache: usage.cacheReadTokens ?? 0,
        output: usage.outputTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
        model,
      })
    }
  }

  return {
    id: header.id,
    cwd: header.cwd ?? null,
    createdAt: header.createdAt ?? null,
    model,
    parent: header.parentSession ?? null,
    origin: header.origin ?? null,
    depth: numericOrNull(header.delegationDepth) ?? 0,
    steps,
  }
}

/**
 * Load and fold every session log under a root.
 * @param {string} root - Sessions root.
 * @param {(message: string) => void} [warn] - Sink for per-session failures.
 * @returns {object[]} Session records.
 */
export function loadSessions(root, warn = () => {}) {
  const sessions = []
  for (const log of findLogs(root)) {
    try {
      const session = foldSession(log)
      if (session !== null) sessions.push(session)
    } catch (error) {
      // One unreadable log must not abort a whole-workspace report.
      warn(`skipped ${log}: ${error.message}`)
    }
  }
  return sessions
}

/**
 * Aggregate a list of priced steps.
 *
 * Steps without a catalog price are counted in `unpriced` so a report can say
 * "this total is incomplete" instead of silently understating spend.
 *
 * @param {object[]} steps - Priced step records.
 * @returns {object} Totals including cache hit rate.
 */
export function rollup(steps) {
  const total = {
    steps: steps.length,
    uncached: 0,
    cache: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    costPeak: 0,
    costOffPeak: 0,
    unpriced: 0,
    hitRate: 0,
    first: null,
    last: null,
  }
  for (const step of steps) {
    total.uncached += step.uncached
    total.cache += step.cache
    total.output += step.output
    total.reasoning += step.reasoning
    total.cost += step.cost
    if (step.tier === 'peak') total.costPeak += step.cost
    else if (step.tier === 'offpeak') total.costOffPeak += step.cost
    else total.unpriced += 1
    if (step.time !== null) {
      if (total.first === null || step.time < total.first) total.first = step.time
      if (total.last === null || step.time > total.last) total.last = step.time
    }
  }
  const input = total.uncached + total.cache
  total.hitRate = input === 0 ? 0 : (100 * total.cache) / input
  return total
}

/**
 * Group priced steps by turn.
 * @param {object[]} steps - Priced step records.
 * @returns {Map<number|null, object[]>} Turn number to its steps.
 */
export function groupByTurn(steps) {
  const turns = new Map()
  for (const step of steps) {
    if (!turns.has(step.turn)) turns.set(step.turn, [])
    turns.get(step.turn).push(step)
  }
  return turns
}
