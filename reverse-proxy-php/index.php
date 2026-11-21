<?php
declare(strict_types=1);

/**
 * reverse-proxy-cf 的 PHP 版（宝塔 / 任何 PHP 主机可直接部署）
 * ---------------------------------------------------------
 * 路由：
 *   /                前端控制台（ui.html）
 *   /api/info        JSON，返回本站域名，供前端拼链接
 *   /health          JSON，健康检查
 *   /目标域名/路径    反向代理，例如 /developer.mozilla.org/zh-CN/
 *
 * 要求：PHP >= 7.4，开启 curl / mbstring / zlib
 * 环境变量（宝塔站点可在「网站 → 站点设置」里加，或直接改下面的默认值）
 *   PROXY_HOST  本站对外域名，缺省自动取当前 Host
 *   HTTPS_ONLY  设为 1 时生成的链接强制 https://，否则用协议相对 //host
 */

error_reporting(E_ALL & ~E_NOTICE & ~E_DEPRECATED & ~E_WARNING);
@ini_set('display_errors', '0');
@ini_set('zlib.output_compression', '0');
@set_time_limit(60);

/* ---------- 基础配置 ---------- */
$proxyHost = trim((string) (getenv('PROXY_HOST') ?: ($_SERVER['HTTP_HOST'] ?? '127.0.0.1')));
$proxyHost = preg_replace('#^https?://#i', '', $proxyHost);
$proxyHost = rtrim(strtolower($proxyHost), '/');
$httpsOnly  = getenv('HTTPS_ONLY') === '1';

define('PROXY_HOST', $proxyHost);
define('SITE_PREFIX', ($httpsOnly ? 'https:' : '') . '//' . PROXY_HOST);
define('UI_FILE', __DIR__ . '/ui.html');

$TAG_LIST = 'a|area|img|link|script|iframe|frame|video|audio|source|embed|object|form';
$ATTR_LIST = 'href|src|srcset|poster|data|action';

/* ---------- 一个小工具：把相对地址补成绝对地址 ---------- */
function abs_url(string $rel, string $base): ?string
{
    if ($rel === '') return $base;
    if (preg_match('~^[a-z][a-z0-9+.\-]*:~i', $rel)) return $rel;      // 已经带协议
    if (strpos($rel, '//') === 0) return 'https:' . $rel;

    $b = parse_url($base);
    if (!$b || empty($b['host'])) return null;
    $origin = ($b['scheme'] ?? 'https') . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');
    $bpath = $b['path'] ?? '/';

    if ($rel[0] === '?') return $origin . $bpath . $rel;
    if ($rel[0] === '#') return $origin . $bpath . (isset($b['query']) ? '?' . $b['query'] : '') . $rel;
    if ($rel[0] === '/') return $origin . $rel;

    $dir = preg_replace('~[^/]*$~', '', $bpath);
    $out = [];
    foreach (explode('/', $dir . $rel) as $seg) {
        if ($seg === '.' || $seg === '') continue;
        if ($seg === '..') { array_pop($out); continue; }
        $out[] = $seg;
    }
    return $origin . '/' . implode('/', $out);
}

/* ---------- 把页面里的一个链接改写回本站 ---------- */
function rewrite_url($value, string $host, string $base = ''): string
{
    $v = trim((string) $value);
    if ($v === '') return (string) $value;
    if (preg_match('~^(data:|javascript:|mailto:|tel:|blob:|about:|#)~i', $v)) return $v;

    if (strpos($v, '//') === 0) return SITE_PREFIX . '/' . substr($v, 2);

    if (preg_match('~^https?://~i', $v)) {
        $p = parse_url($v);
        if (!$p || empty($p['host'])) return $v;
        $out = SITE_PREFIX . '/' . strtolower($p['host']);
        if (!empty($p['port']) && $p['port'] !== 80 && $p['port'] !== 443) {
            $out .= ':' . $p['port'];   // 端口形式本服务不接受，交给上游 404，保持可读
        }
        $out .= $p['path'] ?? '/';
        if (isset($p['query'])) $out .= '?' . $p['query'];
        if (isset($p['fragment'])) $out .= '#' . $p['fragment'];
        return $out;
    }

    if ($v[0] === '/') return '/' . $host . $v;

    // 相对路径：先按所在页面地址解析成绝对地址，再改写，避免子目录页面资源错位
    if ($base !== '') {
        $abs = abs_url($v, $base);
        if ($abs !== null && preg_match('~^https?://~i', $abs)) return rewrite_url($abs, $host);
    }
    return '/' . $host . '/' . preg_replace('~^\./~', '', $v);
}

/* ---------- CSS 里的 url() 与 @import ---------- */
function rewrite_css(string $css, string $host, string $base): string
{
    $css = preg_replace_callback(
        '~url\(\s*([\'"]?)([^)\'"]+?)\1\s*\)~i',
        function ($m) use ($host, $base) {
            $raw = $m[2];
            if (preg_match('~^(data:|#|about:)~i', $raw)) return $m[0];
            $abs = abs_url(trim($raw), $base);
            if ($abs === null) return $m[0];
            return 'url(' . $m[1] . rewrite_url($abs, $host) . $m[1] . ')';
        },
        $css
    );

    return preg_replace_callback(
        '~@import\s+(?:url\()?\s*([\'"])([^\'"]+)\1\s*\)?~i',
        function ($m) use ($host, $base) {
            $abs = abs_url($m[2], $base);
            return '@import url(' . $m[1] . ($abs === null ? $m[2] : rewrite_url($abs, $host)) . $m[1] . ')';
        },
        $css
    );
}

/* ---------- meta refresh / Refresh 头里的 0;url=... ---------- */
function rewrite_refresh(string $val, string $host, string $base): string
{
    return preg_replace_callback(
        '~(url\s*=\s*)([\'"]?)([^\'";\s]+)\2?~i',
        function ($m) use ($host, $base) {
            return $m[1] . $m[2] . rewrite_url($m[3], $host, $base) . $m[2];
        },
        $val
    );
}

/* ---------- 改写 HTML 文档 ---------- */
function rewrite_html(string $html, string $host, string $base): string
{
    global $TAG_LIST, $ATTR_LIST;

    // 1) 带引号的标签属性
    $html = preg_replace_callback(
        '~<(' . $TAG_LIST . ')\b[^>]*>~i',
        function ($tag) use ($host, $base) {
            global $ATTR_LIST;
            return preg_replace_callback(
                '~(\s)(' . $ATTR_LIST . ')\s*=\s*(["\'])(.*?)\3~is',
                function ($a) use ($host, $base) {
                    $attr = strtolower($a[2]);
                    $val  = $a[4];
                    if ($attr === 'srcset') {
                        $val = implode(', ', array_map(function ($part) use ($host, $base) {
                            $part = trim($part);
                            if ($part === '') return '';
                            $bits = preg_split('~\s+~', $part, 2);
                            $bits[0] = rewrite_url($bits[0], $host, $base);
                            return implode(' ', $bits);
                        }, explode(',', $val)));
                    } else {
                        $val = rewrite_url($val, $host, $base);
                    }
                    return $a[1] . $a[2] . '=' . $a[3] . $val . $a[3];
                },
                $tag[0]
            );
        },
        $html
    );

    // 1b) 没有引号的属性，例如 href=/path
    $html = preg_replace_callback(
        '~<(' . $TAG_LIST . ')\b[^>]*>~i',
        function ($tag) use ($host, $base) {
            global $ATTR_LIST;
            return preg_replace_callback(
                '~(\s)(' . $ATTR_LIST . ')\s*=\s*([^"\'\s>]+)~i',
                function ($a) use ($host, $base) {
                    return $a[1] . $a[2] . '=' . rewrite_url($a[3], $host, $base);
                },
                $tag[0]
            );
        },
        $html
    );

    // 1c) 去掉 SRI 校验：我们自己改写过内容，浏览器按 integrity 校验会直接拒绝加载
    $html = preg_replace('~(\s)integrity\s*=\s*(["\'])[^"\']*\2~is', '', $html);

    // 2) <style> 块
    $html = preg_replace_callback(
        '~(<style\b[^>]*>)(.*?)(</style>)~is',
        function ($m) use ($host, $base) {
            return $m[1] . rewrite_css($m[2], $host, $base) . $m[3];
        },
        $html
    );

    // 3) 内联 style
    $html = preg_replace_callback(
        '~(\sstyle\s*=\s*)(["\'])(.*?)\2~is',
        function ($m) use ($host, $base) {
            if (strpos($m[3], 'url(') === false) return $m[0];
            return $m[1] . $m[2] . rewrite_css($m[3], $host, $base) . $m[2];
        },
        $html
    );

    // 4) meta refresh：<meta http-equiv="refresh" content="0;url=/xxx">
    $html = preg_replace_callback(
        '~<meta\b[^>]*>~i',
        function ($tag) use ($host, $base) {
            if (!preg_match('~http-equiv\s*=\s*["\']?refresh~i', $tag[0])) return $tag[0];
            return preg_replace_callback(
                '~(content\s*=\s*)(["\'])(.*?)\2~is',
                function ($c) use ($host, $base) {
                    return $c[1] . $c[2] . rewrite_refresh($c[3], $host, $base) . $c[2];
                },
                $tag[0]
            );
        },
        $html
    );

    return $html;
}

/* ---------- 把「本站地址」翻译回目标站地址（用于 Referer / Origin） ---------- */
function translate_front(string $u): string
{
    if ($u === '') return '';
    $u = preg_replace('~^https?://~i', '', $u);

    $pos  = strpos($u, PROXY_HOST);
    $tail = $pos !== false ? substr($u, $pos + strlen(PROXY_HOST)) : '';
    $tail = ltrim($tail, '/');
    if ($tail === '') return '';

    $cut  = strcspn($tail, '/?#');
    $host = strtolower(substr($tail, 0, $cut));
    if (!preg_match('~^[a-z0-9.\-]+\.[a-z]{2,}$~', $host)) return '';

    $rest = substr($tail, $cut);
    return 'https://' . $host . ($rest === '' ? '/' : $rest);
}

/* ---------- 请求头 ---------- */
function request_headers(): array
{
    if (function_exists('getallheaders')) {
        $all = getallheaders();
        if (is_array($all) && $all) return $all;
    }
    $h = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) {
            $rawName = strtolower(str_replace('_', '-', substr($k, 5)));
            $name = implode('-', array_map('ucfirst', explode('-', $rawName)));
            $h[$name] = $v;
        }
    }
    if (!empty($_SERVER['CONTENT_TYPE'])) $h['Content-Type'] = $_SERVER['CONTENT_TYPE'];
    if (!empty($_SERVER['CONTENT_LENGTH'])) $h['Content-Length'] = $_SERVER['CONTENT_LENGTH'];
    return $h;
}

/* ---------- 错误页 ---------- */
function error_page(string $title, string $detail, int $status = 502): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    $t = htmlspecialchars($title, ENT_QUOTES);
    echo <<<HTML
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{$t}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:radial-gradient(1200px 600px at 20% -10%,#2a1a5e 0%,#0b0a10 55%) fixed,#0b0a10;
color:#eceaf5;font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(620px,100%);padding:38px 36px;border-radius:20px;background:rgba(255,255,255,.045);
border:1px solid rgba(255,255,255,.09);box-shadow:0 24px 70px rgba(0,0,0,.55)}
h1{margin:0 0 10px;font-size:19px;font-weight:600}
p{margin:0 0 22px;color:#9aa0b8;font-size:14px}
a{display:inline-flex;padding:10px 18px;border-radius:10px;text-decoration:none;color:#fff;
background:linear-gradient(135deg,#7c5cff,#a855f7);font-weight:600;font-size:14px}
</style></head><body><div class="card"><h1>{$t}</h1><p>{$detail}</p><a href="/">← 回到控制台</a></div></body></html>
HTML;
}

/* ---------- 解析目标 ---------- */

/** 从一个地址里抠出 [目标域名, 路径]；第一段不是域名就返回 null */
function target_from(string $raw): ?array
{
    $raw = preg_replace('~^https?://~i', '', (string) $raw);

    $pos  = strpos($raw, PROXY_HOST);
    $tail = $pos !== false ? substr($raw, $pos + strlen(PROXY_HOST)) : $raw;
    $tail = ltrim($tail, '/');
    if ($tail === '') return null;

    $cut  = strcspn($tail, '/?#');
    $host = strtolower(rtrim(substr($tail, 0, $cut), '.'));
    $path = substr($tail, $cut);
    if ($path === '') $path = '/';
    if ($path[0] !== '/') $path = '/' . $path;
    if ($path === '/?' || $path === '/#') $path = '/';

    if (!preg_match('~^[a-z0-9.\-]+\.[a-z]{2,}$~', $host)) return null;
    if ($host === PROXY_HOST) return null;
    return [$host, $path];
}

/**
 * 返回 [目标域名, 路径, 是否来自 Referer 兜底]
 * 第三项为 true 时说明原始 URL 里没有目标域名（页面 JS 直接跳的 /search?q= 这类），
 * 调用方应 302 到 /域名/路径，让地址栏重新带上目标站，后续点击才不会再次丢失上下文。
 */
function parse_target(): ?array
{
    $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');

    // 1) 常规：请求路径的第一段就是目标域名
    $t = target_from($uri);
    if ($t !== null) return [$t[0], $t[1], false];

    // 2) 兜底：页面里的 JS 直接改 location（例如 GitHub 搜索框跳到 /search?q=…），
    //    这时第一段不是域名，就用 Referer 里的目标站 + 当前请求的路径拼回真实目标
    $ref = trim((string) ($_SERVER['HTTP_REFERER'] ?? ''));
    $rt  = $ref !== '' ? target_from($ref) : null;

    // 3) 连 Referer 也没有（referrer-policy: no-referrer、或从书签直接打开）：
    //    用上一次成功代理 HTML 时写下的 __rp_host cookie 认人
    if ($rt === null) {
        $ck = strtolower(rawurldecode((string) ($_COOKIE['__rp_host'] ?? '')));
        if (preg_match('~^[a-z0-9.\-]+\.[a-z]{2,}$~', $ck) && $ck !== PROXY_HOST) {
            $rt = [$ck, '/'];
        }
    }
    if ($rt === null) return null;

    $qpos = strpos($uri, '?');
    $p    = $qpos === false ? $uri : substr($uri, 0, $qpos);
    $q    = $qpos === false ? '' : substr($uri, $qpos);
    $p    = '/' . ltrim($p, '/');

    return [$rt[0], $p . $q, true];
}

/* ================= 路由 ================= */
$uri      = (string) ($_SERVER['REQUEST_URI'] ?? '/');
$pathOnly = rawurldecode(explode('?', $uri, 2)[0]);

if ($pathOnly === '/' || $pathOnly === '/index.php' || $pathOnly === '/index.php/') {
    header('Content-Type: text/html; charset=utf-8');
    if (is_file(UI_FILE)) {
        readfile(UI_FILE);
    } else {
        echo '<h1 style="font-family:sans-serif">ui.html 缺失</h1><p style="font-family:sans-serif">请把 ui.html 放到 index.php 同目录。</p>';
    }
    exit;
}

if ($pathOnly === '/health') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true, 'php' => PHP_VERSION, 'proxyHost' => PROXY_HOST], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($pathOnly === '/api/info') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'proxyHost' => PROXY_HOST,
        'scheme'    => $httpsOnly ? 'https' : '',
        'engine'    => 'php',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($pathOnly === '/favicon.ico') {
    http_response_code(204);
    exit;
}

/* ================= 代理 ================= */
$t = parse_target();
if ($t === null) {
    error_page('这个地址没法代理', 'URL 需要是 <code>域名/路径</code> 的形式，且域名要带小数点。例如 <code>/developer.mozilla.org/zh-CN/</code>。', 400);
    exit;
}

[$host, $targetPath, $viaRef] = $t;
$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

// 原始 URL 里没有目标域名（JS 直接跳到 /search?q= 这类）：302 到 /域名/路径，
// 让地址栏重新带上目标站；否则后续点击的相对地址会再次解析失败
if ($viaRef && ($method === 'GET' || $method === 'HEAD')) {
    header('Location: /' . $host . $targetPath, true, 302);
    exit;
}

$target = 'https://' . $host . $targetPath;

$skipHeaders = [
    'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding',
    'referer', 'origin',
];
$headerLines = [];
foreach (request_headers() as $k => $v) {
    $lk = strtolower((string) $k);
    if (in_array($lk, $skipHeaders, true)) continue;
    if (is_array($v)) $v = implode(', ', $v);
    $headerLines[] = $k . ': ' . $v;
}
if (!$headerLines || !preg_grep('~^user-agent:~i', $headerLines)) {
    $headerLines[] = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
}

// 把本站的 Referer / Origin 翻译成目标站自己的地址，
// 这样防盗链、CSRF 校验、来源统计看到的都是“目标站自己”
$refOut = translate_front(trim((string) ($_SERVER['HTTP_REFERER'] ?? '')));
if ($refOut !== '') $headerLines[] = 'Referer: ' . $refOut;

$originIn = trim((string) ($_SERVER['HTTP_ORIGIN'] ?? ''));
if ($originIn !== '' && strcasecmp(preg_replace('~^https?://~i', '', rtrim($originIn, '/')), PROXY_HOST) === 0) {
    $headerLines[] = 'Origin: https://' . $host;
}

$respStatus  = 0;
$respHeaders = [];
$cookies     = [];

$ch = curl_init();
$curlOpts = [
    CURLOPT_URL            => $target,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_ENCODING       => '',        // 自动协商并解压 gzip / deflate / br
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => $headerLines,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respStatus, &$respHeaders, &$cookies) {
        if (preg_match('~^HTTP/\S+\s+(\d{3})~', $line, $m)) {
            $respStatus = (int) $m[1];
            return strlen($line);
        }
        $p = strpos($line, ':');
        if ($p !== false) {
            $k = strtolower(trim(substr($line, 0, $p)));
            $v = trim(substr($line, $p + 1));
            if ($k === 'set-cookie') {
                // 去掉 Domain=：目标站的 cookie 必须落到本站域名，否则浏览器直接丢弃，
                // 表现为登录态丢失、反复跳登录页
                $cookies[] = preg_replace('~;\s*domain=[^;]*~i', '', $v);
            }
            elseif ($k !== '') $respHeaders[$k] = $v;
        }
        return strlen($line);
    },
];

// 服务器没有系统 CA 时（Windows、精简版镜像常见），用同目录自带的 cacert.pem 兜底
$caFile = __DIR__ . '/cacert.pem';
if (is_file($caFile)) {
    $curlOpts[CURLOPT_CAINFO] = $caFile;
}

if ($method !== 'GET' && $method !== 'HEAD') {
    $curlOpts[CURLOPT_POSTFIELDS] = file_get_contents('php://input');
}
curl_setopt_array($ch, $curlOpts);

$raw = curl_exec($ch);
$err = curl_error($ch);
if ($respStatus === 0) $respStatus = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($raw === false || $respStatus === 0) {
    error_page('目标站点没连上', '可能是对方限制、超时，或者这个站点不是 HTTPS。错误信息：<code>' . htmlspecialchars($err ?: 'unknown error', ENT_QUOTES) . '</code>');
    exit;
}

/* 跳转：把 Location 改写回本站，交给浏览器重新请求 */
if ($respStatus >= 300 && $respStatus < 400 && !empty($respHeaders['location'])) {
    $abs = abs_url($respHeaders['location'], $target) ?: $respHeaders['location'];
    foreach ($cookies as $c) header('Set-Cookie: ' . $c, false);
    header('Location: ' . rewrite_url($abs, $host), true, $respStatus);
    exit;
}

/* Refresh 响应头同样是跳转（0;url=https://...），一并改写 */
if (!empty($respHeaders['refresh'])) {
    $respHeaders['refresh'] = rewrite_refresh($respHeaders['refresh'], $host, $target);
}

/* 输出响应头 */
$dropOut = ['content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy',
            'x-content-type-options', 'location', 'set-cookie', 'connection', 'keep-alive'];
http_response_code($respStatus);
foreach ($respHeaders as $k => $v) {
    if (in_array(strtolower($k), $dropOut, true)) continue;
    header($k . ': ' . $v, true);
}
foreach ($cookies as $c) header('Set-Cookie: ' . $c, false);
header('Cache-Control: no-store');

if ($method === 'HEAD') exit;
if (in_array($respStatus, [204, 205, 304], true)) exit;   // 这些状态码不带 body

$ctype  = strtolower((string) ($respHeaders['content-type'] ?? ''));
$accept = strtolower((string) ($_SERVER['HTTP_ACCEPT'] ?? ''));
$isHtml = (bool) preg_match('~text/html|application/xhtml~', $ctype);
$isCss  = (bool) preg_match('~text/css~', $ctype);
$isJsAsCss = preg_match('~text/javascript~', $ctype) && strpos($accept, 'text/css') !== false;

if ($isCss) {
    header('Content-Type: text/css; charset=utf-8');
    echo rewrite_css($raw, $host, $target);
} elseif ($isJsAsCss) {
    header('Content-Type: ' . str_replace('text/javascript', 'text/css', $ctype));
    echo rewrite_css($raw, $host, $target);
} elseif ($isHtml) {
    if (!$ctype) header('Content-Type: text/html; charset=utf-8');
    $out = rewrite_html($raw, $host, $target);
    // 记下"当前在镜像哪个站"：页面里的 JS 把地址改成 /search?q= 这类无域名路径、
    // 浏览器又不送 Referer 时，靠它兜底还原目标站
    header('Set-Cookie: __rp_host=' . rawurlencode($host) . '; Path=/; Max-Age=3600; SameSite=Lax', false);
    header('Content-Length: ' . strlen($out));
    echo $out;
} else {
    echo $raw;
}
