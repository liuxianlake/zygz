/**
 * @name sxsy 自动签到
 * @description sxsy 论坛（Discuz! k_misign 签到插件）自动签到，数学题自动计算
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

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};

// 站点域名：来自插件参数，容错处理（去协议、去路径、去尾部斜杠）
var siteHost = String(arg.site_host || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/.*$/, "")
  .replace(/\/$/, "");

// 单次请求超时（毫秒）：默认 5s 太短，签到页经常来不及返回
var REQ_TIMEOUT = Number(arg.req_timeout || 20000);
if (!(REQ_TIMEOUT > 0)) REQ_TIMEOUT = 20000;

// 单个请求最多尝试次数
var MAX_ATTEMPTS = 3;

var cookie = $persistentStore.read(COOKIE_KEY) || $persistentStore.read(LEGACY_COOKIE_KEY);
var userAgent = $persistentStore.read(UA_KEY) ||
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

function notify(subtitle, content) {
  $notification.post("sxsy签到", subtitle, content || "");
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// 单次 GET：返回 {ok, status, headers, body, cost} 或 {ok:false, error, cost}
function rawGet(url, extraCookie, timeout) {
  return new Promise(function (resolve) {
    var headers = {
      "User-Agent": userAgent,
      "Referer": "https://" + siteHost + "/index.php?mobile=2",
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

// 失败提示里带上最后一次的错误原因，避免只看到"网络错误"
function failReason(r) {
  if (!r) return "无响应";
  if (!r.ok) return r.error;
  return "HTTP " + r.status;
}

async function main() {
  var host = "https://" + siteHost;
  var t0 = Date.now();
  console.log("sxsy-checkin: 开始执行，站点 " + siteHost + "，超时 " + REQ_TIMEOUT + "ms × " + MAX_ATTEMPTS + " 次");

  // ===============================
  // 1. 获取 formhash
  // ===============================
  var r1 = await get(host + "/index.php?mobile=2", "", "首页");
  if (!r1 || !r1.ok) {
    notify("首页请求失败", failReason(r1) + "（详见日志）");
    return;
  }

  // formhash 提取：键名引号可选（兼容 'formhash':'x' 与 formhash:'x'），分隔兼容 : 与 =
  var formhashMatch = r1.body.match(/['"]?formhash['"]?\s*[:=]\s*["']([^"']+)["']/);
  if (!formhashMatch) {
    notify("失败", "没有找到 formhash（Cookie 可能已失效，请重新登录论坛一次）");
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
    notify("获取题目失败", failReason(r2));
    console.log("sxsy-checkin: 取题目失败，耗时 " + (Date.now() - t0) + "ms");
    return;
  }

  // mathv Cookie：前缀随域名可能变化（旧版写死 u52q_2132_），改为泛化匹配
  var setCookie = r2.headers["set-cookie"] || r2.headers["Set-Cookie"] || "";
  var mathvMatch = String(setCookie).match(/([a-z0-9_]*k_misign_mathv=[^;, ]+)/i);
  var mathv = mathvMatch ? mathvMatch[1] : "";
  if (!mathv) {
    console.log("sxsy-checkin: 未发现 mathv Cookie（可能已签到过，继续尝试提交）");
  }

  var questionMatch = r2.body.match(/var q="([^"]+)"/);
  if (!questionMatch) {
    notify("失败", "没有找到数学题（可能今日已签到，或 Cookie 失效）");
    console.log("sxsy-checkin: 未找到数学题，HTTP " + r2.status + " | " + r2.body.slice(0, 200));
    return;
  }
  var question = questionMatch[1];

  var mathMatch = question.match(/(\d+)\s*([+-])\s*(\d+)/);
  if (!mathMatch) {
    notify("失败", question);
    return;
  }

  var num1 = Number(mathMatch[1]);
  var operator = mathMatch[2];
  var num2 = Number(mathMatch[3]);
  var answer = operator === "+" ? num1 + num2 : num1 - num2;
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

  var result = cleanCdata(r3.body).replace(/<[^>]*>/g, "").trim();
  console.log("sxsy-checkin: 签到结果 HTTP " + r3.status + " | " + result +
    " | 总耗时 " + (Date.now() - t0) + "ms");

  if (result.indexOf("失败") !== -1 ||
      result.indexOf("错误") !== -1 ||
      result.indexOf("失效") !== -1 ||
      result.indexOf("不存在") !== -1) {
    notify("签到失败", result || "未知错误");
  } else {
    notify("签到成功", result || "签到请求完成");
  }
}

if (!siteHost) {
  console.log("sxsy-checkin: 未配置站点域名");
  notify("未配置站点域名", "请在插件参数「站点域名」中填写当前域名（如 sxsy46.com）");
  $done();
} else if (!cookie) {
  console.log("sxsy-checkin: 缺少 Cookie");
  notify("缺少 Cookie", "请先登录论坛，捕获脚本会自动保存 Cookie");
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
