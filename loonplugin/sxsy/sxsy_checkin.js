/**
 * @name sxsy 自动签到
 * @description sxsy 论坛（Discuz! k_misign 签到插件）自动签到，数学题自动计算
 *
 * 2026-09-27 新语法版：
 * - 站点域名改为插件参数（$argument.site_host），换域名只需改插件参数「站点域名」
 * - Cookie 键改为 sxsy_cookie（跨域名稳定；兼容读取旧 sxsy13_cookie）
 * - mathv Cookie 正则泛化：不再写死 u52q_2132_ 前缀（域名更换后 Discuz 前缀变化也能匹配）
 * - CDATA 正则支持多行；补日志面包屑；全局异常兜底
 * 流程与判定逻辑未改动：formhash → 数学题 → 计算答案 → 提交。
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

var cookie = $persistentStore.read(COOKIE_KEY) || $persistentStore.read(LEGACY_COOKIE_KEY);
var userAgent = $persistentStore.read(UA_KEY) ||
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

function notify(subtitle, content) {
  $notification.post("sxsy签到", subtitle, content || "");
}

// GET 请求：返回 {status, headers, body}，失败返回 null
function get(url, extraCookie) {
  return new Promise(function (resolve) {
    var headers = {
      "User-Agent": userAgent,
      "Referer": "https://" + siteHost + "/index.php?mobile=2",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9"
    };
    headers["Cookie"] = String(cookie) + (extraCookie ? ";" + extraCookie : "");
    $httpClient.get(
      { url: url, headers: headers },
      function (error, response, body) {
        if (error) {
          console.log("sxsy-checkin: 请求失败 " + error + " | " + url);
          resolve(null);
        } else {
          resolve({
            status: response ? response.status : 0,
            headers: (response && response.headers) || {},
            body: String(body || "")
          });
        }
      }
    );
  });
}

// 提取 CDATA 内容（[\s\S] 兼容多行）
function cleanCdata(text) {
  var m = String(text || "").match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : String(text || "");
}

async function main() {
  var host = "https://" + siteHost;
  console.log("sxsy-checkin: 开始执行，站点 " + siteHost);

  // ===============================
  // 1. 获取 formhash
  // ===============================
  var r1 = await get(host + "/index.php?mobile=2");
  if (!r1) {
    notify("首页请求失败", "网络错误，详见日志");
    return;
  }

  // formhash 提取：键名引号可选（兼容 'formhash':'x' 与 formhash:'x'），分隔兼容 : 与 =
  // （旧正则要求键名必须带引号，页面模板一变就抓不到）
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

  var r2 = await get(questionUrl);
  if (!r2) {
    notify("获取题目失败", "网络错误，详见日志");
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
    console.log("sxsy-checkin: 未找到数学题，HTTP " + r2.status);
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

  var r3 = await get(submitUrl, mathv);
  if (!r3) {
    notify("签到失败", "网络错误，详见日志");
    return;
  }

  var result = cleanCdata(r3.body).replace(/<[^>]*>/g, "").trim();
  console.log("sxsy-checkin: 签到结果 HTTP " + r3.status + " | " + result);

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
