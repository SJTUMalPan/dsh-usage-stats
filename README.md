# dsh-usage-stats

统计 DeepSeek Harness **每个工程、每个步骤**的 token 开销、缓存命中率和花费。

零依赖：只用 Node 22+ 内置能力读 DSH 已经写好的会话日志，不发任何模型请求，不改动任何会话数据。

## 快速开始

```bash
# 全部工程，Markdown 报表
node dsh-usage.mjs

# 单文件可视化仪表盘（推荐）
node dsh-usage.mjs --format html --out usage-dashboard.html

# 只看某个工程
node dsh-usage.mjs --project abstractAI

# 逐步骤明细 CSV（工程 / 会话 / turn / step 一行）
node dsh-usage.mjs --format csv --out steps.csv

# 机器可读 JSON（含每会话的 turn 汇总）
node dsh-usage.mjs --format json --out usage.json

# 自检：把折叠结果与 DSH 自己的 tokenUsage 投影对账
node verify.mjs
```

## 可视化仪表盘

`--format html` 产出**一个自包含的 HTML 文件**：数据、样式、脚本全部内联，
**零 CDN、零 npm 依赖、无任何网络请求**，直接双击用浏览器打开即可（`file://` 可用）。

包含：KPI 概览、各工程花费排行、成本构成环图、主会话/子代理与峰谷堆叠对比、
每日花费趋势、可排序可筛选的会话表、点击会话展开逐轮曲线、最贵步骤排行。

图表是手写 SVG（`lib/client.js`），所以不需要任何图表库。样式在 `lib/client.css`，
两者在生成时被内联进产物——**改样式或图表只改这两个文件，重新生成即可**。

## 在浏览器里看（DSH 插件）

配套的 DSH 宿主插件**已拆成独立仓库**：
[dsh-usage-dashboard](https://github.com/SJTUMalPan/dsh-usage-dashboard)，
把报表挂到**宿主 Web 服务器**的 `/usage`：

```
http://<你的 dsh web 地址>/usage
```

用的是**宿主自己的登录态**——先在同一个地址登录 GUI，`/usage` 直接就能开，不需要第二个令牌。

```bash
# 安装（插件市场里也能直接装；装完重启 dsh web 生效）
dsh plugin --profile web add github:SJTUMalPan/dsh-usage-dashboard

# 生成报表（本工具负责的部分；插件默认读 <插件包>/report/usage-dashboard.html）
node dsh-usage.mjs --format html --out usage-dashboard.html
```

本仓库的 [`dsh-plugin/`](dsh-plugin/) 是一个 **git submodule** 指向那个仓库，
本地开发时两边的路径关系不变（`git clone --recursive` 即可拿到）。

插件靠宿主两个现成接口：`ctx.webServer.register()` 挂路由，
`ctx.connection.requestRejection()` 复用宿主的 Host/Origin 围栏与浏览器鉴权。
未登录返回 401，报表未生成返回 404。

**不修改任何其它工程**——报表由本工程自己的插件承载。详见 `dsh-plugin/README.md`。

## 输出内容

| 章节 | 内容 |
|---|---|
| 一、按工程汇总 | 会话数、子代理会话数、步骤数、未命中输入、缓存命中输入、输出、缓存命中率、花费 |
| ｜主会话 / 子代理拆分 | 每个工程的钱有多少来自子代理 |
| ｜峰谷拆分 | 峰时花费 / 谷时花费 / 未定价步骤数 |
| ｜成本构成 | 输出、缓存命中输入、未命中输入各占多少钱 |
| 二、按工程 → 会话 | 每个会话的模型、步骤、命中率、花费、起始时间 |
| 三、按工程 → turn | 同序号 turn 跨会话汇总，按花费排序 |
| 四、最贵的 N 个步骤 | 全局最贵的单步调用 |

## 口径

这些口径直接决定数字对不对，改动前请先读：

- **step = 一次 LLM 调用。** DSH 每个完成的步骤写一条 `assistant/message` 事件，带
  `data.usage`。只折叠这一条——流式过程中的 usage 采样报的是同一次调用，重复折叠会翻倍。
- **`inputTokens` 是「缓存未命中」部分，不是输入总量。**
  `totalTokens = inputTokens + cacheReadTokens + outputTokens`。
  两者单价差 50 倍（flash 命中 0.02 元/M vs 未命中 1 元/M），**相加再计价会严重失真**。
- **`reasoningTokens` 已包含在 `outputTokens` 里**，只做展示，不重复计费。
- **缓存写入不单独计费**，DSH 日志中 `cacheWriteTokens` 恒为 0。
- **峰谷按调用发生时刻判定**，不是按跑报表的时刻。高峰 = 北京时间周一至周五
  （不含中国法定节假日）9:00–12:00、14:00–18:00，其余为空闲；空闲价 = 高峰价的一半。
- **子代理单独列出，但计入所属工程合计。** 本项目实测子代理占工程花费的 37%–66%，
  只统计主会话会严重少算。
- **按 `cwd` 归属工程**（取自会话头），不靠目录名猜。

## 价目表

`prices.json` 是数据不是代码，调价只改这个文件。当前取自官方定价页
（[中文](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)｜[英文](https://api-docs.deepseek.com/quick_start/pricing)），
单位 **元 / 百万 tokens**：

| 模型 | 缓存命中(谷/峰) | 未命中(谷/峰) | 输出(谷/峰) |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

- `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 是**已下线旧名**，请求由
  DeepSeek-V4.1-Flash 提供并按 Flash 价格计费 —— 因此它们作为 `aliases` 映射到 `deepseek-flash`。
  漏掉这层映射会让历史会话的这部分花费算成 0。
- 模型不在表里时，工具**按 0 计并在 stderr 报警**，不会静默少算。
- 调价后请更新 `fetchedAt` 与价格；`peak.holidays` 需要按年份补中国法定节假日
  （留空 = 不扣节假日；当前统计区间内无节假日，结果不受影响）。

## 数据来源

`$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v3.jsonl.zstd`。

DSH 每追加一条事件就写一个独立的 zstd 帧，所以整个文件是**多个帧的拼接**。
Node 自带的 `zstdDecompressSync` 和流式接口**都在第一帧后停止**，会静默把日志截断成一条事件 ——
`lib/zstd.mjs` 因此自己走帧结构定位边界后逐帧解压。

## 校验

`node verify.mjs` 把每个会话的折叠合计与 DSH 自己的 `tokenUsage` 投影逐会话对账：

```
sessions folded      : 112
projection cache size: 112
exact match          : 112
lagging (live)       : 0
mismatch             : 0
no projection entry  : 0
```

投影缓存是**周期性快照**，正在写入的会话会领先于它，直接比 token 数会在活跃会话上报假失败。
所以脚本按投影的 `seq` 把两种情况分开：`lagging` 是快照落后（无法佐证，不算错），
`mismatch` 才是真的折叠错误。**只有 `mismatch` 会让退出码非 0。**

## 已知限制

- 会话日志存在期间才有数据；会话被删除后其花费也随之消失（本工具无自有账本）。
- 逐步骤明细只覆盖 `assistant/message` 事件可解析的会话；更早的会话格式版本（v0–v2）未验证。
- 高峰期排除中国法定节假日，需要手工维护 `peak.holidays`。
