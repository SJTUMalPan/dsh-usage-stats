#!/usr/bin/env node
/**
 * Smoke-test the dashboard renderer without a browser.
 *
 * Builds a minimal DOM shim, runs the inlined client script against the real
 * embedded payload, and asserts that every section rendered non-empty content.
 * This catches runtime errors and selector typos; it does not check layout.
 */
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./usage-dashboard.html', import.meta.url), 'utf8')
const payload = JSON.parse(
  html.match(/<script id="usage-data" type="application\/json">([\s\S]*?)<\/script>/)[1],
)
const client = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

/** Recorded innerHTML per element id. */
const rendered = new Map()
const listeners = []

function makeEl(id) {
  return {
    id,
    _html: '',
    value: '',
    textContent: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); rendered.set(id, this._html) },
    addEventListener(type, fn) { listeners.push({ id, type, fn }) },
  }
}

const ids = [...client.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
const store = new Map(ids.map((id) => [id, makeEl(id)]))

globalThis.document = {
  getElementById: (id) => {
    if (!store.has(id)) throw new Error(`getElementById('${id}') not found in DOM`)
    return store.get(id)
  },
  createElement: () => ({ set innerHTML(v) { this._first = { text: v } }, get firstChild() { return this._first } }),
  querySelectorAll: () => [],
}

// The payload element is read via getElementById too.
store.set('usage-data', { textContent: JSON.stringify(payload) })

const failures = []
function check(label, id, min) {
  const value = rendered.get(id)
  if (value === undefined) failures.push(`${label}: #${id} was never rendered`)
  else if (value.length < min) failures.push(`${label}: #${id} looks empty (${value.length} chars)`)
}

try {
  new Function(client)()
} catch (error) {
  console.error('renderer threw:', error.message)
  process.exit(1)
}

check('header', 'head-sub', 20)
check('badge', 'head-badge', 10)
check('kpis', 'kpis', 200)
check('project bars', 'proj-bars', 100)
check('composition', 'composition', 200)
check('models', 'model-bars', 80)
check('split', 'split-bars', 100)
check('peak', 'peak-bars', 100)
check('daily', 'daily', 200)
check('daily legend', 'daily-legend', 20)
check('sessions', 'sessions', 500)
check('drill placeholder', 'drill', 10)
check('top steps', 'top-steps', 500)

// An empty project list must still render placeholder text rather than throw.
const withData = rendered.get('sessions')
if (!withData.includes('<table')) failures.push('sessions: expected a table')

// Length-only checks miss charts that render an axis but no data marks, so
// assert on the marks themselves.
function count(id, needle) {
  return (rendered.get(id) || '').split(needle).length - 1
}
const rects = count('daily', '<rect')
if (rects === 0) failures.push('daily: rendered an axis but no bars')
const donutArcs = count('composition', '<circle')
if (donutArcs < 3) failures.push(`composition: expected >=3 arcs, got ${donutArcs}`)
const barFills = count('proj-bars', 'bar-fill')
if (barFills === 0) failures.push('proj-bars: no bars')
const stackedSegs = count('split-bars', '<span style="width:')
if (stackedSegs === 0) failures.push('split-bars: no segments')
const modelBars = count('model-bars', 'bar-fill')
if (modelBars === 0) failures.push('model-bars: no bars')

console.log(`sections rendered : ${rendered.size}`)
console.log(`listeners bound   : ${listeners.length}`)
console.log(`daily bars        : ${rects}`)
console.log(`donut arcs        : ${donutArcs}`)
console.log(`project bars      : ${barFills}`)
console.log(`split segments    : ${stackedSegs}`)
console.log(`model bars        : ${modelBars}`)
for (const [id, body] of rendered) console.log(`  #${id}: ${body.length} chars`)
if (failures.length) {
  console.error('\nFAILURES:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('\nrenderer smoke test passed')
