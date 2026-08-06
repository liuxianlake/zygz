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

const url = "https://sxsy13.com/index.php?mobile=2";

const headers = {
    "Cookie": String(cookie),
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
    "Referer": "https://sxsy13.com/index.php?mobile=2",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9"
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

            const formhashMatch = body.match(/['"]formhash['"]:\s*["']([^"']+)["']/);

            if (formhashMatch) {

                console.log("formhash=" + formhashMatch[1]);

                $notification.post(
                    "sxsy13签到",
                    "找到formhash",
                    formhashMatch[1]
                );

            } else {

                console.log("没有找到formhash");

                $notification.post(
                    "sxsy13签到",
                    "失败",
                    "没有找到formhash"
                );

            }
        }

        $done();

    }
);
