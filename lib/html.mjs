/**
 * Self-contained HTML dashboard.
 *
 * The output is a single file: data, styles, and script all inlined, no CDN and
 * no network access at view time. That is deliberate — the report must open by
 * double-click from `file://` and keep working offline, so nothing may be
 * fetched at runtime.
 *
 * Only a reduced, presentation-shaped dataset is embedded (per-project, per-
 * session, per-turn, and per-step totals) rather than the raw event log.
 *
 * @module dsh-usage-stats/html
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { groupByTurn, rollup } from './sessions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Collapse a step list into the compact shape the page needs.
 * @param {object[]} steps - Priced step records.
 * @returns {object} Totals stripped of fields the page does not render.
 */
function slim(steps) {
  const t = rollup(steps)
  return {
    steps: t.steps,
    uncached: t.uncached,
    cache: t.cache,
    output: t.output,
    reasoning: t.reasoning,
    cost: t.cost,
    costCache: steps.reduce((n, s) => n + s.costCache, 0),
    costUncached: steps.reduce((n, s) => n + s.costUncached, 0),
    costOutput: steps.reduce((n, s) => n + s.costOutput, 0),
    costPeak: t.costPeak,
    costOffPeak: t.costOffPeak,
    unpriced: t.unpriced,
    hitRate: t.hitRate,
    first: t.first,
    last: t.last,
  }
}

/**
 * Bucket steps into per-UTC-day cost totals.
 * @param {object[]} steps - Priced step records.
 * @returns {object[]} `{date, cost, steps, cache, uncached, output}` per day.
 */
function byDay(steps) {
  const days = new Map()
  for (const step of steps) {
    if (step.time === null) continue
    const date = new Date(step.time).toISOString().slice(0, 10)
    if (!days.has(date)) days.set(date, { date, cost: 0, steps: 0, cache: 0, uncached: 0, output: 0 })
    const day = days.get(date)
    day.cost += step.cost
    day.steps += 1
    day.cache += step.cache
    day.uncached += step.uncached
    day.output += step.output
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/**
 * Build the embedded dataset.
 * @param {Map<string, object[]>} projects - Project path to sessions.
 * @param {object} catalog - Parsed price catalog.
 * @param {string} generatedAt - ISO timestamp.
 * @returns {object} Page data.
 */
export function buildData(projects, catalog, generatedAt) {
  const allSteps = [...projects.values()].flatMap((ss) => ss.flatMap((s) => s.steps))
  const rootSteps = [...projects.values()].flatMap((ss) => ss.filter((s) => s.depth === 0).flatMap((s) => s.steps))
  const subSteps = [...projects.values()].flatMap((ss) => ss.filter((s) => s.depth !== 0).flatMap((s) => s.steps))
  const totals = Object.assign(slim(allSteps), {
    sessions: [...projects.values()].reduce((n, ss) => n + ss.length, 0),
    rootCost: rootSteps.reduce((n, s) => n + s.cost, 0),
    subCost: subSteps.reduce((n, s) => n + s.cost, 0),
  })

  const byModel = new Map()
  for (const sessions of projects.values()) {
    for (const session of sessions) {
      const key = session.model ?? '(未知)'
      if (!byModel.has(key)) byModel.set(key, [])
      byModel.get(key).push(session)
    }
  }

  return {
    generatedAt,
    currency: catalog.currency ?? 'CNY',
    priceSource: catalog.source ?? 'n/a',
    notes: catalog.notes ?? [],
    totals,
    models: [...byModel.entries()]
      .map(([model, sessions]) => ({
        model,
        sessions: sessions.length,
        totals: slim(sessions.flatMap((s) => s.steps)),
      }))
      // Sessions with no priced step (empty projects) would otherwise add a
      // meaningless "(未知) · 0.00" row to the model chart.
      .filter((m) => m.totals.steps > 0)
      .sort((a, b) => b.totals.cost - a.totals.cost),
    projects: [...projects.entries()].map(([project, sessions]) => ({
      project,
      totals: slim(sessions.flatMap((s) => s.steps)),
      root: slim(sessions.filter((s) => s.depth === 0).flatMap((s) => s.steps)),
      sub: slim(sessions.filter((s) => s.depth !== 0).flatMap((s) => s.steps)),
      daily: byDay(sessions.flatMap((s) => s.steps)),
      sessions: sessions.map((s) => ({
        id: s.id,
        depth: s.depth,
        parent: s.parent,
        model: s.model,
        cwd: s.cwd,
        totals: slim(s.steps),
        turns: [...groupByTurn(s.steps).entries()].map(([turn, steps]) => ({ turn, totals: slim(steps) })),
        // Short keys: this array is the biggest part of the embedded payload.
        steps: s.steps.map((st) => ({
          turn: st.turn,
          step: st.step,
          t: st.time,
          u: st.uncached,
          c: st.cache,
          o: st.output,
          cost: st.cost,
          tier: st.tier,
        })),
      })),
    })),
  }
}

/**
 * Render the single-file dashboard.
 * @param {object} data - Result of {@link buildData}.
 * @returns {string} Complete HTML document.
 */
export function renderHtml(data) {
  const css = readFileSync(join(HERE, 'client.css'), 'utf8')
  const js = readFileSync(join(HERE, 'client.js'), 'utf8')

  // `<` is escaped so the payload can never terminate the script element early.
  const json = JSON.stringify(data).replaceAll('<', '\\u003c')
  const notes = (data.notes ?? [])
    .map((n) => `<li>${escapeHtml(n)}</li>`)
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 开销统计 · ${escapeHtml(data.totals.steps.toLocaleString())} 步 / ${data.totals.cost.toFixed(2)} ${escapeHtml(data.currency)}</title>
<style>
${css}
</style>
</head>
<body>
<div class="wrap">

  <div class="head">
    <div>
      <h1>DSH 各工程开销统计</h1>
      <div class="sub" id="head-sub"></div>
    </div>
    <div class="badge" id="head-badge"></div>
  </div>

  <div class="kpis" id="kpis"></div>

  <div class="panel">
    <h2>各工程花费<span class="n">按 cwd 归属</span></h2>
    <div class="hint">条长为该工程总花费；子代理会话已计入所属工程。</div>
    <div id="proj-bars"></div>
  </div>

  <div class="panel">
    <h2>各模型花费</h2>
    <div class="hint">同一会话内模型固定，不同会话可能使用不同模型；旧名 <code>deepseek-v4-flash</code> 已按 Flash 价格计价。</div>
    <div id="model-bars"></div>
  </div>

  <div class="grid2">
    <div class="panel">
      <h2>成本构成</h2>
      <div class="hint">缓存命中单价约为未命中的 1/50，但量极大，仍是主要成本之一。</div>
      <div id="composition"></div>
    </div>
    <div class="panel">
      <h2>主会话 vs 子代理</h2>
      <div class="hint">只统计主会话会显著少算。</div>
      <div id="split-bars"></div>
    </div>
  </div>

  <div class="panel">
    <h2>峰时 vs 谷时</h2>
    <div class="hint">高峰 = 北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；空闲价为高峰价的一半。按每次调用发生时刻判定。</div>
    <div id="peak-bars"></div>
  </div>

  <div class="panel">
    <h2>每日花费趋势<span class="n">UTC</span></h2>
    <div class="hint">按工程堆叠，悬停查看当日合计。</div>
    <div id="daily"></div>
    <div id="daily-legend" style="margin-top:10px"></div>
  </div>

  <div class="panel">
    <h2>会话明细</h2>
    <div class="hint">点击任意行展开该会话的逐轮曲线与 turn 汇总。点表头可排序。</div>
    <div class="controls">
      <label class="f" for="f-project">工程</label>
      <select id="f-project"></select>
      <input type="search" id="f-query" placeholder="搜索会话 id / 模型…" style="min-width:220px">
    </div>
    <div id="sessions"></div>
    <div id="drill"></div>
  </div>

  <div class="panel">
    <h2>最贵的 25 个步骤</h2>
    <div class="hint">单次 LLM 调用花费排行；未命中输入高的步骤通常是冷启动或缓存失效。</div>
    <div id="top-steps"></div>
  </div>

  <div class="foot">
    <div><b>口径</b>：step = 一次 LLM 调用（对应一条 <code>assistant/message</code> 事件）。</div>
    <div><code>usage.inputTokens</code> 是<b>缓存未命中</b>部分，不是输入总量；<code>totalTokens = inputTokens + cacheReadTokens + outputTokens</code>。两者单价差约 50 倍，绝不能相加后计价。</div>
    <div><code>reasoningTokens</code> 已包含在 <code>outputTokens</code> 中，只展示不重复计费；缓存写入不单独计费。</div>
    ${notes ? `<ul style="margin:8px 0 0;padding-left:18px">${notes}</ul>` : ''}
  </div>

</div>

<script id="usage-data" type="application/json">${json}</script>
<script>
${js}
</script>
</body>
</html>
`
}

/**
 * Escape text for HTML element content.
 * @param {unknown} value - Raw value.
 * @returns {string} Escaped text.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
