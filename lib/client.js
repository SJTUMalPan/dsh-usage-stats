/* dsh-usage-stats — client renderer (inlined into the generated HTML).
 *
 * Reads the JSON embedded in #usage-data and draws the dashboard. Charts are
 * hand-built SVG, so the page needs no charting library and no network.
 */
(function () {
  'use strict'

  var DATA = JSON.parse(document.getElementById('usage-data').textContent)
  var CURRENCY = DATA.currency || 'CNY'
  var COLOR = {
    cache: '#2dd4bf',
    uncached: '#f5a524',
    output: '#5b8cff',
    peak: '#f4635f',
    offpeak: '#3f8cff',
    root: '#4d6bfe',
    sub: '#a06bff'
  }

  /* ------------------------------------------------------------ helpers */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function money(v) {
    if (v >= 1000) return v.toFixed(0)
    if (v >= 100) return v.toFixed(1)
    if (v >= 1) return v.toFixed(2)
    return v.toFixed(4)
  }
  function int(v) { return (v || 0).toLocaleString('en-US') }
  function pct(v) { return (v || 0).toFixed(2) + '%' }
  function tok(v) {
    v = v || 0
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(v)
  }
  function shortName(path) {
    if (!path) return '(无 cwd)'
    var parts = path.split('/').filter(Boolean)
    return parts[parts.length - 1] || path
  }
  function stamp(ms) {
    if (!ms) return '-'
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
  }

  /** Fixed-precision formatter so every tick on one axis reads the same. */
  function tickFmt(max) {
    var d = max >= 100 ? 0 : max >= 10 ? 1 : max >= 1 ? 2 : 3
    return function (v) { return v.toFixed(d) }
  }

  /** Distinct hues for stacking projects in one chart. */
  var PALETTE = ['#4d6bfe', '#2dd4bf', '#f5a524', '#a06bff', '#f4635f', '#22d3ee', '#84cc16']
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild }

  /* ------------------------------------------------------------- charts */
  /** Horizontal bar list. rows: [{label, sub, value}] */
  function barList(rows, color) {
    if (!rows.length) return '<div class="empty">无数据</div>'
    var max = Math.max.apply(null, rows.map(function (r) { return r.value })) || 1
    return '<div class="bars">' + rows.map(function (r) {
      // A zero-cost row keeps its track but draws no fill: the CSS min-width
      // would otherwise show a misleading 3px sliver.
      var fill = r.value > 0
        ? '<div class="bar-fill" style="width:' + Math.max(0.6, (r.value / max) * 100).toFixed(2) +
          '%;background:' + (r.color || color || 'var(--accent)') + '"></div>'
        : ''
      return '<div class="bar-row">' +
        '<div class="lbl" title="' + esc(r.full || r.label) + '">' + esc(r.label) +
          (r.sub ? ' <span class="tag">' + esc(r.sub) + '</span>' : '') + '</div>' +
        '<div class="bar-track">' + fill + '</div>' +
        '<div class="num">' + money(r.value) + '</div></div>'
    }).join('') + '</div>'
  }

  /** Stacked horizontal bars. rows: [{label, sub, segs:[{v,color,name}]}] */
  function stackedList(rows) {
    if (!rows.length) return '<div class="empty">无数据</div>'
    var max = 0
    rows.forEach(function (r) {
      var t = r.segs.reduce(function (a, s) { return a + s.v }, 0)
      if (t > max) max = t
    })
    max = max || 1
    return '<div class="bars">' + rows.map(function (r) {
      var segs = r.segs.map(function (s) {
        var w = (s.v / max) * 100
        if (w <= 0) return ''
        return '<span style="width:' + w.toFixed(3) + '%;background:' + s.color + '" title="' +
          esc(s.name) + ': ' + money(s.v) + '"></span>'
      }).join('')
      var total = r.segs.reduce(function (a, s) { return a + s.v }, 0)
      return '<div class="bar-row">' +
        '<div class="lbl" title="' + esc(r.full || r.label) + '">' + esc(r.label) +
          (r.sub ? ' <span class="tag">' + esc(r.sub) + '</span>' : '') + '</div>' +
        '<div class="stacked">' + segs + '</div>' +
        '<div class="num">' + money(total) + '</div></div>'
    }).join('') + '</div>'
  }

  /** Donut with legend. segs: [{v,name,color}] */
  function donut(segs) {
    var total = segs.reduce(function (a, s) { return a + s.v }, 0)
    if (total <= 0) return '<div class="empty">无数据</div>'
    var R = 62, SW = 20, CX = 78, CY = 78, CIRC = 2 * Math.PI * R
    var off = 0
    var arcs = segs.map(function (s) {
      var f = s.v / total
      var seg = '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none" stroke="' + s.color +
        '" stroke-width="' + SW + '" stroke-dasharray="' + (f * CIRC).toFixed(2) + ' ' + CIRC.toFixed(2) +
        '" stroke-dashoffset="' + (-off * CIRC).toFixed(2) + '" transform="rotate(-90 ' + CX + ' ' + CY + ')"></circle>'
      off += f
      return seg
    }).join('')
    return '<div class="donut-wrap">' +
      '<svg class="donut" width="156" height="156" viewBox="0 0 156 156">' +
        '<circle cx="78" cy="78" r="62" fill="none" stroke="#1a2029" stroke-width="20"></circle>' + arcs +
        '<text x="78" y="74" text-anchor="middle" fill="#e6edf3" font-size="19" font-weight="650">' + money(total) + '</text>' +
        '<text x="78" y="92" text-anchor="middle" fill="#5d6a7a" font-size="11">' + CURRENCY + '</text>' +
      '</svg>' +
      '<div class="legend">' + segs.map(function (s) {
        return '<div class="li"><span class="sw" style="background:' + s.color + '"></span>' +
          '<span>' + esc(s.name) + '</span>' +
          '<span class="amt">' + money(s.v) + ' · ' + ((s.v / total) * 100).toFixed(1) + '%</span></div>'
      }).join('') + '</div></div>'
  }

  /** Daily stacked bars across projects, with a hover title per day. */
  function dailyChart(days, keys) {
    if (!days.length) return '<div class="empty">无数据</div>'
    var W = 1000, H = 210, PL = 52, PR = 12, PT = 14, PB = 30
    var iw = W - PL - PR, ih = H - PT - PB
    var max = 0
    days.forEach(function (d) {
      var t = keys.reduce(function (a, k) { return a + (d.by[k] || 0) }, 0)
      if (t > max) max = t
    })
    max = max || 1
    var bw = Math.max(3, Math.min(42, iw / days.length - 5))
    var step = iw / days.length
    var bars = days.map(function (d, i) {
      var x = PL + i * step + (step - bw) / 2
      var y = PT + ih
      var segs = keys.map(function (k) {
        var v = d.by[k.key] || 0
        if (v <= 0) return ''
        var h = (v / max) * ih
        y -= h
        return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + h.toFixed(1) + '" fill="' + k.color + '" rx="1.5"></rect>'
      }).join('')
      var total = keys.reduce(function (a, k2) { return a + (d.by[k2.key] || 0) }, 0)
      return '<g><title>' + esc(d.date) + ' · ' + money(total) + ' ' + CURRENCY + '</title>' + segs + '</g>'
    }).join('')
    var tf = tickFmt(max)
    var ticks = [0, 0.25, 0.5, 0.75, 1].map(function (f) {
      var y = PT + ih - f * ih
      return '<line class="gridline" x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="axis" x="' + (PL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + tf(max * f) + '</text>'
    }).join('')
    var labelEvery = Math.ceil(days.length / 12)
    var xlabels = days.map(function (d, i) {
      if (i % labelEvery !== 0) return ''
      var x = PL + i * step + step / 2
      return '<text class="axis" x="' + x.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(d.date.slice(5)) + '</text>'
    }).join('')
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;height:auto">' +
      ticks + bars + xlabels + '</svg>'
  }

  /** Per-turn cost area chart for one session. Receives `{turn, totals}` rows. */
  function turnChart(turns) {
    if (turns.length < 2) return '<div class="empty">该会话轮次不足，无法绘制曲线</div>'
    var W = 1000, H = 170, PL = 52, PR = 12, PT = 12, PB = 26
    var iw = W - PL - PR, ih = H - PT - PB
    var max = Math.max.apply(null, turns.map(function (t) { return t.totals.cost })) || 1
    var step = iw / (turns.length - 1)
    var pts = turns.map(function (t, i) {
      return [PL + i * step, PT + ih - (t.totals.cost / max) * ih]
    })
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1) }).join(' ')
    var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (PT + ih) + ' L' + pts[0][0].toFixed(1) + ' ' + (PT + ih) + ' Z'
    var dots = turns.map(function (t, i) {
      return '<circle cx="' + pts[i][0].toFixed(1) + '" cy="' + pts[i][1].toFixed(1) + '" r="3" fill="#4d6bfe">' +
        '<title>turn ' + t.turn + ' · ' + money(t.totals.cost) + ' ' + CURRENCY + ' · ' + t.totals.steps + ' 步</title></circle>'
    }).join('')
    var tf = tickFmt(max)
    var ticks = [0, 0.5, 1].map(function (f) {
      var y = PT + ih - f * ih
      return '<line class="gridline" x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="axis" x="' + (PL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + tf(max * f) + '</text>'
    }).join('')
    var every = Math.ceil(turns.length / 14)
    var xl = turns.map(function (t, i) {
      if (i % every !== 0) return ''
      return '<text class="axis" x="' + pts[i][0].toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + t.turn + '</text>'
    }).join('')
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;height:auto">' +
      '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4d6bfe" stop-opacity=".38"></stop>' +
      '<stop offset="100%" stop-color="#4d6bfe" stop-opacity="0"></stop></linearGradient></defs>' +
      ticks + '<path d="' + area + '" fill="url(#ag)"></path>' +
      '<path d="' + line + '" fill="none" stroke="#4d6bfe" stroke-width="2"></path>' + dots + xl + '</svg>'
  }

  /* -------------------------------------------------------------- state */
  var state = { project: '', sortKey: 'cost', sortDir: -1, query: '', openSession: null }

  /* ------------------------------------------------------------ sections */
  function renderHeader() {
    var t = DATA.totals
    document.getElementById('head-sub').innerHTML =
      '生成于 ' + esc(DATA.generatedAt.replace('T', ' ').slice(0, 19)) + ' UTC · 价目表 <code>' +
      esc(DATA.priceSource) + '</code> · 数据来自 DSH 会话日志，无模型调用'
    document.getElementById('head-badge').innerHTML =
      '<span class="dot"></span>' + DATA.projects.length + ' 个工程 · ' + t.sessions + ' 个会话 · ' + int(t.steps) + ' 步'
  }

  function renderKpis() {
    var t = DATA.totals
    var subShare = t.rootCost + t.subCost > 0 ? (t.subCost / (t.rootCost + t.subCost)) * 100 : 0
    var cards = [
      { k: '总花费', v: money(t.cost), u: CURRENCY, m: '峰 ' + money(t.costPeak) + ' · 谷 ' + money(t.costOffPeak) },
      { k: '步骤数 (LLM 调用)', v: int(t.steps), u: '', m: '平均 ' + money(t.cost / (t.steps || 1)) + ' ' + CURRENCY + '/步' },
      { k: '缓存命中率', v: pct(t.hitRate), u: '', m: tok(t.cache) + ' 命中 / ' + tok(t.uncached) + ' 未命中' },
      { k: '输出 tokens', v: tok(t.output), u: '', m: '计费输出（含思考）' },
      { k: '子代理花费占比', v: subShare.toFixed(1) + '%', u: '', m: money(t.subCost) + ' / ' + money(t.rootCost + t.subCost) + ' ' + CURRENCY },
      { k: '未定价步骤', v: int(t.unpriced), u: '', m: t.unpriced > 0 ? '花费被少算，请补价目表' : '全部步骤均已计价' }
    ]
    document.getElementById('kpis').innerHTML = cards.map(function (c) {
      return '<div class="kpi"><div class="k">' + esc(c.k) + '</div><div class="v">' + esc(c.v) +
        (c.u ? '<small>' + esc(c.u) + '</small>' : '') + '</div><div class="m">' + esc(c.m) + '</div></div>'
    }).join('')
  }

  function renderProjectBars() {
    var rows = DATA.projects.slice().sort(function (a, b) { return b.totals.cost - a.totals.cost })
      .map(function (p) {
        return {
          label: shortName(p.project), full: p.project,
          sub: p.sessions.length + ' 会话 · ' + pct(p.totals.hitRate) + ' 命中',
          value: p.totals.cost, color: 'linear-gradient(90deg,#4d6bfe,#7c93ff)'
        }
      })
    document.getElementById('proj-bars').innerHTML = barList(rows)
  }

  function renderComposition() {
    var t = DATA.totals
    document.getElementById('composition').innerHTML = donut([
      { name: '输出 tokens', v: t.costOutput, color: COLOR.output },
      { name: '缓存命中输入', v: t.costCache, color: COLOR.cache },
      { name: '未命中输入', v: t.costUncached, color: COLOR.uncached }
    ])
  }

  function renderModels() {
    var rows = (DATA.models || []).map(function (m) {
      return {
        label: m.model, full: m.model,
        sub: m.sessions + ' 会话 · ' + pct(m.totals.hitRate) + ' 命中',
        value: m.totals.cost,
        color: 'linear-gradient(90deg,#a06bff,#4d6bfe)'
      }
    })
    document.getElementById('model-bars').innerHTML = barList(rows)
  }

  function renderSplit() {
    var rows = DATA.projects.filter(function (p) { return p.totals.cost > 0 })
      .sort(function (a, b) { return b.totals.cost - a.totals.cost })
    document.getElementById('split-bars').innerHTML = stackedList(rows.map(function (p) {
      return {
        label: shortName(p.project), full: p.project,
        sub: ((p.sub.cost / (p.totals.cost || 1)) * 100).toFixed(0) + '% 来自子代理',
        segs: [
          { v: p.root.cost, color: COLOR.root, name: '主会话' },
          { v: p.sub.cost, color: COLOR.sub, name: '子代理' }
        ]
      }
    }))
    document.getElementById('peak-bars').innerHTML = stackedList(rows.map(function (p) {
      return {
        label: shortName(p.project), full: p.project,
        sub: ((p.totals.costPeak / (p.totals.cost || 1)) * 100).toFixed(0) + '% 峰时',
        segs: [
          { v: p.totals.costOffPeak, color: COLOR.offpeak, name: '谷时' },
          { v: p.totals.costPeak, color: COLOR.peak, name: '峰时' }
        ]
      }
    }))
  }

  function renderDaily() {
    var map = {}
    var keys = DATA.projects.slice().sort(function (a, b) { return b.totals.cost - a.totals.cost })
      .map(function (p, i) {
        return { key: p.project, color: PALETTE[i % PALETTE.length] }
      })
    DATA.projects.forEach(function (p) {
      p.daily.forEach(function (d) {
        if (!map[d.date]) map[d.date] = { date: d.date, by: {}, steps: 0 }
        map[d.date].by[p.project] = (map[d.date].by[p.project] || 0) + d.cost
        map[d.date].steps += d.steps
      })
    })
    var days = Object.keys(map).sort().map(function (k) { return map[k] })
    document.getElementById('daily').innerHTML = dailyChart(days, keys)
    document.getElementById('daily-legend').innerHTML = keys.map(function (k) {
      return '<span class="li" style="display:inline-flex;margin-right:14px"><span class="sw" style="background:' +
        k.color + '"></span><span>' + esc(shortName(k.key)) + '</span></span>'
    }).join('')
  }

  /** Sortable column key to the comparable value on a flattened session row. */
  function sortValue(row, key) {
    if (key === 'cost') return row.totals.cost
    if (key === 'steps') return row.totals.steps
    if (key === 'hitRate') return row.totals.hitRate
    if (key === 'output') return row.totals.output
    if (key === 'cache') return row.totals.cache
    if (key === 'uncached') return row.totals.uncached
    return row.totals.cost
  }

  /** Build a flat session list respecting the project filter and search box. */
  function visibleSessions() {
    var out = []
    DATA.projects.forEach(function (p) {
      if (state.project && p.project !== state.project) return
      p.sessions.forEach(function (s) {
        if (state.query && s.id.toLowerCase().indexOf(state.query) < 0 &&
            (s.model || '').toLowerCase().indexOf(state.query) < 0) return
        out.push(Object.assign({ project: p.project }, s))
      })
    })
    out.sort(function (a, b) {
      return (sortValue(a, state.sortKey) - sortValue(b, state.sortKey)) * state.sortDir
    })
    return out
  }

  function arrow(key) {
    return state.sortKey === key ? '<span class="arrow">' + (state.sortDir < 0 ? '▼' : '▲') + '</span>' : ''
  }

  function renderSessions() {
    var rows = visibleSessions()
    var head = '<thead><tr>' +
      '<th>工程</th><th>会话</th><th>类型</th><th>模型</th>' +
      '<th class="sortable" data-k="steps" style="text-align:right">步骤' + arrow('steps') + '</th>' +
      '<th class="sortable" data-k="hitRate" style="text-align:right">缓存命中率' + arrow('hitRate') + '</th>' +
      '<th class="sortable" data-k="uncached" style="text-align:right">未命中输入' + arrow('uncached') + '</th>' +
      '<th class="sortable" data-k="cache" style="text-align:right">缓存命中输入' + arrow('cache') + '</th>' +
      '<th class="sortable" data-k="output" style="text-align:right">输出' + arrow('output') + '</th>' +
      '<th class="sortable" data-k="cost" style="text-align:right">花费 (' + CURRENCY + ')' + arrow('cost') + '</th>' +
      '<th>起始 (UTC)</th></tr></thead>'
    var body = rows.map(function (s, i) {
      var t = s.totals
      var active = state.openSession === s.id ? ' active' : ''
      return '<tr class="clickable' + active + '" data-i="' + i + '">' +
        '<td>' + esc(shortName(s.project)) + '</td>' +
        '<td class="mono">' + esc(s.id.slice(0, 16)) + '</td>' +
        '<td><span class="chip ' + (s.depth === 0 ? 'root' : 'sub') + '">' + (s.depth === 0 ? '主会话' : '子代理 d' + s.depth) + '</span></td>' +
        '<td class="mono">' + esc(s.model || '?') + '</td>' +
        '<td class="num">' + int(t.steps) + '</td>' +
        '<td class="num"><span class="hitbar"><span class="track"><span class="fill" style="width:' +
          t.hitRate.toFixed(1) + '%"></span></span>' + t.hitRate.toFixed(1) + '%</span></td>' +
        '<td class="num">' + int(t.uncached) + '</td>' +
        '<td class="num">' + int(t.cache) + '</td>' +
        '<td class="num">' + int(t.output) + '</td>' +
        '<td class="num"><b>' + money(t.cost) + '</b></td>' +
        '<td class="mono">' + esc(stamp(t.first)) + '</td></tr>'
    }).join('')
    document.getElementById('sessions').innerHTML = rows.length === 0
      ? '<div class="empty">没有匹配的会话</div>'
      : '<div class="tbl-scroll"><table>' + head + '<tbody>' + body + '</tbody></table></div>'
    Array.prototype.forEach.call(document.querySelectorAll('#sessions tbody tr'), function (tr) {
      tr.addEventListener('click', function () {
        var s = rows[+tr.getAttribute('data-i')]
        state.openSession = state.openSession === s.id ? null : s.id
        renderSessions()
        renderDrill(rows)
      })
    })
    Array.prototype.forEach.call(document.querySelectorAll('#sessions th.sortable'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-k')
        if (state.sortKey === k) state.sortDir = -state.sortDir
        else { state.sortKey = k; state.sortDir = -1 }
        renderSessions(); renderDrill(visibleSessions())
      })
    })
  }

  function renderDrill(rows) {
    var host = document.getElementById('drill')
    var s = null
    rows.forEach(function (r) { if (r.id === state.openSession) s = r })
    if (!s) { host.innerHTML = '<div class="empty">点击上方任意会话行查看逐轮 / 逐步骤明细</div>'; return }
    var t = s.totals
    var turnRows = s.turns.map(function (tr) {
      var tt = tr.totals
      return '<tr><td class="num">' + tr.turn + '</td><td class="num">' + int(tt.steps) + '</td>' +
        '<td class="num">' + int(tt.uncached) + '</td><td class="num">' + int(tt.cache) + '</td>' +
        '<td class="num">' + int(tt.output) + '</td><td class="num">' + pct(tt.hitRate) + '</td>' +
        '<td class="num"><b>' + money(tt.cost) + '</b></td></tr>'
    }).join('')
    host.innerHTML =
      '<div class="drill">' +
        '<h3>' + esc(shortName(s.project)) + ' · <code class="mono">' + esc(s.id) + '</code></h3>' +
        '<div class="meta">' + (s.depth === 0 ? '主会话' : '子代理 d' + s.depth) + ' · 模型 <code>' + esc(s.model || '?') +
          '</code> · ' + int(t.steps) + ' 步 · 命中率 ' + pct(t.hitRate) + ' · 花费 <b>' + money(t.cost) + ' ' + CURRENCY +
          '</b> · ' + esc(stamp(t.first)) + ' → ' + esc(stamp(t.last)) + '</div>' +
        '<div style="margin-bottom:12px">' + turnChart(s.turns) + '</div>' +
        '<div class="tbl-scroll"><table><thead><tr><th style="text-align:right">turn</th>' +
          '<th style="text-align:right">步骤</th><th style="text-align:right">未命中输入</th>' +
          '<th style="text-align:right">缓存命中输入</th><th style="text-align:right">输出</th>' +
          '<th style="text-align:right">命中率</th><th style="text-align:right">花费</th></tr></thead><tbody>' +
          turnRows + '</tbody></table></div>' +
      '</div>'
  }

  function renderTopSteps() {
    var all = []
    DATA.projects.forEach(function (p) {
      p.sessions.forEach(function (s) {
        s.steps.forEach(function (st) {
          all.push({ project: p.project, sid: s.id, model: s.model, st: st })
        })
      })
    })
    all.sort(function (a, b) { return b.st.cost - a.st.cost })
    var top = all.slice(0, 25)
    document.getElementById('top-steps').innerHTML =
      '<div class="tbl-scroll"><table><thead><tr><th>#</th><th>工程</th><th>会话</th><th>turn</th><th>step</th>' +
      '<th style="text-align:right">未命中输入</th><th style="text-align:right">缓存命中输入</th>' +
      '<th style="text-align:right">输出</th><th style="text-align:right">命中率</th><th>时段</th>' +
      '<th style="text-align:right">花费 (' + CURRENCY + ')</th><th>时间 (UTC)</th></tr></thead><tbody>' +
      top.map(function (r, i) {
        var st = r.st
        var input = st.uncached + st.cache
        var hit = input ? (st.cache / input) * 100 : 0
        return '<tr><td class="num">' + (i + 1) + '</td>' +
          '<td>' + esc(shortName(r.project)) + '</td>' +
          '<td class="mono">' + esc(r.sid.slice(0, 12)) + '</td>' +
          '<td class="num">' + st.turn + '</td><td class="num">' + st.step + '</td>' +
          '<td class="num">' + int(st.uncached) + '</td><td class="num">' + int(st.cache) + '</td>' +
          '<td class="num">' + int(st.output) + '</td><td class="num">' + hit.toFixed(1) + '%</td>' +
          '<td><span class="chip ' + (st.tier === 'peak' ? 'peak' : st.tier === 'offpeak' ? 'offpeak' : 'warn') + '">' +
            (st.tier === 'peak' ? '峰时' : st.tier === 'offpeak' ? '谷时' : '未定价') + '</span></td>' +
          '<td class="num"><b>' + money(st.cost) + '</b></td>' +
          '<td class="mono">' + esc(stamp(st.t)) + '</td></tr>'
      }).join('') + '</tbody></table></div>'
  }

  function renderControls() {
    var sel = document.getElementById('f-project')
    sel.innerHTML = '<option value="">全部工程</option>' + DATA.projects.map(function (p) {
      return '<option value="' + esc(p.project) + '">' + esc(shortName(p.project)) + ' — ' +
        money(p.totals.cost) + ' ' + CURRENCY + '</option>'
    }).join('')
    sel.addEventListener('change', function () {
      state.project = sel.value
      state.openSession = null
      renderSessions(); renderDrill(visibleSessions())
    })
    var q = document.getElementById('f-query')
    q.addEventListener('input', function () {
      state.query = q.value.trim().toLowerCase()
      renderSessions(); renderDrill(visibleSessions())
    })
  }

  /* ---------------------------------------------------------------- boot */
  renderHeader()
  renderKpis()
  renderProjectBars()
  renderModels()
  renderComposition()
  renderSplit()
  renderDaily()
  renderControls()
  renderSessions()
  renderDrill(visibleSessions())
  renderTopSteps()
})()
