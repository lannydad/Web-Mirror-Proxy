# 网页镜像 · Cloudflare Workers 版

单文件 `worker.js`：**前端控制台 + 镜像代理** 都在里面，不需要另外传 `ui.html`，也不需要服务器。

相比原版 `Mikotwa/reverse-proxy-cf` 的 `index.js`，修了这些：

| 原版问题 | 本版处理 |
| --- | --- |
| `WORKER_HOSTNAME` 硬编码，写错整站全挂 | 自动识别当前访问域名，`*.workers.dev` 和自定义域名都能用 |
| 优先读 `Referer` 解析目标 → 从控制台点“访问”直接 502 | 改用真实请求路径解析，`Referer` 只作兜底 |
| 相对路径 `../x`、`./x` 拼错 → 子目录页面 CSS/JS 全 404 | 按所在页面地址解析成绝对地址再改写 |
| 只改写 `href/src` | 补上 `srcset`、`action`、`poster`、CSS `url()`、`@import`、`<style>`、内联 `style` |
| 保留 `integrity`（内容被改过，SRI 校验失败 → 资源拒载） | 剥离 `integrity` |
| 3xx 内部跟随，`Location` 原样返回真实站 | 改为 `redirect: manual`，`Location` 改写后交回浏览器 |
| `Refresh` 响应头、`<meta http-equiv="refresh">` 里的 `url=` 未改写 → 浏览器被带去真实站 | 一并改写成本站路径 |
| `Set-Cookie` 带 `Domain=目标域名`，浏览器丢弃 → 反复跳登录 | 去掉 `Domain=` 属性 |
| `Referer`/`Origin` 泄露本站域名，触发防盗链/来源校验 | 翻译成目标站自己的地址 |
| 没有入口页 | 内置紫色控制台，支持访问记录、常用站点快捷入口、`/health` 实时延迟 |

## 部署方式一：网页后台粘贴（最快）

1. 登录 Cloudflare → **Workers & Pages** → **Create** → **Worker**（Start with Hello World）→ 取个名字，如 `mirror`。
2. 进 **Edit code**，把 `worker.js` 全部内容粘进去（**不用改任何常量**）。
3. 点 **Deploy**，拿到 `mirror.你的账号.workers.dev`。
4. 打开 `https://mirror.你的账号.workers.dev/` 就是控制台；镜像页形如
   `https://mirror.你的账号.workers.dev/developer.mozilla.org/zh-CN/`。

## 部署方式二：wrangler CLI

```bash
npm i -g wrangler
wrangler login
cd reverse-proxy-worker
wrangler deploy
```

`wrangler.toml` 已备好，`name` 就是 Worker 名字，可以自己改。

## 绑定自定义域名

`*.workers.dev` 在国内经常连不上，建议绑自有域名：
Workers → 你的 Worker → **Settings → Domains & Routes → Add → Custom domain**，域名需托管在同一 Cloudflare 账号下。绑定后直接用新域名访问，代码不用改。

## 关于 Cloudflare 挑战（5 秒盾 / Turnstile）

这类校验绑定 **TLS 指纹 + 浏览器 JS 环境 + `cf_clearance` cookie（绑 IP 和 UA）**。Worker 的 `fetch` 是服务端请求，握手特征不是真实浏览器，改 `User-Agent`、`Referer`、`sec-ch-ua` 都过不了。判断方法：响应里出现 `cf-mitigated: challenge` 或 `server: cloudflare` + 403，就属于这一类，代码层面无解；站点是自己的时候就到后台加 WAF 跳过规则。

## 已知局限

- 目标站必须是 HTTPS（或 https 失败后自动回落 http），页面里的绝对 `http://` 资源会被改写成 https 请求，极少见的 http-only 站点可能缺资源。
- 只支持标准端口 80/443，`/host:8080/` 形式的写法会把 `:8080` 当作路径的一部分。
- 站点根路径下的 `/host`（无结尾斜杠）会 302 到 `/host/`，因为相对路径需要一个明确的基准。
- 日免费额度 10 万次请求；大文件、视频走 Worker 会计入流量，注意用量。
- 页面内 `location.host` 自检、强依赖真实浏览器指纹的站点，仍会被它自己跳回原站。

## 自测结果（本地用 Node 直接调用 `worker.fetch`，12 项全过）

```
PASS 控制台 200 且含标题
PASS /health · /api/info
PASS 非法域名 400
PASS 带首页 Referer 仍能拿到 HTML 且相对路径改写正确
PASS CSS 200 且内部 url() 已改写
PASS 3xx Location 改写为本站路径
PASS Referer 翻译 / Origin 翻译 / Host 为目标站
PASS Set-Cookie 去掉 Domain=
PASS MDN 整页 200
```
