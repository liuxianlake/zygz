/**
 * @name 尚香书院 自动签到
 * @description sxsy13自动签到整理版
 */

const cookie = $persistentStore.read("sxsy13_cookie");

if (!cookie) {
    $notification.post(
        "sxsy13签到",
        "缺少Cookie",
        "请先配置sxsy13_cookie"
    );
    $done();
    return;
}


const baseHeaders = {
    "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",

    "Referer":
    "https://sxsy13.com/index.php?mobile=2",

    "Accept":
    "*/*",

    "Accept-Language":
    "zh-CN,zh-Hans;q=9"
};


const loginHeaders = {
    ...baseHeaders,
    "Cookie": String(cookie)
};


// 获取首页 formhash

const homeUrl =
"https://sxsy13.com/index.php?mobile=2";


$httpClient.get(
    {
        url: homeUrl,
        headers: loginHeaders
    },

    function(error1, response1, body1) {

        if (error1) {
            $notification.post(
                "sxsy13签到",
                "首页请求失败",
                error1
            );
            $done();
            return;
        }


        const formhashMatch =
        body1.match(/['"]formhash['"]:\s*["']([^"']+)["']/);


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


        // 获取数学题

        const questionUrl =
        "https://sxsy13.com/plugin.php?id=k_misign:sign" +
        "&operation=qiandao" +
        "&format=text" +
        "&formhash=" +
        formhash;


        $httpClient.get(
            {
                url: questionUrl,
                headers: loginHeaders
            },

            function(error2, response2, body2) {


                if (error2) {
                    $notification.post(
                        "sxsy13签到",
                        "获取题目失败",
                        error2
                    );
                    $done();
                    return;
                }


                // 获取 mathv

                let mathv = "";


                let setCookie =
                response2.headers["set-cookie"]
                ||
                response2.headers["Set-Cookie"]
                ||
                "";


                let mathvMatch =
                String(setCookie).match(
                    /(u52q_2132_k_misign_mathv=[^;, ]+)/
                );


                if (mathvMatch) {
                    mathv = mathvMatch[1];
                }



                const questionMatch =
                body2.match(/var q="([^"]+)"/);


                if (!questionMatch) {

                    $notification.post(
                        "sxsy13签到",
                        "失败",
                        "没有找到数学题"
                    );

                    $done();
                    return;
                }



                const question =
                questionMatch[1];



                const mathMatch =
                question.match(/(\d+)\s*([+-])\s*(\d+)/);



                if (!mathMatch) {

                    $notification.post(
                        "sxsy13签到",
                        "失败",
                        question
                    );

                    $done();
                    return;
                }



                const num1 =
                Number(mathMatch[1]);

                const operator =
                mathMatch[2];

                const num2 =
                Number(mathMatch[3]);


                let answer;


                if (operator === "+") {
                    answer = num1 + num2;
                } else {
                    answer = num1 - num2;
                }



                // 提交签到

                const submitUrl =
                "https://sxsy13.com/plugin.php?id=k_misign:sign" +
                "&operation=qiandao" +
                "&format=global_usernav_extra" +
                "&formhash=" +
                formhash +
                "&mathverify_answer=" +
                encodeURIComponent(answer) +
                "&inajax=1" +
                "&ajaxtarget=k_misign_mv_tmp";



                const submitHeaders = {

                    ...baseHeaders,

                    "Cookie":
                    String(cookie) +
                    (mathv ? ";" + mathv : "")

                };



                $httpClient.get(
                    {
                        url: submitUrl,
                        headers: submitHeaders
                    },

                    function(error3, response3, body3) {


                        if (error3) {

                            $notification.post(
                                "sxsy13签到",
                                "提交失败",
                                error3
                            );

                        } else {


                            let result = body3;


                            let resultMatch =
                            body3.match(
                                /<!\[CDATA\[(.*?)\]\]>/
                            );


                            if (resultMatch) {
                                result = resultMatch[1];
                            }


                            result =
                            result.replace(/<[^>]*>/g, "")
                            .trim();



                            if (
                                result.includes("已签") ||
                                result.includes("成功")
                            ) {

                                $notification.post(
                                    "sxsy13签到",
                                    "成功",
                                    result
                                );

                            } else {

                                $notification.post(
                                    "sxsy13签到",
                                    "结果",
                                    result
                                );

                            }

                        }


                        $done();

                    }
                );

            }
        );

    }
);
