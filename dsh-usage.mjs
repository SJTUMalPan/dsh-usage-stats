#!/usr/bin/env node
/**
 * dsh-usage — per-project, per-step token, cache, and cost report for DSH.
 *
 * Reads the durable session logs DSH already writes, prices each model call
 * with the official catalog, and reports it as `project -> session -> turn ->
 * step`. It performs no model calls and writes nothing outside `--out`.
 *
 * Usage:
 *   node dsh-usage.mjs [--format md|csv|json] [--project SUBSTR] [--out FILE]
 *
 * @module dsh-usage-stats
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { indexCatalog, priceCall } from './lib/pricing.mjs'
import { loadSessions, rollup, sessionsRoot } from './lib/sessions.mjs'
import { groupByProject, renderCsv, renderJson, renderMarkdown } from './lib/report.mjs'
import { buildData, renderHtml } from './lib/html.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Parse `process.argv` into options.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {object} Parsed options.
 */
function parseArgs(argv) {
  const options = {
    format: 'md',
    project: null,
    out: null,
    prices: join(HERE, 'prices.json'),
    workspace: '/workspace/deepseek_workspace',
    topSteps: 15,
    turnsPerProject: 10,
    includeChildProjects: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => argv[++i]
    if (arg === '--format') options.format = value()
    else if (arg === '--project') options.project = value()
    else if (arg === '--out') options.out = value()
    else if (arg === '--prices') options.prices = value()
    else if (arg === '--workspace') options.workspace = value()
    else if (arg === '--top-steps') options.topSteps = Number(value())
    else if (arg === '--turns') options.turnsPerProject = Number(value())
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/**
 * List immediate subdirectories of the workspace, so a project with no
 * sessions yet still appears in the report instead of vanishing silently.
 * @param {string} workspace - Workspace root.
 * @returns {string[]} Absolute project paths.
 */
function discoverProjects(workspace) {
  try {
    return readdirSync(workspace)
      .filter((name) => !name.startsWith('.'))
      .map((name) => join(workspace, name))
      .filter(isDirectory)
      .sort()
  } catch {
    return []
  }
}

/**
 * Test whether a path is a directory.
 * @param {string} path - Candidate path.
 * @returns {boolean} True for directories.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const HELP = `dsh-usage — DSH 各工程逐步骤 token / 缓存 / 成本统计

  --format md|csv|json|html 输出格式（默认 md；html 为单文件可视化仪表盘）
  --project SUBSTR         只统计 cwd 含 SUBSTR 的会话
  --out FILE               写入文件（默认打印到 stdout）
  --prices FILE            价目表（默认 ./prices.json）
  --workspace DIR          工程根目录，用于列出暂无会话的工程
  --top-steps N            列出最贵的 N 个步骤（默认 15）
  --turns N                每个工程列出最贵的 N 轮（默认 10，0 关闭）
  -h, --help               显示本帮助
`

/**
 * Entry point.
 * @returns {void}
 */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(HELP)
    return
  }

  const catalog = JSON.parse(readFileSync(options.prices, 'utf8'))
  const index = indexCatalog(catalog)
  const root = sessionsRoot(process.env, homedir())

  const warnings = []
  let sessions = loadSessions(root, (message) => warnings.push(message))
  if (options.project !== null) {
    sessions = sessions.filter((s) => (s.cwd ?? '').includes(options.project))
  }

  let unpricedModels = new Set()
  for (const session of sessions) {
    for (const step of session.steps) {
      const priced = priceCall(step, catalog, index)
      Object.assign(step, priced)
      if (priced.tier === 'unknown' && step.model !== null) unpricedModels.add(step.model)
    }
  }

  const extraProjects = options.includeChildProjects && options.project === null
    ? discoverProjects(options.workspace)
    : []
  const projects = groupByProject(sessions, extraProjects)
  const generatedAt = new Date().toISOString()

  let text
  if (options.format === 'csv') text = renderCsv(sessions)
  else if (options.format === 'json') text = renderJson({ projects, catalog, generatedAt })
  else if (options.format === 'html') text = renderHtml(buildData(projects, catalog, generatedAt))
  else text = renderMarkdown({ projects, catalog, generatedAt, topSteps: options.topSteps, turnsPerProject: options.turnsPerProject })

  if (options.out !== null) {
    writeFileSync(options.out, text)
    process.stderr.write(`wrote ${resolve(options.out)}\n`)
  } else {
    process.stdout.write(text)
  }

  for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`)
  if (unpricedModels.size > 0) {
    process.stderr.write(
      `warn: 以下模型不在价目表中，花费按 0 计：${[...unpricedModels].join(', ')}\n` +
        `      请把它们补进 ${options.prices} 后重跑。\n`,
    )
  }
  const total = rollup(sessions.flatMap((s) => s.steps))
  process.stderr.write(
    `统计完成：${projects.size} 个工程 / ${sessions.length} 个会话 / ${total.steps} 步 / ` +
      `${total.cost.toFixed(4)} ${catalog.currency ?? 'CNY'}\n`,
  )
}

main()
