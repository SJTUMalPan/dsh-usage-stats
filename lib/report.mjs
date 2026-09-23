/**
 * Report rendering: Markdown, CSV, and JSON.
 *
 * Every view is derived from the same priced step records, so the per-project
 * totals, the per-turn totals, and the flat CSV always agree.
 *
 * @module dsh-usage-stats/report
 */

import { groupByTurn, rollup } from './sessions.mjs'

/**
 * Format a money amount for display.
 * @param {number} value - Amount in the catalog currency.
 * @returns {string} Fixed-precision amount.
 */
export function money(value) {
  return value.toFixed(4)
}

/**
 * Format an epoch millisecond timestamp as UTC `MM-DD HH:MM`.
 * @param {number|null} ms - Epoch milliseconds.
 * @returns {string} Display timestamp, or `-`.
 */
export function stamp(ms) {
  if (ms === null) return '-'
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
}

/**
 * Percentage of a session's spend caused by its subagent descendants.
 * @param {object[]} sessions - Sessions belonging to one project.
 * @returns {object} Cost split between root and subagent sessions.
 */
export function splitByDepth(sessions) {
  const root = []
  const sub = []
  for (const session of sessions) {
    for (const step of session.steps) (session.depth === 0 ? root : sub).push(step)
  }
  return { root: rollup(root), sub: rollup(sub) }
}

/**
 * Group sessions by project directory.
 * @param {object[]} sessions - Session records with priced steps.
 * @param {string[]} extraProjects - Project paths to include even with no sessions.
 * @returns {Map<string, object[]>} Project path to its sessions.
 */
export function groupByProject(sessions, extraProjects = []) {
  const projects = new Map(extraProjects.map((p) => [p, []]))
  for (const session of sessions) {
    const key = session.cwd ?? '(无 cwd)'
    if (!projects.has(key)) projects.set(key, [])
    projects.get(key).push(session)
  }
  return projects
}

/**
 * Render the full Markdown report.
 * @param {object} input - Report inputs.
 * @param {Map<string, object[]>} input.projects - Project to sessions.
 * @param {object} input.catalog - Parsed price catalog.
 * @param {string} input.generatedAt - ISO timestamp for the header.
 * @param {number} [input.topSteps] - How many expensive steps to list.
 * @param {number} [input.turnsPerProject] - How many turns to list per project.
 * @returns {string} Markdown report.
 */
export function renderMarkdown({ projects, catalog, generatedAt, topSteps = 15, turnsPerProject = 0 }) {
  const currency = catalog.currency ?? 'CNY'
  const lines = []
  const ranked = [...projects.entries()]
    .map(([cwd, sessions]) => [cwd, sessions, rollup(sessions.flatMap((s) => s.steps)), splitByDepth(sessions)])
    .sort((a, b) => b[2].cost - a[2].cost)

  lines.push('# DSH 各工程用量与成本统计', '')
  lines.push(`- 币种：**${currency}**`)
  lines.push(`- 价目表：\`${catalog.source ?? 'n/a'}\``)
  lines.push(`- 生成时间：${generatedAt}`)
  lines.push('- 口径：`step` = 一次 LLM 调用；**未命中输入**与**缓存命中输入**分列计价；子代理会话单独列出并计入所属工程。')
  if (catalog.notes != null) {
    for (const note of catalog.notes) lines.push(`- ${note}`)
  }

  lines.push('', '## 一、按工程汇总', '')
  lines.push(`| 工程 | 会话 | 子代理会话 | 步骤 | 未命中输入 | 缓存命中输入 | 输出 | 缓存命中率 | 花费 (${currency}) |`)
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const [cwd, sessions, total] of ranked) {
    const subs = sessions.filter((s) => s.depth !== 0).length
    lines.push(
      `| \`${cwd}\` | ${sessions.length} | ${subs} | ${total.steps.toLocaleString()} | ` +
        `${total.uncached.toLocaleString()} | ${total.cache.toLocaleString()} | ${total.output.toLocaleString()} | ` +
        `${total.hitRate.toFixed(2)}% | ${money(total.cost)} |`,
    )
  }
  const allSteps = ranked.flatMap(([, sessions]) => sessions.flatMap((s) => s.steps))
  const all = rollup(allSteps)
  lines.push(
    `| **合计** | ${ranked.reduce((n, [, s]) => n + s.length, 0)} | ` +
      `${ranked.reduce((n, [, s]) => n + s.filter((x) => x.depth !== 0).length, 0)} | ` +
      `${all.steps.toLocaleString()} | ${all.uncached.toLocaleString()} | ${all.cache.toLocaleString()} | ` +
      `${all.output.toLocaleString()} | ${all.hitRate.toFixed(2)}% | **${money(all.cost)}** |`,
  )

  lines.push('', '### 主会话 / 子代理拆分', '')
  lines.push(`| 工程 | 主会话花费 | 子代理花费 | 子代理占比 |`)
  lines.push('|---|---:|---:|---:|')
  for (const [cwd, , , split] of ranked) {
    const total = split.root.cost + split.sub.cost
    const share = total === 0 ? 0 : (100 * split.sub.cost) / total
    lines.push(`| \`${cwd}\` | ${money(split.root.cost)} | ${money(split.sub.cost)} | ${share.toFixed(1)}% |`)
  }

  lines.push('', '### 峰谷拆分', '')
  lines.push('| 工程 | 峰时花费 | 谷时花费 | 未定价步骤 |')
  lines.push('|---|---:|---:|---:|')
  for (const [cwd, , total] of ranked) {
    lines.push(`| \`${cwd}\` | ${money(total.costPeak)} | ${money(total.costOffPeak)} | ${total.unpriced} |`)
  }

  lines.push('', '### 成本构成', '')
  lines.push(`| 分项 | 金额 (${currency}) | 占比 |`)
  lines.push('|---|---:|---:|')
  const parts = [
    ['输出', allSteps.reduce((n, s) => n + s.costOutput, 0)],
    ['缓存命中输入', allSteps.reduce((n, s) => n + s.costCache, 0)],
    ['未命中输入', allSteps.reduce((n, s) => n + s.costUncached, 0)],
  ]
  for (const [label, value] of parts) {
    lines.push(`| ${label} | ${money(value)} | ${all.cost === 0 ? '0.0' : ((100 * value) / all.cost).toFixed(1)}% |`)
  }

  lines.push('', '## 二、按工程 → 会话', '')
  for (const [cwd, sessions, total] of ranked) {
    lines.push('', `### \`${cwd}\` — ${money(total.cost)} ${currency} / ${total.steps.toLocaleString()} 步 / ${sessions.length} 会话`, '')
    if (sessions.length === 0) {
      lines.push('_该工程暂无会话记录。_')
      continue
    }
    lines.push('| 会话 | 类型 | 模型 | 步骤 | 缓存命中率 | 花费 | 起始 (UTC) |')
    lines.push('|---|---|---|---:|---:|---:|---|')
    const sorted = [...sessions].sort((a, b) => rollup(b.steps).cost - rollup(a.steps).cost)
    for (const session of sorted) {
      const t = rollup(session.steps)
      const kind = session.depth === 0 ? '主会话' : `子代理 d${session.depth}`
      lines.push(
        `| \`${session.id}\` | ${kind} | ${session.model ?? '?'} | ${t.steps} | ` +
          `${t.hitRate.toFixed(1)}% | ${money(t.cost)} | ${stamp(t.first)} |`,
      )
    }
  }

  if (turnsPerProject > 0) {
    lines.push('', '## 三、按工程 → turn（同序号跨会话汇总）', '')
    for (const [cwd, sessions] of ranked) {
      if (sessions.length === 0) continue
      lines.push('', `### \`${cwd}\` — 花费最高的 ${turnsPerProject} 轮`, '')
      lines.push('| turn | 步骤 | 未命中输入 | 缓存命中输入 | 输出 | 缓存命中率 | 花费 |')
      lines.push('|---:|---:|---:|---:|---:|---:|---:|')
      const turns = [...groupByTurn(sessions.flatMap((s) => s.steps)).entries()]
        .map(([turn, steps]) => [turn, rollup(steps)])
        .sort((a, b) => b[1].cost - a[1].cost)
        .slice(0, turnsPerProject)
      for (const [turn, t] of turns) {
        lines.push(
          `| ${turn} | ${t.steps} | ${t.uncached.toLocaleString()} | ${t.cache.toLocaleString()} | ` +
            `${t.output.toLocaleString()} | ${t.hitRate.toFixed(1)}% | ${money(t.cost)} |`,
        )
      }
    }
  }

  lines.push('', `## 四、最贵的 ${topSteps} 个步骤`, '')
  lines.push('| 工程 | 会话 | turn | step | 未命中输入 | 缓存命中输入 | 输出 | 命中率 | 时段 | 花费 |')
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|---:|')
  const flat = ranked.flatMap(([cwd, sessions]) => sessions.flatMap((s) => s.steps.map((step) => ({ cwd, session: s, step }))))
  for (const { cwd, session, step } of flat.sort((a, b) => b.step.cost - a.step.cost).slice(0, topSteps)) {
    const input = step.uncached + step.cache
    const hit = input === 0 ? 0 : (100 * step.cache) / input
    lines.push(
      `| \`${cwd.split('/').pop() ?? cwd}\` | \`${session.id.slice(0, 14)}\` | ${step.turn} | ${step.step} | ` +
        `${step.uncached.toLocaleString()} | ${step.cache.toLocaleString()} | ${step.output.toLocaleString()} | ` +
        `${hit.toFixed(1)}% | ${step.tier} | ${money(step.cost)} |`,
    )
  }

  return lines.join('\n') + '\n'
}

/**
 * Render one CSV row per model call.
 * @param {object[]} sessions - Session records with priced steps.
 * @returns {string} CSV text.
 */
export function renderCsv(sessions) {
  const header = [
    'project', 'session', 'session_type', 'depth', 'parent_session', 'model',
    'turn', 'step', 'time_utc', 'uncached_input', 'cache_read_input', 'output', 'reasoning',
    'cache_hit_rate_pct', 'tier', 'cost_cache', 'cost_uncached', 'cost_output', 'cost_total',
  ]
  const rows = [header.join(',')]
  for (const session of sessions) {
    for (const step of session.steps) {
      const input = step.uncached + step.cache
      rows.push([
        csv(session.cwd), csv(session.id), session.depth === 0 ? 'root' : 'subagent', session.depth,
        csv(session.parent), csv(session.model), step.turn, step.step,
        step.time === null ? '' : new Date(step.time).toISOString(),
        step.uncached, step.cache, step.output, step.reasoning,
        input === 0 ? '' : ((100 * step.cache) / input).toFixed(2),
        step.tier, step.costCache.toFixed(8), step.costUncached.toFixed(8),
        step.costOutput.toFixed(8), step.cost.toFixed(8),
      ].join(','))
    }
  }
  return rows.join('\n') + '\n'
}

/**
 * Quote a CSV field when it contains a delimiter, quote, or newline.
 * @param {unknown} value - Field value.
 * @returns {string} CSV-safe field.
 */
function csv(value) {
  if (value == null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Render the machine-readable report.
 * @param {object} input - Report inputs.
 * @param {Map<string, object[]>} input.projects - Project to sessions.
 * @param {object} input.catalog - Parsed price catalog.
 * @param {string} input.generatedAt - ISO timestamp.
 * @returns {string} JSON text.
 */
export function renderJson({ projects, catalog, generatedAt }) {
  const payload = {
    currency: catalog.currency,
    priceSource: catalog.source,
    generatedAt,
    projects: [...projects.entries()].map(([cwd, sessions]) => {
      const total = rollup(sessions.flatMap((s) => s.steps))
      const split = splitByDepth(sessions)
      return {
        project: cwd,
        totals: total,
        root: split.root,
        subagent: split.sub,
        sessions: sessions.map((s) => ({
          id: s.id,
          type: s.depth === 0 ? 'root' : 'subagent',
          depth: s.depth,
          parent: s.parent,
          cwd: s.cwd,
          model: s.model,
          totals: rollup(s.steps),
          turns: [...groupByTurn(s.steps).entries()].map(([turn, steps]) => ({ turn, totals: rollup(steps) })),
          steps: s.steps,
        })),
      }
    }),
  }
  return JSON.stringify(payload, null, 2) + '\n'
}
