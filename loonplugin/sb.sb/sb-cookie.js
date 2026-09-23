/**
 * sb.sb 论坛 Cookie 捕获脚本（Request Script）
 * 浏览器访问论坛时自动提取请求头中的 Cookie 并保存。
 * 存储键：sb_forum_cookie / sb_forum_ua
 * 依赖：插件 [Mitm] 已包含论坛域名（HTTPS 请求需解密后才能读到请求头）
 */

var COOKIE_KEY = "sb_forum_cookie";
var UA_KEY = "sb_forum_ua";

var headers = $request.headers || {};
var cookie = headers["Cookie"] || headers["cookie"] || "";
// 若同名 Cookie 头被拆成多段（数组），合并为一段
if (cookie && typeof cookie === "object" && cookie.join) {
  cookie = cookie.join("; ");
}
var ua = headers["User-Agent"] || headers["user-agent"] || "";

if (!cookie) {
  // 未登录或静态资源请求，静默跳过
  console.log("sb-cookie: 请求头中无 Cookie，跳过 " + $request.url);
  $done({});
} else if (cookie.indexOf("bbs_session") === -1) {
  // 只带了非会话 Cookie（如 bbs.viewed 等 JS Cookie），不构成有效登录态，跳过
  console.log("sb-cookie: Cookie 中不含会话（bbs_session），跳过");
  $done({});
} else {
  var old = $persistentStore.read(COOKIE_KEY);
  if (old === cookie) {
    // Cookie 未变化，静默跳过，避免频繁通知
    $done({});
  } else {
    var ok = $persistentStore.write(cookie, COOKIE_KEY);
    if (ua) {
      $persistentStore.write(ua, UA_KEY);
    }
    if (ok) {
      $notification.post(
        "sb.sb 论坛签到",
        "✅ Cookie 捕获成功",
        "论坛 Cookie 已保存，自动签到将按计划执行"
      );
      console.log("sb-cookie: Cookie 已保存，长度 " + cookie.length);
    } else {
      $notification.post("sb.sb 论坛签到", "❌ Cookie 保存失败", "请重启 Loon 后重新访问论坛");
    }
    $done({});
  }
}
