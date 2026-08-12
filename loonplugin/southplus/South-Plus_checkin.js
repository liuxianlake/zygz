/**
 * @name South-Plus日常任务签到
 * @description South-Plus每日任务自动签到 V3
 */


let cookie = $persistentStore.read("south_cookie");


if (!cookie) {

    $notification.post(
        "South-Plus签到",
        "失败",
        "未找到 south_cookie"
    );

    $done();

}



const base = "https://www.south-plus.net";

const plugin = `${base}/plugin.php`;


const cid = "15";

const verify = "38dc1030";



const userAgent =
"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";



function getHeaders() {

    return {

        "Cookie": cookie,

        "User-Agent": userAgent,

        "Referer":
        "https://www.south-plus.net/plugin.php?H_name-tasks.html.html",

        "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

        "Accept-Language":
        "zh-CN,zh-Hans;q=0.9"

    };

}





function updateCookie(responseHeaders) {


    if (!responseHeaders) return;


    let setCookie =
        responseHeaders["Set-Cookie"] ||
        responseHeaders["set-cookie"];



    if (!setCookie) return;



    let list = [];



    if (Array.isArray(setCookie)) {


        setCookie.forEach(item => {

            list.push(
                item.split(";")[0]
            );

        });



    } else {


        list.push(
            setCookie.split(";")[0]
        );


    }




    let cookieObj = {};



    cookie.split(";").forEach(item => {


        let pair =
            item.trim().split("=");



        if (pair.length >= 2) {


            cookieObj[pair[0]] =
                pair.slice(1).join("=");


        }


    });





    list.forEach(item => {


        let pair =
            item.split("=");



        if (pair.length >= 2) {


            cookieObj[pair[0]] =
                pair.slice(1).join("=");


        }


    });






    cookie = Object.keys(cookieObj)

        .map(
            key =>
            `${key}=${cookieObj[key]}`
        )

        .join("; ");





    $persistentStore.write(
        cookie,
        "south_cookie"
    );
    
    console.log("更新后的Cookie:");
    console.log(cookie);

}






function get(url) {


    return new Promise(resolve => {



        $httpClient.get(

            {

                url: url,

                headers: getHeaders()

            },

            (error, response, body) => {



                if (response && response.headers) {


                    updateCookie(
                        response.headers
                    );


                }



                if (error) {


                    resolve("");

                } else {


                    resolve(body);

                }


            }

        );



    });


}






(async () => {



    // 1. 社区论坛任务

    await get(
        `${plugin}?H_name-tasks.html`
    );





    // 2. 新任务选择

    await get(
        `${plugin}?H_name-tasks.html.html`
    );






    // 3. 领取日常任务


    const jobUrl =

    `${plugin}?H_name=tasks&action=ajax&actions=job&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;



    const jobResult =
        await get(jobUrl);






    // 4. 进入进行中的任务


    await get(
        `${plugin}?H_name-tasks-actions-newtasks.html.html`
    );







    // 5. 完成任务


    const job2Url =

    `${plugin}?H_name=tasks&action=ajax&actions=job2&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;



    const job2Result =
        await get(job2Url);







    const result =

    "领取任务:\n" +

    jobResult +

    "\n\n完成任务:\n" +

    job2Result;





    console.log(result);





    $notification.post(

        "South-Plus签到",

        "执行结果",

        result

    );





    $done();



})();
