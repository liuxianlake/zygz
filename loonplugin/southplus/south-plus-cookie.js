/**
 * South-Plus 论坛 Cookie 捕获脚本（Request Script）
 * 浏览器访问论坛时自动提取请求头中的 Cookie 并保存/刷新。
 * 存储键：south_cookie（与 South-Plus_checkin.js 读取的键一致）/ south_ua
 * 依赖：插件 [Mitm] 已包含论坛域名（HTTPS 请求需解密后才能读到请求头）
 *
 * 说明：论坛 Cookie 有效期约一年，过期后无需手动操作——
 * 重新登录论坛时本脚本会自动用新 Cookie 覆盖旧值并通知。
 */

var COOKIE_KEY = "south_cookie";
var UA_KEY = "south_ua";

/**
 * 会话 Cookie 识别：只有包含至少一个会话键才保存，
 * 避免「仅 JS 埋点 Cookie」的请求把有效会话覆盖掉。
 * 如果浏览论坛后收到「未识别会话键」的日志，把日志里的键名发给我补充到列表。
 */
var SESSION_MARKERS = [
  "pw_user", "pw_pass", "pwck", "winduser",   // PHPWind 系
  "cdb_auth", "cdb_sid", "auth", "uid"        // Discuz 系 / 通用
];

var headers = $request.headers || {};
var cookie = headers["Cookie"] || headers["cookie"] || "";
// 若同名 Cookie 头被拆成多段（数组），合并为一段
if (cookie && typeof cookie === "object" && cookie.join) {
  cookie = cookie.join("; ");
}
var ua = headers["User-Agent"] || headers["user-agent"] || "";

if (!cookie) {
  // 未登录或静态资源请求，静默跳过
  console.log("sp-cookie: 请求头中无 Cookie，跳过 " + $request.url);
  $done({});
} else {
  // 解析 Cookie 键名（只用于判断与日志，不记录值）
  var keys = cookie.split(";").map(function (k) {
    return k.split("=")[0].trim();
  }).filter(Boolean);

  var isSession = SESSION_MARKERS.some(function (m) {
    return keys.indexOf(m) !== -1;
  });

  if (!isSession) {
    console.log("sp-cookie: 未识别会话键，跳过保存。检测到键: " + keys.join(", "));
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
          "South-Plus 签到",
          old ? "🔄 Cookie 已自动刷新" : "✅ Cookie 捕获成功",
          "会话 Cookie 已保存（键: " + keys.join(", ") + "）"
        );
        console.log("sp-cookie: Cookie 已保存，长度 " + cookie.length + "，键: " + keys.join(", "));
      } else {
        $notification.post("South-Plus 签到", "❌ Cookie 保存失败", "请重启 Loon 后重新访问论坛");
      }
      $done({});
    }
  }
}
