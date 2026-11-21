/**
 * WorkBuddy 自动签到（Loon）
 *
 * 配合「WorkBuddy 登录态捕获」插件使用：捕获脚本把 token 存进本地存储，
 * 本脚本定时拿去签到。App 自己会刷新登录态，捕获脚本每次都能存到最新值，
 * 所以这里不需要也不应该自己刷新 token（跨端争用会导致掉登录）。
 *
 * 失败重试：插件按 7/11/15/19/23 点多次触发。一旦当天确认签到完成，
 * 就写一个「今日已完成」标记，后续时点读到标记直接退出、连请求都不发。
 *
 * 判断"今天"完全以服务端为准：
 * 接口返回 data.checkin_dates（形如 ["2026-11-21","2026-11-20",...]），
 * checkin_dates[0] 就是服务端最近一次签到日期。只有它等于本地今天，
 * 才认为今天已完成 —— 这样即使服务端换天时间与本地不同，也不会误判漏签。
 *
 * 存储键（由捕获脚本写入）：
 *   wb_access_token —— 裸 accessToken
 *   wb_user_id      —— X-User-Id（App 请求可能不带，缺失时就不发这个头）
 *   wb_token_host   —— 令牌来源网关，决定签到打哪个域名
 * 本脚本写入：
 *   wb_signed_date       —— 已完成签到的日期（本地 YYYY-MM-DD）
 *   wb_fail_notify_date  —— 失败提醒节流用
 *
 * 两个网关都提供同一套 billing 接口：
 *   手机 App → copilot.tencent.com
 *   PC / H5 → www.workbuddy.cn
 * 脚本按来源优先，失败自动换另一个。
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

  function notify(title, content) {
    $notification.post("WorkBuddy 签到", title, content || "");
    console.log("[WB-CK] " + title + " | " + (content || ""));
  }

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
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
    notifyFail("❌ 还没有登录态", "请安装「WorkBuddy 登录态捕获」并打开一次 App");
    return done();
  }

  var savedHost = String($persistentStore.read(HOST_KEY) || "").trim();

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
        // 以服务端签到日期为准，避免把"昨天的已签"当成今天
        var dates = Array.isArray(d.checkin_dates) ? d.checkin_dates : null;
        var latest = (dates && dates.length) ? String(dates[0]) : "";
        var trusted = (latest === "") || (latest === today);

        if (trusted) {
          $persistentStore.write(today, SIGNED_KEY);
          console.log("[WB-CK] 今天已签到（服务端 " + (latest || today) + "），已标记，后续时点不再查询");
          if (NOTIFY_SIGNED) notify("今日已签到", "连签 " + streak + " 天");
        } else {
          console.log("[WB-CK] 服务端最新签到日 " + latest + " 不是今天，等换天后重试");
        }
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
          $persistentStore.write(today, SIGNED_KEY);
          var gain = (typeof d2.credit === "number") ? ("+" + d2.credit + " 积分 · ") : "";
          notify("✅ 签到成功", gain + "连签 " + streak2 + " 天");
        } else if (body2.code === ALREADY_CODE) {
          $persistentStore.write(today, SIGNED_KEY);
          if (NOTIFY_SIGNED) notify("今日已签到", "无需重复");
          else console.log("[WB-CK] 服务端判定已签到，已标记");
        } else {
          notifyFail("⚠️ 未签到成功", "HTTP " + status2 + " · " + String(body2.msg || body2.error || ""));
        }
        return done();
      });
    });
  }

  nextHost();
})();
