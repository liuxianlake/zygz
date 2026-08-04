/**
 * 属性签到论坛 (sxsy13.com) 签到脚本
 * 配合 Loon 使用
 */

const $ = new Env('sxsy13签到');

// 1. 抓包模式：保存用户访问页面时自动带有的 Cookie 和 Hash
if (typeof $request !== 'undefined') {
  GetCookie();
} else {
  // 2. 定时任务模式：执行自动签到
  AutoCheckin();
}

function GetCookie() {
  if ($request.headers && $request.url.indexOf('k_misign') !== -1) {
    const cookie = $request.headers['Cookie'] || $request.headers['cookie'];
    const formhashMatch = $request.url.match(/formhash=([^&]+)/);
    
    if (cookie) {
      $.setdata(cookie, 'sxsy13_cookie');
      $.log('[sxsy13] 成功获取并保存 Cookie');
    }
    if (formhashMatch && formhashMatch[1]) {
      $.setdata(formhashMatch[1], 'sxsy13_formhash');
      $.log('[sxsy13] 成功获取并保存 Formhash: ' + formhashMatch[1]);
    }
    $.notification('sxsy13 签到', '获取 Cookie 成功！', '后续将自动完成每日签到');
  }
  $.done();
}

async function AutoCheckin() {
  const cookie = $.getdata('sxsy13_cookie');
  const formhash = $.getdata('sxsy13_formhash');

  if (!cookie) {
    $.notification('sxsy13 签到失败', '', '未获取到 Cookie，请先在 Safari 浏览器中打开论坛登录并点击一次签到');
    $.done();
    return;
  }

  // 第一步：先请求签到页面获取最新的验证码算术题
  const getUrl = `https://www.sxsy13.com/plugin.php?id=k_misign:sign&operation=qiandao&format=global_usernav_extra&inajax=1`;
  const options = {
    url: getUrl,
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://www.sxsy13.com/'
    }
  };

  $.get(options, (error, response, data) => {
    if (error) {
      $.notification('sxsy13 签到失败', '', '网络请求异常');
      $.done();
      return;
    }

    // 尝试解析算术题 (例如匹配 "3 + 5 = ?" 或 "9 - 4 = ?")
    let answer = '';
    const mathMatch = data.match(/(\d+)\s*([\+\-])\s*(\d+)\s*=\s*\?/);
    if (mathMatch) {
      const num1 = parseInt(mathMatch[1]);
      const operator = mathMatch[2];
      const num2 = parseInt(mathMatch[3]);
      answer = operator === '+' ? (num1 + num2) : (num1 - num2);
      $.log(`[sxsy13] 自动识别算术题: ${num1} ${operator} ${num2} = ${answer}`);
    } else {
      $.log('[sxsy13] 未找到算术验证码，尝试直接提交...');
    }

    // 第二步：提交带答案的签到请求
    const actualHash = formhash || '092d5c74';
    let signUrl = `https://www.sxsy13.com/plugin.php?id=k_misign:sign&operation=qiandao&formhash=${actualHash}&format=global_usernav_extra&inajax=1`;
    if (answer !== '') {
      signUrl += `&mathverify_answer=${answer}`;
    }

    const signOptions = {
      url: signUrl,
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.sxsy13.com/'
      }
    };

    $.get(signOptions, (signErr, signRes, signData) => {
      if (signData.includes('今日已签') || signData.includes('签到成功') || signData.includes('恭喜')) {
        $.notification('sxsy13 签到结果', '成功', '签到完成！');
      } else if (signData.includes('验证码')) {
        $.notification('sxsy13 签到结果', '失败', '验证码算术计算错误');
      } else {
        $.notification('sxsy13 签到结果', '通知', '已尝试提交，请进入论坛检查');
      }
      $.log('[sxsy13] 返回结果: ' + signData);
      $.done();
    });
  });
}

// 简易 Env 框架兼容 Loon
function Env(name) {
  return {
    name,
    log: (...args) => console.log(...args),
    getdata: (key) => $persistentStore.read(key),
    setdata: (val, key) => $persistentStore.write(val, key),
    notification: (title, subtitle, message) => $notification.post(title, subtitle, message),
    get: (options, callback) => $httpClient.get(options, callback),
    post: (options, callback) => $httpClient.post(options, callback),
    done: () => $done()
  };
}
