/**
 * @name sxsy 自动签到
 * @description sxsy 论坛（Discuz!）自动签到。2026-11-04 起适配站点新版签到插件 sx_signin
 *
 * 2026-11-04 v3 —— 换插件适配（k_misign 已下线，旧接口返回「插件不存在或已关闭」）
 * - 新接口（抓包实锤）：
 *     POST https://<host>/plugin.php?id=sx_signin:ajax
 *     form: op=signin & formhash=<8位> & seccode=<4位验证码>
 *     响应: {"code":0,"msg":"签到成功","data":{"signed":1,"streak":67,"total":104,"today_credit":2,...}}
 *   → 不再有算术题，社交端改成图片验证码（seccode）。
 *
 * - 本版是【探路版】：核心目的是问服务器「seccode 到底是不是必须的」，分三次尝试：
 *     A 不带 seccode 字段  → 若 code=0，说明服务器根本不校验，全自动可修
 *     B 带空 seccode       → 若 code=0，同上
 *     C 带假验证码 0000    → 若返回「验证码错误」类，说明确实强校验
 *   三次结果会一次性写进通知，据此决定后面走「全自动」还是「OCR / 半自动」。
 *
 * - 保留的能力：域名自动择优、formhash 自动获取、Cookie 失效识别、失败原因人话化。
 *
 * 2026-10-30 域名变更修复（sxsy45.com → sxsy33.com）：域名择优 + 记录捕获域名
 * 2026-10-18 修复 Request timeout：显式 timeout + 3 次重试 + auto-cookie=false
 * 2026-09-27 新语法版：站点域名改参数、Cookie 键 sxsy_cookie、mathv 正则泛化
 */

var COOKIE_KEY = "sxsy_cookie";
var LEGACY_COOKIE_KEY = "sxsy13_cookie";
var UA_KEY = "sxsy_ua";
var HOST_KEY = "sxsy_site_host";
var PUBLISH_URL = "https://sxsy.pw";

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};

// 新签到插件标识（站点后台插件目录名）。换插件只需改插件参数，不用改代码。
var PLUGIN_ID = String(arg.sign_plugin || "sx_signin").trim().replace(/^id=/, "");

var REQ_TIMEOUT = Number(arg.req_timeout || 20000);
if (!(REQ_TIMEOUT > 0)) REQ_TIMEOUT = 20000;
var MAX_ATTEMPTS = 3;
var PROBE_TIMEOUT = Math.min(REQ_TIMEOUT, 12000);
var MAX_PROBE = 3;

// 站点提示分类
var RE_ALREADY = /(已经?签\s*过?到|已签\s*到|今日已签|今天已签|重复签|明天再来|无需重复)/;
var RE_NEED_LOGIN = /(请先登录|需要先登录|您还未登录|尚未登录|未登录|游客|请登录后)/;
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

function notify(subtitle, content) {
  $notification.post("sxsy签到", subtitle, content || "");
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function originOf(url) {
  var m = String(url || "").match(/^https?:\/\/[^\/]+/i);
  return m ? m[0] : "https://" + (hosts[0] || "");
}

function baseHeaders(url, extra) {
  var h = {
    "User-Agent": userAgent,
    "Referer": originOf(url) + "/index.php?mobile=2",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    "Cookie": String(cookie)
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// 单次 GET
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
          var status = response ? response.status : 0;
          console.log("sxsy-checkin: GET 完成(" + cost + "ms) HTTP " + status + " | " + url);
          resolve({ ok: true, status: status, headers: (response && response.headers) || {}, body: String(body || ""), cost: cost });
        }
      }
    );
  });
}

// 单次 POST（form-urlencoded）
function rawPost(url, formBody, referer) {
  return new Promise(function (resolve) {
    var headers = baseHeaders(url, {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    });
    if (referer) headers["Referer"] = referer;
    var started = Date.now();
    $httpClient.post(
      { url: url, headers: headers, body: formBody, timeout: REQ_TIMEOUT, "auto-redirect": true, "auto-cookie": false },
      function (error, response, body) {
        var cost = Date.now() - started;
        if (error) {
          console.log("sxsy-checkin: POST 失败(" + cost + "ms) " + error + " | " + url);
          resolve({ ok: false, error: String(error), cost: cost });
        } else {
          var status = response ? response.status : 0;
          console.log("sxsy-checkin: POST 完成(" + cost + "ms) HTTP " + status + " | " + formBody);
          resolve({ ok: true, status: status, headers: (response && response.headers) || {}, body: String(body || ""), cost: cost });
        }
      }
    );
  });
}

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

// 解析 JSON 响应；非 JSON 就退回文本
function parseResp(body) {
  var t = String(body || "").trim();
  try {
    var j = JSON.parse(t);
    if (j && typeof j === "object") {
      return {
        json: true,
        code: typeof j.code === "number" ? j.code : (j.code === undefined ? null : Number(j.code)),
        msg: String(j.msg || j.message || ""),
        data: j.data || null
      };
    }
  } catch (e) { }
  return { json: false, code: null, msg: plainText(t).slice(0, 140), data: null, raw: t.slice(0, 300) };
}

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

// 一次签到提交
async function submit(host, formhash, seccode, label) {
  var url = "https://" + host + "/plugin.php?id=" + PLUGIN_ID + ":ajax";
  var fields = ["op=signin", "formhash=" + formhash];
  if (seccode !== null) fields.push("seccode=" + encodeURIComponent(seccode));
  var body = fields.join("&");

  var r = await rawPost(url, body, "https://" + host + "/plugin.php?id=" + PLUGIN_ID + ":index");
  if (!r || !r.ok) return { ok: false, label: label, resp: { msg: (r && r.error) || "请求失败" } };
  var parsed = parseResp(r.body);
  console.log("sxsy-checkin: [" + label + "] → " + (r.body || "").slice(0, 300));
  return { ok: true, label: label, resp: parsed, status: r.status };
}

function finishSuccess(r, t0) {
  var d = r.resp.data || {};
  var bits = [];
  if (d.streak) bits.push("连续 " + d.streak + " 天");
  if (d.total) bits.push("累计 " + d.total + " 天");
  if (d.today_credit !== undefined) bits.push("+" + d.today_credit + " 积分");
  var detail = bits.length ? bits.join("，") : (r.resp.msg || "签到成功");
  notify("签到成功（" + r.label + "）", detail + "｜耗时 " + (Date.now() - t0) + "ms");
  console.log("sxsy-checkin: 签到成功 " + JSON.stringify(r.resp.data || {}) + "，总耗时 " + (Date.now() - t0) + "ms");
}

async function main() {
  var t0 = Date.now();
  console.log("sxsy-checkin: v3 探路版启动，插件 " + PLUGIN_ID + "，候选域名 [" + hosts.join(", ") + "]");

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

  var formhash = pickFormhash(picked.resp.body);
  if (!formhash) {
    notify("失败", "未找到 formhash（详见日志）");
    return;
  }
  console.log("sxsy-checkin: formhash = " + formhash);

  // ============ 探路：依次试探 seccode 是否真的必需 ============
  var results = [];

  // A：完全不传 seccode 字段
  var a = await submit(siteHost, formhash, null, "A 不带seccode");
  results.push(a);
  if (a.ok && a.resp.code === 0) return finishSuccess(a, t0);
  if (a.ok && RE_ALREADY.test(a.resp.msg)) { notify("今日已签到", a.resp.msg); return; }

  await sleep(1200);

  // B：传空的 seccode
  var b = await submit(siteHost, formhash, "", "B 空seccode");
  results.push(b);
  if (b.ok && b.resp.code === 0) return finishSuccess(b, t0);
  if (b.ok && RE_ALREADY.test(b.resp.msg)) { notify("今日已签到", b.resp.msg); return; }

  await sleep(1200);

  // C：传假验证码，确认服务器是不是真的在比对
  var c = await submit(siteHost, formhash, "0000", "C 假seccode");
  results.push(c);
  if (c.ok && c.resp.code === 0) return finishSuccess(c, t0);
  if (c.ok && RE_ALREADY.test(c.resp.msg)) { notify("今日已签到", c.resp.msg); return; }

  // ============ 汇总：把三次结果一次说清楚 ============
  var lines = results.map(function (r) {
    var m = r.resp ? (r.resp.msg || "（无 msg）") : "（无响应）";
    var code = r.resp && r.resp.code !== null && r.resp.code !== undefined ? "code=" + r.resp.code + " " : "";
    return r.label + "：" + code + m;
  });

  var allNeedCode = results.every(function (r) {
    return r.resp && RE_SECCODE.test(r.resp.msg || "");
  });

  if (allNeedCode) {
    notify("签到需要验证码", lines.join("｜") + "｜结论：服务器强校验图片验证码");
  } else {
    notify("签到失败（待判断）", lines.join("｜"));
  }
  console.log("sxsy-checkin: 探路结束，总耗时 " + (Date.now() - t0) + "ms");
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
