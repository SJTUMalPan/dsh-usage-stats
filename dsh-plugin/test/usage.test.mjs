/**
 * dsh-usage-dashboard 插件测试。
 *
 * 用一个最小的假 `ctx` 驱动插件：只实现 `webServer.register`、`connection.requestRejection`
 * 和 `logger`。这样能覆盖全部响应分支，且**不需要启动 dsh web**——插件挂在宿主进程里，
 * 为了测它就重启 GUI 是不现实的。
 *
 * 重点覆盖「鉴权先于读文件」这条不变量：未认证请求的响应不能因为报表存在与否而变化，
 * 否则页面就成了一个存在性探针。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name, resolveConfig } from '../lib/index.js'

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const HTML = '<!doctype html><html><body><h1>usage</h1></body></html>'

/** 记录一次响应。 */
function fakeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.ended = true; this.body = body },
  }
}

/**
 * 装配一个假 ctx 并调 apply。
 * @param {{rejection?: 401|403|undefined, config?: object}} options - 判定结果与配置。
 * @returns {{route: object, logs: string[]}} 注册到的路由与日志。
 */
function mount({ rejection = undefined, config = {} } = {}) {
  let route
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    webServer: { register: (r) => { route = r; return () => {} } },
    connection: { requestRejection: () => rejection },
    effect: (fn) => fn(),
  }
  apply(ctx, config)
  return { route, logs }
}

/** 生成一个一次性报表文件。 */
async function withReport(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-dash-'))
  const file = join(dir, 'report.html')
  try {
    if (contents !== null) await writeFile(file, contents, 'utf8')
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('exports the cordis plugin shape', () => {
  assert.equal(name, 'usage-dashboard')
  assert.deepEqual(inject, ['webServer', 'connection'])
})

test('registers an exact GET route on the default path', () => {
  const { route } = mount()
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/usage')
  assert.equal(typeof route.handler, 'function')
})

test('unauthenticated request is rejected before the file is read', async () => {
  // 报表**存在**，但未认证仍必须 401——证明鉴权先于磁盘读取。
  await withReport(HTML, async (file) => {
    const { route } = mount({ rejection: 401, config: { reportPath: file } })
    const res = fakeRes()
    await route.handler({ method: 'GET', headers: {} }, res)
    assert.equal(res.status, 401)
    assert.match(String(res.body), /unauthorized/)
    assert.equal(res.headers['cache-control'], 'no-store')
  })
})

test('untrusted origin is rejected with 403, not 401', async () => {
  await withReport(HTML, async (file) => {
    const { route } = mount({ rejection: 403, config: { reportPath: file } })
    const res = fakeRes()
    await route.handler({ method: 'GET', headers: {} }, res)
    assert.equal(res.status, 403)
    assert.match(String(res.body), /forbidden/)
  })
})

test('authenticated request serves the report as non-cacheable html', async () => {
  await withReport(HTML, async (file) => {
    const { route } = mount({ config: { reportPath: file } })
    const res = fakeRes()
    await route.handler({ method: 'GET', headers: {} }, res)
    assert.equal(res.status, 200)
    assert.equal(String(res.body), HTML)
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['content-length'], Buffer.byteLength(HTML))
  })
})

test('HEAD returns headers without a body', async () => {
  await withReport(HTML, async (file) => {
    const { route } = mount({ config: { reportPath: file } })
    const res = fakeRes()
    await route.handler({ method: 'HEAD', headers: {} }, res)
    assert.equal(res.status, 200)
    assert.equal(res.body, undefined)
    assert.equal(res.headers['content-length'], Buffer.byteLength(HTML))
  })
})

test('missing report is 404, not 500', async () => {
  await withReport(null, async (file) => {
    const { route } = mount({ config: { reportPath: file } })
    const res = fakeRes()
    await route.handler({ method: 'GET', headers: {} }, res)
    assert.equal(res.status, 404)
  })
})

test('404 body does not leak the configured path', async () => {
  await withReport(null, async (file) => {
    const { route } = mount({ config: { reportPath: file } })
    const res = fakeRes()
    await route.handler({ method: 'GET', headers: {} }, res)
    assert.doesNotMatch(String(res.body), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

test('re-reads the file so a regenerated report needs no restart', async () => {
  await withReport(HTML, async (file) => {
    const { route } = mount({ config: { reportPath: file } })
    const first = fakeRes()
    await route.handler({ method: 'GET', headers: {} }, first)
    assert.equal(String(first.body), HTML)

    const updated = '<!doctype html><html><body><h1>v2</h1></body></html>'
    await writeFile(file, updated, 'utf8')
    const second = fakeRes()
    await route.handler({ method: 'GET', headers: {} }, second)
    assert.equal(String(second.body), updated)
  })
})

test('non-GET/HEAD methods are 405 with an Allow header', async () => {
  await withReport(HTML, async (file) => {
    const { route } = mount({ config: { reportPath: file } })
    const res = fakeRes()
    await route.handler({ method: 'POST', headers: {} }, res)
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET, HEAD')
  })
})

test('default reportPath resolves next to the project output', () => {
  const { reportPath } = resolveConfig({}, PACKAGE_ROOT)
  // <包根>/../../usage-dashboard.html —— 即 dsh-usage-stats/usage-dashboard.html
  assert.match(reportPath, /dsh-usage-stats\/usage-dashboard\.html$/)
})

test('rejects a malformed path at load time', () => {
  for (const bad of ['/usage/', '/', 'usage', '/a?b', '/a#b', 42]) {
    assert.throws(() => resolveConfig({ path: bad }, PACKAGE_ROOT), /usage-dashboard/, `应拒绝 path=${String(bad)}`)
  }
})

test('rejects a blank reportPath at load time', () => {
  assert.throws(() => resolveConfig({ reportPath: '   ' }, PACKAGE_ROOT), /reportPath/)
  assert.throws(() => resolveConfig({ reportPath: 7 }, PACKAGE_ROOT), /reportPath/)
})

test('a custom path is honoured', () => {
  const { path } = resolveConfig({ path: '/costs' }, PACKAGE_ROOT)
  assert.equal(path, '/costs')
})

test('a relative reportPath resolves against the package root', () => {
  const { reportPath } = resolveConfig({ reportPath: '../reports/x.html' }, PACKAGE_ROOT)
  assert.match(reportPath, /dsh-usage-stats\/reports\/x\.html$/)
})
