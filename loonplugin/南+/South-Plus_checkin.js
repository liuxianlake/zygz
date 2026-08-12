/**
 * South-Plus 日常任务签到 V1
 * 
 * 流程：
 * 读取Cookie
 * ↓
 * 领取日常任务(job)
 * ↓
 * 完成任务(job2)
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

const host = "https://www.south-plus.net/plugin.php";

const cid = "15";

// 暂时沿用抓包中的 verify
const verify = "38dc1030";


function request(url) {
    return new Promise((resolve) => {
        $httpClient.get(
            {
                url: url,
                headers: {
                    "Cookie": cookie,
                    "User-Agent":
                    "Mozilla/5.0"
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

    const now1 = Date.now();

    // 领取任务
    const jobUrl =
    `${host}?H_name=tasks&action=ajax&actions=job&cid=${cid}&nowtime=${now1}&verify=${verify}`;

    const jobResult = await request(jobUrl);


    // 完成任务
    const now2 = Date.now();

    const job2Url =
    `${host}?H_name=tasks&action=ajax&actions=job2&cid=${cid}&nowtime=${now2}&verify=${verify}`;


    const job2Result = await request(job2Url);


    let msg =
    "领取:\n" +
    jobResult +
    "\n\n完成:\n" +
    job2Result;


    $notification.post(
        "South-Plus签到",
        "执行结果",
        msg
    );


    console.log(msg);

    $done();

})();
