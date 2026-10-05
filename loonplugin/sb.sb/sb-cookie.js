/**
 * sb.sb（烧饼论坛）Cookie 捕获脚本（Request Script）v2
 *
 * ── 2026-10-05 改版说明（核心：不再每次浏览都覆盖）──────────────────────────
 * 旧版缺陷：
 *   1) 只校验「Cookie 里存在会话键（bbs_session）」，但**游客态/登录中途的会话同样带该键**，
 *      于是未登录的 Cookie 会覆盖掉原本可用的登录态 Cookie → 下次签到必失败。
 *   2) 只要 Cookie 字符串一变就立即写入，没有任何节流/校验，
 *      登录流程里连续多个请求会反复覆盖，落盘的可能不是权威值。
 *
 * 新版策略：
 *   · auto 模式（默认）：仅在「从未捕获过」或「签到脚本已标记失效」时才尝试捕获；
 *     已有可用 Cookie 时，浏览论坛/重新登录都不会覆盖它 —— 即「失效后才捕获」。
 *   · always 模式：每次浏览都校验并更新（慎用）。
 *   · 无论哪种模式，**写入前都用候选 Cookie 访问一次签到页**：
 *       是「已登录」页面（无密码框、含 _csrf）才保存；
 *       是游客/未登录页面则直接丢弃，绝不污染已存的好 Cookie。
 *
 * 存储键：
 *   sb_forum_cookie          登录 Cookie
 *   sb_forum_ua              捕获时的 User-Agent
 *   sb_forum_cookie_ts       捕获时间戳
 *   sb_forum_cookie_host     捕获来源主机（诊断用）
 *   sb_forum_cookie_tried    最近一次被校验的候选值（去重，避免重复校验/打扰）
 *   sb_forum_cookie_tryts    最近一次校验时间
 *   sb_forum_cookie_invalid  由签到脚本写入 "1" 表示现存 Cookie 已失效 → 允许重新捕获
 *
 * $argument（由插件传入）：
 *   checkin_url   签到页地址（用于推导校验地址与站点主机）
 *   capture_mode  auto / always
 */

var COOKIE_KEY = "sb_forum_cookie";
var UA_KEY = "sb_forum_ua";
var TS_KEY = "sb_forum_cookie_ts";
var HOST_KEY = "sb_forum_cookie_host";
var TRIED_KEY = "sb_forum_cookie_tried";
var TRYTS_KEY = "sb_forum_cookie_tryts";
var INVALID_KEY = "sb_forum_cookie_invalid";

var SESSION_NAMES = ["bbs_session", "sb_session", "express.sid", "connect.sid", "bbs_sid"];
var DEFAULT_CHECKIN_URL = "https://sb.sb/signin/";
var RETRY_WINDOW = 5 * 60 * 1000; // 同一个候选值最多每 5 分钟校验一次

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};
var reqUrl = String($request.url || "");

// 请求头统一转小写键，兼容不同大小写写法
var H = {};
(function () {
  var raw = $request.headers || {};
  for (var k in raw) {
    H[String(k).toLowerCase()] = raw[k];
  }
})();

var cookie = H["cookie"] || "";
if (cookie && typeof cookie === "object" && cookie.join) {
  cookie = cookie.join("; ");
}
var ua = H["user-agent"] || "";
if (ua && typeof ua === "object" && ua.join) {
  ua = ua.join(" ");
}

function finish() {
  $done({});
}

/** Cookie 中是否包含会话键（用精确的 name= 匹配，避免子串误判） */
function cookieHasSession(c) {
  var s = String(c || "");
  for (var i = 0; i < SESSION_NAMES.length; i++) {
    var name = SESSION_NAMES[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(?:^|;\\s*)" + name + "=", "i").test(s)) return true;
  }
  return false;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function pageTitle(html) {
  var m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]) : "";
}

/** 地区限制页（该站按地区封锁时返回 404，文案固定） */
function looksRegionBlocked(html) {
  return String(html || "").indexOf("暂未对您所在地区开放") !== -1;
}

/** 登录页特征（组合判定，任一命中即未登录） */
function looksLoggedOut(html) {
  var h = String(html || "");
  if (!h) return false;
  if (h.indexOf("登录 - 烧饼论坛") !== -1) return true;
  if (/type=["']password["']/i.test(h)) return true;
  if (/<form[^>]+action=["'][^"']*\/login/i.test(h)) return true;
  return false;
}

/** 已登录页面的正面证据：能拿到 _csrf */
function hasCsrf(html) {
  return /name="_csrf"\s+value="([^"]+)"/.test(String(html || ""));
}

/** 写入 Cookie 并清理状态（清掉「失效」标记 → 回到「不再覆盖」的按需状态） */
function commit(value, ua, host, subtitle) {
  var ok = $persistentStore.write(value, COOKIE_KEY);
  if (ua) $persistentStore.write(ua, UA_KEY);
  $persistentStore.write(String(Date.now()), TS_KEY);
  $persistentStore.write(host || "", HOST_KEY);
  $persistentStore.write("", TRIED_KEY);
  $persistentStore.write("", INVALID_KEY);
  if (ok) {
    console.log("sb-cookie: Cookie 已保存（长度 " + value.length + "，来源 " + host + "）");
    $notification.post("sb.sb 论坛签到", subtitle, "自动签到将按计划执行");
  } else {
    console.log("sb-cookie: Cookie 写入失败");
    $notification.post("sb.sb 论坛签到", "❌ Cookie 保存失败", "请重启 Loon 后重新访问论坛");
  }
}

function main() {
  var host = "";
  var hm = reqUrl.match(/^https?:\/\/([^\/:]+)/i);
  if (hm) host = hm[1].toLowerCase();

  // 防止本脚本自己发起的校验请求被再次拦截（若 Loon 会拦截内部请求）
  if (String(H["x-sb-internal"] || "") === "1") {
    return finish();
  }

  if (!cookie) {
    console.log("sb-cookie: 请求未携带 Cookie，跳过 " + reqUrl);
    return finish();
  }
  if (!cookieHasSession(cookie)) {
    console.log("sb-cookie: Cookie 不含会话标识（如 bbs_session），视为非登录态附属 Cookie，跳过");
    return finish();
  }
  var stored = $persistentStore.read(COOKIE_KEY);
  if (stored === cookie) {
    return finish(); // 与已存一致，无需处理
  }

  var invalid = String($persistentStore.read(INVALID_KEY) || "");
  var mode = String(arg.capture_mode || "auto").toLowerCase();
  var canCapture = !stored || invalid === "1" || mode === "always";
  if (!canCapture) {
    console.log("sb-cookie: 已存 Cookie 尚未失效，按需模式跳过覆盖（来源 " + host + "，候选长度 " + cookie.length + "）");
    return finish();
  }

  var now = Date.now();
  var tried = String($persistentStore.read(TRIED_KEY) || "");
  var tryts = parseInt($persistentStore.read(TRYTS_KEY) || "0", 10) || 0;
  var isFirstTry = tried !== cookie; // 是否首次见到这个候选值（用于决定要不要弹通知）
  if (!isFirstTry && now - tryts < RETRY_WINDOW) {
    console.log("sb-cookie: 该候选 Cookie 刚校验过，暂时跳过");
    return finish();
  }

  var checkinUrl = String(arg.checkin_url || DEFAULT_CHECKIN_URL).trim() || DEFAULT_CHECKIN_URL;
  var om = checkinUrl.match(/^https?:\/\/[^\/]+/);
  var origin = om ? om[0] : "https://sb.sb";

  console.log("sb-cookie: 开始校验候选 Cookie（来源 " + host + "，长度 " + cookie.length + "，模式 " + mode + "）");

  // 先记录，避免同一候选值被反复校验
  $persistentStore.write(cookie, TRIED_KEY);
  $persistentStore.write(String(now), TRYTS_KEY);

  $httpClient.get(
    {
      url: checkinUrl,
      headers: {
        "Cookie": cookie,
        "User-Agent": ua || "",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": origin + "/",
        "X-SB-Internal": "1"
      },
      "auto-cookie": false,
      timeout: 10000
    },
    function (err, resp, data) {
      if (err) {
        console.log("sb-cookie: 校验请求失败（" + err + "），无法判定，暂存候选 Cookie");
        commit(cookie, ua, host, "⚠️ Cookie 已保存（未能校验）");
        return finish();
      }

      var html = String(data || "");
      var code = resp && resp.status ? Number(resp.status) : 0;

      if (looksRegionBlocked(html)) {
        console.log("sb-cookie: 校验命中地区限制（HTTP " + code + "），无法判定，暂存候选 Cookie");
        commit(cookie, ua, host, "⚠️ Cookie 已保存（校验时命中地区限制）");
        return finish();
      }

      var csrfOk = hasCsrf(html);
      var out = looksLoggedOut(html);
      if (out || !csrfOk) {
        console.log(
          "sb-cookie: 候选 Cookie 未通过校验（未登录=" + out + "，有_csrf=" + csrfOk +
            "，HTTP " + code + "，标题「" + pageTitle(html) + "」），已丢弃，保留原有 Cookie"
        );
        if (isFirstTry) {
          $notification.post(
            "sb.sb 论坛签到",
            "⚠️ 未保存 Cookie（疑似未登录）",
            "当前浏览会话看起来还是游客态，已保留原有 Cookie。\n若确实已登录，请下拉刷新一次论坛页面。"
          );
        }
        return finish();
      }

      commit(cookie, ua, host, "✅ Cookie 已捕获并通过登录校验");
      return finish();
    }
  );
}

main();
