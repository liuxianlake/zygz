/**
 * @name South-Plus日常任务签到
 * @description South-Plus每日任务自动签到
 */

const cookie = $persistentStore.read("south_cookie");

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


const headers = {
    "Cookie": cookie,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6 Mobile/15E148 Safari/604.1",
    "Referer": "https://www.south-plus.net/plugin.php?H_name-tasks.html"
};


function get(url) {

    return new Promise((resolve) => {

        $httpClient.get(
            {
                url: url,
                headers: headers
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


(async () => {


    // 进入任务中心
    await get(
        `${plugin}?H_name-tasks.html`
    );


    // 领取日常任务
    const jobUrl =
        `${plugin}?H_name=tasks&action=ajax&actions=job&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;


    const jobResult = await get(jobUrl);



    // 进入进行中的任务页面
    await get(
        `${plugin}?H_name-tasks-actions-newtasks.html.html`
    );



    // 完成任务领取奖励
    const job2Url =
        `${plugin}?H_name=tasks&action=ajax&actions=job2&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;


    const job2Result = await get(job2Url);



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
