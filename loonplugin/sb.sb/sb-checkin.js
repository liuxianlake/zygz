/**
 * sb.sb（烧饼论坛）签到脚本（Cron / Generic Script）
 *
 * 流程：
 *   1. GET 签到页，提取 _csrf，并**从页面表单里解析出真正的提交地址**
 *   2. POST 签到（form-urlencoded，体为 _csrf=<token>&message=<留言>）
 *   3. 解析 <div class="signin-result ..."> 块，发通知
 *
 * 依赖 sb-cookie.js 捕获的 Cookie（存储键 sb_forum_cookie / sb_forum_ua / sb_forum_cookie_ts）。
 *
 * 插件对象参数（$argument）：
 *   checkin_url      签到页地址（默认 https://sb.sb/signin/）
 *   checkin_method   POST（默认）/ GET（仅测试用）
 *   signin_message   签到留言，可留空
 *   success_keyword  备用成功关键字，一般留空
 *   notify           是否推送通知（Boolean）
 *
 * ── 2026-09-29 修订说明（重要）──────────────────────────────────────────
 * 上一版用 response.url / response.finalUrl 判断「是否被重定向到登录页」，
 * 但 Loon 官方 Script API 文档里 $httpClient 回调的 response 只有
 * { status, headers, h2_trailers }，**没有 url / finalUrl 字段**——
 * 那段判断从未生效过。现改为**实测验证过的**页面特征判定：
 *   · 登录页特征：title 含「登录 - 烧饼论坛」、含 type="password"、含 action="/login" 表单
 *   · 地区限制：页面含「暂未对您所在地区开放」（该站按地区封锁，封锁时返回 404）
 * 另新增两项增强：
 *   · 从签到页表单里解析真实提交地址（站点改版换接口时自动跟随，不再写死）
 *   · 两个请求都显式设置 auto-cookie=false（Cookie 完全由脚本自己管理，
 *     避免 Loon 内部 Cookie 罐覆盖我们显式带上的会话）
 * 并把 GET/POST 的 HTTP 状态、页面标题、提交地址写进日志，便于一次定位问题。
 */

var COOKIE_KEY = "sb_forum_cookie";
var UA_KEY = "sb_forum_ua";
var TS_KEY = "sb_forum_cookie_ts";
var DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};

function notify(subtitle, content) {
  // 宽松判断：默认开启，仅当明确为 false 时才静默
  if (arg.notify !== false && arg.notify !== "false") {
    $notification.post("烧饼论坛签到", subtitle, content);
  }
}

function statusOf(resp) {
  var c = resp && resp.status ? Number(resp.status) : 0;
  return isNaN(c) ? 0 : c;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function brief(body) {
  var text = stripTags(
    String(body || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
  );
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

function pageTitle(html) {
  var m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]) : "";
}

/** 地区限制页（该站按地区封锁，封锁时返回 404） */
function looksRegionBlocked(html) {
  return String(html || "").indexOf("暂未对您所在地区开放") !== -1;
}

/**
 * 登录页特征判定（实测：登录页 title 为「登录 - 烧饼论坛」，
 * 含 type="password" 输入、含 action="/login" 表单）
 */
function looksLoggedOut(html) {
  var h = String(html || "");
  if (!h) return false;
  if (h.indexOf("登录 - 烧饼论坛") !== -1) return true;
  if (/type=["']password["']/i.test(h)) return true;
  if (/<form[^>]+action=["'][^"']*\/login/i.test(h)) return true;
  return false;
}

/** 把 href 解析成绝对地址 */
function resolveUrl(href, origin) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.charAt(0) === "/") return origin + href;
  return origin + "/" + href;
}

/**
 * 从签到页里解析真正的提交地址：
 * 找第一个「包含 _csrf 输入、且 action 不指向 /login」的表单。
 * 站点若改版换了接口路径，脚本会自动跟随，不必改代码。
 */
function findSubmitAction(html, origin) {
  var re = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  var m;
  while ((m = re.exec(String(html || ""))) !== null) {
    var form = m[0];
    if (!/name=["']_csrf["']/i.test(form)) continue;
    var am = form.match(/action=["']([^"']*)["']/i);
    if (!am) continue;
    var action = am[1];
    if (/\/login\b/i.test(action)) continue;
    return resolveUrl(action, origin);
  }
  return "";
}

function main() {
  var cookie = $persistentStore.read(COOKIE_KEY);
  console.log("sb-checkin: 脚本已执行，Cookie " + (cookie ? "已存储 (" + cookie.length + " 字符)" : "未存储"));
  if (!cookie) {
    notify("❌ 未找到 Cookie", "请先用浏览器登录论坛，让插件自动捕获 Cookie");
    console.log("sb-checkin: 缺少 Cookie");
    $done();
    return;
  }

  var savedAt = parseInt($persistentStore.read(TS_KEY) || "0", 10) || 0;
  var savedHint = savedAt ? "（Cookie 保存于 " + new Date(savedAt).toLocaleString() + "）" : "";

  var url = String(arg.checkin_url || "https://sb.sb/signin/").trim() || "https://sb.sb/signin/";
  var method = String(arg.checkin_method || "POST").toUpperCase();

  var originMatch = url.match(/^https?:\/\/[^\/]+/);
  var origin = originMatch ? originMatch[0] : "https://sb.sb";
  var ua = $persistentStore.read(UA_KEY) || DEFAULT_UA;

  function headersFor(extra) {
    var h = {
      "Cookie": cookie,
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": origin + "/signin/",
      "Origin": origin
    };
    if (extra) {
      for (var k in extra) { h[k] = extra[k]; }
    }
    return h;
  }

  // 统一：显式管理 Cookie，禁用 Loon 内部 Cookie 罐的复用/覆盖
  function baseOptions(withUrl) {
    return { url: withUrl, headers: headersFor(), "auto-cookie": false, timeout: 20000 };
  }

  // ---------- 第 1 步：GET 签到页 ----------
  console.log("sb-checkin: 正在请求 " + url);
  $httpClient.get(baseOptions(url), function (err, resp, data) {
    if (err) {
      notify("❌ 请求失败（获取签到页）", String(err));
      console.log("sb-checkin: GET 失败 " + err);
      $done();
      return;
    }
    var html = String(data || "");
    var code = statusOf(resp);
    console.log("sb-checkin: GET -> HTTP " + code + " | 标题「" + pageTitle(html) + "」| " + brief(html));

    // 地区限制（该站对部分地区封锁，返回 404）
    if (looksRegionBlocked(html)) {
      notify(
        "🚫 地区限制，无法签到",
        "论坛提示「暂未对您所在地区开放」（HTTP " + code + "）。请确认签到请求走了代理出口。"
      );
      console.log("sb-checkin: 命中地区限制页");
      $done();
      return;
    }

    if (code === 404) {
      notify(
        "❌ 签到页不存在（HTTP 404）",
        "GET " + url + " 返回 404。可能是接口路径变化或地区限制。\n" + brief(html)
      );
      console.log("sb-checkin: GET 404");
      $done();
      return;
    }

    if (code === 401 || code === 403) {
      notify("❌ Cookie 已失效", "签到页返回 HTTP " + code + savedHint + "，请重新登录论坛一次。");
      console.log("sb-checkin: GET 未授权 HTTP " + code);
      $done();
      return;
    }

    // 被重定向到登录页
    if (looksLoggedOut(html)) {
      notify(
        "❌ Cookie 已失效",
        "签到页跳转到了登录页" + savedHint + "。请在手机浏览器打开一次论坛并保持登录，让插件重新捕获 Cookie。"
      );
      console.log("sb-checkin: 页面为登录页，判定未登录");
      $done();
      return;
    }

    // 已签到
    if (html.indexOf("今日已签到") !== -1) {
      notify("ℹ️ 今日已签到", "今天已经签过啦，明天再来");
      console.log("sb-checkin: 今日已签到（GET 阶段检测）");
      $done();
      return;
    }

    var csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      notify(
        "❌ 无法获取 CSRF Token",
        "签到页未包含 _csrf" + savedHint + "，Cookie 可能已失效，请重新登录论坛一次。\n" + brief(html)
      );
      console.log("sb-checkin: 未找到 _csrf，HTTP " + code);
      $done();
      return;
    }
    var csrf = csrfMatch[1];
    console.log("sb-checkin: 已获取 _csrf (" + csrf.length + " chars)");

    // 解析真实提交地址（站点改版时自动跟随）
    var discovered = findSubmitAction(html, origin);
    var target = discovered || url;
    console.log("sb-checkin: 签发表单提交地址 = " + (discovered || "(未找到表单，回退配置地址)") + " -> " + target);

    // GET 模式（仅测试用）
    if (method !== "POST") {
      var kw0 = String(arg.success_keyword || "").trim();
      var ok0 = kw0 ? html.indexOf(kw0) !== -1 : code >= 200 && code < 300;
      notify(ok0 ? "✅ 签到页可访问" : "❌ 请求异常", "HTTP " + code + "\n" + brief(html));
      $done();
      return;
    }

    // ---------- 第 2 步：POST 签到 ----------
    var msg = String(arg.signin_message || "").trim();
    var body = "_csrf=" + encodeURIComponent(csrf) + "&message=" + encodeURIComponent(msg);

    var postOpts = baseOptions(target);
    postOpts.headers = headersFor({ "Content-Type": "application/x-www-form-urlencoded" });
    postOpts.body = body;

    $httpClient.post(postOpts, function (err2, resp2, data2) {
      if (err2) {
        notify("❌ 请求失败（签到）", String(err2));
        console.log("sb-checkin: POST 失败 " + err2);
        $done();
        return;
      }
      var html2 = String(data2 || "");
      var code2 = statusOf(resp2);
      console.log("sb-checkin: POST -> HTTP " + code2 + " | 标题「" + pageTitle(html2) + "」| " + brief(html2));

      // 1) 最权威：签到结果块
      var rm = html2.match(/class="signin-result([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
      if (rm) {
        var cls = rm[1] || "";
        var text = stripTags(rm[2]);
        if (cls.indexOf("success") !== -1) {
          notify("✅ 签到成功", text);
        } else {
          notify("❌ 签到未成功", text + "\nHTTP " + code2);
        }
        console.log("sb-checkin: signin-result" + cls + " | " + text);
        $done();
        return;
      }

      // 2) 已签到
      if (html2.indexOf("今日已签到") !== -1) {
        notify("ℹ️ 今日已签到", "无需重复签到");
        console.log("sb-checkin: 今日已签到（POST 阶段检测）");
        $done();
        return;
      }

      // 3) 地区限制
      if (looksRegionBlocked(html2)) {
        notify("🚫 地区限制，签到达不到", "签到请求被地区限制拦截（HTTP " + code2 + "），请检查代理出口。");
        console.log("sb-checkin: POST 命中地区限制页");
        $done();
        return;
      }

      // 4) 明确失败：404 / 登录页
      if (code2 === 404 || looksLoggedOut(html2)) {
        var why = looksLoggedOut(html2)
          ? "服务端把请求当成了未登录"
          : "提交地址返回 404，接口路径可能已变化";
        notify(
          "❌ 签到未成功（HTTP " + code2 + "）",
          "提交到 " + target + "\n原因：" + why + savedHint +
            "\n页面标题「" + pageTitle(html2) + "」\n" + brief(html2)
        );
        console.log("sb-checkin: POST 失败判定 -> " + why);
        $done();
        return;
      }

      // 5) 兜底：成功关键字 / 状态码
      var kw = String(arg.success_keyword || "").trim();
      if (kw && html2.indexOf(kw) !== -1) {
        notify("✅ 签到成功", "HTTP " + code2 + "\n" + brief(html2));
      } else {
        notify("⚠️ 签到结果待确认", "HTTP " + code2 + " · 提交到 " + target + "\n" + brief(html2));
      }
      $done();
    });
  });
}

main();
