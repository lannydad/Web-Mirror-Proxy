# reverse-proxy-node · 网页镜像

`Mikotwa/reverse-proxy-cf` 的 Node 版实现 + 自带前端控制台，可以直接跑在宝塔服务器上。

原项目是 Cloudflare Worker 的 service-worker 脚本（`index.js` + `addEventListener("fetch")` + `HTMLRewriter`），只能在 Cloudflare 运行时里运行，宝塔里没有这个运行时，所以不能原样部署。这里用 Node 原生 `http` + `cheerio` 复刻了同样的逻辑，并补了一个前端。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.js` | 服务端：代理逻辑 + 接口 + 首页 |
| `ui.html` | 前端控制台（单页，无框架、无外链依赖） |
| `package.json` | 依赖只有 `cheerio`，要求 Node ≥ 18 |
| `preview-home.png` | 首页效果预览 |

## 路由

| 路径 | 说明 |
| --- | --- |
| `/` | 前端控制台：输入网址、常用站点、访问记录 |
| `/api/info` | 返回本站域名等配置（前端用来拼链接） |
| `/health` | 健康检查，前端右上角的“在线 · xx ms”读它 |
| `/目标域名/路径` | 反向代理，例如 `/developer.mozilla.org/zh-CN/` |

## 前端有什么

- 输入框支持完整 URL 或裸域名，`https://`、`www.`、尾部斜杠自动处理，按 `/域名/路径` 规则跳转
- 8 个常用站点快捷入口，点一下直达
- 访问记录存 `localStorage`（最近 20 条），可一键复制链接、可清空
- 右上角实时显示服务状态与响应耗时
- 键盘 `/` 快速聚焦输入框
- 全中文、深色紫调、移动端自适应；底部带备案号与工信部链接

> 底部备案号是占位 `粤ICP备00000000号`，上线前在 `ui.html` 里搜 “粤ICP备” 改成自己的真实备案号。

## 部署到宝塔

1. 宝塔面板 → 软件商店 → 安装「Node.js 版本管理器」，选 **Node 18 或以上**（需要内置 `fetch`）。
2. 把本项目上传到 `/www/wwwroot/reverse-proxy`。
3. 终端里执行 `npm install`（只装 cheerio）。
4. 宝塔 → 网站 → Node 项目 → 添加 Node 项目：
   - 项目目录：`/www/wwwroot/reverse-proxy`
   - 启动文件：`server.js`
   - 端口：`3000`
   - 运行用户：`www`
   - 环境变量：`PROXY_HOST=你的域名`（例如 `proxy.example.com`，不带 `https://`）
5. 给项目绑定域名并申请 SSL，宝塔会自动生成到 `127.0.0.1:3000` 的反向代理。
   （若用 PM2 托管，则手动在「网站 → 站点设置 → 反向代理」加一条，目标 URL 填 `http://127.0.0.1:3000`。）
6. 打开 `https://你的域名/` 就是控制台，输入框里访问任意站点。

本地试跑：

```bash
npm install
PORT=3000 PROXY_HOST=127.0.0.1:3000 node server.js
# 打开 http://127.0.0.1:3000/
```

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `3000` |
| `PROXY_HOST` | 本站对外域名，用于把绝对链接改写回本站 | `127.0.0.1:3000` |
| `HTTPS_ONLY` | 设为 `1` 时生成的链接强制带 `https://`，否则用协议相对 `//host` | 未设置 |

## 相比原项目补了什么

- HTML 里 `a / area / img / link / script / iframe / video / audio / source / embed / object` 的链接改写，含 `srcset`
- CSS 文件、`<style>` 块和内联 style 里的 `url()`、`@import` 改写
- 302/301 跳转的 `Location` 头改写回本站，避免跳到外域
- 去掉 `content-security-policy`、`x-content-type-options`
- 不再把本站 `Referer` 传给目标站（避免防盗链和统计串味）
- 相对路径（`../assets/x.css`、`assets/a.js`）会按页面地址解析后再改写，子目录页面不会错位
- 去掉 `integrity` 校验属性（内容被改写过，浏览器按 SRI 校验会直接拒绝加载）
- 前端控制台：输入、常用站点、历史、状态、复制链接
- 出错时返回带“回到控制台”入口的错误页，而不是裸文本

## 如果前面还有一层宝塔 Nginx

宝塔默认站点配置带 `location ~ .*\.(js|css)?$`、`location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)$` 这类正则块，
它们优先级高于 `location /`，会让代理出来的 css/js/图片绕过反代直接去磁盘找文件，结果全部 404。
如果你前面套了 Nginx，请把这两块改成：

```nginx
location ~ .*\.(js|css)?$ { proxy_pass http://127.0.0.1:3000; }
location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)$ { proxy_pass http://127.0.0.1:3000; }
```

或者直接删掉这两块（代理站不需要本地静态缓存）。

## 局限（和原项目一致）

- 目标站点必须是 HTTPS；纯 HTTP 站会失败。
- 部分站点（Bing、Mediawiki、强 CSP / 全靠 JS 渲染的站）反代会不正常。
- 不支持 WebSocket（`wss://` 类站点无法完整工作）。
- 只接受 `a.b` 形式的域名，IP 或带端口的地址会被拒绝（防止变成开放请求器）。

## 注意

原项目 README 已声明「使用受所在地法律法规限制，确保合规使用是使用者的责任」。国内服务器自建网页代理/镜像存在合规风险，请自行评估后再上线。
