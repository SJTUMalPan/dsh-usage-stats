# dsh-usage-dashboard

把 `dsh-usage-stats` 生成的用量报表挂到 **DSH 宿主 Web 服务器**的 `/usage`。

宿主插件，纯 ESM，零依赖，**不修改任何其它工程**。

## 为什么是插件

报表属于 `dsh-usage-stats` 自己。DSH 宿主已经提供了两件正好够用的东西：

| 用途 | 接口 |
|---|---|
| 挂一条自己的 HTTP 路由 | `ctx.webServer.register({kind, path, handler})` |
| 复用宿主登录态做鉴权 | `ctx.connection.requestRejection(req)` → `401` / `403` / `undefined` |

`requestRejection` 的文档原话是「Apply Connection's Host/Origin checks and browser
authentication to **another Web route**」——它存在的意义就是给插件自挂的路由复用宿主的
Host/Origin 围栏与会话 Cookie。所以本插件**没有自己的令牌体系**：能打开 DSH GUI 的浏览器，
同一 origin 下就能打开 `/usage`（会话 Cookie 是 `Path=/; SameSite=Strict`）。

## 安装

```bash
dsh plugin --profile web add "link:$PWD/dsh-plugin"   # 在仓库根目录执行
```

`dsh plugin` 会把包交给 pnpm 装进 profile，然后对账 `dsh.profile.bundles`——只要包装了
`dsh.bundle.patch`，就自动把包名追加进层级列表，**不需要手改 profile 的任何文件**。
装完**重启 `dsh web`** 生效。

## 访问

```
http://<你的 dsh web 地址>/usage
```

用的是宿主登录态：先在同一个地址登录 GUI，`/usage` 就直接能开，不用再抄一个令牌。
未登录返回 `401`，Host/Origin 不通过返回 `403`。

## 配置

`cordis.patch.yml` 里那一行的 `config`，两项都可省略：

```yaml
- insert:
    - id: usage-dashboard
      name: dsh-usage-dashboard
      config:
        path: /usage        # 挂载路径，默认 /usage
        reportPath: /abs/path/to/report.html
        # 默认 <本包>/../usage-dashboard.html，即 dsh-usage-stats/usage-dashboard.html
```

`path` 必须是以 `/` 开头、非根、无尾斜杠且不含查询串/片段的绝对路径——非法值在**装载期**
就抛错，而不是留到请求时才 404。

`reportPath` 可以是绝对路径，也可以相对本包根目录。

## 行为

| 情况 | 响应 |
|---|---|
| 未认证 | `401`（**先于**读文件——否则页面会变成文件存在性探针） |
| Host/Origin 不通过 | `403` |
| 方法不是 GET/HEAD | `405` + `Allow: GET, HEAD` |
| 报表文件不存在 | `404`，且响应体**不回显**配置的路径 |
| 正常 | `200`，`text/html`，`Cache-Control: no-store`，`X-Content-Type-Options: nosniff` |

**每次请求现读磁盘**：重新生成报表后刷新页面即可，不需要重启 `dsh web`。

## 刷新数据

```bash
cd /path/to/dsh-usage-stats
node dsh-usage.mjs --format html --out usage-dashboard.html
```

## 卸载

```bash
dsh plugin --profile web remove dsh-usage-dashboard
```

路由随插件卸载自动注销（`ctx.effect` 的 disposer）。

## 测试

```bash
node --test test/*.test.mjs
```

用假 `ctx` 驱动，覆盖全部响应分支，**不需要启动 `dsh web`**——插件跑在宿主进程里，
为了测它就重启 GUI 不现实。

## 已知边界

- **可用性跟着 `dsh web` 走**：DSH 挂了页面就打不开。如果需要一个独立于 DSH 存活的入口，
  应该由本工程自己起进程，而不是挂进宿主。
- **没有 TLS**：与宿主同源，沿用宿主既有的传输边界（宿主 Web 本身不带 TLS）。
- 报表含工程名、会话 id 与花费，属内部信息；**不要**把它挪到宿主的免鉴权路径上。
