# 网页镜像 · Web Mirror Proxy

> 一个域名，把任意站点搬进你的浏览器 —— 基于 Cloudflare Workers 的反向代理网页镜像，另附 PHP 与 Node 两个可自托管版本。

**在线演示：<https://cold-art-7b37.ym-eb5.workers.dev>**
（打开即控制台，输入 `developer.mozilla.org/zh-CN/` 点"访问"即可；演示实例不保证长期可用，建议按下文自行部署）

原项目 [Mikotwa/reverse-proxy-cf](https://github.com/Mikotwa/reverse-proxy-cf) 只有一个 `index.js`，靠 Cloudflare 专属的 `HTMLRewriter` 和 `addEventListener("fetch")` 运行，离开 Workers 就完全跑不起来，而且域名是硬编码、链接改写只覆盖 `href/src`。这个仓库在原版基础上做了系统性修复，并补齐了 **PHP / Node 两个自托管版本** 和一套 **内置前端控制台**。

```
浏览器 ──▶ 你的域名/目标域名/路径 ──▶ (Worker / PHP / Node) ──▶ 目标站点
                ▲                                       │
                └──── 页面、脚本、样式全部改写回本域 ◀─┘
```

---

## 一、这是干什么的

把一个外部网站，通过你自己的一个域名完整地"镜像"出来：

- 访问 `https://你的域名/developer.mozilla.org/zh-CN/`，看到的就是 MDN 中文站
- 页面里的链接、图片、CSS、JS、字体、`srcset`、CSS `url()`、`@import` 全部被改写到你的域名下
- 浏览器地址栏**始终只有一个域名**，点任何内链都不会跳出去
- 不需要装插件、不需要改 DNS、不需要在本地开端口

对使用者来说，它就是一个"能装下很多站点"的普通网站；对服务端来说，它只是把响应内容做了一次链接重写。

### 适合哪些场景

| 场景       | 说明                                          |
| -------- | ------------------------------------------- |
| 跨境查资料    | 技术文档、开源项目主页、包仓库、API 参考，统一从自己的域名进入，方便收藏和分享   |
| 团队内网知识入口 | 把常用海外文档站收敛到一个入口，同事不用各自折腾环境                  |
| 前端调试与抓取  | 需要看某个站点的 HTML/CSS 结构，或做页面比对，直接在浏览器里拿到改写后的产物 |
| 受限网络环境   | 部分网络对特定境外域名不通时，只要能访问到你的这个域名，内容就能正常打开        |

> ⚠️ 本项目只做**页面内容转发与链接改写**，不代理登录态、不绕过付费墙、不破解任何访问控制。请遵守你所在地区的法律法规以及目标站点的服务条款。

---

## 二、它凭什么能打开"被墙"的站点

关键在于**请求发起的位置**。

浏览器直连境外站点时，走的是你本地网络出口，链路中途是否可达、是否被干扰，取决于你所在的网络环境。而这个程序把"取内容"这一步挪到了**另一台机器上**：

1. 你的浏览器只访问 `https://你的域名/目标域名/路径` —— 这是**一个普通 HTTPS 请求**，目标是你自己的域名
2. Worker / PHP / Node 在服务端用自己的出口（Cloudflare 边缘节点 / 你的服务器）去请求真正的目标站
3. 拿到响应后，把 HTML、CSS 里的绝对链接、相对链接、`srcset`、`url()` 全部改写回你的域名，再返回给浏览器
4. 浏览器后续加载的每一个资源，依然回到你的域名，再由服务端去取

所以"能不能打开"取决于两件事：**你的域名是否可达**，以及**服务端出口是否能访问目标站**。Cloudflare Workers 天然在所有边缘节点上运行，出口就是 Cloudflare 自己的网络，对大量站点比普通机房 IP 更友好；自托管版则取决于你服务器的线路。

同一条链路上，被代理的只是**页面内容**，不涉及你的登录凭证与支付流程——需要登录的站点，通常会因为 Cookie 域不匹配而部分失效，这属于预期内的限制。

---

## 三、三个版本，按需选

| 版本                | 目录                      | 运行环境                | 适合谁                          |
| ----------------- | ----------------------- | ------------------- | ---------------------------- |
| **Workers 版**（推荐） | `reverse-proxy-worker/` | Cloudflare 免费账号     | 不想买服务器、想要全球边缘节点、零运维          |
| **PHP 版**         | `reverse-proxy-php/`    | 宝塔 / 任意 PHP 7.4+ 主机 | 已有站点和域名，传几个文件就能用，不占端口、不用常驻进程 |
| **Node 版**        | `reverse-proxy-node/`   | Node 18+            | 需要常驻进程、更高并发，或页面 HTML 畸形较多时更稳 |

三个版本**共用同一套前端界面**，接口一致（`/api/info`、`/health`），代理规则一致（`/目标域名/路径`）。

---

## 四、相比原版改了什么

原版能用，但在真实站点上会踩到一串坑。这里逐条对上：

| 问题                                         | 原版表现                                                                       | 本仓库处理                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 域名硬编码                                      | `WORKER_HOSTNAME` 写死，绑自定义域名或改名后整站失效                                        | 自动从请求里识别当前域名，`*.workers.dev` 和自定义域名都能直接用                                                            |
| 解析目标靠 `Referer`                            | 从首页输入框点"访问"时，`Referer` 是本站首页，解析出空目标 → 报"这个地址没法代理"                          | 改用真实请求路径解析，`Referer` 只作兜底候选，并逐个校验域名格式                                                               |
| 页面 JS 直接改 `location`                       | 例如 GitHub 搜索框跳到 `/search?q=…`，第一段不是域名 → 报"这个地址没法代理"                        | 路径不合法时用 `Referer`（或 `__rp_host` cookie）上的目标域名 + 当前请求路径**302 到 `/域名/路径`**，让地址栏重新带上目标站，后续点击才不会再次丢失上下文 |
| 相对路径直接字符串拼接                                | 子目录页面里 `../_static/x.css` 被拼成 `/域名/../_static/x.css` → 样式和脚本整批 404         | 相对地址先按所在页面 URL 解析成绝对地址，再改写                                                                          |
| 只改写 `href` / `src`                         | `srcset`、`action`、`poster`、CSS `url()`、`@import`、`<style>`、内联 `style` 全部漏改 | 全部覆盖                                                                                                |
| 保留 `integrity`                             | 内容被改写过，浏览器按 SRI 校验直接拒绝加载资源                                                 | 改写时剥离 `integrity` 属性                                                                                |
| 3xx 在服务端跟随                                 | 跨域跳转后 `Location` 指向真实站，浏览器直接跳走，后续相对资源全错位                                   | 改为 `redirect: manual`，改写 `Location` 后交回浏览器再走一次代理                                                    |
| `Set-Cookie` 带 `Domain`                    | 目标站 Cookie 的 `Domain` 不是本站域名，浏览器直接丢弃 → 每请求都是未登录态，表现为反复跳登录                  | 剥离 `Domain=` 属性                                                                                     |
| `Referer` / `Origin` 泄露本站域名                | 触发防盗链、来源校验、CSRF 检查，被拒或被重定向                                                 | 翻译成目标站自己的地址再发出                                                                                      |
| `Refresh` 头与 `<meta http-equiv="refresh">` | `0;url=https://真实站` 没被改写，浏览器被带走                                            | 一并改写成站内路径                                                                                           |
| 响应头残留                                      | `CSP`、`x-content-type-options` 干扰加载                                        | 剥离                                                                                                  |
| 没有入口页                                      | 只能手敲 URL                                                                   | **新增前端控制台**：网址归一化、常用站点快捷入口、访问记录（localStorage）、`/health` 实时延迟、`/` 快捷键聚焦、中文校验提示                       |

另外新增的接口与路由：

```
GET /              前端控制台
GET /api/info      {"proxyHost","scheme","engine"}
GET /health        {"ok":true,"engine":"cloudflare-worker","time":...}
GET /favicon.ico   204
GET /robots.txt    禁止收录
```

---

## 五、Cloudflare Workers 免费搭建（5 分钟）

### 方式 A：网页后台粘贴（无需本地环境）

1. 注册 / 登录 [Cloudflare](https://dash.cloudflare.com/)，进入 **Workers & Pages**
2. 点 **Create** → 选择 **Workers** → **Start with Hello World!** → 取个名字（如 `mirror`）→ **Deploy**
3. 进入这个 Worker，点右上角 **Edit code**（老界面叫 **Quick Edit**）
4. 删掉编辑器里的默认代码，把 `reverse-proxy-worker/worker.js` **全文粘进去**（**不需要改任何常量**）
5. 点右上角 **Deploy**，访问 `https://mirror.你的账号.workers.dev/`

打开首页就是控制台，输入 `developer.mozilla.org/zh-CN/` 点"访问"，即可看到镜像站。

> **别用 "Upload / 上传" 那个入口**：它会把你上传的 JS 当成需要构建的静态资源项目，直接报"此上传程序暂不支持需要构建过程的项目"。Worker 脚本只能走 **Edit code** 粘贴或 **wrangler** 部署。

### 方式 B：wrangler CLI

```bash
npm i -g wrangler
wrangler login
cd reverse-proxy-worker
wrangler deploy
```

`wrangler.toml` 已备好：

```toml
name = "reverse-proxy"
main = "worker.js"
compatibility_date = "2025-01-01"
```

`name` 就是 Worker 名字，可自行修改。若浏览器授权流程走不通，用 API Token：

```bash
# PowerShell
$env:CLOUDFLARE_API_TOKEN="你的token"
wrangler deploy
```

Token 在 My Profile → API Tokens 创建，权限选 **Edit Cloudflare Workers**。

### 绑定自定义域名（建议做）

`*.workers.dev` 在国内经常连不上，绑自有域名后稳定得多：

**Workers → 你的 Worker → Settings → Domains & Routes → Add → Custom domain**，填一个已托管在同一 Cloudflare 账号下的域名（如 `mirror.yourdomain.com`）。

绑完直接用新域名访问，**代码一个字都不用改**——Worker 是从请求里取当前域名的。

### 免费额度

- 每天 **10 万次请求**（Workers 免费计划）
- 单次请求 CPU 时间 10ms（本项目的改写是纯正则 + 字符串操作，正常页面远低于这个阈值）
- 大文件与视频会消耗流量额度，注意用量

### 常见坑

| 现象                        | 原因 / 处理                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 报"暂不支持需要构建过程的项目"          | 用了 Upload 入口，改用 Edit code 或 wrangler                                                                                                                  |
| 粘贴后编辑器报语法错误               | 极少数旧版 Quick Edit 只认 Service Worker 写法，把末尾 `export default { async fetch(...) }` 换成 `addEventListener("fetch", e => e.respondWith(handle(e.request)))` |
| 输入什么都是"这个地址没法代理"          | 域名不带小数点，或把本站域名当目标；URL 必须是 `/目标域名/路径` 形式                                                                                                               |
| 页面能开但样式/JS 全丢             | Workers 版已修；若用 PHP 版，是宝塔 nginx 的 `location ~ .*\.(js                                                                                                  |
| 访问出现 Cloudflare 挑战页 / 403 | 目标站开了托管挑战，见下方"已知局限"                                                                                                                                   |

---

## 六、PHP 版部署（宝塔）

```
reverse-proxy-php/
├── index.php                全部逻辑（代理 + 链接改写 + 首页 + 接口）
├── ui.html                  前端控制台
├── cacert.pem               CA 兜底（服务器缺系统 CA 时自动启用）
├── nginx-rewrite.conf.txt   宝塔伪静态规则（必配）
└── .htaccess                Apache 用，Nginx 忽略
```

1. 宝塔新建一个 **PHP 站点**（PHP ≥ 7.4，需开启 `curl`、`mbstring`、`zlib`）
2. 把 `index.php`、`ui.html`、`cacert.pem` 上传到站点根目录
3. **站点设置 → 伪静态**，粘贴 `nginx-rewrite.conf.txt` 全文（里面有两段 `location`，第二段专门覆盖 `.js/.css/图片/字体` 后缀，否则宝塔默认规则会把它们当静态文件去磁盘找，直接 404）
4. 访问 `https://你的域名/` 即控制台

## 七、Node 版部署

```bash
cd reverse-proxy-node
npm install
PORT=3000 PROXY_HOST=你的域名 node server.js
```

依赖只有 `cheerio`，Node ≥ 18。若前面还有一层 Nginx，注意 `proxy_pass` 不要带路径、并透传 `Host`。

---

## 八、已知局限（先看这段，避免走错方向）

- **Cloudflare 托管挑战（5 秒盾 / Turnstile）**：这类校验绑定 TLS 指纹 + 浏览器 JS 环境 + `cf_clearance`（绑 IP 与 UA）。服务端 `fetch` / `curl` 的握手特征不是真实浏览器，改 `User-Agent`、`Referer`、`sec-ch-ua` 都过不去。响应里出现 `cf-mitigated: challenge` 或 `server: cloudflare` + 403，即属此类。
- **页面 JS 自检**：站点脚本判断 `location.host` 不是自己的域名就 `location.href = 官方地址`。伪造 `location` 现代浏览器不允许，无法处理。
- **登录态**：PPT 已剥离 Cookie 的 `Domain`，但不同目标站共用同一个域名下的 Cookie 空间，多站点登录可能互相覆盖。
- **端口**：只支持标准 80/443；`/host:8080/` 这种写法会被当作路径。
- **http-only 老站**：优先按 HTTPS 请求，失败自动回落 HTTP；页面里写死 `http://` 的绝对资源可能缺失。
- **反代不是翻墙**：需要目标站可被你的出口访问，代理本身不提供任何网络层转发能力。

---

## 九、目录结构

```
reverse-proxy-worker/     Cloudflare Workers 版（单文件，前端内嵌）
reverse-proxy-php/        PHP 版（宝塔 / 任意 PHP 主机）
reverse-proxy-node/       Node 版（常驻进程）
使用说明.md                三个版本的选型与排查速查
```

## 十、致谢与许可

- 原项目：[Mikotwa/reverse-proxy-cf](https://github.com/Mikotwa/reverse-proxy-cf)，感谢原作者把思路跑通
- 本仓库的修复与新增部分同样遵循原项目许可；使用前请阅读原仓库的 LICENSE
- 前端界面为自绘，无外部依赖、无 CDN 外链

## 免责声明

本项目仅用于**技术研究与合法的内容访问**。使用者应自行确保其行为符合所在地法律法规及目标站点的服务条款；作者不对任何因使用本项目造成的后果负责。
