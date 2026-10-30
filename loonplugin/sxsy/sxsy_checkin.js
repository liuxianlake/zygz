/**
 * @name sxsy 自动签到
 * @description sxsy 论坛（Discuz! k_misign 签到插件）自动签到，数学题自动计算
 *
 * 2026-10-30 域名变更修复（sxsy45.com → sxsy33.com）：
 * - 【根因】域名换了，但插件参数「站点域名」还停在旧域名 → 首页请求打到已 301 的旧站，签到必失败。
 * - 现在支持「域名择优」：候选 = 参数里的域名（可逗号填多个）+ Cookie 捕获脚本记录的最近登录域名，
 *   逐个探测（首页能否拿到 formhash），用第一个可用的。参数忘了改也能自己找到活域名。
 * - 探测到的是登录页时，直接提示「Cookie 已失效」，不再含糊报 formhash 缺失。
 * - 今日已签到时给出明确提示，而不是当成「找不到数学题」失败。
 *
 * 2026-10-18 修复 Request timeout：
 * - 【根因】$httpClient 的 timeout 默认只有 5000ms，脚本从未显式传入。
 *   plugin.php（签到页/提交）比 index.php 慢，5 秒就被 Loon 掐断 → "Request timeout."。
 * - 现在每次请求显式 timeout=20000（可被插件参数覆盖），并对超时/5xx/429 自动重试 3 次（2s、4s 退避）。
 * - 请求加 "auto-cookie": false（Cookie 由脚本自己管，避免 Loon 内部 Cookie 罐覆盖会话）。
 * - 每次请求打印耗时，方便下次判断是「站点慢」还是「站点挂」。
 *
 * 2026-09-27 新语法版：
 * - 站点域名改为插件参数（$argument.site_host），换域名只需改插件参数「站点域名」
 * - Cookie 键改为 sxsy_cookie（跨域名稳定；兼容读取旧 sxsy13_cookie）
 * - mathv Cookie 正则泛化：不再写死 u52q_2132_ 前缀（域名更换后 Discuz 前缀变化也能匹配）
 * - CDATA 正则支持多行；补日志面包屑；全局异常兜底
 */

var COOKIE_KEY = "sxsy_cookie";
var LEGACY_COOKIE_KEY = "sxsy13_cookie";
var UA_KEY = "sxsy_ua";
var HOST_KEY = "sxsy_site_host";       // 由 sxsy-cookie.js 写入
var PUBLISH_URL = "https://sxsy.pw";   // 官方发布页（查看最新域名）

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};

// 单次请求超时（毫秒）：默认 5s 太短，签到页经常来不及返回
var REQ_TIMEOUT = Number(arg.req_timeout || 20000);
if (!(REQ_TIMEOUT > 0)) REQ_TIMEOUT = 20000;

// 单个请求最多尝试次数
var MAX_ATTEMPTS = 3;

// 域名探测只试 1 次、超时收紧，避免旧域名挂掉时把整次执行拖爆
var PROBE_TIMEOUT = Math.min(REQ_TIMEOUT, 12000);
var MAX_PROBE = 3;

function normalizeHost(s) {
  return String(s || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

// 候选域名：参数（支持逗号/空格分隔多个）优先，其后是 Cookie 捕获时记录的域名
var configuredHosts = String(arg.site_host || "")
  .split(/[,，\s]+/)
  .map(normalizeHost)
  .filter(Boolean);
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

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function originOf(url) {
  var m = String(url || "").match(/^https?:\/\/[^\/]+/i);
  return m ? m[0] : "https://" + (hosts[0] || "");
}

// 单次 GET：返回 {ok, status, headers, body, cost} 或 {ok:false, error, cost}
function rawGet(url, extraCookie, timeout) {
  return new Promise(function (resolve) {
    var headers = {
      "User-Agent": userAgent,
      "Referer": originOf(url) + "/index.php?mobile=2",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9"
    };
    headers["Cookie"] = String(cookie) + (extraCookie ? ";" + extraCookie : "");

    var started = Date.now();

    $httpClient.get(
      {
        url: url,
        headers: headers,
        timeout: timeout || REQ_TIMEOUT,
        "auto-redirect": true,
        // Cookie 由脚本自己维护，关掉 Loon 的内部 Cookie 罐，避免覆盖显式会话
        "auto-cookie": false
      },
      function (error, response, body) {
        var cost = Date.now() - started;
        if (error) {
          console.log("sxsy-checkin: 请求失败(" + cost + "ms) " + error + " | " + url);
          resolve({ ok: false, error: String(error), cost: cost });
        } else {
          var status = response ? response.status : 0;
          console.log("sxsy-checkin: 请求完成(" + cost + "ms) HTTP " + status + " | " + url);
          resolve({
            ok: true,
            status: status,
            headers: (response && response.headers) || {},
            body: String(body || ""),
            cost: cost
          });
        }
      }
    );
  });
}

// 带重试的 GET：超时/网络错误/5xx/429 会重试，最多 MAX_ATTEMPTS 次
async function get(url, extraCookie, label) {
  var last = null;
  for (var i = 1; i <= MAX_ATTEMPTS; i++) {
    var r = await rawGet(url, extraCookie, REQ_TIMEOUT);
    last = r;

    var needRetry = !r.ok || r.status >= 500 || r.status === 429;
    if (!needRetry) return r;

    if (i < MAX_ATTEMPTS) {
      var wait = 2000 * i; // 2s、4s
      console.log(
        "sxsy-checkin: " + label + " 第 " + i + " 次失败（" +
        (r.ok ? "HTTP " + r.status : r.error) + "），" + (wait / 1000) + "s 后重试"
      );
      await sleep(wait);
    }
  }
  // 重试用尽仍是可重试类失败（超时 / 5xx / 429）：标记为失败，别让调用方拿半成品往下走
  if (last && last.ok) {
    last.ok = false;
    last.error = "HTTP " + last.status + "（已重试 " + MAX_ATTEMPTS + " 次）";
  }
  return last;
}

// 提取 CDATA 内容（[\s\S] 兼容多行）
function cleanCdata(text) {
  var m = String(text || "").match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : String(text || "");
}

function plainText(html) {
  return cleanCdata(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 被 Discuz 踢到登录页的特征
function isLoginPage(body) {
  var b = String(body || "");
  return /action=login/i.test(b) ||
    /type=["']password["']/i.test(b) ||
    /id=["']loginform["']/i.test(b);
}

function hasFormhash(body) {
  return /['"]?formhash['"]?\s*[:=]\s*["']?[0-9a-zA-Z]{6,}/.test(String(body || ""));
}

// 失败提示里带上最后一次的错误原因，避免只看到"网络错误"
function failReason(r) {
  if (!r) return "无响应";
  if (!r.ok) return r.error;
  return "HTTP " + r.status;
}

/**
 * 域名择优：按候选顺序探测 index.php?mobile=2，谁先返回「带 formhash 的页面」就用谁。
 * 返回 { host, resp } / { loginHost, resp }（探测到登录页）/ { tried: [...] }（全部失败）
 */
async function pickHost() {
  var tried = [];
  var list = hosts.slice(0, MAX_PROBE);

  for (var i = 0; i < list.length; i++) {
    var h = list[i];
    var url = "https://" + h + "/index.php?mobile=2";
    var r = await rawGet(url, "", PROBE_TIMEOUT);

    if (!r.ok) {
      tried.push(h + "：" + r.error);
      console.log("sxsy-checkin: 域名探测 " + h + " 失败（" + r.error + "）");
      continue;
    }
    if (r.status !== 200) {
      tried.push(h + "：HTTP " + r.status);
      console.log("sxsy-checkin: 域名探测 " + h + " 返回 HTTP " + r.status);
      continue;
    }
    if (hasFormhash(r.body)) {
      console.log("sxsy-checkin: 域名探测命中 " + h);
      return { host: h, resp: r };
    }
    if (isLoginPage(r.body)) {
      console.log("sxsy-checkin: 域名 " + h + " 正常响应，但被重定向到登录页（Cookie 失效）");
      return { loginHost: h, resp: r };
    }
    tried.push(h + "：页面无 formhash");
    console.log("sxsy-checkin: 域名探测 " + h + " 页面既无 formhash 也不是登录页");
  }

  return { tried: tried };
}

async function main() {
  var t0 = Date.now();
  console.log("sxsy-checkin: 开始执行，候选域名 [" + hosts.join(", ") + "]，超时 " +
    REQ_TIMEOUT + "ms × " + MAX_ATTEMPTS + " 次");

  // ===============================
  // 0. 域名择优
  // ===============================
  var picked = await pickHost();

  if (picked.loginHost) {
    notify("Cookie 已失效", "站点 " + picked.loginHost + " 要求重新登录，请用浏览器打开论坛登录一次（Cookie 会自动更新）");
    return;
  }
  if (!picked.host) {
    notify("域名可能又变了", "所有候选域名都不通（" + (picked.tried || []).join("；") +
      "）。请打开 " + PUBLISH_URL + " 查最新地址，改插件参数「站点域名」（详见日志）");
    return;
  }

  var siteHost = picked.host;
  var host = "https://" + siteHost;

  // 记住这次可用的域名，下次少走弯路
  if (siteHost !== capturedHost) {
    $persistentStore.write(siteHost, HOST_KEY);
    console.log("sxsy-checkin: 已记录可用域名 " + siteHost + "（原 " + (capturedHost || "无") + "）");
  }

  // ===============================
  // 1. formhash（探测页已拿到，直接用）
  // ===============================
  var r1 = picked.resp;
  // formhash 提取：引号可选（兼容 'formhash':'x'、var formhash = "x"、以及 URL 里 &formhash=x）
  var formhashMatch = String(r1.body).match(/['"]?formhash['"]?\s*[:=]\s*["']?([0-9a-zA-Z]{6,})/);
  if (!formhashMatch) {
    notify("失败", "站点 " + siteHost + " 响应异常，未找到 formhash（详见日志）");
    console.log("sxsy-checkin: 未找到 formhash，HTTP " + r1.status);
    return;
  }
  var formhash = formhashMatch[1];
  console.log("sxsy-checkin: formhash 已获取 (" + formhash.length + " chars)");

  // ===============================
  // 2. 获取数学题
  // ===============================
  var questionUrl = host + "/plugin.php?id=k_misign:sign" +
    "&operation=qiandao" +
    "&format=text" +
    "&formhash=" + formhash;

  var r2 = await get(questionUrl, "", "取题目");
  if (!r2 || !r2.ok) {
    notify("获取签到页失败", failReason(r2));
    console.log("sxsy-checkin: 取题目失败，耗时 " + (Date.now() - t0) + "ms");
    return;
  }

  // mathv Cookie：前缀随域名/重装可能变化（旧版写死 u52q_2132_），泛化匹配
  var setCookie = r2.headers["set-cookie"] || r2.headers["Set-Cookie"] || "";
  var mathvMatch = String(setCookie).match(/([a-z0-9_]*k_misign_mathv=[^;, ]+)/i);
  var mathv = mathvMatch ? mathvMatch[1] : "";
  if (!mathv) {
    console.log("sxsy-checkin: 未发现 mathv Cookie（可能已签到过，继续尝试提交）");
  }

  var questionMatch = String(r2.body).match(/var q="([^"]+)"/);
  if (!questionMatch) {
    if (isLoginPage(r2.body)) {
      notify("Cookie 已失效", "签到页要求重新登录，请用浏览器打开论坛登录一次");
      return;
    }
    var pageText = plainText(r2.body).slice(0, 120);
    if (/已经签到|已签到|签到过了/.test(r2.body)) {
      notify("今日已签到", "无需重复签到");
      console.log("sxsy-checkin: 今日已签到 | " + pageText);
      return;
    }
    notify("失败", "没有找到数学题：" + (pageText || "页面为空") + "（详见日志）");
    console.log("sxsy-checkin: 未找到数学题，HTTP " + r2.status + " | " + pageText);
    return;
  }
  var question = questionMatch[1];

  var mathMatch = question.match(/(\d+)\s*([+\-×x*÷\/])\s*(\d+)/);
  if (!mathMatch) {
    notify("数学题格式未知", question);
    console.log("sxsy-checkin: 无法解析题目 " + question);
    return;
  }

  var num1 = Number(mathMatch[1]);
  var operator = mathMatch[2];
  var num2 = Number(mathMatch[3]);
  var answer;
  if (operator === "+") answer = num1 + num2;
  else if (operator === "-") answer = num1 - num2;
  else if (operator === "×" || operator === "x" || operator === "*") answer = num1 * num2;
  else answer = num2 === 0 ? 0 : Math.floor(num1 / num2);
  console.log("sxsy-checkin: 题目 " + question + " = " + answer);

  // ===============================
  // 3. 提交签到
  // ===============================
  var submitUrl = host + "/plugin.php?id=k_misign:sign" +
    "&operation=qiandao" +
    "&format=global_usernav_extra" +
    "&formhash=" + formhash +
    "&mathverify_answer=" + encodeURIComponent(answer) +
    "&inajax=1" +
    "&ajaxtarget=k_misign_mv_tmp";

  var r3 = await get(submitUrl, mathv, "提交签到");
  if (!r3 || !r3.ok) {
    notify("签到失败", "提交请求失败：" + failReason(r3));
    console.log("sxsy-checkin: 提交失败，总耗时 " + (Date.now() - t0) + "ms");
    return;
  }

  var result = plainText(r3.body);
  console.log("sxsy-checkin: 签到结果 HTTP " + r3.status + " | " + result +
    " | 总耗时 " + (Date.now() - t0) + "ms");

  if (/已经签到|已签到|无需重复/.test(result)) {
    notify("今日已签到", result.slice(0, 80));
    return;
  }
  if (result.indexOf("失败") !== -1 ||
      result.indexOf("错误") !== -1 ||
      result.indexOf("失效") !== -1 ||
      result.indexOf("不存在") !== -1) {
    notify("签到失败", result.slice(0, 100) || "未知错误");
  } else {
    notify("签到成功", result.slice(0, 100) || "签到请求完成");
  }
}

if (!hosts.length) {
  console.log("sxsy-checkin: 未配置站点域名");
  notify("未配置站点域名", "请在插件参数「站点域名」中填写当前域名（最新地址见 " + PUBLISH_URL + "）");
  $done();
} else if (!cookie) {
  console.log("sxsy-checkin: 缺少 Cookie");
  notify("缺少 Cookie", "请先用浏览器登录论坛，捕获脚本会自动保存 Cookie");
  $done();
} else {
  (async function () {
    try {
      await main();
    } catch (e) {
      console.log("sxsy-checkin: 执行异常 " + (e && e.message ? e.message : e));
      notify("执行异常", String(e && e.message ? e.message : e));
    }
    $done();
  })();
}
