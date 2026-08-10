/**
 * @name sxsy 自动签到
 * @description sxsy自动签到整理稳定版
 */


// ===============================
// 修改这里即可更换网站
// ===============================

const host = "https://sxsy45.com";



// ===============================
// Cookie
// ===============================

const cookie = $persistentStore.read("sxsy13_cookie");


if (!cookie) {

    $notification.post(
        "sxsy签到",
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
    host + "/index.php?mobile=2",

    "Accept":
    "*/*",

    "Accept-Language":
    "zh-CN,zh-Hans;q=0.9"

};



const loginHeaders = {

    ...baseHeaders,

    "Cookie":
    String(cookie)

};




// ===============================
// 1. 获取 formhash
// ===============================


const homeUrl =
host + "/index.php?mobile=2";



$httpClient.get(

    {
        url: homeUrl,
        headers: loginHeaders
    },


    function(error1, response1, body1) {


        if (error1) {

            $notification.post(
                "sxsy签到",
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
                "sxsy签到",
                "失败",
                "没有找到formhash"
            );


            $done();
            return;

        }



        const formhash =
        formhashMatch[1];





// ===============================
// 2. 获取数学题
// ===============================


        const questionUrl =

        host +
        "/plugin.php?id=k_misign:sign" +
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
                        "sxsy签到",
                        "获取题目失败",
                        error2
                    );


                    $done();
                    return;

                }





                // 获取mathv

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

                    mathv =
                    mathvMatch[1];

                }





                const questionMatch =
                body2.match(/var q="([^"]+)"/);



                if (!questionMatch) {


                    $notification.post(
                        "sxsy签到",
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
                        "sxsy签到",
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

                    answer =
                    num1 + num2;

                } else {

                    answer =
                    num1 - num2;

                }





// ===============================
// 3. 提交签到
// ===============================


                const submitUrl =


                host +
                "/plugin.php?id=k_misign:sign" +
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

                    String(cookie)
                    +
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
                                "sxsy签到",
                                "签到失败",
                                error3
                            );


                            $done();
                            return;

                        }





                        let result =
                        body3 || "";




                        let resultMatch =
                        result.match(
                            /<!\[CDATA\[(.*?)\]\]>/
                        );



                        if (resultMatch) {

                            result =
                            resultMatch[1];

                        }



                        result =
                        result
                        .replace(/<[^>]*>/g, "")
                        .trim();






                        // ===============================
                        // 修复通知判断
                        // ===============================


                        if (

                            result.includes("失败")
                            ||
                            result.includes("错误")
                            ||
                            result.includes("失效")
                            ||
                            result.includes("不存在")

                        ) {


                            $notification.post(
                                "sxsy签到",
                                "签到失败",
                                result || "未知错误"
                            );


                        } else {


                            $notification.post(
                                "sxsy签到",
                                "签到成功",
                                result || "签到请求完成"
                            );


                        }





                        $done();


                    }

                );



            }


        );



    }


);
