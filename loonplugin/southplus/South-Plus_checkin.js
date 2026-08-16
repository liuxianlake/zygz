/**
 * @name South-Plus签到
 * @description South-Plus日常+周常任务签到 
 */


let cookie = $persistentStore.read("south_cookie");


if (!cookie) {

    $notification.post(
        "South-Plus签到",
        "Cookie不存在",
        ""
    );

    $done();

}



const base = "https://www.south-plus.net";

const plugin = `${base}/plugin.php`;

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







async function runTask(name, cid) {



    let result = {

        name:name,

        status:"",

        log:""

    };




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




    const cleanJob =
        cleanResponse(jobResult);






    /*
       判断领取结果
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





        const cleanJob2 =
            cleanResponse(job2Result);





        result.log =

        `[${name}]\n\n` +

        "领取:\n" +

        cleanJob +

        "\n\n完成:\n" +

        cleanJob2;






        if (

            cleanJob2.includes("已经完成")

        ) {


            result.status =
            `${name}任务完成`;


        } else {


            result.status =
            `${name}任务异常`;


        }





    } else {



        result.log =

        `[${name}]\n\n` +

        "领取:\n" +

        cleanJob;







        if (

            cleanJob.includes("还没超过") ||

            cleanJob.includes("距离上次")

        ) {


            result.status =
            `${name}已签到`;



        } else if (

            cleanJob.includes("您还没有登录")

        ) {


            result.status =
            "Cookie失效";



        } else {


            result.status =
            `${name}未刷新`;


        }


    }





    return result;



}









(async () => {



    let logs = [];

    let notices = [];





    // 日常

    const daily =
        await runTask("日常",15);



    logs.push(daily.log);



    notices.push(daily.status);






    // 周常

    const weekly =
        await runTask("周常",14);



    logs.push(weekly.log);



    notices.push(weekly.status);








    const logText =
        logs.join("\n\n================\n\n");





    const noticeText =
        notices.join("\n");






    console.log(logText);





    $notification.post(

        "South-Plus签到",

        noticeText,

        ""

    );





    $done();



})();
