/**
 * @name sxsy13 自动签到测试版
 * @description sxsy13签到插件测试
 */

const cookie = $persistentStore.read("sxsy13_cookie");

if (!cookie) {
    $notification.post(
        "sxsy13签到",
        "缺少Cookie",
        "请先配置 sxsy13_cookie"
    );
    $done();
}

const url = "https://www.sxsy13.com/plugin.php?id=k_misign:sign&operation=qiandao&format=global_usernav_extra&inajax=1";

const headers = {
    "Cookie": cookie,
    "User-Agent": "Mozilla/5.0"
};

$httpClient.get(
    {
        url: url,
        headers: headers
    },
    function(error, response, body) {

        if (error) {
            $notification.post(
                "sxsy13签到",
                "请求失败",
                error
            );
        } else {
            console.log(body);

            $notification.post(
                "sxsy13签到",
                "请求完成",
                "已获取签到页面"
            );
        }

        $done();
    }
);
