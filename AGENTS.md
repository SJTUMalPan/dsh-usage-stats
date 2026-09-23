# dsh-usage-stats — 项目规则

DSH 各工程的逐步骤 token / 缓存 / 成本统计工具。跨工程读取 `$DSH_HOME/sessions` 下的会话日志。

## 技术约定

- **纯 Node ESM，零运行时依赖。** 只用 Node 22+ 内置模块。不要引入 npm 依赖——这个工具要能在一个
  刚装好的 DSH 上直接跑。
- **不改动任何会话数据。** 只读日志，唯一的写操作是 `--out` 指定的文件。
- **不做模型调用。** 统计必须完全离线、可重复。
- 金额一律走 `prices.json`，不要把价格数字写进代码。

## 改代码前必须知道的口径

1. **step = 一次 LLM 调用**，对应一条 `assistant/message` 事件。**只折叠这一条**；流式
   usage 采样报的是同一次调用，重复折叠会让数字翻倍。
2. **`usage.inputTokens` 是缓存未命中部分，不是输入总量。**
   `totalTokens = inputTokens + cacheReadTokens + outputTokens`。命中/未命中单价差 50 倍，
   **绝不能相加后再计价**。
3. **`reasoningTokens` 已包含在 `outputTokens` 中**，不重复计费。
4. **峰谷按事件时间戳判定**，不是按运行报表的时间。
5. **子代理会话计入所属工程合计**，同时单独展示——实测占工程花费 37%–66%。
6. **工程归属用会话头里的 `cwd`**，不要用目录名推断。

## 会话日志格式（踩过的坑）

- 路径：`$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v3.jsonl.zstd`。
- **每追加一条事件写一个独立 zstd 帧**，文件是多帧拼接。Node 内置的 `zstdDecompressSync`
  和流式解压**都在第一帧后停止**，会静默把整份日志截成一条事件。必须走 `lib/zstd.mjs`。
- 帧边界只能靠解析 zstd 帧结构得到；**不要扫魔数**（`28 B5 FD` 会合法地出现在压缩块内部）。
- 路由/模型来自 `request/header` 与 `request/context` 事件；同一会话内模型可能切换，
  要按「每条 step 之前最近的 route 事件」归属。
- 会话树靠会话头里的 `parentSession` / `delegationDepth` / `origin` 连接。

## 改动后必须验证

```bash
node verify.mjs        # 折叠正确性：与 DSH 的 tokenUsage 投影逐会话对账
node smoke-html.mjs    # 仪表盘渲染：用最小 DOM 垫片跑客户端脚本，无依赖
```

`verify.mjs` 的 **`mismatch` 必须为 0**；只有「正在写入的活跃会话」允许 `lagging`
（投影缓存是周期性快照，不是错误）。改完折叠或解压逻辑一定要跑。

`smoke-html.mjs` 只检查渲染不报错、各区块非空、图表真的画出了数据图元。
**不要只断言字符串长度**——坐标轴和网格线本身就够长，会掩盖「有轴无柱」的 bug
（`daily` 的柱子就曾因为键名写错而全部消失，长度检查却通过）。加图表就往里面加一条
图元计数断言。

## 可视化产物

`--format html` 生成**单文件**仪表盘：CSS/JS/数据全部内联，无 CDN、无网络请求、
`file://` 直接可开。样式在 `lib/client.css`、图表与交互在 `lib/client.js`，
生成时读取并内联（`lib/html.mjs`）——**产出必须保持单文件自包含，不要引入外部引用**。
图表是手写 SVG，不要引图表库。

## 工程边界（重要）

报表由**本工程自己的 DSH 插件**（`dsh-plugin/`）承载，挂在宿主 Web 的 `/usage`。

**不要把报表页塞进别的工程。** 曾经的做法是改 `message` 的 notify-hub（加路由、加配置键、
改文档、重启它的服务）来承载本工程的页面——那是跨工程侵入，已全部撤销。`message` 有它
自己的模块契约与测试纪律，本工程的产物不该由它托管。

插件用的是宿主现成接口，不需要任何跨工程改动：

- `ctx.webServer.register({kind, path, handler})` —— 挂路由
- `ctx.connection.requestRejection(req)` —— 复用宿主的 Host/Origin 围栏与浏览器鉴权

**鉴权必须复用宿主的，不要自建令牌体系**，也**不要**把页面挪到免鉴权路径上——报表含工程名、
会话 id 与花费，属内部信息。

`dsh-plugin/test/` 用假 `ctx` 驱动，覆盖全部响应分支。插件跑在宿主进程里，
**不要为了测它就重启 `dsh web`**。

## 维护价目表

`prices.json` 是数据。官方调价后更新价格、`fetchedAt`，并检查 `aliases`
（如 `deepseek-v4-flash` → `deepseek-flash`，漏掉会让历史花费算成 0）。
`peak.holidays` 需按年份补中国法定节假日。

来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
