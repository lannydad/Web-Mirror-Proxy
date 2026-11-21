/**
 * reverse-proxy-cf 的 Node 版（宝塔可部署）+ 自带前端控制台
 * ---------------------------------------------------------
 * 路由：
 *   GET  /                前端控制台（ui.html）
 *   GET  /api/info        返回本站域名等配置，供前端拼链接
 *   GET  /health          健康检查（JSON）
 *   ANY  /目标域名/路径    反向代理（例如 /developer.mozilla.org/zh-CN/）
 *
 * 环境变量：
 *   PORT        监听端口，默认 3000
 *   PROXY_HOST  本站对外域名（不带协议、不带斜杠），默认 127.0.0.1:3000
 *   HTTPS_ONLY  设为 1 时生成的链接强制 https://，否则用协议相对 //host
 */

import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const PROXY_HOST = String(process.env.PROXY_HOST || `127.0.0.1:${PORT}`)
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");
const HTTPS_ONLY = process.env.HTTPS_ONLY === "1";
const SCHEME = HTTPS_ONLY ? "https:" : "";
const SITE_PREFIX = `${SCHEME}//${PROXY_HOST}`;

const UI_PATH = path.join(__dirname, "ui.html");
let UI_HTML = "";
try {
  UI_HTML = fs.readFileSync(UI_PATH, "utf8");
} catch {
  UI_HTML = "<h1>ui.html 缺失</h1><p>请把 ui.html 放在 server.js 同目录下。</p>";
}

/** 需要改写的标签属性 */
const ATTR_MAP = {
  a: ["href"],
  area: ["href"],
  img: ["src", "srcset"],
  link: ["href"],
  script: ["src"],
  iframe: ["src"],
  frame: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  source: ["src", "srcset"],
  embed: ["src"],
  object: ["data"],
};

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "accept-encoding",
]);

/** 把页面里的一个链接改写回本站 */
function rewriteUrl(value, targetHost, baseUrl) {
  if (!value) return value;
  const v = String(value).trim();
  if (!v) return value;
  if (/^(data:|javascript:|mailto:|tel:|blob:|about:|#)/i.test(v)) return value;
  if (v.startsWith("//")) return `${SCHEME}//${PROXY_HOST}/${v.slice(2)}`;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return `${SITE_PREFIX}/${u.host}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return value;
    }
  }
  if (v.startsWith("/")) return `/${targetHost}${v}`;
  // 相对路径：先按所在页面地址解析成绝对地址，再改写，避免子目录页面资源错位
  if (baseUrl) {
    try {
      return rewriteUrl(new URL(v, baseUrl).toString(), targetHost);
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return `/${targetHost}/${v.replace(/^\.\//, "")}`;
}

/** 改写 CSS 里的 url() 与 @import */
function rewriteCss(text, targetHost, baseUrl) {
  const fix = (u) => {
    const t = u.trim().replace(/^['"]|['"]$/g, "");
    if (!t || /^(data:|#|about:)/i.test(t)) return u;
    if (/^https?:\/\//i.test(t) || t.startsWith("//")) return rewriteUrl(t, targetHost);
    try {
      const abs = new URL(t, baseUrl).toString();
      return rewriteUrl(abs, targetHost);
    } catch {
      return u;
    }
  };
  return text
    .replace(/url\(\s*([^)]+?)\s*\)/gi, (m, u) => `url(${fix(u)})`)
    .replace(
      /@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?/gi,
      (m, q, u) => `@import url(${q}${fix(u)}${q})`
    );
}

/** 改写 HTML 文档 */
function rewriteHtml(text, targetHost, baseUrl) {
  const $ = cheerio.load(text, { decodeEntities: false });

  for (const [tag, attrs] of Object.entries(ATTR_MAP)) {
    $(tag).each((_, el) => {
      for (const attr of attrs) {
        const val = $(el).attr(attr);
        if (!val) continue;
        if (attr === "srcset") {
          $(el).attr(
            attr,
            val
              .split(",")
              .map((part) => {
                const p = part.trim();
                const [url, ...rest] = p.split(/\s+/);
                if (!url) return part;
                return [rewriteUrl(url, targetHost, baseUrl), ...rest].join(" ");
              })
              .join(", ")
          );
        } else {
          $(el).attr(attr, rewriteUrl(val, targetHost, baseUrl));
        }
      }
    });
  }

  // 我们自己改写过内容，SRI 校验会让浏览器直接拒绝加载
  $("[integrity]").removeAttr("integrity");

  $("style").each((_, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css, targetHost, baseUrl));
  });
  $("[style]").each((_, el) => {
    const s = $(el).attr("style");
    if (s && s.includes("url(")) $(el).attr("style", rewriteCss(s, targetHost, baseUrl));
  });

  // <meta http-equiv="refresh" content="0;url=/xxx">：另一种把浏览器带走的跳转
  $('meta[http-equiv]').each((_, el) => {
    const eq = ($(el).attr("http-equiv") || "").toLowerCase();
    if (eq !== "refresh") return;
    const c = $(el).attr("content");
    if (c) $(el).attr("content", rewriteRefresh(c, targetHost, baseUrl));
  });

  return $.html();
}

/** 改写 `0; url=/xxx` 这类 refresh 值 */
function rewriteRefresh(val, targetHost, baseUrl) {
  return String(val).replace(/(url\s*=\s*)(['"]?)([^'";\s]+)\2?/gi, (m, pre, q, u) =>
    pre + q + rewriteUrl(u, targetHost, baseUrl) + q
  );
}

/** 把「本站地址」翻译回目标站地址（用于 Referer） */
function translateFront(ref) {
  if (!ref) return "";
  const s = String(ref).replace(/^https?:\/\//i, "");
  const idx = s.indexOf(PROXY_HOST);
  let tail = idx !== -1 ? s.slice(idx + PROXY_HOST.length) : "";
  tail = tail.replace(/^\/+/, "");
  if (!tail) return "";
  const cut = strcspn(tail, "/?#");
  const host = tail.slice(0, cut).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return "";
  const rest = cut === Number.MAX_SAFE_INTEGER ? "" : tail.slice(cut);
  return `https://${host}${rest || "/"}`;
}

/** 从一个地址里抠出 { host, path }；第一段不是域名就返回 null */
function targetFrom(raw0) {
  let raw = String(raw0 || "").replace(/^https?:\/\//i, "");
  const idx = raw.indexOf(PROXY_HOST);
  let tail = idx !== -1 ? raw.slice(idx + PROXY_HOST.length) : raw;
  tail = tail.replace(/^\/+/, "");
  if (!tail) return null;

  const cut = strcspn(tail, "/?#");
  const host = tail.slice(0, cut).replace(/\.+$/, "").toLowerCase();
  let p = cut === Number.MAX_SAFE_INTEGER ? "/" : tail.slice(cut);
  if (!p.startsWith("/")) p = "/" + p;
  if (p === "/?" || p === "/#") p = "/";

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  if (host === PROXY_HOST) return null;
  return { host, path: p };
}

/** 从请求中解析出真实目标：host + path */
function parseTarget(req) {
  // 1) 常规：请求路径的第一段就是目标域名
  const t = targetFrom(req.url || "/");
  if (t) return t;

  // 2) 兜底：页面里的 JS 直接改 location（如 GitHub 搜索框跳到 /search?q=…），
  //    第一段不是域名，就用 Referer 里的目标站 + 当前请求的路径拼回真实目标
  const rt = req.headers.referer ? targetFrom(req.headers.referer) : null;
  if (!rt) {
    // 连 Referer 也没有（referrer-policy: no-referrer、或从书签直接打开）：
    // 用上一次成功代理 HTML 时写下的 __rp_host cookie 认人
    const ck = cookieValue(req.headers.cookie, "__rp_host");
    if (!ck) return null;
    const h = ck.toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) || h === PROXY_HOST) return null;
    const url = String(req.url || "/");
    const qi = url.indexOf("?");
    const p = qi === -1 ? url : url.slice(0, qi);
    const q = qi === -1 ? "" : url.slice(qi);
    return { host: h, path: "/" + p.replace(/^\/+/, "") + q, viaReferer: true };
  }

  const url = String(req.url || "/");
  const qi = url.indexOf("?");
  const p = qi === -1 ? url : url.slice(0, qi);
  const q = qi === -1 ? "" : url.slice(qi);
  return { host: rt.host, path: "/" + p.replace(/^\/+/, "") + q, viaReferer: true };
}

/** 取一个 cookie 的值 */
function cookieValue(header, name) {
  if (!header) return "";
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/** 返回第一个 / ? # 的位置，没有则返回一个大数 */
function strcspn(s, chars) {
  for (let i = 0; i < s.length; i++) if (chars.includes(s[i])) return i;
  return Number.MAX_SAFE_INTEGER;
}

/** 错误页：比原来的纯文本友好一些，并带上返回入口 */
function errorPage(title, detail, target) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:radial-gradient(1200px 600px at 20% -10%,#2a1a5e 0%,#0b0a10 55%) fixed,#0b0a10;
color:#eceaf5;font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(620px,100%);padding:38px 36px;border-radius:20px;background:rgba(255,255,255,.045);
border:1px solid rgba(255,255,255,.09);box-shadow:0 24px 70px rgba(0,0,0,.55)}
h1{margin:0 0 10px;font-size:19px;font-weight:600}
p{margin:0 0 18px;color:#9aa0b8;font-size:14px}
code{display:block;padding:12px 14px;margin:0 0 22px;border-radius:10px;background:rgba(0,0,0,.35);
border:1px solid rgba(255,255,255,.07);font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#b9a7ff;word-break:break-all}
a{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:10px;text-decoration:none;
color:#fff;background:linear-gradient(135deg,#7c5cff,#a855f7);font-weight:600;font-size:14px}
</style></head><body><div class="card">
<h1>${title}</h1><p>${detail}</p>
${target ? `<code>${target}</code>` : ""}
<a href="/">← 回到控制台</a>
</div></body></html>`;
}

function send(res, status, type, body, extra) {
  const headers = { "content-type": type, "content-length": String(Buffer.byteLength(body)) };
  res.writeHead(status, Object.assign(headers, extra || {}));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const rawUrl = req.url || "/";
    const p = decodeURIComponent(rawUrl.split("?")[0]);

    // ---------- 前端 / 接口 ----------
    if (p === "/") return send(res, 200, "text/html; charset=utf-8", UI_HTML);
    if (p === "/health") {
      return send(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), proxyHost: PROXY_HOST })
      );
    }
    if (p === "/api/info") {
      return send(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ proxyHost: PROXY_HOST, scheme: HTTPS_ONLY ? "https" : "", port: PORT })
      );
    }
    if (p === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    // ---------- 代理 ----------
    const parsed = parseTarget(req);
    if (!parsed) {
      return send(
        res,
        400,
        "text/html; charset=utf-8",
        errorPage(
          "这个地址没法代理",
          "URL 需要是 <code>域名/路径</code> 的形式，且域名要带小数点。例如 <code>/developer.mozilla.org/zh-CN/</code>。",
          "你请求的是：" + rawUrl
        )
      );
    }

    const { host, path: targetPath, viaReferer } = parsed;

    // 原始 URL 里没有目标域名（JS 直接跳到 /search?q= 这类）：302 到 /域名/路径，
    // 让地址栏重新带上目标站，否则后续点击的相对地址会再次解析失败
    if (viaReferer && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(302, { location: `/${host}${targetPath}`, "cache-control": "no-store" });
      return res.end();
    }

    const target = `https://${host}${targetPath}`;

    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(k)) continue;
      if (k === "referer" || k === "origin") continue; // 后面单独翻译
      fwd[k] = v;
    }
    fwd["accept-encoding"] = "identity";
    if (!fwd["user-agent"]) {
      fwd["user-agent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    }

    // 让目标站看到的 Referer / Origin 都是它自己的地址
    const tRef = translateFront(req.headers.referer);
    if (tRef) fwd["referer"] = tRef;
    if (String(req.headers.origin || "").replace(/^https?:\/\//i, "") === PROXY_HOST) {
      fwd["origin"] = `https://${host}`;
    }

    let body;
    if (!["GET", "HEAD"].includes(req.method || "GET")) {
      body = Buffer.from(await readBody(req));
    }

    const upstream = await fetch(target, {
      method: req.method === "HEAD" ? "GET" : req.method,
      headers: fwd,
      body,
      redirect: "manual", // 3xx 交回浏览器，由我们改写后的 Location 再走一次代理
      duplex: body ? "half" : undefined,
    });

    let buf = Buffer.from(await upstream.arrayBuffer());

    const enc = String(upstream.headers.get("content-encoding") || "").toLowerCase();
    try {
      if (enc === "gzip") buf = zlib.gunzipSync(buf);
      else if (enc === "deflate") buf = zlib.inflateSync(buf);
      else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
    } catch {
      /* 解不开就原样透传 */
    }

    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (HOP_HEADERS.has(k)) return;
      if (k === "set-cookie") return;
      if (k === "content-security-policy") return;
      if (k === "location") return;
      outHeaders[key] = value;
    });

    const setCookie = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
    // 去掉 Domain=：目标站 cookie 必须落到本站域名，否则浏览器丢弃（表现为反复跳登录）
    if (setCookie.length) outHeaders["set-cookie"] = setCookie.map((c) => c.replace(/;\s*domain=[^;]*/i, ""));

    const location = upstream.headers.get("location");
    if (location) outHeaders["location"] = rewriteUrl(location, host, target) || location;

    // Refresh 响应头同样是跳转（0;url=https://...），一并改写
    const refresh = upstream.headers.get("refresh");
    if (refresh) outHeaders["refresh"] = rewriteRefresh(refresh, host, target);

    const ctype = String(upstream.headers.get("content-type") || "");
    const isHtml = /text\/html|application\/xhtml/i.test(ctype);
    const isCss = /text\/css/i.test(ctype);
    const isJsButCss = /text\/javascript/i.test(ctype) && String(req.headers.accept || "").includes("text/css");

    let outBuf = buf;
    if (isCss) {
      outHeaders["content-type"] = "text/css; charset=utf-8";
      outBuf = Buffer.from(rewriteCss(buf.toString("utf8"), host, target), "utf8");
    } else if (isJsButCss) {
      outHeaders["content-type"] = ctype.replace("text/javascript", "text/css");
      outBuf = Buffer.from(rewriteCss(buf.toString("utf8"), host, target), "utf8");
    } else if (isHtml) {
      outBuf = Buffer.from(rewriteHtml(buf.toString("utf8"), host, target), "utf8");
      if (!outHeaders["content-type"]) outHeaders["content-type"] = "text/html; charset=utf-8";
      // 记下"当前在镜像哪个站"，页面 JS 把地址改成无域名路径时用它兜底
      const mine = "__rp_host=" + encodeURIComponent(host) + "; Path=/; Max-Age=3600; SameSite=Lax";
      outHeaders["set-cookie"] = Array.isArray(outHeaders["set-cookie"])
        ? outHeaders["set-cookie"].concat(mine)
        : [mine];
    } else if (ctype) {
      outHeaders["content-type"] = ctype;
    }

    outHeaders["content-length"] = String(outBuf.length);
    outHeaders["cache-control"] = outHeaders["cache-control"] || "no-store";

    res.writeHead(upstream.status, outHeaders);
    res.end(req.method === "HEAD" ? undefined : outBuf);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!res.headersSent) {
      send(
        res,
        502,
        "text/html; charset=utf-8",
        errorPage("目标站点没连上", "可能是对方限制、超时，或者这个站点不是 HTTPS。错误信息：<br>" + escapeHtml(msg))
      );
    } else {
      res.end();
    }
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`reverse-proxy-node 已启动：http://0.0.0.0:${PORT}  对外域名 PROXY_HOST=${PROXY_HOST}`);
});
