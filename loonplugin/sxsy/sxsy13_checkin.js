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

const url = "https://sxsy13.com/plugin.php?id=k_misign%3Asign&operation=qiandao&format=text&formhash=b3e3f9b1";

const headers = {
    "Cookie": cookie,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
    "Referer": "https://sxsy13.com/index.php?mobile=2",
    "Accept": "*/*"
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
                "返回内容",
                body
            );
        }

        $done();
    }
);
