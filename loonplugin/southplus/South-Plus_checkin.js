/**
 * @name South-Plus日常任务签到
 * @description South-Plus每日任务自动签到 修正版
 */

let cookie = $persistentStore.read("south_cookie");

if (!cookie) {
    $notification.post(
        "South-Plus签到",
        "失败",
        "未找到 south_cookie，请先在配置中填写登录Cookie"
    );
    $done();
}

const base = "https://www.south-plus.net";
const plugin = `${base}/plugin.php`;
const cid = "15"; // 日常任务分类ID，如失效请从任务页面提取

// 建议修改为你获取Cookie时使用的浏览器UA，避免会话校验失败
const userAgent =
"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";

function getHeaders(referer = `${plugin}?H_name=tasks`) {
    return {
        "Cookie": cookie,
        "User-Agent": userAgent,
        "Referer": referer,
        "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
        "zh-CN,zh-Hans;q=0.9"
    };
}

function get(url, referer) {
    return new Promise(resolve => {
        $httpClient.get(
            {
                url: url,
                headers: getHeaders(referer),
                "auto-cookie": false
            },
            (error, response, body) => {
                if (error || !body) {
                    resolve("");
                } else {
                    resolve(body);
                }
            }
        );
    });
}

(async () => {
    // 1. 访问任务中心首页，提取动态verify令牌（核心修复）
    const taskIndexUrl = `${plugin}?H_name=tasks`;
    const taskPage = await get(taskIndexUrl);
    
    if (!taskPage) {
        $notification.post("South-Plus签到", "失败", "无法访问任务页面，请检查网络或Cookie有效性");
        $done();
        return;
    }

    // 从页面中匹配verify（兼容链接、JS变量、隐藏域等多种形式）
    const verifyMatch = taskPage.match(/verify["']?\s*[=:]\s*["']?([a-f0-9]+)["']?/i);
    if (!verifyMatch || !verifyMatch[1]) {
        $notification.post("South-Plus签到", "失败", "提取校验令牌失败，大概率是Cookie已过期或未登录");
        console.log("页面调试片段：" + taskPage.slice(0, 600));
        $done();
        return;
    }
    const verify = verifyMatch[1];
    console.log("成功获取当前verify：" + verify);

    // 2. 访问新任务列表页，同步会话上下文
    const newTaskUrl = `${plugin}?H_name=tasks&action=newtasks`;
    await get(newTaskUrl, taskIndexUrl);

    // 3. 领取日常任务
    const jobUrl = `${plugin}?H_name=tasks&action=ajax&actions=job&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;
    const jobResult = await get(jobUrl, newTaskUrl);

    // 4. 访问进行中任务页，触发状态更新
    const doingTaskUrl = `${plugin}?H_name=tasks&action=doing`;
    await get(doingTaskUrl, jobUrl);

    // 5. 提交完成任务
    const job2Url = `${plugin}?H_name=tasks&action=ajax&actions=job2&cid=${cid}&nowtime=${Date.now()}&verify=${verify}`;
    const job2Result = await get(job2Url, doingTaskUrl);

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
