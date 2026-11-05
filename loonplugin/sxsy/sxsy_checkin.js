/**
 * @name sxsy 自动签到（OCR 版）
 * @description sxsy 论坛自动签到：抓验证码图片 → 发给自己 VPS 上的 ddddocr 识别 → 自动提交；失败则推可点击通知兜底
 *
 * ================== 2026-11-04 v5：OCR 自动签到 ==================
 *
 * 【背景】站点 11 月改版，签到插件从 k_misign 换成自研的 sx_signin，接口：
 *     POST https://<host>/plugin.php?id=sx_signin:ajax
 *     form: op=signin & formhash=<8位> & seccode=<4位图片验证码>
 *     成功: {"code":0,"msg":"签到成功","data":{"signed":1,"streak":67,"total":104,"today_credit":2,...}}
 *     失败: {"code":11,"msg":"验证码错误，请重新输入"}
 *   实测不传/空/假 seccode 一律 code:11 → 强校验，绕不过去，只能真识别。
 *
 * 【为什么能 OCR】Loon Script API 支持二进制：
 *   - 请求加 "binary-mode": true → 响应体是 Uint8Array（真字节，不经过字符串）
 *   - insecure 默认 true → VPS 用自签证书也能连，不用域名不用备案
 *
 * 【VPS 侧】（见工作区 vps-ocr/）
 *   iPhone → Caddy :8443（HTTPS + X-OCR-Token 校验）→ 127.0.0.1:8001 ddddocr
 *   ddddocr 官方 API 收 JSON：{"image":"<base64>"}，返回 {"result":"vtxv","processing_time":0.08}
 *   Loon 没有 $utils.base64Encode，所以本脚本自带一个 bytesToBase64()。
 *
 * 【流程】
 *   1. 域名择优 → 首页取 formhash
 *   2. 打开签到页 → 判断「今日已签到 / 未签到」，同时抓出验证码图片地址
 *   3. 未签到且配了 OCR：取图(Uint8Array) → Base64 → POST 给 VPS → 拿到 4 位码 → 提交
 *      **同一张图依次试「原样 / 全大写 / 全小写」**：站点疑似区分大小写，而 OCR 习惯输出小写；
 *      全部失败才换一张新图，最多 ocr_retry 张、总提交次数上限 2×ocr_retry
 *   4. 已签到 → 静默；OCR 没配/全失败 → 推可点击通知（openUrl 直达签到页）+ **附图**（mediaUrl 显示验证码原图），
 *      方便一眼看出 OCR 是读错了还是大小写不匹配
 *
 * 【Loon 参数】ocr_url（如 https://64.110.114.30:8443/ocr）、ocr_token、ocr_retry
 *
 * ================== 历史 ==================
 * 2026-11-04 v4 提醒版：强校验验证码，改半自动
 * 2026-10-30 域名变更修复（sxsy45.com → sxsy33.com）：域名择优 + 记录捕获域名
 * 2026-10-18 修复 Request timeout：显式 timeout + 3 次重试 + auto-cookie=false
 * 2026-09-27 新语法版：站点域名改参数、Cookie 键 sxsy_cookie
 */

var COOKIE_KEY = "sxsy_cookie";
var LEGACY_COOKIE_KEY = "sxsy13_cookie";
var UA_KEY = "sxsy_ua";
var HOST_KEY = "sxsy_site_host";
var FH_KEY = "sxsy_last_formhash";
var PUBLISH_URL = "https://sxsy.pw";

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};

var PLUGIN_ID = String(arg.sign_plugin || "sx_signin").trim().replace(/^id=/, "");
var OCR_URL = String(arg.ocr_url || "").trim();
var OCR_TOKEN = String(arg.ocr_token || "").trim();
var OCR_RETRY = Number(arg.ocr_retry || 3);
if (!(OCR_RETRY >= 1)) OCR_RETRY = 3;
if (OCR_RETRY > 6) OCR_RETRY = 6;

var REQ_TIMEOUT = Number(arg.req_timeout || 20000);
if (!(REQ_TIMEOUT > 0)) REQ_TIMEOUT = 20000;
var PROBE_TIMEOUT = Math.min(REQ_TIMEOUT, 12000);
var MAX_PROBE = 3;

var NOTIFY_WHEN_SIGNED = String(arg.notify_when_signed || "").toLowerCase() === "true";

var RE_ALREADY = /(已经?签\s*过?到|已签\s*到|今日已签|今天已签|重复签|明天再来|无需重复)/;

function normalizeHost(s) {
  return String(s || "").trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

var configuredHosts = String(arg.site_host || "")
  .split(/[,，\s]+/).map(normalizeHost).filter(Boolean);
var capturedHost = normalizeHost($persistentStore.read(HOST_KEY));
var hosts = [];
configuredHosts.concat(capturedHost ? [capturedHost] : []).forEach(function (h) {
  if (h && hosts.indexOf(h) < 0) hosts.push(h);
});

var cookie = $persistentStore.read(COOKIE_KEY) || $persistentStore.read(LEGACY_COOKIE_KEY);
var userAgent = $persistentStore.read(UA_KEY) ||
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

// ---------- Cookie 罐 ----------
// 验证码答案很可能是随 Set-Cookie 下发的（Discuz seccode 的经典做法）。
// 早先版本忽略 Set-Cookie，导致「我们看到的图」和「服务器认的答案」不是同一张 → 永远 code:11。
var cookieJar = {};

function mergeSetCookie(headers) {
  if (!headers) return;
  var sc = headers["set-cookie"] || headers["Set-Cookie"];
  if (!sc) return;
  var list = (typeof sc === "string") ? [sc] : sc;
  for (var i = 0; i < list.length; i++) {
    // 一条 header 里可能塞了多个 Set-Cookie，按 "xxx=, yyy=" 拆分
    var parts = String(list[i]).split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
    for (var j = 0; j < parts.length; j++) {
      var first = parts[j].split(";")[0].trim();
      var eq = first.indexOf("=");
      if (eq <= 0) continue;
      var name = first.slice(0, eq).trim();
      var value = first.slice(eq + 1).trim();
      if (name) cookieJar[name] = value;
    }
  }
}

// 组装 Cookie 头：基础 Cookie + 新接住的（新值覆盖旧值）+ 额外指定的
function cookieHeader(extra) {
  var map = {};
  String(cookie || "").split(";").forEach(function (p) {
    var eq = p.indexOf("=");
    if (eq > 0) map[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  });
  for (var k in cookieJar) map[k] = cookieJar[k];
  var out = [];
  for (var n in map) out.push(n + "=" + map[n]);
  if (extra) out.push(extra);
  return out.join("; ");
}

function jarNames() {
  var arr = [];
  for (var k in cookieJar) arr.push(k);
  return arr;
}

// 通知：第 3 参可传 openUrl 字符串，或 {openUrl, mediaUrl} 对象
function notify(subtitle, content, opts) {
  var o = {};
  if (typeof opts === "string") {
    if (opts) o.openUrl = opts;
  } else if (opts) {
    if (opts.openUrl) o.openUrl = opts.openUrl;
    if (opts.mediaUrl) o.mediaUrl = opts.mediaUrl;
  }
  $notification.post("sxsy签到", subtitle, content || "", o);
}

// 按文件头判断图片类型（通知的 mediaUrl 需要正确的 MIME）
function imageMime(b) {
  if (!b || b.length < 4) return "image/png";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp";
  return "image/png";
}

// 把验证码图片转成通知可直接显示的 Data URI
function toDataUri(bytes) {
  if (!bytes || !bytes.length) return "";
  return "data:" + imageMime(bytes) + ";base64," + bytesToBase64(bytes);
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function originOf(url) {
  var m = String(url || "").match(/^https?:\/\/[^\/]+/i);
  return m ? m[0] : "https://" + (hosts[0] || "");
}

function resolveUrl(src, origin) {
  var s = String(src || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf("//") === 0) return "https:" + s;
  if (s.charAt(0) === "/") return origin + s;
  return origin + "/" + s;
}

function withCacheBuster(url) {
  var sep = url.indexOf("?") >= 0 ? "&" : "?";
  return url + sep + "_t=" + Date.now() + Math.floor(Math.random() * 1000);
}

function baseHeaders(url, extra) {
  var h = {
    "User-Agent": userAgent,
    "Referer": originOf(url) + "/index.php?mobile=2",
    "Accept": "text/html,application/json,text/javascript,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Cookie": cookieHeader()
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// ---------- HTTP ----------

function rawGet(url, extraCookie, timeout, referer) {
  return new Promise(function (resolve) {
    var headers = baseHeaders(url);
    if (referer) headers["Referer"] = referer;
    if (extraCookie) headers["Cookie"] = cookieHeader(extraCookie);
    var started = Date.now();
    $httpClient.get(
      { url: url, headers: headers, timeout: timeout || REQ_TIMEOUT, "auto-redirect": true, "auto-cookie": false },
      function (error, response, body) {
        var cost = Date.now() - started;
        if (error) {
          console.log("sxsy-checkin: GET 失败(" + cost + "ms) " + error + " | " + url);
          resolve({ ok: false, error: String(error), cost: cost });
        } else {
          var hs = (response && response.headers) || {};
          mergeSetCookie(hs);
          console.log("sxsy-checkin: GET 完成(" + cost + "ms) HTTP " + (response ? response.status : 0) + " | " + url);
          resolve({ ok: true, status: response ? response.status : 0, headers: hs, body: String(body || ""), cost: cost });
        }
      }
    );
  });
}

// 取图片：binary-mode 让 Loon 以 Uint8Array 返回，才是真正的字节
function getBytes(url, referer) {
  return new Promise(function (resolve) {
    var headers = baseHeaders(url, { "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" });
    if (referer) headers["Referer"] = referer;
    $httpClient.get(
      {
        url: url,
        headers: headers,
        timeout: REQ_TIMEOUT,
        "auto-redirect": true,
        "auto-cookie": false,
        "binary-mode": true
      },
      function (error, response, data) {
        if (error) {
          console.log("sxsy-checkin: 取图失败 " + error + " | " + url);
          return resolve({ ok: false, error: String(error) });
        }
        var hs = (response && response.headers) || {};
        var before = jarNames().length;
        mergeSetCookie(hs);
        var after = jarNames().length;

        var len = data && data.length !== undefined ? data.length : 0;
        console.log("sxsy-checkin: 取图完成 HTTP " + (response ? response.status : 0) + "，" + len +
          " 字节" + (after > before ? "，新 Cookie " + (after - before) + " 个" : ""));
        resolve({ ok: len > 0, bytes: data, len: len, headers: hs });
      }
    );
  });
}

function rawPost(url, formBody, referer) {
  return new Promise(function (resolve) {
    var headers = baseHeaders(url, { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" });
    if (referer) headers["Referer"] = referer;
    $httpClient.post(
      { url: url, headers: headers, body: formBody, timeout: REQ_TIMEOUT, "auto-redirect": true, "auto-cookie": false },
      function (error, response, body) {
        if (error) {
          console.log("sxsy-checkin: POST 失败 " + error + " | " + formBody);
          return resolve({ ok: false, error: String(error) });
        }
        var hs = (response && response.headers) || {};
        mergeSetCookie(hs);
        console.log("sxsy-checkin: POST 完成 HTTP " + (response ? response.status : 0) + " | " + formBody);
        resolve({ ok: true, status: response ? response.status : 0, body: String(body || ""), headers: hs });
      }
    );
  });
}

// ---------- Base64（Loon 没有 $utils.base64Encode，只能手写） ----------
var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(src) {
  // Loon 在 "binary-mode": true 时返回 Uint8Array；兜底兼容字符串/数组
  var bytes = src;
  if (typeof bytes === "string") {
    var arr = [];
    for (var k = 0; k < bytes.length; k++) arr.push(bytes.charCodeAt(k) & 0xff);
    bytes = arr;
  }
  var len = (bytes && bytes.length) || 0;
  var out = "";
  var i = 0;
  for (; i + 2 < len; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64CHARS.charAt((n >> 18) & 63) + B64CHARS.charAt((n >> 12) & 63) +
      B64CHARS.charAt((n >> 6) & 63) + B64CHARS.charAt(n & 63);
  }
  var rem = len - i;
  if (rem === 1) {
    var n1 = bytes[i] << 16;
    out += B64CHARS.charAt((n1 >> 18) & 63) + B64CHARS.charAt((n1 >> 12) & 63) + "==";
  } else if (rem === 2) {
    var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64CHARS.charAt((n2 >> 18) & 63) + B64CHARS.charAt((n2 >> 12) & 63) +
      B64CHARS.charAt((n2 >> 6) & 63) + "=";
  }
  return out;
}

// 把图片字节 Base64 后发给自己的 VPS 网关，拿回 4 位验证码
// 网关：Caddy 8443（HTTPS + X-OCR-Token）→ 127.0.0.1:8001 ddddocr /ocr
function askOcr(bytes) {
  return new Promise(function (resolve) {
    var payload = JSON.stringify({ image: bytesToBase64(bytes) });
    console.log("sxsy-checkin: OCR 请求 " + payload.length + " 字节 → " + OCR_URL);

    var headers = {
      "Content-Type": "application/json",
      "Accept": "application/json"
    };
    if (OCR_TOKEN) headers["X-OCR-Token"] = OCR_TOKEN;

    $httpClient.post(
      {
        url: OCR_URL,
        headers: headers,
        body: payload,
        timeout: REQ_TIMEOUT,
        "auto-redirect": true
      },
      function (error, response, data) {
        if (error) {
          console.log("sxsy-checkin: OCR 请求失败 " + error);
          return resolve({ ok: false, error: String(error) });
        }
        var status = response ? response.status : 0;
        var text = String(data || "").trim();

        if (status === 401) return resolve({ ok: false, error: "网关拒绝（Token 不对，HTTP 401）" });
        if (status >= 400) {
          return resolve({ ok: false, error: "网关返回 HTTP " + status + "：" + text.slice(0, 60) });
        }

        var j = null;
        try { j = JSON.parse(text); } catch (e) { }
        if (!j) return resolve({ ok: false, error: "OCR 返回非 JSON：" + text.slice(0, 80) });

        // ddddocr 官方 API 返回 {"result":"vtxv","processing_time":0.08}
        var code = j.result || j.text || "";
        if (!code) return resolve({ ok: false, error: j.error || j.detail || "OCR 未返回结果" });

        code = String(code).replace(/[^0-9A-Za-z]/g, "");
        if (!code) return resolve({ ok: false, error: "OCR 结果里没有字母数字" });

        console.log("sxsy-checkin: OCR 识别 → " + code);
        resolve({ ok: true, text: code });
      }
    );
  });
}

// ---------- 解析 ----------

function plainText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLoginPage(body) {
  var b = String(body || "");
  return /action=login/i.test(b) || /type=["']password["']/i.test(b) || /id=["']loginform["']/i.test(b);
}

function pickFormhash(body) {
  var b = String(body || "");
  var m = b.match(/['"]?formhash['"]?\s*[:=]\s*["']?([0-9a-zA-Z]{6,})/);
  if (m) return m[1];
  m = b.match(/name=["']formhash["'][^>]*?value=["']([0-9a-zA-Z]{6,})["']/i);
  if (m) return m[1];
  m = b.match(/value=["']([0-9a-zA-Z]{6,})["'][^>]*?name=["']formhash["']/i);
  if (m) return m[1];
  return "";
}

function parseJson(body) {
  try {
    var j = JSON.parse(String(body || "").trim());
    if (j && typeof j === "object") return j;
  } catch (e) { }
  return null;
}

function parseStatus(html) {
  var t = plainText(html);
  var out = { signed: null, streak: "", total: "" };
  var ms = t.match(/连续签到[^\d]{0,8}(\d+)/) || t.match(/连续[^\d]{0,4}(\d+)\s*天/);
  if (ms) out.streak = ms[1];
  var mt = t.match(/累计签到[^\d]{0,12}(\d+)/) || t.match(/累计[^\d]{0,8}(\d+)\s*天/) ||
    t.match(/累计[^\d]{0,12}(\d+)/);
  if (mt) out.total = mt[1];
  if (/今日未签到|今天未签到|尚未签到|还未签到/.test(t)) out.signed = false;
  else if (/今日已签到|今天已签到|已签到/.test(t)) out.signed = true;
  return out;
}

// 找验证码图片地址：优先关键词命中，其次 plugin.php 生成的图
function findCaptchaUrls(html, origin) {
  var b = String(html || "");
  var all = [], hit = [];
  var re = /<img\b[^>]*>/gi, m;
  while ((m = re.exec(b))) {
    var tag = m[0];
    var srcM = tag.match(/\b(data-src|data-original|src)\s*=\s*["']([^"']+)["']/i);
    if (!srcM) continue;
    var raw = String(srcM[2] || "")
      .replace(/&amp;/gi, "&").replace(/&#38;/g, "&")
      .replace(/&quot;/gi, '"').trim();
    var url = resolveUrl(raw, origin);
    if (!url || /^data:/i.test(url)) continue;
    all.push(url);
    if (/captcha|seccode|verify|vcode|checkcode|code/i.test(url) || /plugin\.php/i.test(url)) hit.push(url);
  }
  // 命中关键词就只在这些里面挑（避免拿 logo 之类浪费重试次数）
  var pool = hit.length ? hit : all;
  var out = [], seen = {};
  pool.forEach(function (u) { if (!seen[u]) { seen[u] = 1; out.push(u); } });
  console.log("sxsy-checkin: 页面图片 " + all.length + " 张，疑似验证码 " + hit.length + " 张" +
    (out.length ? "：" + out.slice(0, 3).join(" , ") : "（未找到）"));
  return out;
}

// ---------- 业务 ----------

async function pickHost() {
  var tried = [];
  var list = hosts.slice(0, MAX_PROBE);
  for (var i = 0; i < list.length; i++) {
    var h = list[i];
    var r = await rawGet("https://" + h + "/index.php?mobile=2", "", PROBE_TIMEOUT);
    if (!r.ok) { tried.push(h + "：" + r.error); continue; }
    if (r.status !== 200) { tried.push(h + "：HTTP " + r.status); continue; }
    if (pickFormhash(r.body)) { console.log("sxsy-checkin: 域名探测命中 " + h); return { host: h, resp: r }; }
    if (isLoginPage(r.body)) { return { loginHost: h, resp: r }; }
    tried.push(h + "：页面无 formhash");
  }
  return { tried: tried };
}

async function submitSign(host, formhash, seccode) {
  var url = "https://" + host + "/plugin.php?id=" + PLUGIN_ID + ":ajax";
  var fields = ["op=signin", "formhash=" + formhash];
  if (seccode !== null && seccode !== undefined) fields.push("seccode=" + encodeURIComponent(seccode));
  var r = await rawPost(url, fields.join("&"), "https://" + host + "/plugin.php?id=" + PLUGIN_ID + ":index");
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "请求失败" };
  var j = parseJson(r.body);
  console.log("sxsy-checkin: 提交响应 " + (r.body || "").slice(0, 220));
  return { ok: true, json: j, body: r.body };
}

/**
 * OCR 自动签到：换图重试，直到成功或用尽次数
 * 返回 {done:true, json} / {done:false, reason}
 */
async function autoSign(host, formhash, captchaUrls) {
  if (!OCR_URL) return { done: false, reason: "未配置 OCR 服务" };
  if (!captchaUrls.length) return { done: false, reason: "页面里没找到验证码图片" };

  var reasons = [];
  function addReason(r) {
    var s = String(r || "").trim();
    if (s && reasons.indexOf(s) < 0) reasons.push(s);
  }

  // 每次提交都算一次「试错」，给个总上限，避免把站点惹毛
  var MAX_SUBMIT = OCR_RETRY * 2;
  var submitted = 0;
  var lastImg = null;
  var lastCode = "";
  var signPageRef = "https://" + host + "/plugin.php?id=" + PLUGIN_ID + ":index";

  for (var i = 1; i <= OCR_RETRY && submitted < MAX_SUBMIT; i++) {
    var rawUrl = captchaUrls[(i - 1) % captchaUrls.length];
    // 第一张必须用页面上的原地址（不加缓存参数）：换一张图就等于换了一个验证码，
    // 而服务器认的答案可能绑定在页面那一次生成的图上
    var imgUrl = (i === 1) ? rawUrl : withCacheBuster(rawUrl);
    var img = await getBytes(imgUrl, signPageRef);
    if (!img.ok) { addReason("取验证码图片失败"); continue; }
    lastImg = img.bytes;
    if (i === 1) {
      console.log("sxsy-checkin: Cookie 罐 " + jarNames().length + " 项 [" + jarNames().join(", ") + "]");
    }

    var ocr = await askOcr(img.bytes);
    if (!ocr.ok) {
      addReason(ocr.error);
      // Token 不对 / 网关不通，重试也没意义，直接收工
      if (/Token|401|404|502|503/i.test(ocr.error || "")) break;
      continue;
    }
    if (!ocr.text) { addReason("OCR 返回空"); continue; }
    lastCode = ocr.text;

    // 该插件疑似区分大小写（页面截图里是大写，OCR 习惯输出小写）
    // 同一张图依次试：原样 → 全大写 → 全小写，去重后逐个提交
    var variants = [];
    [ocr.text, ocr.text.toUpperCase(), ocr.text.toLowerCase()].forEach(function (v) {
      if (v && variants.indexOf(v) < 0) variants.push(v);
    });
    console.log("sxsy-checkin: 第 " + i + " 张图 OCR=" + ocr.text + "，变体 [" + variants.join(", ") + "]");

    for (var k = 0; k < variants.length && submitted < MAX_SUBMIT; k++) {
      var code = variants[k];
      submitted++;
      var res = await submitSign(host, formhash, code);
      if (!res.ok) { addReason(res.error); continue; }

      if (res.json && res.json.code === 0) {
        console.log("sxsy-checkin: 第 " + i + " 张图、变体 " + code + " 提交成功");
        return { done: true, json: res.json, try: i, code: code, bytes: img.bytes };
      }
      var msg = (res.json && res.json.msg) || "";
      if (RE_ALREADY.test(msg)) return { done: true, json: res.json, already: true, bytes: img.bytes };

      addReason(msg || "签到未成功");
      console.log("sxsy-checkin: 变体 " + code + " 失败（" + (msg || "无 msg") + "）");
      await sleep(600);
    }
  }

  // 优先展示第一次（通常最有信息量）的失败原因；带上最后一张图和 OCR 结果，便于人工核对
  return {
    done: false,
    reason: reasons[0] || reasons.join("；") || "识别失败",
    bytes: lastImg,
    code: lastCode,
    tries: submitted
  };
}

function successNotify(json, extra, t0) {
  var d = (json && json.data) || {};
  var bits = [];
  if (d.streak) bits.push("连续 " + d.streak + " 天");
  if (d.total) bits.push("累计 " + d.total + " 天");
  if (d.today_credit !== undefined) bits.push("+" + d.today_credit + " 积分");
  var detail = bits.length ? bits.join("，") : ((json && json.msg) || "签到成功");
  notify("签到成功" + (extra ? "（" + extra + "）" : ""), detail);
  console.log("sxsy-checkin: 成功 " + JSON.stringify(d) + "，耗时 " + (Date.now() - t0) + "ms");
}

async function main() {
  var t0 = Date.now();
  console.log("sxsy-checkin: v5 OCR 版启动，插件 " + PLUGIN_ID +
    "，OCR " + (OCR_URL ? "已配置" : "未配置") + "，重试 " + OCR_RETRY + " 次");

  var picked = await pickHost();
  if (picked.loginHost) {
    notify("Cookie 已失效", "站点 " + picked.loginHost + " 要求重新登录，请在浏览器登录一次（Cookie 会自动更新）");
    return;
  }
  if (!picked.host) {
    notify("域名可能又变了", "所有候选域名都不通（" + (picked.tried || []).join("；") + "）。最新地址见 " + PUBLISH_URL);
    return;
  }

  var siteHost = picked.host;
  if (siteHost !== capturedHost) $persistentStore.write(siteHost, HOST_KEY);

  var signPageUrl = "https://" + siteHost + "/plugin.php?id=" + PLUGIN_ID + ":index";
  var formhash = pickFormhash(picked.resp.body) || $persistentStore.read(FH_KEY) || "";

  var r = await rawGet(signPageUrl, "", REQ_TIMEOUT);
  if (!r || !r.ok) {
    notify("签到页打不开", "站点 " + siteHost + " 响应异常：" + ((r && r.error) || "未知错误"), signPageUrl);
    return;
  }
  if (isLoginPage(r.body)) {
    notify("Cookie 已失效", "签到页要求重新登录，请在浏览器登录一次", signPageUrl);
    return;
  }

  // 签到页里的 formhash 更新（比首页的更贴近）
  var fhPage = pickFormhash(r.body);
  if (fhPage) formhash = fhPage;
  if (formhash) $persistentStore.write(formhash, FH_KEY);

  var st = parseStatus(r.body);
  console.log("sxsy-checkin: 状态 " + (st.signed === null ? "未知" : (st.signed ? "已签到" : "未签到")) +
    "｜连续 " + (st.streak || "?") + "｜累计 " + (st.total || "?"));

  // ---- 已签到：静默 ----
  if (st.signed === true) {
    console.log("sxsy-checkin: 今日已签到，静默结束（耗时 " + (Date.now() - t0) + "ms）");
    var bits = [];
    if (st.streak) bits.push("连续 " + st.streak + " 天");
    if (st.total) bits.push("累计 " + st.total + " 天");
    if (NOTIFY_WHEN_SIGNED) notify("今日已签到", bits.join("，") || "无需重复签到", signPageUrl);
    return;
  }

  // ---- 未签到（或状态未知）：尝试 OCR 自动签到 ----
  if (!formhash) {
    notify("取不到 formhash", "签到页结构可能又变了，点此手动签到", signPageUrl);
    return;
  }

  var captchaUrls = findCaptchaUrls(r.body, "https://" + siteHost);
  var result = await autoSign(siteHost, formhash, captchaUrls);

  if (result.done && result.already) {
    notify("今日已签到", "服务器返回：" + ((result.json && result.json.msg) || "已签到"), signPageUrl);
    return;
  }
  if (result.done) {
    successNotify(result.json, "OCR 第 " + result.try + " 次", t0);
    return;
  }

  // ---- 兜底：推可点击通知 + 附上验证码图片（便于一眼看出 OCR 读得对不对） ----
  var why = result.reason || "未知原因";
  var detail = [];
  if (st.streak) detail.push("连续 " + st.streak + " 天");
  var extra = "";
  if (result.code) extra += "｜OCR 读到：" + result.code;
  if (result.tries) extra += "（共试 " + result.tries + " 次）";

  var opts = { openUrl: signPageUrl };
  var uri = toDataUri(result.bytes);
  if (uri) opts.mediaUrl = uri;

  notify(
    "自动签到没成功",
    "原因：" + why + (detail.length ? "｜" + detail.join("，") : "") + extra + "｜点此手动签一下",
    opts
  );
  console.log("sxsy-checkin: 自动签到失败（" + why + "），耗时 " + (Date.now() - t0) + "ms" +
    (uri ? "｜已附图 " + uri.length + " 字节" : ""));
}

if (!hosts.length) {
  notify("未配置站点域名", "请在插件参数「站点域名」中填写当前域名（最新地址见 " + PUBLISH_URL + "）");
  $done();
} else if (!cookie) {
  notify("缺少 Cookie", "请先用浏览器登录论坛，捕获脚本会自动保存 Cookie");
  $done();
} else {
  (async function () {
    try { await main(); } catch (e) {
      console.log("sxsy-checkin: 执行异常 " + (e && e.message ? e.message : e));
      notify("执行异常", String(e && e.message ? e.message : e));
    }
    $done();
  })();
}
