/**
 * WorkBuddy 自动签到（Loon）
 *
 * 配合「WorkBuddy 登录态捕获」插件使用：捕获脚本把 token 存进本地存储，
 * 本脚本定时拿去签到。App 自己会刷新登录态，捕获脚本每次都能存到最新值，
 * 所以这里不需要也不应该自己刷新 token（跨端争用会导致掉登录）。
 *
 * 失败重试：插件按 7/11/15/19/23 点多次触发，本脚本每次先查状态，
 * 已签到就静默退出，所以失败后会自动在下一个时间点重试，成功后其余
 * 时段只剩一次查询、不会重复领取（接口本身也幂等）。
 *
 * 存储键（由捕获脚本写入）：
 *   wb_access_token —— 裸 accessToken
 *   wb_user_id      —— X-User-Id（App 请求可能不带，缺失时就不发这个头）
 *   wb_token_host   —— 令牌来源网关，决定签到打哪个域名
 *
 * 两个网关都提供同一套 billing 接口：
 *   手机 App → copilot.tencent.com
 *   PC / H5 → www.workbuddy.cn
 * 脚本按来源优先，失败自动换另一个。
 *
 * 登录态失效时会推通知提示「打开一次 App 即可自动恢复」——
 * 因为打开 App 就会产生带 Bearer 的请求，捕获脚本立即更新 token。
 * 同一天内失败只提醒一次，避免每个重试点都弹窗。
 *
 * 参数：
 *   notify_when_signed —— 已签到时是否也通知，默认关
 */

(function () {
  var TOKEN_KEY = "wb_access_token";
  var UID_KEY = "wb_user_id";
  var HOST_KEY = "wb_token_host";
  var FAIL_KEY = "wb_fail_notify_date";

  var STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
  var CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
  var ALREADY_CODE = 10001;

  var arg = (typeof $argument === "object" && $argument !== null) ? $argument : {};
  var NOTIFY_SIGNED = (arg.notify_when_signed === true ||
    String(arg.notify_when_signed || "").toLowerCase() === "true");

  var token = String($persistentStore.read(TOKEN_KEY) || "").trim();
  var uid = String($persistentStore.read(UID_KEY) || "").trim();
  var savedHost = String($persistentStore.read(HOST_KEY) || "").trim();

  function done() {
    $done({});
  }

  function notify(title, content) {
    $notification.post("WorkBuddy 签到", title, content || "");
    console.log("[WB-CK] " + title + " | " + (content || ""));
  }

  function todayStr() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  // 失败类提醒每天只弹一次，重试点不重复打扰
  function notifyFail(title, content) {
    var today = todayStr();
    if ($persistentStore.read(FAIL_KEY) === today) {
      console.log("[WB-CK] 今日已提示过失败，静默：" + title);
      return;
    }
    $persistentStore.write(today, FAIL_KEY);
    notify(title, content);
  }

  function request(url, cb) {
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

  if (!token) {
    notifyFail("❌ 还没有登录态", "请安装「WorkBuddy 登录态捕获」并打开一次 App");
    return done();
  }

  // 网关择优：来源优先，再补另一个
  var hosts = [];
  if (savedHost) hosts.push(savedHost);
  ["copilot.tencent.com", "www.workbuddy.cn"].forEach(function (h) {
    if (hosts.indexOf(h) < 0) hosts.push(h);
  });

  var idx = 0;

  function nextHost() {
    if (idx >= hosts.length) {
      notifyFail("❌ 登录态已失效", "打开一次 App 即可自动恢复");
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
      var streak = (typeof d.streak_days === "number") ? d.streak_days : "?";
      var signed = (d.today_checked_in === true) || (body.code === ALREADY_CODE);

      if (signed) {
        console.log("[WB-CK] 今天已签到，连签 " + streak + " 天，跳过");
        if (NOTIFY_SIGNED) notify("今日已签到", "连签 " + streak + " 天");
        return done();
      }

      // 未签到，执行
      request(base + CHECKIN_PATH, function (err2, status2, body2) {
        if (err2 || !body2) {
          notifyFail("❌ 签到请求失败", String(err2 || "无响应"));
          return done();
        }
        var d2 = (body2.data && typeof body2.data === "object") ? body2.data : {};
        var streak2 = (typeof d2.streak_days === "number") ? d2.streak_days : "?";

        if (status2 === 200 && (typeof d2.credit === "number" || body2.code === 0)) {
          var gain = (typeof d2.credit === "number") ? ("+" + d2.credit + " 积分 · ") : "";
          notify("✅ 签到成功", gain + "连签 " + streak2 + " 天");
        } else if (body2.code === ALREADY_CODE) {
          if (NOTIFY_SIGNED) notify("今日已签到", "无需重复");
          else console.log("[WB-CK] 服务端判定已签到");
        } else {
          notifyFail("⚠️ 未签到成功", "HTTP " + status2 + " · " + String(body2.msg || body2.error || ""));
        }
        return done();
      });
    });
  }

  nextHost();
})();
