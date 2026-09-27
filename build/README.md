# build/ —— 看板用的仪表盘（**生成物，不进库**）

`subpage.json` 指向本目录，DSH 门户里的「用量」页读的就是
`build/usage-dashboard.html`。

刷新数据（在能读到 DSH 会话日志的机器上执行）：

```bash
node dsh-usage.mjs --format html --out build/usage-dashboard.html
```

**这份产物不入库**：它是一份运行现场快照，内含本机的会话 ID 与绝对路径
（实测一份 1.2 MB 的产物里有 191 个会话 UUID、8 个绝对路径），
固化进一个会被公开的仓库没有意义，也没法反映别人的用量。

因此新环境 clone 下来「用量」页会显示「静态页面文件缺失」——这是**预期行为**，
跑一次上面的命令即可。`subpage.json` 与页面壳（`lib/html.mjs`）才是仓库该有的东西。
