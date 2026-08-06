/**
 * @name sxsy13 自动签到测试版
 * @description 获取签到数学题测试
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


const headers = {
    "Cookie": String(cookie),
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
    "Referer": "https://sxsy13.com/index.php?mobile=2",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9"
};


// 第一步：获取首页，提取formhash

const homeUrl = "https://sxsy13.com/index.php?mobile=2";


$httpClient.get(
    {
        url: homeUrl,
        headers: headers
    },
    function(error, response, body) {

        if (error) {
            $notification.post(
                "sxsy13签到",
                "首页请求失败",
                error
            );
            $done();
            return;
        }


        const formhashMatch = body.match(/['"]formhash['"]:\s*["']([^"']+)["']/);


        if (!formhashMatch) {

            $notification.post(
                "sxsy13签到",
                "失败",
                "没有找到formhash"
            );

            $done();
            return;
        }


        const formhash = formhashMatch[1];


        console.log("formhash=" + formhash);



        // 第二步：请求数学题

        const questionUrl =
            "https://sxsy13.com/plugin.php?id=k_misign:sign&operation=qiandao&format=text&formhash=" 
            + formhash;



        $httpClient.get(
            {
                url: questionUrl,
                headers: headers
            },
            function(error2, response2, body2) {


                if (error2) {

                    $notification.post(
                        "sxsy13签到",
                        "数学题请求失败",
                        error2
                    );

                } else {

                    console.log(body2);


                    $notification.post(
                        "sxsy13签到",
                        "数学题返回",
                        body2
                    );

                }


                $done();

            }
        );


    }
);
