/**
 * WorkBuddy 登录态捕获脚本（Request Script）
 *
 * 手机端任何走 workbuddy 域名的请求都会经过这里，从请求头取出
 *   Authorization: Bearer <accessToken>
 *   X-User-Id: <uid>
 * 写入 Loon 本地存储，供「WorkBuddy 自动签到」定时脚本直接复用。
 * 这样一来不需要手工粘贴 token，App 每次刷新登录态也会自动同步过来。
 *
 * 存储键：
 *   wb_access_token —— 裸 accessToken（已去掉 "Bearer " 前缀）
 *   wb_user_id      —— X-User-Id
 *   wb_host         —— 最近一次命中的域名
 *   wb_token_ts     —— 最近一次捕获时间（毫秒时间戳）
 *
 * 安全约定：
 *   - 绝不把 token 内容写进日志或通知，只输出长度
 *   - 不修改请求，原样放行
 */

(function () {
  var TOKEN_KEY = "wb_access_token";
  var UID_KEY = "wb_user_id";
  var HOST_KEY = "wb_host";
  var TS_KEY = "wb_token_ts";
  var SEEN_KEY = "wb_probe_seen";
  var TOKEN_HOST_KEY = "wb_token_host";

  var req = $request || {};
  var url = String(req.url || "");
  var headers = req.headers || {};

  function finish() {
    $done({});
  }

  function pickHeader(name) {
    var lower = String(name).toLowerCase();
    for (var k in headers) {
      if (String(k).toLowerCase() === lower) {
        var v = headers[k];
        return (v && typeof v === "object" && v.join) ? v.join(" ") : v;
      }
    }
    return "";
  }

  function getHost(u) {
    var m = String(u).match(/^https?:\/\/([^\/:?#]+)/i);
    return m ? m[1].toLowerCase() : "";
  }

  var host = getHost(url);
  // 双保险：插件侧正则已筛过一遍，这里再确认域名。
  // 手机 App 走 copilot.tencent.com，PC 与 H5 走 workbuddy/codebuddy，三套都覆盖。
  if (!/workbuddy|codebuddy|copilot\.tencent/i.test(host)) {
    return finish();
  }

  var auth = pickHeader("Authorization");
  var uid = pickHeader("X-User-Id") ||
            pickHeader("x-uid") ||
            pickHeader("X-OneId-Uid") ||
            pickHeader("X-Userid");

  var token = String(auth || "").replace(/^\s*Bearer\s+/i, "").trim();
  var uidStr = String(uid || "").trim();

  console.log("[WB] " + (req.method || "GET") + " " + host +
    " authLen=" + token.length + " uidLen=" + uidStr.length);

  // 探针自检：第一次命中任意请求就通知一次，用来确认规则与 MitM 是否真生效。
  // 即使这条请求没带 token，也说明脚本确实跑起来了（避免"没通知=没工作"的误判）。
  if (!$persistentStore.read(SEEN_KEY)) {
    $persistentStore.write("1", SEEN_KEY);
    $notification.post(
      "WorkBuddy 探针",
      "✅ 规则已命中",
      host + " · authLen=" + token.length + " uidLen=" + uidStr.length
    );
  }

  if (!token) {
    // 这条请求没带 Bearer（静态资源、或 Cookie 鉴权的接口），跳过
    return finish();
  }

  var oldToken = $persistentStore.read(TOKEN_KEY) || "";
  var oldUid = $persistentStore.read(UID_KEY) || "";

  var ok = $persistentStore.write(token, TOKEN_KEY);
  if (!ok) {
    console.log("[WB] 持久化写入失败");
    $notification.post("WorkBuddy 签到", "❌ 登录态保存失败", "请重启 Loon 后重新打开 App");
    return finish();
  }

  if (uidStr) $persistentStore.write(uidStr, UID_KEY);
  if (host) {
    $persistentStore.write(host, HOST_KEY);
    // 记录令牌来源网关：签到脚本据此选 www.workbuddy.cn 还是 copilot.tencent.com
    $persistentStore.write(host, TOKEN_HOST_KEY);
  }
  $persistentStore.write(String(Date.now()), TS_KEY);

  if (!oldToken) {
    // 首次捕获才打扰一次，之后刷新静默
    $notification.post(
      "WorkBuddy 签到",
      "✅ 登录态捕获成功",
      "域名 " + host + "，令牌长度 " + token.length
    );
  } else if (oldToken !== token) {
    console.log("[WB] 登录态已刷新：长度 " + oldToken.length + " → " + token.length);
  }

  if (!uidStr) {
    console.log("[WB] 提示：该请求未带 X-User-Id，签到脚本将不发送此头");
  } else if (!oldUid && uidStr) {
    console.log("[WB] 已捕获 X-User-Id，长度 " + uidStr.length);
  }

  return finish();
})();
