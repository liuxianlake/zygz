# sb.sb 论坛自动签到（Loon 插件）

Loon 远程插件：浏览论坛时自动捕获 Cookie，定时自动签到，结果推送到系统通知。

## 文件结构

```
sb-checkin/
├── sb-checkin.plugin   # 插件主文件（远程安装入口）
├── sb-cookie.js       # Cookie 捕获脚本（request 阶段触发）
└── sb-checkin.js       # 签到脚本（cron 定时 / 手动触发）
```

## 一、部署到 GitHub

```bash
cd sb-checkin
git init
git add .
git commit -m "feat: sb.sb 论坛签到插件"
# 在 GitHub 新建仓库 sb-checkin 后：
git remote add origin https://github.com/<你的用户名>/sb-checkin.git
git branch -M main
git push -u origin main
```

> 记得把 `sb-checkin.plugin` 顶部的 `#!author` 和 `#!homepage` 改成你自己的，
> 以及 `[Script]` 里三处 URL 中的 `<你的GitHub用户名>` 替换为实际用户名。
> （若你使用相对路径版本遇到"脚本运行无任何输出/日志"，请改用完整 URL——相对路径在部分远程插件场景下不解析）

### 安装链接（二选一）

- 官方 Raw：`https://raw.githubusercontent.com/<你的用户名>/sb-checkin/main/sb-checkin.plugin`
- jsDelivr 镜像（国内更快）：`https://cdn.jsdelivr.net/gh/<你的用户名>/sb-checkin@main/sb-checkin.plugin`

> 插件内脚本用的是相对路径，Loon 会自动解析到同目录下的 js 文件，无需修改。
> 如遇脚本加载失败，把 `[Script]` 里的 `script("xxx.js")` 改成完整 raw URL 即可。

## 二、首次配置（获取 Cookie）

### 1. 安装并信任 MitM 证书（一次性，已做过可跳过）

1. Loon →「配置」→「MITM」→「证书管理」→ 生成新的 CA 证书 → 安装
2. iOS 系统设置 →「通用」→「VPN 与设备管理」→ 安装 Loon 的描述文件
3. iOS 系统设置 →「通用」→「关于本机」→「证书信任设置」→ 打开 Loon CA 的完全信任开关

> 插件的 `[Mitm] hostname` 会自动合并论坛域名，无需手动填写。
> 没有这一步，HTTPS 请求无法解密，脚本读不到 Cookie 请求头。

### 2. 安装插件

Loon →「配置」→「插件」→ 右上角「+」→ 从链接安装 → 粘贴上面的安装链接。

### 3. 捕获 Cookie

1. 确保 Loon 已开启、你的网络环境能访问论坛（**论坛屏蔽大陆 IP**，代理由你自己的分流规则或其他代理软件负责）
2. 用 Safari 打开 `https://sb.sb` 并**登录**
3. 看到通知「✅ Cookie 捕获成功」即完成
4. 以后 Cookie 过期时，重新登录一次论坛即可自动更新（Cookie 变化时会重新通知）

## 三、签到接口（已通过抓包确认，无需手动配置）

2026-09-23 抓包确认的签到流程，脚本已自动实现：

1. **GET** `https://sb.sb/signin/` —— 从页面 HTML 提取 CSRF token（`<input name="_csrf" value="...">`）
2. **POST** `https://sb.sb/signin/`，请求体为表单：`_csrf=<token>&message=<签到留言>`
3. 响应页面中的 `<div class="signin-result ...">` 块即为结果：
   - `signin-result success` → 签到成功，通知里会带上「连续签到第 X 天，基础 X 饼共 X 饼」
   - 页面出现「今日已签到」→ 跳过，不发重复请求

参数里只需按需调整：**签到留言**（可留空）、**定时时间**、**签到通知**。

配置好后到「工具」→「脚本」里手动运行「sb论坛手动签到」测试一次，成功后就等 cron 自动跑。

> 如果通知提示「无法获取 CSRF Token」，说明 Cookie 已失效：重新登录一次论坛即可自动更新。

## 四、参数说明

| 参数 | 说明 |
| --- | --- |
| 签到接口地址 | 签到页地址，已预填 `https://sb.sb/signin/`，一般无需修改 |
| 请求方式 | 默认 POST，已确认；GET 仅测试用 |
| 签到留言 | 签到附带的一句话留言，显示在今日签到板，可留空 |
| 成功关键字 | 备用判定，脚本已自动识别结果，一般留空 |
| 定时时间 | Cron 表达式（分 时 日 月 周），默认每天 8:30（论坛每日 8:00 北京时间重置，勿早于 8 点） |
| 签到通知 | 签到结果推送到系统通知 |

## 注意事项

- 需要 Loon ≥ 3.5.1 (983)（新版 Script 语法）
- 签到请求由 Loon 发出，走不走代理取决于你自己的分流配置；论坛屏蔽大陆 IP，请确保相应域名有代理出口
- Cookie 通过 `$persistentStore` 保存在本机 Loon 持久化存储（键：`sb_forum_cookie` / `sb_forum_ua`），不会上传到任何地方
