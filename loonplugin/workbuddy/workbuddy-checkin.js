/**
 * WorkBuddy 自动签到（Loon）
 *
 * 配合同插件内的「登录态捕获」规则使用：捕获规则把 token 存进本地存储，
 * 本脚本定时拿去签到。App 自己会刷新登录态，捕获规则每次都会存到最新值，
 * 所以这里不需要也不应该自己刷新 token（跨端争用会导致掉登录）。
 *
 * 失败重试：插件按 7/11/15/19/23 点多次触发。一旦当天确认签到完成，
 * 就写「今日已完成」标记，后续时点读到标记直接退出、连请求都不发。
 *
 * 判断"今天"以服务端为准：接口返回 data.checkin_dates，
 * checkin_dates[0] 即服务端最近签到日期。只有它等于本地今天才标记，
 * 避免服务端换天时间与本地不一致时误判漏签。
 *
 * 通知格式（两行）：
 *   WorkBuddy 签到        ← title，固定站点名，与同插件其他脚本一致
 *   ✅ 签到成功            ← subtitle，状态图标 + 结论
 *   📊 +100 积分 · 连签 53 天  ← content，一行一字段
 *
 * 积分值取自签到接口返回的 data.credit（真实值，非写死）：官方若调整
 * 每日分值，通知会随之变化；两个来源都取不到时显示 ?，不编造数字。
 *
 * 参数：
 *   notify_when_signed —— 已签到时是否也通知，默认关
 */

(function () {
  var TOKEN_KEY = "wb_access_token";
  var UID_KEY = "wb_user_id";
  var HOST_KEY = "wb_token_host";
  var FAIL_KEY = "wb_fail_notify_date";
  var SIGNED_KEY = "wb_signed_date";

  var STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
  var CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
  var ALREADY_CODE = 10001;

  var arg = (typeof $argument === "object" && $argument !== null) ? $argument : {};
  var NOTIFY_SIGNED = (arg.notify_when_signed === true ||
    String(arg.notify_when_signed || "").toLowerCase() === "true");

  function done() {
    $done({});
  }

  // 通知标题固定站点名，与同插件内的登录态捕获脚本保持一致
  var NOTIFY_TITLE = "WorkBuddy 签到";

  // 三行通知：title 固定站点名 / subtitle 状态图标 + 结论 / content 明细
  function notify(subtitle, content) {
    $notification.post(NOTIFY_TITLE, subtitle || "",
      (content === undefined || content === null) ? "" : String(content));
    console.log("[WB-CK] " + NOTIFY_TITLE + " | " + (subtitle || "") + " | " + (content || ""));
  }

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function num(v) {
    return (typeof v === "number" && isFinite(v)) ? v : null;
  }

  // 失败类提醒每天只弹一次，重试点不重复打扰
  function notifyFail(subtitle, content) {
    var today = todayStr();
    if ($persistentStore.read(FAIL_KEY) === today) {
      console.log("[WB-CK] 今日已提示过失败，静默：" + subtitle);
      return;
    }
    $persistentStore.write(today, FAIL_KEY);
    notify(subtitle, content);
  }

  function request(url, cb) {
    var token = String($persistentStore.read(TOKEN_KEY) || "").trim();
    var uid = String($persistentStore.read(UID_KEY) || "").trim();
    var headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    if (uid) headers["X-User-Id"] = uid;
    $httpClient.post({ url: url, headers: headers, body: "{}" }, function (err, resp, data) {
      if (err) {
        console.log("[WB-CK] 网络错误: " + err + " " + url);
        return cb(err, 0, null);
      }
      var status = (resp && resp.status) ? resp.status : 0;
      var body = null;
      try {
        body = JSON.parse(data || "{}");
      } catch (e) {
        body = null;
      }
      cb(null, status, body);
    });
  }

  var today = todayStr();

  // 今天已完成过：直接退出，不联网
  if ($persistentStore.read(SIGNED_KEY) === today) {
    console.log("[WB-CK] 今日已完成签到，跳过（不发请求）");
    return done();
  }

  var token = String($persistentStore.read(TOKEN_KEY) || "").trim();
  if (!token) {
    notifyFail("❌ 还没有登录态", "📱 打开一次 App 即可自动捕获");
    return done();
  }

  var savedHost = String($persistentStore.read(HOST_KEY) || "").trim();

  var hosts = [];
  if (savedHost) hosts.push(savedHost);
  ["copilot.tencent.com", "www.workbuddy.cn"].forEach(function (h) {
    if (hosts.indexOf(h) < 0) hosts.push(h);
  });

  var idx = 0;

  function nextHost() {
    if (idx >= hosts.length) {
      notifyFail("❌ 登录态已失效", "📱 打开一次 App 即可自动恢复");
      return done();
    }
    var base = "https://" + hosts[idx++];
    console.log("[WB-CK] 尝试网关 " + base);

    request(base + STATUS_PATH, function (err, status, body) {
      if (err || status !== 200 || !body) {
        console.log("[WB-CK] 网关不可用 " + base + " status=" + status);
        return nextHost();
      }

      var d = (body.data && typeof body.data === "object") ? body.data : {};
      var streak = num(d.streak_days);
      var todayCredit = num(d.today_credit);
      var signed = (d.today_checked_in === true) || (body.code === ALREADY_CODE);

      if (signed) {
        var dates = Array.isArray(d.checkin_dates) ? d.checkin_dates : null;
        var latest = (dates && dates.length) ? String(dates[0]) : "";
        var trusted = (latest === "") || (latest === today);

        if (trusted) {
          $persistentStore.write(today, SIGNED_KEY);
          console.log("[WB-CK] 今天已签到（服务端 " + (latest || today) + "），已标记，后续时点不再查询");
          if (NOTIFY_SIGNED) {
            var c = (todayCredit !== null) ? todayCredit : num(d.daily_credit);
            notify(
              "✅ 今日已签到",
              "📊 " + (c !== null ? c : "?") + " 积分 · 连签 " + (streak !== null ? streak : "?") + " 天"
            );
          }
        } else {
          console.log("[WB-CK] 服务端最新签到日 " + latest + " 不是今天，等换天后重试");
        }
        return done();
      }

      // 未签到，执行
      request(base + CHECKIN_PATH, function (err2, status2, body2) {
        if (err2 || !body2) {
          notifyFail("❌ 签到请求失败", "📡 " + String(err2 || "无响应"));
          return done();
        }
        var d2 = (body2.data && typeof body2.data === "object") ? body2.data : {};
        var streak2 = num(d2.streak_days);
        if (streak2 === null) streak2 = streak;

        if (status2 === 200 && (num(d2.credit) !== null || body2.code === 0)) {
          $persistentStore.write(today, SIGNED_KEY);
          var credit = num(d2.credit);
          if (credit === null) credit = todayCredit;
          notify(
            "✅ 签到成功",
            "📊 +" + (credit !== null ? credit : "?") + " 积分 · 连签 " + (streak2 !== null ? streak2 : "?") + " 天"
          );
        } else if (body2.code === ALREADY_CODE) {
          $persistentStore.write(today, SIGNED_KEY);
          if (NOTIFY_SIGNED) {
            notify(
              "✅ 今日已签到",
              "📊 " + (todayCredit !== null ? todayCredit : "?") + " 积分 · 连签 " + (streak2 !== null ? streak2 : "?") + " 天"
            );
          } else {
            console.log("[WB-CK] 服务端判定已签到，已标记");
          }
        } else {
          notifyFail("⚠️ 签到未成功",
            "📡 HTTP " + status2 + " · " + String(body2.msg || body2.error || ""));
        }
        return done();
      });
    });
  }

  nextHost();
})();
