/**
 * @name South-Plus日常任务签到
 * @description South-Plus每日任务自动签到 V7
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
"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";





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





function get(url) {


    return new Promise(resolve => {


        $httpClient.get(

            {

                url: url,

                headers: getHeaders(),

                "auto-cookie": false

            },


            (error, response, body) => {


                if (error) {

                    resolve("");

                } else {

                    resolve(body);

                }


            }


        );


    });


}






// 清理服务器返回的 XML

function cleanResponse(text) {


    if (!text) return "";


    let match = text.match(
        /<!\[CDATA\[(.*?)\]\]>/
    );


    if (match) {

        return match[1];

    }


    return text
        .replace(/<[^>]+>/g, "")
        .trim();


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







    // 3. 领取任务


    const jobUrl =

    `${plugin}?H_name=tasks&action=ajax&actions=job&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;



    const jobResult =
        await get(jobUrl);






    let finalMessage = "";






    /*
       判断是否领取成功
    */


    if (

        jobResult.includes("success") &&

        jobResult.includes("完成")

    ) {



        // 4. 进入进行中的任务

        await get(
            `${plugin}?H_name-tasks-actions-newtasks.html.html`
        );







        // 5. 完成任务


        const job2Url =

        `${plugin}?H_name=tasks&action=ajax&actions=job2&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;



        const job2Result =
            await get(job2Url);





        finalMessage =

        "领取任务:\n" +

        cleanResponse(jobResult) +

        "\n\n完成任务:\n" +

        cleanResponse(job2Result);



    } else {



        finalMessage =

        "今日无需签到:\n\n" +

        cleanResponse(jobResult);



    }






    console.log(finalMessage);





    $notification.post(

        "South-Plus签到",

        "执行结果",

        finalMessage

    );






    $done();



})();
