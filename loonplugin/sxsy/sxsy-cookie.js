/**
 * sxsy 论坛 Cookie 捕获脚本（Request Script）
 * 浏览器访问论坛时自动提取请求头中的 Cookie 并保存/刷新。
 *
 * 存储键：
 *   sxsy_cookie     —— 完整 Cookie 串
 *   sxsy_ua         —— User-Agent
 *   sxsy_site_host  —— 【2026-10-30 新增】捕获时的域名，供签到脚本自动择优
 *
 * 2026-10-30 变更：
 * - 域名变化（sxsy45.com → sxsy33.com）导致插件参数不匹配、捕获规则不命中：
 *   插件侧规则已改为正则匹配任意 sxsy/sxyx 域名，本脚本不再依赖任何域名参数。
 * - 记录捕获域名到 sxsy_site_host，签到脚本会优先尝试「最近一次真正登录过的域名」。
 * - 退出登录时 Discuz 会把 xxx_auth 置为 deleted，此情况不覆盖已保存的可用 Cookie。
 */

(function () {
  var COOKIE_KEY = "sxsy_cookie";
  var UA_KEY = "sxsy_ua";
  var HOST_KEY = "sxsy_site_host";

  var req = $request || {};
  var headers = req.headers || {};

  function pickHeader(name) {
    var lower = String(name).toLowerCase();
    for (var k in headers) {
      if (String(k).toLowerCase() === lower) return headers[k];
    }
    return "";
  }

  var cookie = pickHeader("Cookie");
  // 同名 Cookie 头被拆成多段（数组）时合并
  if (cookie && typeof cookie === "object" && cookie.join) {
    cookie = cookie.join("; ");
  }
  var ua = pickHeader("User-Agent");

  function finish() {
    $done({});
  }

  // ---------------- 访客 / 无 Cookie ----------------
  if (!cookie) {
    console.log("sxsy-cookie: 请求头中无 Cookie，跳过 " + req.url);
    return finish();
  }

  // ---------------- 解析键名（只用于判断与日志，不落盘 Cookie 值） ----------------
  var pairs = String(cookie).split(";").map(function (s) {
    return s.trim();
  }).filter(Boolean);

  var keys = pairs.map(function (p) {
    return p.split("=")[0].trim();
  });

  function valueOf(key) {
    for (var i = 0; i < pairs.length; i++) {
      var idx = pairs[i].indexOf("=");
      if (idx > 0 && pairs[i].slice(0, idx).trim() === key) {
        return pairs[i].slice(idx + 1).trim();
      }
    }
    return "";
  }

  // Discuz 会话识别：键名以 _auth 结尾（前缀随域名/重装变化，不写死）
  var authKey = keys.filter(function (k) {
    return /(^|_)auth$/i.test(k);
  })[0];

  if (!authKey) {
    console.log("sxsy-cookie: 未识别会话键（可能未登录），跳过。检测到键: " + keys.join(", "));
    return finish();
  }

  // 已退出登录：Discuz 会把 _auth 写成 deleted，别用它覆盖可用的旧 Cookie
  if (/^deleted$/i.test(String(valueOf(authKey)).trim())) {
    console.log("sxsy-cookie: 检测到 " + authKey + "=deleted（已退出登录），保留旧 Cookie 不覆盖");
    return finish();
  }

  // ---------------- 保存 ----------------
  var old = $persistentStore.read(COOKIE_KEY);
  if (old === cookie) {
    // Cookie 未变化，静默跳过，避免频繁通知
    return finish();
  }

  // 从 URL 提取域名，供签到脚本择优
  var hostMatch = String(req.url || "").match(/^https?:\/\/([^\/:?#]+)/i);
  // www. 归一化，避免签到脚本把 www 当成独立域名
  var host = hostMatch ? hostMatch[1].toLowerCase().replace(/^www\./, "") : "";
  var oldHost = $persistentStore.read(HOST_KEY) || "";

  var ok = $persistentStore.write(cookie, COOKIE_KEY);
  if (!ok) {
    console.log("sxsy-cookie: 写入持久化存储失败");
    $notification.post("sxsy签到", "❌ Cookie 保存失败", "请重启 Loon 后重新访问论坛");
    return finish();
  }

  if (ua) $persistentStore.write(ua, UA_KEY);
  if (host) $persistentStore.write(host, HOST_KEY);

  var hostNote = "";
  if (host && !oldHost) hostNote = "（域名: " + host + "）";
  else if (host && host !== oldHost) hostNote = "（域名已更新为 " + host + "）";
  $notification.post(
    "sxsy签到",
    old ? "🔄 Cookie 已自动刷新" : "✅ Cookie 捕获成功",
    "会话键: " + authKey + hostNote
  );
  console.log("sxsy-cookie: Cookie 已保存，长度 " + cookie.length +
    "，会话键 " + authKey + "，域名 " + host + "（原 " + (oldHost || "无") + "）");

  return finish();
})();
