/**
 * @name South-Plus Cookie测试
 */

const cookie = $persistentStore.read("south_cookie");

const url = "https://www.south-plus.net/plugin.php?H_name-tasks.html.html";

$httpClient.get(
    {
        url: url,
        headers: {
            "Cookie": cookie,
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
        }
    },
    (error, response, body) => {

        console.log(body);

        $notification.post(
            "South-Plus测试",
            "响应结果",
            body.substring(0, 100)
        );

        $done();

    }
);
