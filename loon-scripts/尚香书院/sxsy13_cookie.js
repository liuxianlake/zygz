/**
 * 自动获取 sxsy13 论坛 Cookie
 */
if ($request && $request.headers) {
  const cookie = $request.headers['Cookie'] || $request.headers['cookie'];
  if (cookie) {
    if ($persistentStore.write(cookie, "sxsy13_cookie")) {
      $notification.post("SXSY13 论坛", "Cookie 获取成功 🎉", "已成功保存登录凭证，可以关闭此获取脚本了。");
    }
  }
}
$done({});
