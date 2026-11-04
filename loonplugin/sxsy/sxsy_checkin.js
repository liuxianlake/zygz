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
 *      失败(code 11)就换一张图重试，最多 ocr_retry 次（90% 单次成功率 × 3 次 ≈ 99.9%）
 *   4. 已签到 → 静默；OCR 没配/全失败 → 推可点击通知（openUrl 直达签到页），永不漏签
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
var RE_SECCODE = /(验证码|校验码|seccode)/i;

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

function notify(subtitle, content, openUrl) {
  var opts = {};
  if (openUrl) opts.openUrl = openUrl;
  $notification.post("sxsy签到", subtitle, content || "", opts);
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
    "Cookie": String(cookie)
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// ---------- HTTP ----------

function rawGet(url, extraCookie, timeout) {
  return new Promise(function (resolve) {
    var headers = baseHeaders(url);
    if (extraCookie) headers["Cookie"] = String(cookie) + ";" + extraCookie;
    var started = Date.now();
    $httpClient.get(
      { url: url, headers: headers, timeout: timeout || REQ_TIMEOUT, "auto-redirect": true, "auto-cookie": false },
      function (error, response, body) {
        var cost = Date.now() - started;
        if (error) {
          console.log("sxsy-checkin: GET 失败(" + cost + "ms) " + error + " | " + url);
          resolve({ ok: false, error: String(error), cost: cost });
        } else {
          console.log("sxsy-checkin: GET 完成(" + cost + "ms) HTTP " + (response ? response.status : 0) + " | " + url);
          resolve({ ok: true, status: response ? response.status : 0, headers: (response && response.headers) || {}, body: String(body || ""), cost: cost });
        }
      }
    );
  });
}

// 取图片：binary-mode 让 Loon 以 Uint8Array 返回，才是真正的字节
function getBytes(url) {
  return new Promise(function (resolve) {
    $httpClient.get(
      {
        url: url,
        headers: baseHeaders(url, { "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" }),
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
        var len = data && data.length !== undefined ? data.length : 0;
        console.log("sxsy-checkin: 取图完成 HTTP " + (response ? response.status : 0) + "，" + len + " 字节");
        resolve({ ok: len > 0, bytes: data, len: len });
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
        console.log("sxsy-checkin: POST 完成 HTTP " + (response ? response.status : 0) + " | " + formBody);
        resolve({ ok: true, status: response ? response.status : 0, body: String(body || "") });
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
  var mt = t.match(/累计签到[^\d]{0,8}(\d+)/) || t.match(/累计[^\d]{0,4}(\d+)\s*天/);
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

  for (var i = 1; i <= OCR_RETRY; i++) {
    var imgUrl = withCacheBuster(captchaUrls[(i - 1) % captchaUrls.length]);
    var img = await getBytes(imgUrl);
    if (!img.ok) { addReason("取验证码图片失败"); continue; }

    var ocr = await askOcr(img.bytes);
    if (!ocr.ok) {
      addReason(ocr.error);
      // Token 不对 / 网关不通，重试也没意义，直接收工
      if (/Token|401|404|502|503/i.test(ocr.error || "")) break;
      continue;
    }
    if (!ocr.text) { addReason("OCR 返回空"); continue; }

    var res = await submitSign(host, formhash, ocr.text);
    if (!res.ok) { addReason(res.error); continue; }

    if (res.json && res.json.code === 0) {
      console.log("sxsy-checkin: 第 " + i + " 次识别成功，验证码 " + ocr.text);
      return { done: true, json: res.json, try: i, code: ocr.text };
    }
    var msg = (res.json && res.json.msg) || "";
    if (RE_ALREADY.test(msg)) return { done: true, json: res.json, already: true };
    addReason(msg || "签到未成功");
    console.log("sxsy-checkin: 第 " + i + " 次失败（" + (msg || "无 msg") + "），换图重试");
    await sleep(800);
  }
  // 优先展示第一次（通常最有信息量）的失败原因
  return { done: false, reason: reasons[0] || reasons.join("；") || "识别失败" };
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

  // ---- 兜底：推可点击通知，绝不漏签 ----
  var why = result.reason || "未知原因";
  var detail = [];
  if (st.streak) detail.push("连续 " + st.streak + " 天");
  notify(
    "自动签到没成功",
    "原因：" + why + (detail.length ? "｜" + detail.join("，") : "") + "｜点此手动签一下",
    signPageUrl
  );
  console.log("sxsy-checkin: 自动签到失败（" + why + "），耗时 " + (Date.now() - t0) + "ms");
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
