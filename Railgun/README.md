# Railgun 自动签到助手

这是一个仿照当前目录 GLaDOS 插件结构制作的 Chrome Manifest V3 扩展。它会每天在设定时间后由后台 service worker 静默请求 Railgun 签到接口，不打开网页、不模拟点击。

## 安装

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`Railgun`。

## 使用

1. 点击扩展图标进入选项页。
2. 设置每日签到时间。
3. 确认 Chrome 已登录 `https://railgun.info`。
4. 如果浏览器没有保持登录，可以在选项页的 Cookie 输入框填入 `koa:sess=...; koa:sess.sig=...` 形式的 cookie。
5. 点击“立即静默测试签到”验证接口和 Cookie 是否可用。

点击浏览器插件栏图标会打开一个小弹窗，可查看定时时间、自动登录状态和最近日志，也可以从弹窗底部进入完整设置页。

## Gmail 自动登录

登录失效时，扩展可以自动完成以下流程：

1. 请求 Railgun 向你的邮箱发送登录验证码。
2. 使用当前 Chrome 的 Gmail 登录态读取 Gmail 收件箱 Feed。
3. 提取验证码并请求 Railgun 登录接口。
4. 登录成功后重新静默签到。

首次启用不需要 Google Cloud，也不需要 OAuth Client ID：

1. 在当前 Chrome 里登录你的 Gmail。
2. 打开 `https://mail.google.com/mail/feed/atom`，确认能看到 Gmail Feed 或 XML 内容。
3. 回到扩展选项页，填写 Railgun 登录邮箱。
4. 勾选“登录失效时自动用 Gmail 验证码登录 Railgun”。
5. 点击“测试 Gmail Feed”，确认扩展能读取 Feed。
6. 点击“立即静默测试签到”。

## 说明

- Cookie 只保存在本机 Chrome 扩展存储中，不会发送到 Railgun 以外的网站。
- 静默签到接口来自 Railgun 控制台 Points 页面：`POST https://railgun.info/api/user/checkin`，请求体为 `{"token":"railgun.info"}`。
- 自动登录接口来自 Railgun 登录页：`POST https://railgun.info/api/authorization` 和 `POST https://railgun.info/api/login`。
- Gmail 自动登录读取 `https://mail.google.com/mail/feed/atom`。这个 Feed 通常只返回未读收件箱邮件，所以验证码邮件到达后请先不要手动读掉。
- 自动任务使用 Chrome Alarms，每 60 分钟检查一次；当天成功尝试后不再重复自动执行。
