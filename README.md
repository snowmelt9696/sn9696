# 阿里云余额与优惠券日报

这个仓库可以直接上传到 GitHub，使用 GitHub Actions 每天北京时间 18:30 自动运行。它不依赖本地电脑、不需要浏览器登录态，运行时通过阿里云 OpenAPI 获取账户余额、可用优惠券和近几个月的抵扣明细，然后发送到 QQ 邮箱。

## GitHub 配置

上传仓库后，在 GitHub 仓库页面打开 `Settings` -> `Secrets and variables` -> `Actions`。

新增这些 `Repository secrets`：

| 名称 | 含义 |
| --- | --- |
| `ALIYUN_ACCESS_KEY_ID` | 阿里云 RAM 用户 AccessKey ID |
| `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 RAM 用户 AccessKey Secret |
| `QQ_MAIL_USER` | 发件 QQ 邮箱，例如 `123456@qq.com` |
| `QQ_MAIL_AUTH_CODE` | QQ 邮箱 SMTP 授权码，不是 QQ 密码 |
| `QQ_MAIL_TO` | 收件邮箱，可以也是 QQ 邮箱 |

可选新增这些 `Repository variables`：

| 名称 | 默认值 | 含义 |
| --- | --- | --- |
| `ALIYUN_REGION_ID` | `cn-hangzhou` | 阿里云区域参数 |
| `ALIYUN_BILLING_CYCLE_MONTHS` | `2` | 查询最近几个月的抵扣明细 |

## 阿里云权限

推荐新建一个 RAM 用户专门给这个任务使用，不要使用主账号 AccessKey。最省事的权限是给 RAM 用户授予 `AliyunBSSFullAccess`。

如果你想收窄权限，需要至少允许这些 BssOpenApi 动作：

- `bssapi:QueryAccountBalance`
- `bssapi:QueryCashCoupons`
- `bssapi:QueryInstanceBill`

## QQ 邮箱授权码

QQ 邮箱网页端打开 `设置` -> `账户`，开启 `POP3/SMTP` 服务并生成授权码。把授权码填到 GitHub Secret `QQ_MAIL_AUTH_CODE`，不要填 QQ 登录密码。

## 自动运行

工作流文件在 `.github/workflows/aliyun-coupon-report.yml`。GitHub cron 使用 UTC 时间，仓库里配置的是：

```yaml
cron: '30 10 * * *'
```

这对应北京时间 / 香港时间每天 18:30。你也可以在 GitHub 的 `Actions` 页面手动点 `Run workflow` 立即测试。

## 输出

每次运行会：

- 发送 QQ 邮件，正文包含账户余额、可用优惠券数量、抵扣明细摘要。
- 邮件附件包含 `aliyun-coupon-deductions.csv` 和 `aliyun-coupons.csv`。
- GitHub Actions artifact 保留 `output/` 下的 JSON/CSV，默认保留 14 天。

## 本地测试（可选）

本地不是必须的，只是方便排查：

```bash
npm install
ALIYUN_ACCESS_KEY_ID=xxx ALIYUN_ACCESS_KEY_SECRET=yyy QQ_MAIL_USER=123@qq.com QQ_MAIL_AUTH_CODE=zzz QQ_MAIL_TO=456@qq.com npm run crawl:email
```

Windows PowerShell 可以这样设置环境变量：

```powershell
$env:ALIYUN_ACCESS_KEY_ID = "xxx"
$env:ALIYUN_ACCESS_KEY_SECRET = "yyy"
$env:QQ_MAIL_USER = "123@qq.com"
$env:QQ_MAIL_AUTH_CODE = "zzz"
$env:QQ_MAIL_TO = "456@qq.com"
npm run crawl:email
```

## 注意

阿里云账单接口字段偶尔会调整。如果邮件里余额或抵扣明细为空，先打开 GitHub Actions 的 artifact 下载 `aliyun-coupon-result.json`，里面会记录 API 返回和错误摘要，方便按实际字段微调。
