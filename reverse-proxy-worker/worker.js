/**
 * reverse-proxy-cf · Cloudflare Workers 增强版（单文件）
 * ------------------------------------------------------------------
 * 相比原版 index.js 修的内容：
 *   1. 不再硬编码 WORKER_HOSTNAME，自动识别当前访问域名（workers.dev 或自定义域名都行）
 *   2. 解析目标域名改用「真实请求路径」，不再优先读 Referer（修掉「输入什么都是没法代理」）
 *   3. 相对路径按所在页面地址解析（../x、./x 不再错位）
 *   4. srcset / CSS url() / @import / <style> / 内联 style 全部改写
 *   5. 剥离 integrity（我们改写过内容，浏览器按 SRI 会拒载）
 *   6. 3xx 不内部跟随，改写 Location 后交回浏览器
 *   7. Set-Cookie 去掉 Domain=，登录态才能落在本站域名
 *   8. Referer / Origin 翻译成目标站自己的地址
 *   9. 内置前端控制台（内嵌，无需额外文件）
 *
 * 路由：/ 控制台 · /api/info · /health · /favicon.ico · /目标域名/路径
 */

const UI_HTML = "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>网页镜像 · 把任意站点穿进一个域名</title>\n<meta name=\"description\" content=\"输入的网址经由本站反向代理与链接改写，页面、脚本、样式全部走同一个域名，无需插件。\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%237c5cff'/%3E%3Cstop offset='1' stop-color='%23c084fc'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='9' fill='url(%23g)'/%3E%3Cpath d='M16 7l7 9-7 9-7-9z' fill='white' opacity='.92'/%3E%3C/svg%3E\">\n<style>\n  :root{\n    --bg:#0a0910;\n    --ink:#efedf7;\n    --mute:#9297ad;\n    --line:rgba(255,255,255,.09);\n    --card:rgba(255,255,255,.045);\n    --violet:#7c5cff;\n    --fuchsia:#c084fc;\n    --radius:20px;\n  }\n  *{box-sizing:border-box}\n  html{-webkit-text-size-adjust:100%}\n  body{\n    margin:0;min-height:100vh;background:var(--bg);color:var(--ink);\n    font:15px/1.7 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;\n    letter-spacing:.01em;overflow-x:hidden;\n  }\n  /* ---------- 背景 ---------- */\n  .bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}\n  .bg .orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55}\n  .o1{width:620px;height:620px;left:-180px;top:-260px;background:radial-gradient(circle,#5b3cff 0%,transparent 70%)}\n  .o2{width:560px;height:560px;right:-160px;top:-120px;background:radial-gradient(circle,#9b4dff 0%,transparent 72%);opacity:.42}\n  .o3{width:700px;height:420px;left:35%;bottom:-260px;background:radial-gradient(circle,#2b1e5e 0%,transparent 75%);opacity:.5}\n  .bg .grid{\n    position:absolute;inset:0;opacity:.5;\n    background-image:linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),\n                      linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px);\n    background-size:56px 56px;\n    mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,#000 25%,transparent 78%);\n    -webkit-mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,#000 25%,transparent 78%);\n  }\n\n  .wrap{position:relative;z-index:1;max-width:1040px;margin:0 auto;padding:0 22px 70px}\n\n  /* ---------- 顶栏 ---------- */\n  header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:26px 0 0}\n  .brand{display:flex;align-items:center;gap:12px}\n  .mark{width:38px;height:38px;flex:none;display:grid;place-items:center;\n    background:linear-gradient(135deg,var(--violet),var(--fuchsia));border-radius:11px;\n    box-shadow:0 8px 26px rgba(124,92,255,.4)}\n  .mark svg{width:17px;height:17px}\n  .brand b{display:block;font-size:16px;font-weight:650;line-height:1.2}\n  .brand span{font-size:11.5px;color:var(--mute);letter-spacing:.14em;text-transform:uppercase}\n  .navright{display:flex;align-items:center;gap:10px}\n  .pill{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;\n    font-size:12.5px;color:#cfc9e8;background:rgba(255,255,255,.05);border:1px solid var(--line)}\n  .dot{width:7px;height:7px;border-radius:50%;background:#22d3a5;box-shadow:0 0 0 3px rgba(34,211,165,.15)}\n  .dot.off{background:#f2687b;box-shadow:0 0 0 3px rgba(242,104,123,.15)}\n  .ghost{font-size:13px;color:var(--mute);text-decoration:none;padding:6px 8px;border-radius:8px;transition:.2s}\n  .ghost:hover{color:#fff;background:rgba(255,255,255,.06)}\n\n  /* ---------- Hero ---------- */\n  .hero{padding:64px 0 8px;text-align:center}\n  .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:5px 13px;margin-bottom:22px;\n    border-radius:999px;font-size:12.5px;color:#c7bdf0;background:rgba(124,92,255,.12);\n    border:1px solid rgba(124,92,255,.28)}\n  .eyebrow i{width:6px;height:6px;border-radius:50%;background:var(--fuchsia)}\n  h1{margin:0 0 16px;font-size:clamp(27px,4.4vw,44px);line-height:1.25;font-weight:700;letter-spacing:-.015em}\n  h1 em{font-style:normal;background:linear-gradient(100deg,#a78bfa,#e9d5ff 45%,#7c5cff);\n    -webkit-background-clip:text;background-clip:text;color:transparent}\n  .sub{margin:0 auto 38px;max-width:620px;color:var(--mute);font-size:14.5px;line-height:1.85}\n\n  /* ---------- 输入条 ---------- */\n  form.bar{display:flex;align-items:center;gap:10px;max-width:760px;margin:0 auto;\n    padding:9px 9px 9px 18px;border-radius:16px;background:rgba(18,16,28,.82);\n    border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(14px);\n    box-shadow:0 20px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);\n    transition:border-color .22s,box-shadow .22s}\n  form.bar:focus-within{border-color:rgba(124,92,255,.62);\n    box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 0 4px rgba(124,92,255,.16)}\n  .lead{display:inline-flex;align-items:center;gap:6px;flex:none;font:12px/1 ui-monospace,Menlo,Consolas,monospace;\n    color:#857ea6;padding-right:12px;border-right:1px solid var(--line);max-width:34%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n  input#q{flex:1;min-width:0;border:0;background:none;color:var(--ink);font-size:15px;padding:11px 2px;outline:none}\n  input#q::placeholder{color:#5d5a72}\n  .go{flex:none;display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border:0;border-radius:11px;\n    background:linear-gradient(135deg,#7c5cff,#a855f7);color:#fff;font-weight:650;font-size:14px;cursor:pointer;\n    box-shadow:0 10px 26px rgba(124,92,255,.32);transition:transform .16s,box-shadow .16s,filter .16s}\n  .go:hover{transform:translateY(-1px);filter:brightness(1.07)}\n  .go:active{transform:translateY(0) scale(.985)}\n  .go svg{width:14px;height:14px}\n\n  .hint{margin:18px auto 0;max-width:760px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;\n    font-size:12.5px;color:#767289;align-items:center}\n  .hint b{font-weight:500;color:#6d6885}\n  .hint button{border:1px dashed rgba(255,255,255,.14);background:rgba(255,255,255,.03);color:#b4abdc;\n    font-size:12.5px;padding:4px 11px;border-radius:8px;cursor:pointer;transition:.18s}\n  .hint button:hover{border-color:rgba(124,92,255,.55);color:#fff;background:rgba(124,92,255,.16)}\n  .err{margin:16px auto 0;max-width:760px;font-size:13px;color:#ff9aa6;min-height:20px}\n\n  /* ---------- 卡片区 ---------- */\n  .panels{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;margin-top:52px}\n  @media (max-width:820px){.panels{grid-template-columns:1fr}}\n  .card{padding:24px 26px 26px;border-radius:var(--radius);background:var(--card);\n    border:1px solid var(--line);backdrop-filter:blur(10px);box-shadow:0 18px 50px rgba(0,0,0,.32)}\n  .card h2{margin:0 0 18px;font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;\n    color:#9d96bc;display:flex;align-items:center;justify-content:space-between;gap:10px}\n  .card h2 .mini{border:0;background:none;color:#726c8c;font-size:12px;cursor:pointer;letter-spacing:0;\n    text-transform:none;padding:4px 6px;border-radius:6px;transition:.18s}\n  .card h2 .mini:hover{color:#f2687b;background:rgba(242,104,123,.1)}\n\n  .quick{display:grid;grid-template-columns:1fr 1fr;gap:9px}\n  .qlink{display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:11px;cursor:pointer;\n    background:rgba(255,255,255,.028);border:1px solid rgba(255,255,255,.06);\n    color:#ded8f5;font-size:13.5px;text-align:left;transition:.18s}\n  .qlink:hover{background:rgba(124,92,255,.14);border-color:rgba(124,92,255,.4);transform:translateY(-1px)}\n  .qlink i{width:8px;height:8px;border-radius:2px;flex:none;background:linear-gradient(135deg,#7c5cff,#c084fc);opacity:.85}\n  .qlink span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .qlink small{display:block;font-size:11px;color:#78738f;font-weight:400;letter-spacing:0}\n\n  .hist{list-style:none;margin:0;padding:0;max-height:246px;overflow:auto}\n  .hist::-webkit-scrollbar{width:6px}\n  .hist::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:6px}\n  .hrow{display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px dashed rgba(255,255,255,.06)}\n  .hrow:last-child{border-bottom:0}\n  .hrow a{flex:1;min-width:0;text-decoration:none;color:#ddd7f4;font-size:13.5px;\n    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .hrow a:hover{color:#fff;text-decoration:underline;text-decoration-color:rgba(160,140,255,.7)}\n  .hrow time{flex:none;font-size:11.5px;color:#6f6a86}\n  .hrow .cp{border:0;background:none;color:#7b7593;cursor:pointer;padding:3px 5px;border-radius:5px;line-height:0}\n  .hrow .cp:hover{color:#b9a7ff;background:rgba(124,92,255,.14)}\n  .empty{padding:26px 0;text-align:center;color:#66627c;font-size:13px}\n\n  /* ---------- 说明 ---------- */\n  .how{margin-top:18px}\n  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}\n  @media (max-width:820px){.steps{grid-template-columns:1fr}}\n  .step{padding:16px 18px;border-radius:13px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06)}\n  .step b{display:block;font-size:12px;color:#a78bfa;letter-spacing:.1em;margin-bottom:7px}\n  .step p{margin:0;font-size:13px;color:#9b96b0;line-height:1.72}\n  .step code{font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#c3b5ff;background:rgba(124,92,255,.1);\n    padding:2px 6px;border-radius:5px}\n\n  footer{margin-top:44px;padding-top:24px;border-top:1px solid rgba(255,255,255,.06);\n    text-align:center;font-size:12.5px;color:#6b6680;line-height:2}\n  footer a{color:#8a83a8;text-decoration:none}\n  footer a:hover{color:#c9bfff}\n  footer .sep{margin:0 9px;color:#403d52}\n\n  .toast{position:fixed;left:50%;bottom:34px;transform:translate(-50%,16px);z-index:50;\n    padding:10px 18px;border-radius:11px;font-size:13px;color:#fff;\n    background:rgba(28,24,44,.94);border:1px solid rgba(124,92,255,.4);\n    box-shadow:0 14px 40px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:.28s}\n  .toast.on{opacity:1;transform:translate(-50%,0)}\n</style>\n</head>\n<body>\n<div class=\"bg\"><span class=\"orb o1\"></span><span class=\"orb o2\"></span><span class=\"orb o3\"></span><div class=\"grid\"></div></div>\n\n<div class=\"wrap\">\n  <header>\n    <div class=\"brand\">\n      <div class=\"mark\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M12 3l8 9-8 9-8-9z\" fill=\"#fff\" opacity=\".95\"/></svg>\n      </div>\n      <div><b>网页镜像</b><span>Proxy Mirror</span></div>\n    </div>\n    <div class=\"navright\">\n      <span class=\"pill\"><i class=\"dot\" id=\"dot\"></i><span id=\"status\">连接中…</span></span>\n      <a class=\"ghost\" href=\"https://github.com/lannydad/Web-Mirror-Proxy\" target=\"_blank\" rel=\"noreferrer\">项目主页 ↗</a>\n    </div>\n  </header>\n\n  <section class=\"hero\">\n    <div class=\"eyebrow\"><i></i>跨境直达 · 一个域名装下所有站点</div>\n    <h1>想去的地方，都收进<br>这层<em>镜像</em>里</h1>\n    <p class=\"sub\">粘贴任意站点地址，页面、脚本、样式里的链接会被服务端改写回本域。跨境查资料、比对海外原站，地址栏始终只有一个域名——不装插件，不改 DNS，也不用开端口。</p>\n\n    <form class=\"bar\" id=\"form\" autocomplete=\"off\">\n      <span class=\"lead\" id=\"lead\">example.com</span>\n      <input id=\"q\" placeholder=\"粘贴网址，或直接输入域名 …\" spellcheck=\"false\">\n      <button class=\"go\" type=\"submit\">访问\n        <svg viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M5 12h13M13 6l6 6-6 6\" stroke=\"#fff\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>\n      </button>\n    </form>\n\n    <div class=\"hint\">\n      <b>试试：</b>\n      <button data-fill=\"developer.mozilla.org/zh-CN/\">MDN 中文文档</button>\n      <button data-fill=\"github.com\">GitHub</button>\n      <button data-fill=\"npmjs.com\">npm</button>\n      <button data-fill=\"nodejs.org/en\">Node.js</button>\n      <button data-fill=\"tailwindcss.com\">Tailwind</button>\n    </div>\n    <div class=\"err\" id=\"err\"></div>\n  </section>\n\n  <section class=\"panels\">\n    <div class=\"card\">\n      <h2>常用站点</h2>\n      <div class=\"quick\" id=\"quick\"></div>\n    </div>\n    <div class=\"card\">\n      <h2>访问记录 <button class=\"mini\" id=\"clear\" type=\"button\">清空</button></h2>\n      <ul class=\"hist\" id=\"hist\"></ul>\n    </div>\n  </section>\n\n  <section class=\"card how\">\n    <h2>怎么用</h2>\n    <div class=\"steps\">\n      <div class=\"step\">\n        <b>01 / 输入</b>\n        <p>支持完整 URL 或裸域名，<code>https://</code>、尾部斜杠都会被自动处理。</p>\n      </div>\n      <div class=\"step\">\n        <b>02 / 跳转</b>\n        <p>按 <code>/域名/路径</code> 规则进入镜像地址，形如 <code>/developer.mozilla.org/</code>。</p>\n      </div>\n      <div class=\"step\">\n        <b>03 / 浏览</b>\n        <p>页面内的链接、图片、样式会继续留在本域，导航不会跳出镜像。</p>\n      </div>\n    </div>\n  </section>\n\n  <footer>\n    <div>© <span id=\"year\">2026</span> 网页镜像 · 仅做页面内容转发，不在服务器留存任何浏览数据</div>\n    <div>\n      <a href=\"/health\" target=\"_blank\">服务状态</a>\n    </div>\n  </footer>\n</div>\n\n<div class=\"toast\" id=\"toast\"></div>\n\n<script>\n(function(){\n  var KEY = \"rp_history_v1\";\n  var $ = function(id){ return document.getElementById(id); };\n  var q = $(\"q\"), form = $(\"form\"), errBox = $(\"err\"), toastEl = $(\"toast\");\n\n  var QUICK = [\n    { name:\"MDN 文档\", url:\"developer.mozilla.org/zh-CN/\", tag:\"前端手册\" },\n    { name:\"GitHub\", url:\"github.com\", tag:\"代码托管\" },\n    { name:\"npm\", url:\"npmjs.com\", tag:\"包仓库\" },\n    { name:\"Node.js\", url:\"nodejs.org/en\", tag:\"运行时\" },\n    { name:\"Tailwind CSS\", url:\"tailwindcss.com\", tag:\"样式框架\" },\n    { name:\"React\", url:\"react.dev\", tag:\"组件库\" },\n    { name:\"Docker Docs\", url:\"docs.docker.com\", tag:\"容器\" },\n    { name:\"MDN Web API\", url:\"developer.mozilla.org/en-US/docs/Web/API\", tag:\"接口索引\" }\n  ];\n\n  /* ---------- 工具 ---------- */\n  function toast(msg){\n    toastEl.textContent = msg;\n    toastEl.classList.add(\"on\");\n    clearTimeout(toastEl._t);\n    toastEl._t = setTimeout(function(){ toastEl.classList.remove(\"on\"); }, 1800);\n  }\n\n  /** 把用户输入规范化成 {host, path} */\n  function normalize(input){\n    var s = String(input || \"\").trim();\n    if (!s) return null;\n    s = s.replace(/^[\\s\"'<>]+|[\\s\"'<>]+$/g, \"\");\n    s = s.replace(/^https?:\\/\\//i, \"\");\n    // 去掉可能粘贴的多余协议片段\n    s = s.replace(/^(?:www\\.)?([^\\/]+)/, function(m){ return m; });\n    var m = s.match(/^([^\\/?#]+)([\\/?#].*)?$/);\n    if (!m) return null;\n    var host = m[1].toLowerCase().replace(/\\.$/, \"\");\n    var path = m[2] || \"/\";\n    if (path.charAt(0) === \"?\") path = \"/\" + path;\n    if (!/^[a-z0-9.-]+\\.[a-z]{2,}$/.test(host)) return null;\n    if (host === location.host.toLowerCase()) return null; // 别镜像自己\n    if (path.charAt(0) !== \"/\") path = \"/\" + path;\n    return { host: host, path: path };\n  }\n\n  function buildUrl(t){ return \"/\" + t.host + t.path; }\n\n  /* ---------- 历史 ---------- */\n  function readHist(){\n    try { return JSON.parse(localStorage.getItem(KEY) || \"[]\") || []; } catch(e){ return []; }\n  }\n  function writeHist(list){\n    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20))); } catch(e){}\n  }\n  function pushHist(t){\n    var list = readHist().filter(function(i){ return !(i.host === t.host && i.path === t.path); });\n    list.unshift({ host:t.host, path:t.path, ts: Date.now() });\n    writeHist(list);\n    renderHist();\n  }\n  function fmtTime(ts){\n    var d = new Date(ts), now = Date.now(), diff = (now - ts) / 1000;\n    if (diff < 60) return \"刚刚\";\n    if (diff < 3600) return Math.floor(diff/60) + \" 分钟前\";\n    if (diff < 86400) return Math.floor(diff/3600) + \" 小时前\";\n    return (d.getMonth()+1) + \"月\" + d.getDate() + \"日\";\n  }\n  function renderHist(){\n    var list = readHist(), box = $(\"hist\");\n    if (!list.length){\n      box.innerHTML = '<li class=\"empty\">还没有记录，先访问一个站点吧</li>';\n      return;\n    }\n    box.innerHTML = list.map(function(i){\n      var url = \"/\" + i.host + i.path;\n      return '<li class=\"hrow\">' +\n        '<a href=\"' + url + '\">' + i.host + (i.path !== \"/\" ? i.path : \"\") + '</a>' +\n        '<time>' + fmtTime(i.ts) + '</time>' +\n        '<button class=\"cp\" type=\"button\" data-copy=\"' + esc(url) + '\" title=\"复制链接\">' +\n          '<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" fill=\"none\">' +\n          '<rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2.5\" stroke=\"currentColor\" stroke-width=\"1.6\"/>' +\n          '<path d=\"M15 6.5V5.5A2.5 2.5 0 0 0 12.5 3H5.5A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15H6.5\" stroke=\"currentColor\" stroke-width=\"1.6\"/>' +\n          '</svg></button></li>';\n    }).join(\"\");\n  }\n  function esc(s){ return String(s).replace(/[&<>\"']/g, function(c){ return ({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"})[c]; }); }\n\n  /* ---------- 快捷入口 ---------- */\n  function renderQuick(){\n    $(\"quick\").innerHTML = QUICK.map(function(item){\n      var t = normalize(item.url);\n      var href = t ? buildUrl(t) : \"#\";\n      return '<a class=\"qlink\" href=\"' + href + '\"><i></i><span>' + esc(item.name) +\n        '<small>' + esc(item.tag) + '</small></span></a>';\n    }).join(\"\");\n  }\n\n  /* ---------- 提交 ---------- */\n  function go(value){\n    var t = normalize(value);\n    if (!t){\n      errBox.textContent = \"地址看起来不对：需要是 example.com 或 https://example.com/路径 这样的形式。\";\n      q.focus();\n      return false;\n    }\n    errBox.textContent = \"\";\n    pushHist(t);\n    location.href = buildUrl(t);\n    return true;\n  }\n\n  form.addEventListener(\"submit\", function(e){\n    e.preventDefault();\n    go(q.value);\n  });\n  q.addEventListener(\"input\", function(){ errBox.textContent = \"\"; });\n\n  document.querySelectorAll(\"[data-fill]\").forEach(function(btn){\n    btn.addEventListener(\"click\", function(){\n      q.value = btn.dataset.fill;\n      q.focus();\n    });\n  });\n\n  $(\"hist\").addEventListener(\"click\", function(e){\n    var cp = e.target.closest(\"[data-copy]\");\n    if (!cp) return;\n    e.preventDefault();\n    var text = location.origin + cp.dataset.copy;\n    if (navigator.clipboard && navigator.clipboard.writeText){\n      navigator.clipboard.writeText(text).then(function(){ toast(\"链接已复制\"); },\n        function(){ toast(\"复制失败，请手动选择\"); });\n    } else {\n      var ta = document.createElement(\"textarea\");\n      ta.value = text; document.body.appendChild(ta); ta.select();\n      try { document.execCommand(\"copy\"); toast(\"链接已复制\"); } catch(e2){ toast(\"复制失败\"); }\n      document.body.removeChild(ta);\n    }\n  });\n\n  $(\"clear\").addEventListener(\"click\", function(){\n    writeHist([]); renderHist(); toast(\"记录已清空\");\n  });\n\n  document.addEventListener(\"keydown\", function(e){\n    if (e.key === \"/\" && document.activeElement !== q){\n      e.preventDefault(); q.focus();\n    }\n  });\n\n  /* ---------- 状态 ---------- */\n  function checkStatus(){\n    var t0 = performance.now();\n    fetch(\"/health\", { cache: \"no-store\" })\n      .then(function(r){ return r.json(); })\n      .then(function(){\n        var ms = Math.round(performance.now() - t0);\n        $(\"dot\").classList.remove(\"off\");\n        $(\"status\").textContent = \"在线 · \" + ms + \"ms\";\n      })\n      .catch(function(){\n        $(\"dot\").classList.add(\"off\");\n        $(\"status\").textContent = \"连接异常\";\n      });\n  }\n\n  fetch(\"/api/info\", { cache: \"no-store\" })\n    .then(function(r){ return r.json(); })\n    .then(function(info){\n      var lead = $(\"lead\");\n      lead.textContent = info.proxyHost + \"/\";\n      lead.dataset.host = info.proxyHost;\n      lead.title = \"本站代理入口：\" + location.origin + \"/\";\n    })\n    .catch(function(){ $(\"lead\").textContent = location.host + \"/\"; });\n\n  $(\"year\").textContent = new Date().getFullYear();\n  renderQuick();\n  renderHist();\n  checkStatus();\n  q.focus();\n})();\n</script>\n</body>\n</html>\n";

const TAG_LIST = "a|area|img|link|script|iframe|frame|video|audio|source|embed|object|form";
const ATTR_LIST = "href|src|srcset|poster|data|action";

/** 不转发的逐跳 / Cloudflare 内部头 */
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "host", "content-length", "accept-encoding",
  "cf-connecting-ip", "cf-ray", "cf-ipcountry", "cf-visitor", "cf-worker",
  "cdn-loop", "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  "x-forwarded-host", "true-client-ip",
]);

const STYLE_ERROR = `
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:radial-gradient(1200px 600px at 50% -10%,#2a1b4d,#0d0a17 60%);color:#e8e3ff;
font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.box{max-width:560px;padding:40px 36px;border-radius:20px;background:rgba(30,22,54,.82);
border:1px solid rgba(160,130,255,.25);box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{margin:0 0 12px;font-size:22px;letter-spacing:.5px}
p{margin:0 0 8px;color:#b8aff0;line-height:1.7;font-size:14px}
code{display:block;margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,.35);
color:#c9bfff;font-size:13px;word-break:break-all}
a{display:inline-block;margin-top:22px;color:#c4b5fd;text-decoration:none;border-bottom:1px solid rgba(196,181,253,.5)}
`;

/* ============================ 小工具 ============================ */

/** 把相对地址补成绝对地址；实在补不出来返回 null */
function absUrl(rel, base) {
  const v = String(rel == null ? "" : rel).trim();
  if (!v) return base || null;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(v)) return v;      // 已带协议
  if (v.startsWith("//")) return "https:" + v;
  try {
    return new URL(v, base).href;
  } catch (e) {
    return null;
  }
}

/** 把目标站的一个地址改写成「本站路径」形式 */
function rewriteUrl(value, host, base = "") {
  const raw = String(value == null ? "" : value);
  const v = raw.trim();
  if (!v) return raw;
  if (/^(data:|javascript:|mailto:|tel:|blob:|about:|#)/i.test(v)) return v;

  if (v.startsWith("//")) return rewriteUrl("https:" + v, host, base);

  if (/^https?:/i.test(v)) {
    let u;
    try {
      u = new URL(v);
    } catch (e) {
      return v;
    }
    let out = "/" + u.hostname.toLowerCase();
    if (u.port && u.port !== "80" && u.port !== "443") out += ":" + u.port;
    out += u.pathname || "/";
    if (u.search) out += u.search;
    if (u.hash) out += u.hash;
    return out;
  }

  if (v[0] === "/") return "/" + host + v;

  // 相对路径：先按所在页面地址补全，再改写，避免子目录页面资源错位
  if (base) {
    const abs = absUrl(v, base);
    if (abs && /^https?:\/\//i.test(abs)) return rewriteUrl(abs, host);
  }
  return "/" + host + "/" + v.replace(/^\.\//, "");
}

/** CSS 里的 url() 与 @import */
function rewriteCss(css, host, base) {
  let out = String(css).replace(/url\(\s*(['"]?)([^)'"]+?)\1\s*\)/gi, (m, q, raw) => {
    if (/^(data:|#|about:)/i.test(raw)) return m;
    const abs = absUrl(raw, base);
    if (!abs) return m;
    return "url(" + q + rewriteUrl(abs, host) + q + ")";
  });
  out = out.replace(/@import\s+(?:url\()?(['"])([^'"]+)\1\s*\)?/gi, (m, q, raw) => {
    const abs = absUrl(raw, base);
    return "@import url(" + q + (abs ? rewriteUrl(abs, host) : raw) + q + ")";
  });
  return out;
}

const TAG_RE = new RegExp("<(" + TAG_LIST + ")\\b[^>]*>", "gi");
const ATTR_QUOTED_RE = new RegExp("(\\s)(" + ATTR_LIST + ")\\s*=\\s*([\"'])([\\s\\S]*?)\\3", "gi");
const ATTR_BARE_RE = new RegExp("(\\s)(" + ATTR_LIST + ")\\s*=\\s*([^\"'\\s>]+)", "gi");

/** 改写 `0; url=/xxx` 这类 refresh 值，其余原样返回 */
function rewriteRefresh(val, host, base) {
  return String(val).replace(/(url\s*=\s*)(['"]?)([^'";\s]+)\2?/gi, (m, pre, q, u) => {
    const next = rewriteUrl(u, host, base);
    return pre + q + next + q;
  });
}

/** 改写整段 HTML */
function rewriteHtml(html, host, base) {
  const fixAttr = (attrName, val) => {
    if (attrName.toLowerCase() === "srcset") {
      return val
        .split(",")
        .map((part) => {
          const p = part.trim();
          if (!p) return "";
          const bits = p.split(/\s+/);
          bits[0] = rewriteUrl(bits[0], host, base);
          return bits.join(" ");
        })
        .join(", ");
    }
    return rewriteUrl(val, host, base);
  };

  // 1) 带引号的属性
  let out = String(html).replace(TAG_RE, (tag) =>
    tag.replace(ATTR_QUOTED_RE, (m, sp, name, q, val) => sp + name + "=" + q + fixAttr(name, val) + q)
  );

  // 1b) 没引号的属性，如 href=/path
  out = out.replace(TAG_RE, (tag) =>
    tag.replace(ATTR_BARE_RE, (m, sp, name, val) => sp + name + "=" + rewriteUrl(val, host, base))
  );

  // 1c) 去掉 SRI：我们改过内容，浏览器按 integrity 会直接拒载
  out = out.replace(/(\s)integrity\s*=\s*(["'])[^"']*\2/gi, "");

  // 2) <style> 块
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) =>
    a + rewriteCss(css, host, base) + b
  );

  // 3) 内联 style
  out = out.replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (m, pre, q, css) =>
    css.indexOf("url(") === -1 ? m : pre + q + rewriteCss(css, host, base) + q
  );

  // 4) <meta http-equiv="refresh" content="0;url=/xxx"> —— 也是一种「把浏览器带走」的跳转
  out = out.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!/http-equiv\s*=\s*["']?refresh["']?/i.test(tag)) return tag;
    return tag.replace(/(content\s*=\s*)(["'])([\s\S]*?)\2/i, (m, pre, q, val) =>
      pre + q + rewriteRefresh(val, host, base) + q
    );
  });

  return out;
}

/** 取一个 cookie 的值 */
function cookieValue(header, name) {
  if (!header) return "";
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        return part.slice(i + 1).trim();
      }
    }
  }
  return "";
}

/** 把「本站地址」翻译回目标站地址（用于 Referer） */
function translateFront(ref, proxyHost) {
  if (!ref) return "";
  let s = String(ref).replace(/^https?:\/\//i, "");
  const idx = s.indexOf(proxyHost);
  let tail = idx !== -1 ? s.slice(idx + proxyHost.length) : "";
  tail = tail.replace(/^\/+/, "");
  if (!tail) return "";
  const firstStop = tail.search(/[/?#]/);
  const host = (firstStop === -1 ? tail : tail.slice(0, firstStop)).toLowerCase();
  if (!/^[a-z0-9.\-]+\.[a-z]{2,}$/.test(host)) return "";
  const rest = firstStop === -1 ? "" : tail.slice(firstStop);
  return "https://" + host + (rest || "/");
}

/* ============================ 输出 ============================ */

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorPage(title, detail, status = 502, host = "") {
  const back = host ? `https://${host}/` : "/";
  return htmlResponse(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${STYLE_ERROR}</style></head><body>
<div class="box"><h1>${title}</h1><p>${detail}</p><code>${back}</code>
<a href="${back}">← 回到控制台</a></div></body></html>`,
    status
  );
}

/* ============================ 主逻辑 ============================ */

const HOST_RE = /^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$/i;

async function handle(request) {
  const url = new URL(request.url);
  const proxyHost = url.host.toLowerCase();
  const path = url.pathname;

  // ---- 本站自身路由 ----
  if (path === "/" || path === "/index.html") return htmlResponse(UI_HTML);
  if (path === "/api/info") {
    return jsonResponse({
      proxyHost,
      scheme: url.protocol.replace(":", ""),
      engine: "cloudflare-worker",
    });
  }
  if (path === "/health") {
    return jsonResponse({ ok: true, engine: "cloudflare-worker", time: Date.now() });
  }
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (path === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // ---- 解析目标：第一段必须是域名 ----
  let raw = path.slice(1);
  const slash = raw.indexOf("/");
  const hostSeg = slash === -1 ? raw : raw.slice(0, slash);
  let host = hostSeg.toLowerCase();
  try {
    host = decodeURIComponent(hostSeg).toLowerCase();
  } catch (e) { /* 保留原值 */ }

  let pathQuery = slash === -1 ? "/" + url.search : raw.slice(slash) + url.search;

  if (!HOST_RE.test(host) || host === proxyHost) {
    // 兜底：页面里的 JS 直接改 location 跳到 /search?q=… 这类地址时，第一段不是域名。
    // 借 Referer 上的目标域名 + 当前请求路径，仍能正确代理（例如 GitHub 搜索框）
    const refUrl = translateFront(request.headers.get("referer") || "", proxyHost);
    let refHost = (refUrl.replace(/^https:\/\//i, "").split(/[/?#]/)[0] || "").toLowerCase();

    // 连 Referer 也没有（referrer-policy: no-referrer、或从书签打开）：
    // 用上一次成功代理 HTML 时写下的 __rp_host cookie 认人
    if (!refHost) {
      const ck = cookieValue(request.headers.get("cookie") || "", "__rp_host").toLowerCase();
      if (/^[a-z0-9.\-]+\.[a-z]{2,}$/.test(ck)) refHost = ck;
    }

    if (!refHost || !HOST_RE.test(refHost) || refHost === proxyHost) {
      return errorPage(
        "这个地址没法代理",
        "URL 需要是 <b>域名/路径</b> 的形式，且域名要带小数点。例如 /developer.mozilla.org/zh-CN/。",
        400,
        proxyHost
      );
    }

    host = refHost;
    pathQuery = (path.startsWith("/") ? path : "/" + path) + url.search;

    // 302 到 /域名/路径，让地址栏重新带上目标站；否则后续点击的相对地址会再次解析失败
    if (request.method === "GET" || request.method === "HEAD") {
      return Response.redirect(`https://${proxyHost}/${host}${pathQuery}`, 302);
    }
  } else if (slash === -1) {
    // 没有结尾斜杠时补一个，否则页面里的相对路径会错位到站点根
    return Response.redirect(`https://${proxyHost}/${host}/${url.search}`, 302);
  }

  const target = `https://${host}${pathQuery}`;

  // ---- 构造发给目标站的请求头 ----
  const fwd = new Headers();
  request.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_HEADERS.has(lk) || lk === "referer" || lk === "origin" || lk === "cookie") return;
    fwd.set(k, v);
  });
  if (!fwd.has("user-agent")) {
    fwd.set("user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
  }
  // Cookie 里可能混着本站自己的键（如未登录态），仍然透传，保持目标站会话
  const cookie = request.headers.get("cookie");
  if (cookie) fwd.set("cookie", cookie);

  // Referer / Origin 翻译成目标站自己的地址
  const tRef = translateFront(request.headers.get("referer") || "", proxyHost);
  if (tRef) fwd.set("referer", tRef);
  const originIn = (request.headers.get("origin") || "").replace(/^https:\/\//i, "").replace(/^http:\/\//i, "").replace(/\/$/, "");
  if (originIn && originIn.toLowerCase() === proxyHost) fwd.set("origin", `https://${host}`);

  // ---- 请求上游 ----
  const init = { method: request.method, headers: fwd, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    // https 打不通就试 http（老站点常见）
    try {
      upstream = await fetch(`http://${host}${pathQuery}`, init);
    } catch (e2) {
      return errorPage("上游站连不上", `请求 <b>${host}</b> 失败：${e2.message || e2}`, 502, proxyHost);
    }
  }

  // ---- 组装响应头 ----
  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_HEADERS.has(lk)) return;
    if (lk === "set-cookie" || lk === "location") return;
    if (lk.startsWith("content-security-policy")) return;
    if (lk === "x-content-type-options" || lk === "content-encoding") return;
    out.set(k, v);
  });

  // Cookie：去掉 Domain= 才能落到本站域名（否则登录态丢失、反复跳登录）
  let cookies = [];
  if (typeof upstream.headers.getSetCookie === "function") cookies = upstream.headers.getSetCookie();
  else {
    const raw = upstream.headers.get("set-cookie");
    if (raw) cookies = [raw];
  }
  if (cookies.length) {
    out.delete("set-cookie");
    for (const c of cookies) out.append("set-cookie", String(c).replace(/;\s*domain=[^;]*/gi, ""));
  }

  // 跳转：改写成本站路径，交回浏览器再走一次代理
  const loc = upstream.headers.get("location");
  if (loc) {
    const abs = absUrl(loc, target) || loc;
    out.set("location", rewriteUrl(abs, host, target) || loc);
  }

  // Refresh 响应头同样是跳转（0;url=https://...），一并改写
  const refresh = upstream.headers.get("refresh");
  if (refresh) out.set("refresh", rewriteRefresh(refresh, host, target));

  const status = upstream.status;
  if (status === 204 || status === 304 || status === 205) {
    return new Response(null, { status, headers: out });
  }

  const ctype = upstream.headers.get("content-type") || "";
  const isCss = /text\/css/i.test(ctype);
  const isJsButCss = /text\/javascript/i.test(ctype) &&
    ((request.headers.get("accept") || "").indexOf("text/css") !== -1);
  const isHtml = /text\/html|application\/xhtml/i.test(ctype);

  if (isCss || isJsButCss || isHtml) {
    const text = await upstream.text();
    out.delete("content-length");
    if (isCss) {
      out.set("content-type", "text/css; charset=utf-8");
      return new Response(rewriteCss(text, host, target), { status, headers: out });
    }
    if (isJsButCss) {
      out.set("content-type", ctype.replace("text/javascript", "text/css"));
      return new Response(rewriteCss(text, host, target), { status, headers: out });
    }
    // 记下"当前在镜像哪个站"：页面 JS 把地址改成无域名路径、浏览器又不送 Referer 时靠它兜底
    out.append("set-cookie", `__rp_host=${encodeURIComponent(host)}; Path=/; Max-Age=3600; SameSite=Lax`);
    return new Response(rewriteHtml(text, host, target), { status, headers: out });
  }

  if (request.method === "HEAD") return new Response(null, { status, headers: out });
  return new Response(upstream.body, { status, headers: out });
}

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (e) {
      return errorPage("代理内部出错", String((e && e.message) || e), 502, new URL(request.url).host);
    }
  },
};
