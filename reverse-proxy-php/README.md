# 网页镜像 · PHP 版

`Mikotwa/reverse-proxy-cf` 的 PHP 实现，自带前端控制台，丢进宝塔任意 PHP 站点就能跑。
和 Node 版功能一致，区别只是运行时：**PHP 版不需要装 Node、不需要常驻进程、不需要开端口**，走的是你站点已有的 Nginx + PHP-FPM。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.php` | 全部逻辑：代理、链接改写、首页、接口 |
| `ui.html` | 前端控制台（和 Node 版同一套界面） |
| `cacert.pem` | CA 证书兜底，服务器没有系统 CA 时自动启用（建议一起上传） |
| `nginx-rewrite.conf.txt` | 宝塔伪静态规则，**必须配置**，否则打不开代理路径 |
| `.htaccess` | Apache 环境用，Nginx/宝塔忽略 |
| `preview-home.png` | 首页效果预览 |

## 环境要求

- PHP **7.4 – 8.3** 均可，需要 `curl`、`mbstring`、`zlib` 扩展（宝塔默认的 PHP 都带）
- 不需要数据库、不需要 composer、不需要任何第三方库

## 部署到宝塔（Nginx + PHP）

1. 宝塔 → 网站 → 添加站点，PHP 版本选 7.4 / 8.0 / 8.1 任意一个，**不要选纯静态**。
2. 把 `index.php`、`ui.html` 上传到该站点的根目录（例如 `/www/wwwroot/proxy.example.com/`）。
3. 网站 → 设置 → **伪静态**，把 `nginx-rewrite.conf.txt` 里的内容粘进去保存：
   ```nginx
   location / {
       try_files $uri $uri/ /index.php?$query_string;
   }
   ```
   这一步不做的话，`/developer.mozilla.org/...` 会被 Nginx 直接 404。
4. （可选）想固定对外域名，可在 `index.php` 顶部把默认值写死，或给站点加环境变量 `PROXY_HOST=你的域名`；不设置会自动取当前访问的 Host，一般不用管。
5. 打开 `https://你的域名/` 就是控制台，输入框里随便访问一个站点试试。

本地想先看看效果：装了 PHP 的话，在本目录执行（注意要带 `index.php` 当路由脚本，否则代理路径会 404）：

```bash
php -S 127.0.0.1:8000 index.php
# 浏览器打开 http://127.0.0.1:8000/
```

## 路由

| 路径 | 说明 |
| --- | --- |
| `/` | 前端控制台 |
| `/api/info` | JSON，返回本站域名（前端拼链接用） |
| `/health` | JSON，健康检查（首页右上角的“在线 · xx ms”） |
| `/目标域名/路径` | 反向代理 |

## 实现要点

- 用 `curl` 请求目标站，自动处理 gzip / deflate / br，跟随你转发的请求头，但会丢掉 `Host`、`Referer`、`Connection` 等
- HTML 用正则改写 `a / area / img / link / script / iframe / video / audio / source / embed / object / form` 上的 `href src srcset poster data action`，带引号和不带引号的属性都处理
- CSS 单独处理：`url()` 与 `@import` 都按 CSS 文件自身地址解析后改写，所以相对路径（`./fonts/xx.woff`）也不会断
- 3xx 跳转不跟随，而是把 `Location` 改写回本站再返回给浏览器，避免跳出镜像
- 输出时去掉上游的 `content-encoding`、`content-length`、CSP，避免二进制错位和页面被策略拦掉

## 和 Node 版怎么选

| | PHP 版 | Node 版 |
| --- | --- | --- |
| 部署成本 | 丢文件 + 一条伪静态 | 装 Node 18+、npm install、开端口、配反代 |
| 常驻进程 | 无（PHP-FPM 托管） | 需要 PM2 或 Node 项目管理器托管 |
| 并发模型 | 每请求一个进程/线程 | 单进程异步，更省资源 |
| HTML 改写 | 正则 | cheerio（真正解析 DOM，畸形 HTML 更稳） |
| 大文件/流式 | 全量缓冲在内存 | 全量缓冲 |

站点结构规整、流量不大时 PHP 版最省事；页面 HTML 很畸形、或者并发高，Node 版的 cheerio 解析更靠谱。

## 局限（两版一致）

- 目标站点必须是 HTTPS；纯 HTTP 站失败
- Bing、Mediawiki、强 CSP / 全靠 JS 渲染的站会不正常
- 不支持 WebSocket
- 只接受 `a.b` 形式的域名，IP / 带端口地址会被拒绝

## 常见问题

- **打开代理路径直接 404（Nginx 自己的 404 页面）**：伪静态没配，回到第 3 步。
- **页面能打开，但样式、JS、图片全部失效**：宝塔默认配置里的 `location ~ .*\.(js|css)?$` 和 `location ~ .*\.(gif|jpg|...)$` 比 `location /` 优先，带后缀的请求根本没进 `index.php`。把 `nginx-rewrite.conf.txt` 完整粘进伪静态（里面第二段就是专门覆盖它们的），或者直接删掉站点配置里这两段。
- **提示 `SSL certificate ... unable to get local issuer certificate`**：服务器缺 CA，把 `cacert.pem` 一起放到同目录即可（`index.php` 会自动读取）。
- **提示 `Call to undefined function curl_init()`**：PHP 没装/没开 curl 扩展，宝塔 → 软件商店 → 对应 PHP 版本 → 设置 → 安装扩展。
- **整个站都变成 502**：先在服务器上确认能否访问目标站（`curl -I https://目标域名`），再检查防火墙。
- **页面样式全丢**：多半是目标站用了 CSS `@import` 链式加载或靠 JS 拼出的样式表，这类站点本来就容易出问题。

## 注意

原项目 README 已声明「使用受所在地法律法规限制，确保合规使用是使用者的责任」。国内服务器自建网页代理/镜像存在合规风险，请自行评估后再上线。
