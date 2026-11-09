/**
 * sb.sb（烧饼论坛）签到脚本（Cron / Generic Script）v3
 *
 * 流程：
 *   1. GET 签到页，提取 _csrf / Cap 端点 / 真正的提交地址
 *   2. 若站点启用了 Cap 人机验证：走完整验证流程换取 cap-token
 *        challenge -> 复现探测脚本(state) + PoW 求解 -> redeem -> cap-token
 *   3. POST 签到（form-urlencoded：_csrf / message / cap-token）
 *   4. 解析结果块（JSON 优先，HTML 兜底），发通知
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
 * ── 2026-09-29 修订（两处根因修复）──────────────────────────────────────
 * 【根因 1】站点改为 AJAX-only：不带 X-Requested-With: XMLHttpRequest 的
 *           POST 会被拒（实测 404/403）→ POST 显式带该头，优先按 JSON 解析。
 * 【根因 2】签到页「搜索表单」也带 _csrf 且在 DOM 前面，旧解析误选 /search/
 *           → 改为两轮筛选（action 匹配 signin/checkin/daily，或含 message 输入）。
 * 另：删除失效的 response.url 判断（Loon 的 response 只有 {status, headers,
 *     h2_trailers}），改用实测页面特征。
 *
 * ── 2026-10-05 修订（与 Cookie 捕获脚本配合的「按需捕获」闭环）────────────
 * 签到脚本在确认失效时写标记 sb_forum_cookie_invalid=1，捕获脚本据此重新捕获；
 * 签到成功则清除标记。
 *
 * ── 2026-10-06 修订（★ 本次：新增 Cap 人机验证）─────────────────────────
 * 现象：自动签到返回「人机验证未通过，请重新验证后再试。」
 * 根因：站点接入 Cap（capjs.net）工作量证明验证。签发表单挂载
 *       <cap-widget data-cap-api-endpoint="https://capjs.net/xxx/">，前端 JS 在
 *       提交前要求表单内含隐藏字段 cap-token；没有该字段即被服务端拒绝。
 * 对策：脚本内实现完整的 Cap 验证流程（纯 JS，无外部依赖）：
 *       ① POST {endpoint}challenge 取挑战 {c,s,d} + token + instrumentation
 *       ② 解压 instrumentation（base64 + deflate-raw）得到探测脚本，
 *          提取其中的确定性计算块并执行，复现出 state（服务端会比对期望值）
 *       ③ 按 FNV-1a + xorshift32 派生的 salt/target 做 PoW，解出 c 个 nonce
 *       ④ POST {endpoint}redeem 提交 solutions + instr → 换取 cap-token
 *       ⑤ POST 签到表单时带上 cap-token
 *       验证端点从签到页的 data-cap-api-endpoint 动态解析，站点换 key 也不失效。
 *
 * ⚠️ 性能：PoW 需要约 80 × 65536 次 SHA-256（纯 JS），iPhone 上大约
 *    10~60 秒。请把 cron/generic 的 timeout 设到 300 秒。这是 Cap 的设计
 *    目的（拖慢自动化），属正常现象，不是卡死。
 *
 * ── 2026-10-08 修订（★ 本次：Cap 请求换出口重试）───────────────────────
 * 现象：昨天签到成功，今天日志停在
 *       「cap 失败 -> 挑战请求失败: … Request timeout.」
 * 根因：并非站点改机制，而是 **capjs.net 这个验证域名在当前出口时通时不通**
 *       （实测直连 3 次失败 2 次，走代理 3 次全成功）。签到页请求走代理没问题，
 *       但 Cap 验证域名按内置路由走了直连，于是间歇性超时。
 * 对策：
 *   ① cap 的 challenge / redeem 请求均做「换出口重试」——依次尝试
 *      跟随内置路由 → PROXY 策略组 → 跟随内置路由（共 3 次）；
 *   ② 插件新增「Cap 验证出口」参数（cap_node），可固定指定策略组/节点名；
 *   ③ 因网络问题失败时，通知里会直接给出该怎么填。
 * 另：站点签到地址已由 /signin/ 变为 /checkin/，脚本从表单 action 自动跟随，
 *     无需改配置。
 *
 * ── 2026-11-09 修订（★ 本次：Cap 一次性 token 被原样重试作废）──────────
 * 现象：challenge 拿到挑战、PoW 也算完了，redeem 却返回
 *       「HTTP 403 Challenge already redeemed」。
 * 根因：① redeem 是**一次性消费**请求（服务端收到即把 challenge token 标记
 *         为已兑换，防重放）。旧代码对 redeem 也套了「换出口重试」，
 *         而第一次是**客户端**超时（Loon 报 Request timeout），
 *         请求其实已经到了服务端并兑换成功，只是响应在回程丢了 ——
 *         于是第二个出口拿同一枚 token 去换，必然 403。
 *           challenge 可安全重试（每次都生成新挑战），redeem 绝对不行。
 *       ② 出口经验没复用：challenge 已在某出口成功，redeem 却仍从
 *         「默认路由」重新开始，白吃一次 15~25s 超时。
 * 对策：
 *       ① redeem 失败一律「重新申请挑战 → 重解 PoW → 用新 token 再兑换」，
 *          不再原样重发；最多 3 轮 + 75s 墙钟预算；
 *       ② 某出口打通 challenge 后，本轮后续请求直接以它为起点；
 *          成功出口写入 $persistentStore(sb_cap_route)，下次首发就用它；
 *       ③ 移除硬编码的 "PROXY" 兜底 —— 很多 Loon 配置里没有这个策略组，
 *          Loon 会提示 "can not find policy: proxy, use the global first
 *          node" 并回退到全局第一个节点，等于白填。现在 cap_node 留空
 *          就只用内置分流（推荐配合自己的分流规则），填了就按填的走，
 *          支持逗号分隔多个；
 *       ④ 签到 POST 网络超时后重来一次（重新取 cap-token，因为 cap-token
 *          同样一次性）。
 */

var COOKIE_KEY = "sb_forum_cookie";
var UA_KEY = "sb_forum_ua";
var TS_KEY = "sb_forum_cookie_ts";
var INVALID_KEY = "sb_forum_cookie_invalid";
var DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

/** Cap 验证端点默认值（签到页没解析到时回退用） */
var DEFAULT_CAP_ENDPOINT = "https://capjs.net/415786673b/";

/** 脚本启动时刻，用于总量控制（避免打满插件 300s 超时） */
var SCRIPT_STARTED_AT = Date.now();

/** 单个 cap 请求的超时（ms）。cap 服务响应通常 < 1s，15s 足够 */
var CAP_TIMEOUT = 15000;

/** 整个 cap 流程最多重来几轮（每轮 = 新挑战 + 重新解 PoW + 重新 redeem） */
var CAP_FLOW_MAX = 3;

/** 单次取得 cap-token 的墙钟预算（ms），超出即放弃 */
var CAP_FLOW_BUDGET = 75000;

/** 记住「上次把 cap 打通的那个出口」，下次优先用；空 = 从未成功过 */
var CAP_ROUTE_KEY = "sb_cap_route";

/** 签到 POST 最多提交几次（超时会重来一次，重来必须换新的 cap-token） */
var POST_MAX_ATTEMPTS = 2;

/** 距脚本启动超过这个时长就不再重试签到（给 cap 重算留出时间） */
var POST_RETRY_BUDGET = 150000;

var arg = typeof $argument === "object" && $argument !== null ? $argument : {};

function notify(subtitle, content) {
  // 宽松判断：默认开启，仅当明确为 false 时才静默
  if (arg.notify !== false && arg.notify !== "false") {
    $notification.post("烧饼论坛签到", subtitle, content);
  }
}

/**
 * 标记现存 Cookie 已失效 → 下次浏览论坛时，Cookie 捕获脚本才会重新捕获。
 * 这是「按需捕获」闭环的开关：只有这里置 1，捕获脚本才会覆盖 Cookie。
 */
function markCookieInvalid(reason) {
  $persistentStore.write("1", INVALID_KEY);
  console.log("sb-checkin: 已标记 Cookie 失效 -> " + reason);
}

/** 清除失效标记：Cookie 仍然有效，不要让捕获脚本再覆盖它 */
function clearCookieInvalid() {
  $persistentStore.write("", INVALID_KEY);
}

var RELOGIN_HINT = "请重新登录论坛一次，插件会自动重新捕获 Cookie。";

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
 * 从签到页里解析真正的提交地址。
 * 2026-09-29 修复：签到页上「搜索表单」也带 _csrf 且排在前面，
 * 之前"第一个含 _csrf 的表单"会误选 /search/。
 * 现在的优先级：
 *   1) action 明确是签到路径（signin/checkin/daily）的表单
 *   2) 含 message 输入（签到留言框）的表单
 *   3) 都没有 → 返回 ""，由调用方回退到配置的 checkin_url
 */
function findSubmitAction(html, origin, pageUrl) {
  var forms = String(html || "").match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
  var byMessage = "";
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    if (!/name=["']_csrf["']/i.test(f)) continue;             // 必须含 _csrf
    var am = f.match(/action=["']([^"']*)["']/i);
    var action = am ? am[1] : "";
    if (/\/login\b/i.test(action)) continue;                   // 排除登录表单
    if (/signin|checkin|daily/i.test(action)) {
      return action ? resolveUrl(action, origin) : pageUrl;
    }
    if (!byMessage && /name=["']message["']/i.test(f)) {
      byMessage = action ? resolveUrl(action, origin) : pageUrl;
    }
  }
  return byMessage;
}

/** 从页面解析 Cap 验证端点 */
function findCapEndpoint(html, origin) {
  var m = String(html || "").match(/data-cap-api-endpoint=["']([^"']+)["']/i);
  if (!m) return "";
  var ep = m[1];
  if (!/^https?:\/\//i.test(ep)) ep = resolveUrl(ep, origin);
  if (ep.charAt(ep.length - 1) !== "/") ep += "/";
  return ep;
}

/* ======================================================================
 * Cap 人机验证（PoW + Instrumentation）
 * 纯 JS 实现：base64 解码 / inflate-raw 解压 / SHA-256 / PoW / 探测脚本复现
 * ==================================================================== */

var CAP_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function capB64ToBytes(input) {
  var s = String(input || "").replace(/[\s]/g, "");
  var map = capB64ToBytes._m;
  if (!map) {
    map = capB64ToBytes._m = {};
    for (var i = 0; i < CAP_B64.length; i++) map[CAP_B64.charAt(i)] = i;
    map["-"] = 62;
    map["_"] = 63;
  }
  var out = [];
  var acc = 0, bits = 0;
  for (var j = 0; j < s.length; j++) {
    var v = map[s.charAt(j)];
    if (v === undefined) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}

/* ---- inflate（deflate-raw），用于解压 instrumentation 脚本 ---- */
var CAP_LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var CAP_LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
var CAP_DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var CAP_DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
var CAP_CLCIDX = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

function capInflateRaw(src) {
  var pos = 0, bitbuf = 0, bitcnt = 0;
  var out = [];

  function getBit() {
    if (bitcnt === 0) { bitbuf = src[pos++] & 0xff; bitcnt = 8; }
    var b = bitbuf & 1;
    bitbuf >>= 1;
    bitcnt--;
    return b;
  }
  function getBits(n) {
    var v = 0;
    for (var i = 0; i < n; i++) v |= getBit() << i;
    return v;
  }
  function buildHuff(lengths) {
    var maxLen = 0, i;
    for (i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
    var blCount = [], nextCode = [];
    for (i = 0; i <= maxLen; i++) { blCount[i] = 0; nextCode[i] = 0; }
    for (i = 0; i < lengths.length; i++) blCount[lengths[i]]++;
    blCount[0] = 0;
    var code = 0;
    for (i = 1; i <= maxLen; i++) { code = (code + blCount[i - 1]) << 1; nextCode[i] = code; }
    var table = {};
    for (i = 0; i < lengths.length; i++) {
      var l = lengths[i];
      if (l) { table[(l << 16) | nextCode[l]] = i; nextCode[l]++; }
    }
    return { table: table, maxLen: maxLen };
  }
  function decodeSym(h) {
    var code = 0;
    for (var l = 1; l <= h.maxLen; l++) {
      code = (code << 1) | getBit();
      var sym = h.table[(l << 16) | code];
      if (sym !== undefined) return sym;
    }
    throw new Error("huffman code error");
  }
  function inflateHuff(litH, distH) {
    for (;;) {
      var sym = decodeSym(litH);
      if (sym < 256) { out.push(sym); }
      else if (sym === 256) { break; }
      else {
        var li = sym - 257;
        var length = CAP_LBASE[li] + getBits(CAP_LEXT[li]);
        var dsym = decodeSym(distH);
        var dist = CAP_DBASE[dsym] + getBits(CAP_DEXT[dsym]);
        var start = out.length - dist;
        for (var i = 0; i < length; i++) out.push(out[start + i]);
      }
    }
  }

  var fixedLit = null, fixedDist = null;
  for (;;) {
    var bfinal = getBit();
    var btype = getBits(2);
    if (btype === 0) {
      bitcnt = 0;
      var len = (src[pos] & 0xff) | ((src[pos + 1] & 0xff) << 8);
      pos += 4;
      for (var s = 0; s < len; s++) out.push(src[pos++] & 0xff);
    } else if (btype === 1) {
      if (!fixedLit) {
        var fl = [], fd = [], k;
        for (k = 0; k < 144; k++) fl[k] = 8;
        for (; k < 256; k++) fl[k] = 9;
        for (; k < 280; k++) fl[k] = 7;
        for (; k < 288; k++) fl[k] = 8;
        for (k = 0; k < 30; k++) fd[k] = 5;
        fixedLit = buildHuff(fl);
        fixedDist = buildHuff(fd);
      }
      inflateHuff(fixedLit, fixedDist);
    } else if (btype === 2) {
      var hlit = getBits(5) + 257;
      var hdist = getBits(5) + 1;
      var hclen = getBits(4) + 4;
      var clLen = [], j;
      for (j = 0; j < 19; j++) clLen[j] = 0;
      for (j = 0; j < hclen; j++) clLen[CAP_CLCIDX[j]] = getBits(3);
      var clHuff = buildHuff(clLen);
      var lens = [];
      while (lens.length < hlit + hdist) {
        var sym2 = decodeSym(clHuff);
        if (sym2 < 16) lens.push(sym2);
        else if (sym2 === 16) {
          var prev = lens[lens.length - 1], r = 3 + getBits(2);
          while (r--) lens.push(prev);
        } else if (sym2 === 17) {
          var r2 = 3 + getBits(3);
          while (r2--) lens.push(0);
        } else {
          var r3 = 11 + getBits(7);
          while (r3--) lens.push(0);
        }
      }
      inflateHuff(buildHuff(lens.slice(0, hlit)), buildHuff(lens.slice(hlit, hlit + hdist)));
    } else {
      throw new Error("bad block type");
    }
    if (bfinal) break;
  }
  return out;
}

function capUtf8(bytes) {
  var out = "", i = 0;
  while (i < bytes.length) {
    var c = bytes[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      var cp = ((c & 7) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

/* ---- SHA-256（返回复用的 32 字节缓冲，调用方须立即比对 / 拷贝） ---- */
var CAP_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
var _capW = new Array(64);
var _capMsg = new Array(128);
var _capOut = new Uint8Array(32);
var _capLastLen = -1;

/**
 * 把 salt（hex 字符串，逐字符作为字节）写进消息缓冲开头。
 * 返回 salt 字节长度。PoW 每个挑战调用一次，之后复用缓冲。
 */
function capMsgSetSalt(salt) {
  for (var i = 0; i < salt.length; i++) _capMsg[i] = salt.charCodeAt(i) & 0xff;
  return salt.length;
}

/**
 * 计算 sha256(salt + nonceStr)，salt 已在缓冲开头。
 * 填充区只在消息长度变化时重写（nonce 位数变化不频繁），省掉大量重复写入。
 * 结果放在 _capOut 中（会被下次调用覆盖）。
 */
function capMsgHashNonce(saltLen, nonceStr) {
  var np = nonceStr.length;
  var len = saltLen + np;
  var total = ((len + 9 + 63) >> 6) << 6;
  var msg = _capMsg;
  if (msg.length < total) msg = _capMsg = new Array(total);
  var i;
  for (i = 0; i < np; i++) msg[saltLen + i] = nonceStr.charCodeAt(i) & 0xff;
  if (len !== _capLastLen) {
    msg[len] = 0x80;
    for (i = len + 1; i < total; i++) msg[i] = 0;
    var bl = len * 8;
    msg[total - 8] = 0; msg[total - 7] = 0; msg[total - 6] = 0; msg[total - 5] = 0;
    msg[total - 4] = (bl >>> 24) & 0xff;
    msg[total - 3] = (bl >>> 16) & 0xff;
    msg[total - 2] = (bl >>> 8) & 0xff;
    msg[total - 1] = bl & 0xff;
    _capLastLen = len;
  }
  return capHashMsg(total);
}

/** 对 _capMsg 前 total 字节做 SHA-256 压缩，结果写入 _capOut */
function capHashMsg(total) {
  var msg = _capMsg;
  var i;

  var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  var w = _capW;

  for (var off = 0; off < total; off += 64) {
    for (i = 0; i < 16; i++) {
      w[i] = ((msg[off + i*4] << 24) | (msg[off + i*4 + 1] << 16) |
              (msg[off + i*4 + 2] << 8) | msg[off + i*4 + 3]);
    }
    for (i = 16; i < 64; i++) {
      var x = w[i - 15], y = w[i - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + CAP_K[i] + w[i]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
  }
  _capOut[0]=(h0>>>24)&0xff; _capOut[1]=(h0>>>16)&0xff; _capOut[2]=(h0>>>8)&0xff; _capOut[3]=h0&0xff;
  _capOut[4]=(h1>>>24)&0xff; _capOut[5]=(h1>>>16)&0xff; _capOut[6]=(h1>>>8)&0xff; _capOut[7]=h1&0xff;
  _capOut[8]=(h2>>>24)&0xff; _capOut[9]=(h2>>>16)&0xff; _capOut[10]=(h2>>>8)&0xff; _capOut[11]=h2&0xff;
  _capOut[12]=(h3>>>24)&0xff; _capOut[13]=(h3>>>16)&0xff; _capOut[14]=(h3>>>8)&0xff; _capOut[15]=h3&0xff;
  _capOut[16]=(h4>>>24)&0xff; _capOut[17]=(h4>>>16)&0xff; _capOut[18]=(h4>>>8)&0xff; _capOut[19]=h4&0xff;
  _capOut[20]=(h5>>>24)&0xff; _capOut[21]=(h5>>>16)&0xff; _capOut[22]=(h5>>>8)&0xff; _capOut[23]=h5&0xff;
  _capOut[24]=(h6>>>24)&0xff; _capOut[25]=(h6>>>16)&0xff; _capOut[26]=(h6>>>8)&0xff; _capOut[27]=h6&0xff;
  _capOut[28]=(h7>>>24)&0xff; _capOut[29]=(h7>>>16)&0xff; _capOut[30]=(h7>>>8)&0xff; _capOut[31]=h7&0xff;
  return _capOut;
}

/* ---- FNV-1a + xorshift32 PRNG（与 Cap 服务端一致） ---- */
function capFnv1a(str) {
  var hash = 2166136261;
  for (var i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}
function capFnv1aResume(state, str) {
  var h = state;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}
function capPrngFromHash(initialHash, length) {
  var state = initialHash;
  var result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    var hex = state.toString(16);
    while (hex.length < 8) hex = "0" + hex;
    result += hex;
  }
  return result.substring(0, length);
}

/**
 * 求解 PoW：对每个挑战 i 找出最小 nonce，使
 * sha256(salt_i + nonce) 的前 difficulty 位十六进制等于 target_i
 */
function capSolvePoW(token, c, size, difficulty) {
  var tokenFnv = capFnv1a(token);
  var solutions = [];
  var fullBytes = difficulty >> 1;
  var partialNibble = (difficulty & 1) ? 0 : -1;

  for (var i = 0; i < c; i++) {
    var saltSeed = capFnv1aResume(tokenFnv, String(i + 1));
    var targetSeed = capFnv1aResume(saltSeed, "d");
    var salt = capPrngFromHash(saltSeed, size);
    var target = capPrngFromHash(targetSeed, difficulty);

    var tb = new Array(fullBytes);
    for (var j = 0; j < fullBytes; j++) tb[j] = parseInt(target.substr(j * 2, 2), 16);
    var pn = -1;
    if (difficulty & 1) pn = parseInt(target.charAt(difficulty - 1), 16);

    // salt 写入复用的消息缓冲（逐字符作为字节）
    var saltLen = capMsgSetSalt(salt);

    var nonce = 0;
    for (;;) {
      var ns = String(nonce);
      var h = capMsgHashNonce(saltLen, ns);
      var ok = true;
      for (var p = 0; p < fullBytes; p++) { if (h[p] !== tb[p]) { ok = false; break; } }
      if (ok && pn >= 0 && (h[fullBytes] >> 4) !== pn) ok = false;
      if (ok) break;
      nonce++;
    }
    solutions.push(nonce);
  }
  return solutions;
}

/* ---- 探测脚本复现（用于通过 instrumentation 校验） ---- */

/** 最小 DOM 节点 mock：供脚本里的 domHelper 使用 */
function capMockNode() {
  var n = {
    style: {}, innerText: "", parentNode: null, children: [],
    appendChild: function (c) { c.parentNode = n; n.children.push(c); return c; },
    removeChild: function (c) {
      var i = n.children.indexOf(c);
      if (i >= 0) n.children.splice(i, 1);
      c.parentNode = null;
      return c;
    }
  };
  Object.defineProperty(n, "lastElementChild", {
    get: function () { return n.children.length ? n.children[n.children.length - 1] : null; }
  });
  return n;
}

/**
 * 解压 instrumentation，提取其中的确定性计算块并执行，复现出 state。
 * 服务端会拿 state 与期望值比对，因此必须逐位算对。
 * 返回 { id, state } / { error } / null
 */
function capRunInstrumentation(blob, ua) {
  var script = capUtf8(capInflateRaw(capB64ToBytes(blob)));

  var idM = script.match(/nonce:\s*"([0-9a-fA-F]{8,})"/);
  var id = idM ? idM[1] : "";

  var dm = script.match(/var (\w+)=(\d+);var (\w+)=(\d+);var (\w+)=(\d+);var (\w+)=(\d+);/);
  if (!dm) return { error: "未找到初始化变量" };
  var start = script.indexOf(dm[0]);
  var tail = script.slice(start);
  var retM = tail.match(/return (\w+);\}\)\(\);/);
  if (!retM) return { error: "未找到返回值" };
  var body = tail.slice(0, retM.index + ("return " + retM[1] + ";").length);

  var docMock = { createElement: function () { return capMockNode(); }, body: capMockNode() };
  var navMock = { userAgent: ua || DEFAULT_UA };

  var state;
  try {
    var fn = new Function("navigator", "document", body);
    state = fn(navMock, docMock);
  } catch (e) {
    return { error: "执行探测脚本失败: " + String(e && e.message ? e.message : e) };
  }
  if (!state || typeof state !== "object") return { error: "探测脚本返回为空" };
  return { id: id, state: state };
}

/**
 * 伪造一个「真实 iPhone Safari」的环境探测向量，规避自动化特征检测。
 * 服务端只用它做启发式判断（不比对具体数值），因此给出合理即可。
 */
function capBuildProbe(ua) {
  return {
    ua: ua,
    productSub: "20030107",
    webdriver: false,
    oscpu: "__undefined",
    deviceMemory: null,
    uaDataPresent: false,
    uaData: null,
    plugins: { length: 0 },
    pdfViewerEnabled: true,
    engine: { hasMozInnerScreenX: false, hasChrome: false },
    screen: { width: 390, height: 844 },
    outerWH: [390, 664],
    isExtended: null,
    fontWidths: [
      905.34, 812.11, 1004.56, 903.22, 902.45, 903.01, 900.88, 905.12,
      902.67, 901.34, 903.78, 902.19, 905.55, 903.41, 902.88, 904.02, 901.77
    ],
    tamper: {
      getParameterWebGL: true, toDataURL: true, getImageData: true,
      permissionsQuery: true, fnToString: true
    }
  };
}

/**
 * 解析「Cap 验证出口」参数，得到候选出口列表。
 * cap_node 支持逗号 / 空格分隔多个策略组或节点名；留空则只用内置分流。
 * 列表末尾总会补上「跟随内置分流」（null）作为兜底。
 * ⚠️ 不再硬编码任何策略组名：填入不存在的名字时 Loon 只会提示
 *    "can not find policy: xxx, use the global first node" 并静默回退，
 *    既达不到目的，又白耗一次超时。
 */
function capParseNodes(raw) {
  var list = [];
  var s = String(raw === undefined || raw === null ? "" : raw).trim();
  if (s && s !== "false") {
    var parts = s.split(/[,，\s]+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p && p !== "false") list.push(p);
    }
  }
  list.push(null);                     // 兜底：跟随内置分流
  return list;
}

/** 候选出口去重，并把「上次成功的出口」提到最前 */
function capNodePlan() {
  var cand = capParseNodes(arg.cap_node);
  var uniq = [], seen = {}, i, k;
  for (i = 0; i < cand.length; i++) {
    k = cand[i] === null ? "__direct__" : String(cand[i]);
    if (seen[k]) continue;
    seen[k] = 1;
    uniq.push(cand[i]);
  }
  var learned = String($persistentStore.read(CAP_ROUTE_KEY) || "").trim();
  if (learned) {
    for (i = 0; i < uniq.length; i++) {
      k = uniq[i] === null ? "__direct__" : String(uniq[i]);
      if (k === learned) {
        if (i > 0) uniq.unshift(uniq.splice(i, 1)[0]);
        break;
      }
    }
  }
  return uniq;
}

/** 把「打通过的出口」记下来，下次首发就用它 */
function capRememberRoute(node) {
  try {
    $persistentStore.write(node ? String(node) : "__direct__", CAP_ROUTE_KEY);
  } catch (e) {
    /* 存储失败不影响签到 */
  }
}

/** 出口的可读名，用于日志 */
function capNodeName(node) {
  return node ? String(node) : "默认路由";
}

/**
 * 完整走一遍 Cap 验证，换取 cap-token。
 * @param endpoint   形如 https://capjs.net/xxx/
 * @param ua         与浏览器一致的 User-Agent
 * @param siteOrigin 站点源，用于 Origin / Referer
 * @param cb         function(errMsg, token)
 */
function capFetchToken(endpoint, ua, siteOrigin, cb) {
  var nodes = capNodePlan();
  var goodIdx = 0;                     // 已确认可用的出口下标
  var startedAt = Date.now();
  var flow = 0;                        // 第几轮（1 = 首次）
  var lastErr = "";                    // 最后一次失败原因，用于最终上报

  var names = [];
  for (var ni = 0; ni < nodes.length; ni++) names.push(capNodeName(nodes[ni]));
  console.log("sb-checkin: [cap] 出口候选：" + names.join(" -> "));

  function capHeaders() {
    return {
      "User-Agent": ua || DEFAULT_UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Content-Type": "application/json",
      "Origin": siteOrigin,
      "Referer": siteOrigin + "/"
    };
  }

  /**
   * 发一次 cap 请求。遇到网络错误时从 startIdx 起轮换出口。
   * 回调给出 usedIdx：最后一个真正返回响应的出口下标，
   * 后续请求直接以它为起点，不再回到「已证明不通」的出口。
   */
  function capPost(path, body, startIdx, done) {
    var idx = startIdx % nodes.length;
    var tries = 0;
    function once() {
      var node = nodes[idx];
      var opts = {
        url: endpoint + path,
        headers: capHeaders(),
        body: body,
        "auto-cookie": false,
        timeout: CAP_TIMEOUT
      };
      if (node) opts.node = node;
      console.log("sb-checkin: [cap] POST " + path + "（出口：" + capNodeName(node) + "）");
      $httpClient.post(opts, function (err, resp, data) {
        if (err && tries < nodes.length - 1) {
          tries++;
          idx = (idx + 1) % nodes.length;
          console.log("sb-checkin: [cap] " + path + " 失败（" + err + "），换出口重试");
          return once();
        }
        done(err, resp, data, idx);
      });
    }
    once();
  }

  /**
   * 一轮完整流程：challenge -> 探测脚本 + PoW -> redeem
   * 失败标记：网络层失败和「兑换被拒」都走重来（换新挑战）；
   * 协议层的异常（格式错、参数错、探测脚本解不出）直接判失败，重试也无用。
   */
  function startFlow() {
    if (flow >= CAP_FLOW_MAX) {
      return cb(lastErr
        ? lastErr + "（已重试 " + flow + " 轮）"
        : "人机验证未通过（已重试 " + flow + " 轮）");
    }
    if (Date.now() - startedAt > CAP_FLOW_BUDGET) {
      return cb("人机验证超时（超出 " + Math.round(CAP_FLOW_BUDGET / 1000) + " 秒预算）");
    }
    flow++;
    if (flow > 1) {
      console.log("sb-checkin: [cap] 第 " + flow + " 轮：重新申请挑战（上一枚 token 已被服务端消费，不能复用）");
    }

    capPost("challenge", "{}", goodIdx, function (err, resp, data, idx) {
      if (err) {
        lastErr = "挑战请求失败（出口均无响应）: " + err;
        console.log("sb-checkin: [cap] " + lastErr + "，重来");
        return startFlow();
      }
      goodIdx = idx;

      var code = statusOf(resp);
      var raw = String(data || "");
      if (code !== 200) return cb("挑战请求 HTTP " + code + " " + raw.slice(0, 120));

      var ch = null;
      try { ch = JSON.parse(raw); } catch (e) { ch = null; }
      if (!ch || !ch.challenge || !ch.token) return cb("挑战响应格式异常: " + raw.slice(0, 120));

      var cNum = Number(ch.challenge.c) || 0;
      var sNum = Number(ch.challenge.s) || 0;
      var dNum = Number(ch.challenge.d) || 0;
      if (!cNum || !sNum || !dNum) return cb("挑战参数异常");
      console.log("sb-checkin: [cap] 挑战参数 c=" + cNum + " s=" + sNum + " d=" + dNum +
        (ch.instrumentation ? "（含 instrumentation）" : ""));

      // 1) 复现探测脚本（每轮都要重做：state 里带时间戳）
      var instr = null;
      if (ch.instrumentation) {
        var t1 = Date.now();
        var r = capRunInstrumentation(ch.instrumentation, ua);
        if (r && r.error) return cb("人机验证探测脚本复现失败: " + r.error);
        if (r && r.state) {
          instr = { i: r.id, state: r.state, p: capBuildProbe(ua), ts: Date.now() };
          console.log("sb-checkin: [cap] 探测脚本复现完成（" + (Date.now() - t1) + "ms）");
        }
      }

      // 2) 求解 PoW（同步，耗时较长）
      var t0 = Date.now();
      var solutions;
      try {
        solutions = capSolvePoW(ch.token, cNum, sNum, dNum);
      } catch (e) {
        return cb("工作量证明计算失败: " + String(e && e.message ? e.message : e));
      }
      console.log("sb-checkin: [cap] PoW 求解完成，耗时 " + (Date.now() - t0) + "ms");

      // 3) 兑换 cap-token
      var payload = { token: ch.token, solutions: solutions };
      if (instr) payload.instr = instr;

      capPost("redeem", JSON.stringify(payload), goodIdx, function (err2, resp2, data2, idx2) {
        goodIdx = idx2;

        if (err2) {
          // 网络层失败：这枚 token 可能已被服务端消费（响应丢在回程），
          // 所以不能原样重发，只能连同 challenge 一起重来
          lastErr = "兑换请求失败（出口均无响应）: " + err2;
          console.log("sb-checkin: [cap] " + lastErr + "，重来");
          return startFlow();
        }

        var code2 = statusOf(resp2);
        var raw2 = String(data2 || "");
        var r2 = null;
        try { r2 = JSON.parse(raw2); } catch (e) { r2 = null; }

        if (code2 === 200 && r2 && r2.success && r2.token) {
          if (idx2 > 0) capRememberRoute(nodes[idx2]);   // 只有「换过出口才成功」才值得记
          console.log("sb-checkin: [cap] 已取得 cap-token（出口：" + capNodeName(nodes[idx2]) +
            "，第 " + flow + " 轮）");
          return cb(null, r2.token);
        }

        var reason = r2 ? String(r2.error || r2.reason || "").trim() : "";
        if (!reason) reason = raw2.slice(0, 160) || "（空响应）";
        lastErr = "兑换失败（HTTP " + code2 + "）: " + reason;
        console.log("sb-checkin: [cap] " + lastErr);

        // 关键：redeem 是一次性消费请求。同一枚 token 重发必然失败
        // （服务端已标记 redeemed，哪怕上一次只是「客户端超时」）。
        // 因此这里绝不原样重试，只能申请新挑战重来。
        return startFlow();
      });
    });
  }

  startFlow();
}

/* ======================================================================
 * 主流程
 * ==================================================================== */

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

  /**
   * 第 3 步：POST 签到（可带 capToken）
   * @param onRetry 网络超时后的重来入口（null = 不再重试）。
   *                cap-token 是一次性的，重来必须重新走一遍 Cap 验证。
   */
  function doCheckin(target, csrf, capToken, onRetry) {
    var msg = String(arg.signin_message || "").trim();
    var body = "_csrf=" + encodeURIComponent(csrf) + "&message=" + encodeURIComponent(msg);
    if (capToken) body += "&cap-token=" + encodeURIComponent(capToken);

    // ⚠️ 站点为 AJAX 接口：不带 X-Requested-With 头的 POST 会被拒绝（实测 404/403）
    var postOpts = baseOptions(target);
    postOpts.headers = headersFor({
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest"
    });
    postOpts.body = body;
    console.log("sb-checkin: POST " + target + "（含 cap-token=" + (capToken ? "是" : "否") + "）");

    $httpClient.post(postOpts, function (err2, resp2, data2) {
      if (err2) {
        if (onRetry) {
          console.log("sb-checkin: POST 失败 " + err2 + "，重新取 cap-token 后重试");
          return onRetry();
        }
        notify("❌ 请求失败（签到）", String(err2));
        console.log("sb-checkin: POST 失败 " + err2);
        $done();
        return;
      }
      var html2 = String(data2 || "");
      var code2 = statusOf(resp2);
      console.log("sb-checkin: POST -> HTTP " + code2 + " | " + brief(html2));

      // 1) JSON 响应（站点 AJAX 接口的标准返回：{ok, message, redirect, html}）
      var json = null;
      if (/^\s*\{/.test(html2)) {
        try { json = JSON.parse(html2); } catch (e) { json = null; }
      }
      if (json && typeof json === "object") {
        console.log("sb-checkin: POST JSON -> " + JSON.stringify(json).slice(0, 240));
        var okVal = json.ok === 1 || json.ok === true;
        var jmsg = String(json.message || json.msg || "").trim();
        var jhtml = String(json.html || "");

        // html 字段里可能带签到结果块
        var jr = jhtml.match(/class="signin-result([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
        if (jr) {
          var jcls = jr[1] || "";
          var jtext = stripTags(jr[2]) || jmsg;
          if (jcls.indexOf("success") !== -1) {
            clearCookieInvalid();
            notify("✅ 签到成功", jtext);
          } else {
            notify("❌ 签到未成功", jtext + (jmsg && jmsg !== jtext ? "\n" + jmsg : ""));
          }
          console.log("sb-checkin: JSON.html signin-result" + jcls + " | " + jtext);
        } else if (okVal) {
          clearCookieInvalid();
          notify("✅ 签到成功", jmsg || "HTTP " + code2);
        } else if (/已签到/.test(jmsg)) {
          clearCookieInvalid();
          notify("ℹ️ 今日已签到", jmsg || "无需重复签到");
        } else if (/人机验证|captcha|cap-token|验证/i.test(jmsg)) {
          notify("❌ 人机验证未通过", jmsg + "\n（Cap 验证可能已变更，请把这条提示反馈给作者）");
          console.log("sb-checkin: 服务端返回人机验证相关错误");
        } else if (/登录|未登录|session/i.test(jmsg)) {
          markCookieInvalid("POST JSON: " + jmsg);
          notify("❌ Cookie 已失效", "服务端返回：" + jmsg + savedHint + "。" + RELOGIN_HINT);
        } else {
          notify("❌ 签到未成功", jmsg || "HTTP " + code2 + "\n" + brief(html2));
        }
        $done();
        return;
      }

      // 2) HTML 响应：签到结果块（旧版页面兼容）
      console.log("sb-checkin: POST -> HTTP " + code2 + " | 标题「" + pageTitle(html2) + "」");
      var rm = html2.match(/class="signin-result([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
      if (rm) {
        var cls = rm[1] || "";
        var text = stripTags(rm[2]);
        if (cls.indexOf("success") !== -1) {
          clearCookieInvalid();
          notify("✅ 签到成功", text);
        } else {
          notify("❌ 签到未成功", text + "\nHTTP " + code2);
        }
        console.log("sb-checkin: signin-result" + cls + " | " + text);
        $done();
        return;
      }

      // 3) 已签到
      if (html2.indexOf("今日已签到") !== -1) {
        clearCookieInvalid();
        notify("ℹ️ 今日已签到", "无需重复签到");
        console.log("sb-checkin: 今日已签到（POST 阶段检测）");
        $done();
        return;
      }

      // 4) 地区限制
      if (looksRegionBlocked(html2)) {
        notify("🚫 地区限制，签到达不到", "签到请求被地区限制拦截（HTTP " + code2 + "），请检查代理出口。");
        console.log("sb-checkin: POST 命中地区限制页");
        $done();
        return;
      }

      // 5) 明确失败：404 / 登录页
      //    注：NodeBB 对「无有效会话」的提交同样返回 404，因此两种情况都标记失效，
      //    让捕获脚本在用户下次浏览论坛时重新捕获（重新捕获本身不会有害）。
      if (code2 === 404 || looksLoggedOut(html2)) {
        var isLogin = looksLoggedOut(html2);
        var why = isLogin
          ? "服务端把请求当成了未登录"
          : "提交地址返回 404（会话失效或接口路径变化）";
        markCookieInvalid("POST " + (isLogin ? "落入登录页" : "HTTP 404"));
        notify(
          "❌ 签到未成功（HTTP " + code2 + "）",
          "提交到 " + target + "\n原因：" + why + savedHint +
            "\n" + (isLogin ? RELOGIN_HINT : "若反复出现，可能是接口变更。") +
            "\n页面标题「" + pageTitle(html2) + "」\n" + brief(html2)
        );
        console.log("sb-checkin: POST 失败判定 -> " + why);
        $done();
        return;
      }

      // 6) 兜底：成功关键字 / 状态码
      var kw = String(arg.success_keyword || "").trim();
      if (kw && html2.indexOf(kw) !== -1) {
        clearCookieInvalid();
        notify("✅ 签到成功", "HTTP " + code2 + "\n" + brief(html2));
      } else {
        notify("⚠️ 签到结果待确认", "HTTP " + code2 + " · 提交到 " + target + "\n" + brief(html2));
      }
      $done();
    });
  }

  // ---------- 第 1 步：GET 签到页 ----------
  /**
   * 拉取签到页。站点曾把签到页由 /signin/ 改为 /checkin/，
   * 若配置地址返回 404，会自动改用新路径再试一次（allowAltPath）。
   */
  function fetchCheckinPage(pageUrl, allowAltPath) {
    console.log("sb-checkin: 正在请求 " + pageUrl);
    $httpClient.get(baseOptions(pageUrl), function (err, resp, data) {
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
      // 路径可能已变更（如 /signin/ -> /checkin/），自动改试一次
      var alt = String(pageUrl).replace(/\/signin\/?$/i, "/checkin/");
      if (allowAltPath && alt !== pageUrl) {
        console.log("sb-checkin: " + pageUrl + " 返回 404，自动改试 " + alt);
        return fetchCheckinPage(alt, false);
      }
      notify(
        "❌ 签到页不存在（HTTP 404）",
        "GET " + pageUrl + " 返回 404。可能是接口路径变化或地区限制。\n" + brief(html)
      );
      console.log("sb-checkin: GET 404");
      $done();
      return;
    }

    if (code === 401 || code === 403) {
      markCookieInvalid("GET HTTP " + code);
      notify("❌ Cookie 已失效", "签到页返回 HTTP " + code + savedHint + "。" + RELOGIN_HINT);
      console.log("sb-checkin: GET 未授权 HTTP " + code);
      $done();
      return;
    }

    // 被重定向到登录页
    if (looksLoggedOut(html)) {
      markCookieInvalid("GET 跳转到登录页");
      notify(
        "❌ Cookie 已失效",
        "签到页跳转到了登录页" + savedHint + "。" + RELOGIN_HINT
      );
      console.log("sb-checkin: 页面为登录页，判定未登录");
      $done();
      return;
    }

    // 已签到
    if (html.indexOf("今日已签到") !== -1) {
      clearCookieInvalid();
      notify("ℹ️ 今日已签到", "今天已经签过啦，明天再来");
      console.log("sb-checkin: 今日已签到（GET 阶段检测）");
      $done();
      return;
    }

    var csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      markCookieInvalid("GET 页面无 _csrf");
      notify(
        "❌ 无法获取 CSRF Token",
        "签到页未包含 _csrf" + savedHint + "，Cookie 可能已失效。" + RELOGIN_HINT + "\n" + brief(html)
      );
      console.log("sb-checkin: 未找到 _csrf，HTTP " + code);
      $done();
      return;
    }
    var csrf = csrfMatch[1];
    console.log("sb-checkin: 已获取 _csrf (" + csrf.length + " chars)");

    // 解析真实提交地址（站点改版时自动跟随）
    var discovered = findSubmitAction(html, origin, pageUrl);
    var target = discovered || pageUrl;
    console.log("sb-checkin: 签发表单提交地址 = " + (discovered || "(未找到签到表单，回退配置地址)") + " -> " + target);

    // GET 模式（仅测试用）
    if (method !== "POST") {
      var kw0 = String(arg.success_keyword || "").trim();
      var ok0 = kw0 ? html.indexOf(kw0) !== -1 : code >= 200 && code < 300;
      notify(ok0 ? "✅ 签到页可访问" : "❌ 请求异常", "HTTP " + code + "\n" + brief(html));
      $done();
      return;
    }

    // ---------- 第 2 步：需要人机验证则先换取 cap-token ----------
    var hasCapWidget = /<cap-widget|data-cap-api-endpoint/i.test(html);
    var capEndpoint = hasCapWidget
      ? (findCapEndpoint(html, origin) || DEFAULT_CAP_ENDPOINT)
      : "";
    if (hasCapWidget) {
      console.log("sb-checkin: 检测到 Cap 人机验证，端点 " + capEndpoint);
    } else {
      console.log("sb-checkin: 页面未发现 Cap 验证组件，直接提交");
    }

    /**
     * 提交签到：先按需取 cap-token，再 POST。
     * attempt=1 首次；2 = 上一次 POST 网络超时后的重来。
     * 重来必须重新取 cap-token —— cap-token 同样是一次性的。
     */
    function submit(attempt) {
      var canRetry = attempt < POST_MAX_ATTEMPTS &&
        (Date.now() - SCRIPT_STARTED_AT) < POST_RETRY_BUDGET;
      var onRetry = canRetry ? function () { submit(attempt + 1); } : null;

      if (!hasCapWidget) {
        doCheckin(target, csrf, "", onRetry);
        return;
      }

      capFetchToken(capEndpoint, ua, origin, function (capErr, capToken) {
        if (capErr) {
          var isNetFail = /无响应|均不通|timeout|Timeout|挑战请求失败|兑换请求失败|验证超时/i.test(capErr);
          var hint = isNetFail
            ? "\n\ncapjs.net 在当前出口不可达。最省事的做法是在你自己的 Loon 配置里加一条分流规则：" +
              "\nDOMAIN-SUFFIX,capjs.net,你代理论坛用的策略组名" +
              "\n也可以把插件里的「Cap验证出口」填成真实存在的策略组名（多个用逗号分隔）；" +
              "\n填之前请先在 Loon 里确认这个策略组真的存在 —— 名字不存在时 Loon 只会" +
              "提示 can not find policy 并回退到全局第一个节点，等于白填。"
            : "";
          notify(
            "❌ 人机验证失败",
            "无法获取 cap-token：" + capErr + hint + "\n\n本次未提交签到。"
          );
          console.log("sb-checkin: cap 失败 -> " + capErr);
          $done();
          return;
        }
        doCheckin(target, csrf, capToken, onRetry);
      });
    }

    submit(1);
    });
  }

  fetchCheckinPage(url, true);
}

main();
