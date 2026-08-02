/**
 * SXSY13 论坛自动算数签到脚本
 */

const cookie = $persistentStore.read("sxsy13_cookie");

if (!cookie) {
  $notification.post("SXSY13 签到", "失败 ❌", "未找到 Cookie，请先在 Safari 中打开论坛签到页获取 Cookie");
  $done();
} else {
  getQuizPage();
}

// 1. 获取签到页面，提取算数题和 formhash
function getQuizPage() {
  const options = {
    url: "https://www.sxsy13.com/plugin.php?id=k_misign:sign",
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      "Cookie": cookie
    }
  };

  $httpClient.get(options, function(error, response, data) {
    if (error || !data) {
      $notification.post("SXSY13 签到", "失败 ❌", "无法打开签到页面");
      $done();
      return;
    }

    // 判断是否已经签到过
    if (data.includes("您的签到状态：已签到") || data.includes("今日已签")) {
      $notification.post("SXSY13 签到", "提示 ℹ️", "今天已经签到过了，无需重复签到");
      $done();
      return;
    }

    // 匹配 formhash
    const hashMatch = data.match(/name="formhash"\s+value="([a-zA-Z0-9]+)"/) || data.match(/formhash=([a-zA-Z0-9]+)/);
    
    // 匹配算数题，常见格式如：15 - 14 = ? 或 15-14
    const mathMatch = data.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);

    if (hashMatch && mathMatch) {
      const formhash = hashMatch[1];
      const num1 = parseInt(mathMatch[1]);
      const operator = mathMatch[2];
      const num2 = parseInt(mathMatch[3]);

      let answer = 0;
      if (operator === '+') answer = num1 + num2;
      else if (operator === '-') answer = num1 - num2;
      else if (operator === '*') answer = num1 * num2;

      console.log(`[SXSY13] 算数题匹配成功: ${num1} ${operator} ${num2} = ${answer}`);
      
      // 2. 提交签到答案
      submitSign(answer, formhash);
    } else {
      $notification.post("SXSY13 签到", "失败 ❌", "未能解析出算术题或 formhash，请检查网页结构");
      $done();
    }
  });
}

// 2. 发送 GET 请求提交签到
function submitSign(answer, formhash) {
  const signUrl = `https://www.sxsy13.com/plugin.php?id=k_misign:sign&operation=qiandao&format=text&formhash=${formhash}&mathverify_answer=${answer}&inajax=1&ajaxtarget=signBtn`;
  
  const options = {
    url: signUrl,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      "Cookie": cookie,
      "Referer": "https://www.sxsy13.com/plugin.php?id=k_misign:sign"
    }
  };

  $httpClient.get(options, function(error, response, data) {
    if (!error && (data.includes("签到成功") || data.includes("恭喜") || response.status === 200)) {
      $notification.post("SXSY13 签到", "成功 🎉", `算术验证 ${answer} 计算正确，签到完成！`);
    } else {
      $notification.post("SXSY13 签到", "可能失败 ⚠️", `返回数据: ${data ? data.slice(0, 50) : '无数据'}`);
    }
    $done();
  });
}
