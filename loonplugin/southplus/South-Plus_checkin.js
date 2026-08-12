/**
 * @name South-Plus日常任务签到
 * @description South-Plus每日任务自动签到
 */

const cookie = $persistentStore.read("south_cookie");

console.log(cookie);

if (!cookie) {
    $notification.post(
        "South-Plus签到",
        "失败",
        "未找到 south_cookie"
    );
    $done();
}

const host = "https://www.south-plus.net/plugin.php";

const cid = "15";
const verify = "38dc1030";


function request(url) {
    return new Promise((resolve) => {
        $httpClient.get(
            {
                url: url,
                headers: {
                    "Cookie": cookie,
                    "User-Agent": "Mozilla/5.0"
                }
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

    // 领取日常任务
    const jobUrl =
        `${host}?H_name=tasks&action=ajax&actions=job&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;

    const jobResult = await request(jobUrl);


    // 完成日常任务
    const job2Url =
        `${host}?H_name=tasks&action=ajax&actions=job2&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;

    const job2Result = await request(job2Url);


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
