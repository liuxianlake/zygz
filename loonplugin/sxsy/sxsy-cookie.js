/**
 * sxsy 论坛 Cookie 捕获脚本（Request Script）
 * 浏览器访问论坛时自动提取请求头中的 Cookie 并保存/刷新。
 * 存储键：sxsy_cookie（跨域名稳定，与 sxsy_checkin.js 读取的键一致）/ sxsy_ua
 * 依赖：插件 [Mitm] 通配符 sxsy*.com 已覆盖域名变化，无需手动维护
 */

var COOKIE_KEY = "sxsy_cookie";
var UA_KEY = "sxsy_ua";

var headers = $request.headers || {};
var cookie = headers["Cookie"] || headers["cookie"] || "";
// 若同名 Cookie 头被拆成多段（数组），合并为一段
if (cookie && typeof cookie === "object" && cookie.join) {
  cookie = cookie.join("; ");
}
var ua = headers["User-Agent"] || headers["user-agent"] || "";

if (!cookie) {
  // 未登录或静态资源请求，静默跳过
  console.log("sxsy-cookie: 请求头中无 Cookie，跳过 " + $request.url);
  $done({});
} else {
  // 解析 Cookie 键名（只用于判断与日志，不记录值）
  var keys = cookie.split(";").map(function (k) {
    return k.split("=")[0].trim();
  }).filter(Boolean);

  // Discuz 会话识别：键名以 _auth 结尾（前缀随域名可能变化，不写死）
  var isSession = keys.some(function (k) {
    return /(^|_)auth$/i.test(k);
  });

  if (!isSession) {
    console.log("sxsy-cookie: 未识别会话键，跳过保存。检测到键: " + keys.join(", "));
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
          "sxsy签到",
          old ? "🔄 Cookie 已自动刷新" : "✅ Cookie 捕获成功",
          "会话 Cookie 已保存（键: " + keys.join(", ") + "）"
        );
        console.log("sxsy-cookie: Cookie 已保存，长度 " + cookie.length + "，键: " + keys.join(", "));
      } else {
        $notification.post("sxsy签到", "❌ Cookie 保存失败", "请重启 Loon 后重新访问论坛");
      }
      $done({});
    }
  }
}
