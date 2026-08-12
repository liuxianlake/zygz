/**
 * @name South-Plus日常任务签到
 * @description South-Plus每日任务自动签到
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
"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";


function updateCookie(headers) {

    if (!headers) return;

    let setCookie = headers["Set-Cookie"] || headers["set-cookie"];

    if (!setCookie) return;


    let newCookies = [];

    if (Array.isArray(setCookie)) {

        setCookie.forEach(item => {
            newCookies.push(
                item.split(";")[0]
            );
        });

    } else {

        newCookies.push(
            setCookie.split(";")[0]
        );

    }


    let oldCookies = {};

    cookie.split(";").forEach(item => {

        let part = item.trim().split("=");

        if (part.length >= 2) {
            oldCookies[part[0]] =
                part.slice(1).join("=");
        }

    });


    newCookies.forEach(item => {

        let part = item.split("=");

        if (part.length >= 2) {

            oldCookies[part[0]] =
                part.slice(1).join("=");

        }

    });


    cookie = Object.keys(oldCookies)
        .map(key => `${key}=${oldCookies[key]}`)
        .join("; ");


    $persistentStore.write(
        cookie,
        "south_cookie"
    );

}



function get(url) {

    return new Promise((resolve) => {

        $httpClient.get(
            {
                url: url,
                headers: {

                    "Cookie": cookie,

                    "User-Agent": userAgent,

                    "Referer":
                    "https://www.south-plus.net/plugin.php?H_name-tasks.html.html",

                    "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

                }
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


    // 进入任务中心

    await get(
        `${plugin}?H_name-tasks.html`
    );



    // 新任务选择

    await get(
        `${plugin}?H_name-tasks.html.html`
    );



    // 领取日常任务

    const jobUrl =
    `${plugin}?H_name=tasks&action=ajax&actions=job&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;


    const jobResult = await get(jobUrl);



    // 进入进行中的任务

    await get(
        `${plugin}?H_name-tasks-actions-newtasks.html.html`
    );



    // 完成任务

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
