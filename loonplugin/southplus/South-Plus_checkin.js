/**
 * @name South-Plus签到
 * @description South-Plus 日常+周常任务签到
 *
 * 2026-09-27 修订：
 * - 修复：缺 Cookie 时 $done() 后未中断，会继续执行流程并二次通知
 * - 修复：CDATA 正则不跨行，多行内容会被截断
 * - 新增：请求失败/全局异常的日志面包屑与兜底通知
 * - 优化：UA 优先读取捕获脚本保存的 south_ua
 * 流程与判定逻辑未改动（日常 cid=15 / 周常 cid=14）。
 */

var COOKIE_KEY = "south_cookie";
var UA_KEY = "south_ua";

var cookie = $persistentStore.read(COOKIE_KEY);

var base = "https://www.south-plus.net";
var plugin = base + "/plugin.php";

// PHPWind 任务中心 verify 参数（抓包所得）。
// 注意：若未来 Cookie 刷新后签到开始持续报「异常」，可能 verify 也已过期，需重新抓包确认。
var verify = "38dc1030";

var userAgent = $persistentStore.read(UA_KEY) ||
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

function notify(text) {
  $notification.post("South-Plus", text, "");
}

function getHeaders() {
  return {
    "Cookie": cookie,
    "User-Agent": userAgent,
    "Referer": base + "/plugin.php?H_name-tasks.html.html",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9"
  };
}

function get(url) {
  return new Promise(function (resolve) {
    $httpClient.get(
      { url: url, headers: getHeaders(), "auto-cookie": false },
      function (error, response, body) {
        if (error) {
          console.log("sp-checkin: 请求失败 " + error + " | " + url);
          resolve("");
        } else {
          resolve(body || "");
        }
      }
    );
  });
}

function cleanResponse(text) {
  if (!text) return "";
  // [\s\S] 兼容多行 CDATA 内容（旧正则 . 不跨行会被截断）
  var match = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (match) {
    return match[1];
  }
  return text.replace(/<[^>]+>/g, "").trim();
}

async function runTask(name, cid) {
  var result = { name: name, status: "异常", log: "" };

  // 1. 社区论坛任务
  await get(plugin + "?H_name-tasks.html");

  // 2. 新任务选择
  await get(plugin + "?H_name-tasks.html.html");

  // 3. 领取任务
  var jobUrl = plugin + "?H_name=tasks&action=ajax&actions=job&cid=" + cid +
               "&nowtime=" + Date.now() + "&verify=" + verify;
  var jobResult = await get(jobUrl);
  var cleanJob = cleanResponse(jobResult);

  // 领取成功
  if (jobResult.includes("success") && jobResult.includes("完成")) {

    // 4. 进入进行中的任务
    await get(plugin + "?H_name-tasks-actions-newtasks.html.html");

    // 5. 完成任务
    var job2Url = plugin + "?H_name=tasks&action=ajax&actions=job2&cid=" + cid +
                  "&nowtime=" + Date.now() + "&verify=" + verify;
    var job2Result = await get(job2Url);
    var cleanJob2 = cleanResponse(job2Result);

    result.log = "[" + name + "]\n\n领取:\n" + cleanJob + "\n\n完成:\n" + cleanJob2;

    // 完成成功
    if (cleanJob2.includes("已经完成")) {
      result.status = "完成";
    } else {
      result.status = "异常";
    }

  } else {

    result.log = "[" + name + "]\n\n领取:\n" + cleanJob;

    // 已经完成 / 尚未刷新
    if (cleanJob.includes("还没超过") ||
        cleanJob.includes("距离上次") ||
        cleanJob.includes("拒离上次")) {
      result.status = "未刷新";
    } else if (cleanJob.includes("您还没有登录")) {
      result.status = "Cookie失效";
    } else {
      result.status = "异常";
    }
  }

  console.log("sp-checkin: [" + name + "] cid=" + cid + " -> " + result.status);
  return result;
}

if (!cookie) {
  console.log("sp-checkin: 缺少 Cookie，终止执行");
  notify("Cookie 缺失，请先登录论坛（捕获脚本会自动保存）");
  $done();
} else {
  (async function () {
    try {
      console.log("sp-checkin: 开始执行，Cookie " + cookie.length + " 字符");

      var logs = [];

      // 日常
      var daily = await runTask("日常", 15);
      logs.push(daily.log);

      // 周常
      var weekly = await runTask("周常", 14);
      logs.push(weekly.log);

      var logText = logs.join("\n\n================\n\n");
      console.log(logText);

      // 只发送一次通知，内容保持极短
      var notificationText = "日常：" + daily.status + "｜周常：" + weekly.status;
      if (daily.status === "Cookie失效" || weekly.status === "Cookie失效") {
        notificationText = "Cookie失效，请重新登录（浏览论坛一次即可自动更新）";
      }
      notify(notificationText);

    } catch (e) {
      console.log("sp-checkin: 执行异常 " + (e && e.message ? e.message : e));
      notify("执行异常：" + (e && e.message ? e.message : e));
    }

    $done();
  })();
}
