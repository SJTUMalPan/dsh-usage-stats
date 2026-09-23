/**
 * dsh-usage-dashboard — 把 DSH 用量报表页挂到宿主 Web 服务器的 `/usage`。
 *
 * **为什么是宿主插件而不是改别的工程**
 *
 * 报表属于本工程（`dsh-usage-stats`）。宿主已经提供了两件正好够用的东西：
 *
 * 1. `ctx.webServer.register({kind, path, handler})` —— 具名路由表，精确路径优先于
 *    兜底的 SPA dist（见 `@deepseek-ai/dsh-host-webserver`）。它自己不认识任何 harness
 *    概念，也不做鉴权。
 * 2. `ctx.connection.requestRejection(req)` —— 它的文档原话是「Apply Connection's
 *    Host/Origin checks and browser authentication to **another Web route**」，就是给
 *    插件自挂的路由复用宿主登录态用的。返回 `401`/`403`/`undefined`。
 *
 * 因此本插件**不需要自己的令牌体系**：能打开 DSH GUI 的浏览器，同一 origin 下就能
 * 打开 `/usage`（会话 Cookie 是 `Path=/`）。这也意味着页面可用性跟着 `dsh web` 走。
 *
 * **边界**：本插件只读一个 HTML 文件，不碰任何会话数据、不改 DSH 其他部分、
 * 不依赖任何其它工程。卸载只需把 profile 里的依赖去掉。
 *
 * @module dsh-usage-dashboard
 */

import { readFile, stat } from 'node:fs/promises'

/** 插件显示名。 */
export const name = 'usage-dashboard'

/**
 * 依赖的两个宿主服务。
 *
 * `webServer` 提供路由表；`connection` 提供「对另一条 Web 路由施加 Host/Origin 围栏
 * 与浏览器鉴权」的判定。二者缺一就不装载——宁可不出现，也不要挂出一条**无鉴权**的页面。
 */
export const inject = ['webServer', 'connection']

/** 未配置 `reportPath` 时的默认报表位置（相对本包根目录，即 dsh-usage-stats/usage-dashboard.html）。 */
const DEFAULT_REPORT_RELATIVE = '../usage-dashboard.html'

/** 允许的 HTTP 方法。`HEAD` 与 `GET` 同源，便于探测。 */
const ALLOWED_METHODS = 'GET, HEAD'

/**
 * 解析插件配置。
 *
 * @param {object} config - `cordis.patch.yml` 中本插件那一行的 `config`。
 * @param {string} packageRoot - 本包根目录的绝对路径。
 * @returns {{path: string, reportPath: string}} 归一化后的配置。
 * @throws {Error} 配置非法时抛出，让装载期直接暴露问题。
 */
export function resolveConfig(config = {}, packageRoot) {
  const path = config.path ?? '/usage'
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.endsWith('/')) {
    throw new Error(`usage-dashboard: path 必须是以 / 开头、非根、无尾斜杠的绝对路径，实际是 ${String(path)}`)
  }
  if (path.includes('?') || path.includes('#')) {
    throw new Error(`usage-dashboard: path 不得包含查询串或片段：${path}`)
  }

  const raw = config.reportPath
  if (raw !== undefined && (typeof raw !== 'string' || raw.trim() === '')) {
    throw new Error('usage-dashboard: reportPath 必须是非空字符串（不配置则用默认位置）')
  }
  const reportPath = raw === undefined
    ? new URL(DEFAULT_REPORT_RELATIVE, `file://${packageRoot}/`).pathname
    : (raw.startsWith('/') ? raw : new URL(raw, `file://${packageRoot}/`).pathname)

  return { path, reportPath }
}

/**
 * 读取报表文件；不存在或不可读时返回 null（**不抛**，缺文件是正常状态）。
 *
 * @param {string} reportPath - 报表绝对路径。
 * @returns {Promise<Buffer|null>} 文件内容，或 null。
 */
async function readReport(reportPath) {
  try {
    const info = await stat(reportPath)
    if (!info.isFile()) return null
    return await readFile(reportPath)
  } catch {
    return null
  }
}

/**
 * 写一个纯文本响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {string} body - 正文。
 * @param {Record<string,string>} [headers] - 附加响应头。
 */
function text(res, status, body, headers = {}) {
  const payload = Buffer.from(`${body}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
    ...headers,
  })
  res.end(payload)
}

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {object} [config] - 本插件的配置。
 */
export function apply(ctx, config = {}) {
  const packageRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
  const settings = resolveConfig(config, packageRoot)

  /**
   * `/usage` 的完整响应生命周期。
   *
   * 鉴权**先于**任何文件读取：未认证的请求不应因为报表存在与否而得到不同的响应，
   * 否则就成了一个存在性探针。
   *
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  async function handler(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      text(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      text(res, 405, 'method not allowed', { allow: ALLOWED_METHODS })
      return
    }
    const html = await readReport(settings.reportPath)
    if (html === null) {
      // 报表还没生成过。不回显路径，避免把内部布局写进响应体。
      text(res, 404, 'usage report not generated yet')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // 报表由 dsh-usage.mjs 重新生成，缓存住就永远看不到新数据。
      'cache-control': 'no-store',
      'content-length': html.length,
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : html)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: settings.path, handler }),
    `usage-dashboard: ${settings.path}`,
  )
  ctx.logger.info(`usage-dashboard: 已挂载 ${settings.path} → ${settings.reportPath}（鉴权复用宿主登录态）`)
}
