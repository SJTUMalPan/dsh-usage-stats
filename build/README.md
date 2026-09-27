# build/ —— 看板用的仪表盘（**这一份是有意提交的**）

`subpage.json` 指向本目录。DSH 门户里的「用量」页读的就是
`build/usage-dashboard.html`。

刷新数据（在能读到 DSH 会话日志的机器上执行）：

```bash
node dsh-usage.mjs --format html --out build/usage-dashboard.html
```

提交与否都可以：**提交**则 submodule 开箱可见（推荐，新机器 clone 下来就有页面）；
**不提交**则新环境里该页面会显示「静态页面文件缺失」——这也是预期行为，跑一次上面的
命令即可。其余报表产物（`usage-steps.csv` / `usage.json` / `USAGE-REPORT.md`）不进库。
