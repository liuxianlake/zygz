/**
 * sb.sb（烧饼论坛）签到脚本（Cron / Generic Script）
 *
 * 流程（已按 2026-09-23 抓包结果实现）：
 *   1. GET 签到页 /signin/，从 HTML 中提取 _csrf token
 *   2. POST /signin/，请求体为 _csrf=<token>&message=<留言>（form-urlencoded）
 *   3. 解析响应中的 <div class="signin-result ..."> 块，提取签到结果并发通知
 *
 * 依赖 sb-cookie.js 捕获的 Cookie（存储键 sb_forum_cookie / sb_forum_ua）。
 * 插件对象参数（$argument）：
 *   checkin_url      签到页地址（默认 https://sb.sb/signin/）
 *   checkin_method   POST（默认）/ GET（仅测试用）
 *   signin_message   签到留言，可留空
 *   success_keyword  备用成功关键字，一般留空
 *   notify           是否推送通知（Boolean）
 *
 * 注意：签到请求由 Loon 发出，能否走代理取决于你自己的分流配置；
 * 请确保论坛域名（屏蔽大陆 IP）在你的规则中走代理出口。
 */

var COOKIE_KEY = "sb_forum_cookie";
var UA_KEY = "sb_forum_ua";
var DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};

function notify(subtitle, content) {
  // 宽松判断：默认开启，仅当明确为 false 时才静默（兼容不同版本 $argument 的类型差异）
  if (arg.notify !== false && arg.notify !== "false") {
    $notification.post("烧饼论坛签到", subtitle, content);
  }
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

function main() {
  var cookie = $persistentStore.read(COOKIE_KEY);
  console.log("sb-checkin: 脚本已执行，Cookie " + (cookie ? "已存储 (" + cookie.length + " 字符)" : "未存储"));
  if (!cookie) {
    notify("❌ 未找到 Cookie", "请先用浏览器登录论坛，让插件自动捕获 Cookie");
    console.log("sb-checkin: 缺少 Cookie");
    $done();
    return;
  }

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
      "Referer": origin + "/signin",
      "Origin": origin
    };
    if (extra) {
      for (var k in extra) { h[k] = extra[k]; }
    }
    return h;
  }

  // ---------- 第 1 步：GET 签到页，提取 _csrf ----------
  console.log("sb-checkin: 正在请求 " + url);
  $httpClient.get({ url: url, headers: headersFor() }, function (err, resp, data) {
    if (err) {
      notify("❌ 请求失败（获取签到页）", String(err));
      console.log("sb-checkin: GET 失败 " + err);
      $done();
      return;
    }
    var html = String(data || "");

    // 已签到：页面出现置灰的「今日已签到」按钮
    if (html.indexOf("今日已签到") !== -1) {
      notify("ℹ️ 今日已签到", "今天已经签过啦，明天再来");
      console.log("sb-checkin: 今日已签到（GET 阶段检测）");
      $done();
      return;
    }

    // 登录态校验：登录用户的页面会输出 window.BBS_UID
    if (html.indexOf("BBS_UID") === -1) {
      notify("❌ Cookie 已失效", "页面显示未登录状态，请重新登录论坛一次以更新 Cookie");
      console.log("sb-checkin: 页面无 BBS_UID，疑似未登录，HTTP " + resp.status);
      $done();
      return;
    }

    var csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      notify("❌ 无法获取 CSRF Token", "页面未包含 _csrf，Cookie 可能已失效，请重新登录论坛一次\n\n" + brief(html));
      console.log("sb-checkin: 未找到 _csrf，HTTP " + resp.status);
      $done();
      return;
    }
    var csrf = csrfMatch[1];
    console.log("sb-checkin: 已获取 _csrf (" + csrf.length + " chars)");

    // GET 模式（仅测试用）：不走 POST
    if (method !== "POST") {
      var kw0 = String(arg.success_keyword || "").trim();
      var ok0 = kw0 ? html.indexOf(kw0) !== -1 : resp.status >= 200 && resp.status < 300;
      notify(ok0 ? "✅ 签到请求已执行" : "❌ 签到失败", "HTTP " + resp.status + "\n" + brief(html));
      $done();
      return;
    }

    // ---------- 第 2 步：POST 签到 ----------
    var msg = String(arg.signin_message || "").trim();
    var body = "_csrf=" + encodeURIComponent(csrf) + "&message=" + encodeURIComponent(msg);

    $httpClient.post(
      {
        url: url,
        headers: headersFor({ "Content-Type": "application/x-www-form-urlencoded" }),
        body: body
      },
      function (err2, resp2, data2) {
        if (err2) {
          notify("❌ 请求失败（签到）", String(err2));
          console.log("sb-checkin: POST 失败 " + err2);
          $done();
          return;
        }
        var html2 = String(data2 || "");

        // 解析签到结果块：<div class="signin-result success">...</div>
        var rm = html2.match(/class="signin-result([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
        if (rm) {
          var cls = rm[1] || "";
          var text = stripTags(rm[2]);
          if (cls.indexOf("success") !== -1) {
            notify("✅ 签到成功", text);
          } else {
            notify("❌ 签到未成功", text + "\nHTTP " + resp2.status);
          }
          console.log("sb-checkin: signin-result" + cls + " | " + text);
        } else if (html2.indexOf("今日已签到") !== -1) {
          notify("ℹ️ 今日已签到", "无需重复签到");
          console.log("sb-checkin: 今日已签到（POST 阶段检测）");
        } else {
          // 兜底：成功关键字 / 状态码
          var kw = String(arg.success_keyword || "").trim();
          if (kw && html2.indexOf(kw) !== -1) {
            notify("✅ 签到成功", "HTTP " + resp2.status + "\n" + brief(html2));
          } else {
            notify("⚠️ 签到结果待确认", "HTTP " + resp2.status + "\n" + brief(html2));
          }
          console.log("sb-checkin: POST -> HTTP " + resp2.status + " | " + brief(html2));
        }
        $done();
      }
    );
  });
}

main();
