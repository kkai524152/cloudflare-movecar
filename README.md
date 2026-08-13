# 轻声挪车

一个部署在 Cloudflare 边缘网络上的个人挪车网站。路人扫描车上的二维码后，可以先通过 PushPlus 微信通知车主；PushPlus 受理通知后，如仍有需要，再按需获取车主电话。车主可从通知中的私密链接查看留言、确认已收到，并选择是否共享当前位置。

本项目参考了 [kkai524152/movecar](https://github.com/kkai524152/movecar)，但重新设计了会话隔离、静态资源交付、限流和隐私凭证，不是对原项目的直接复刻。

## 功能

- 扫码留言，一键通过 PushPlus 微信通知车主
- 未共享位置时默认显示 30 秒防骚扰倒计时，可取消；倒计时内补充位置可立即发送
- PushPlus 受理通知后才允许本次呼叫者按需获取电话
- 呼叫者与车主均可选择共享位置，并生成高德/Apple 地图链接
- 车主可回复“正在赶来”等状态，呼叫页自动更新
- 每次呼叫独立会话，默认 1 小时自动过期
- 基于 IP 与 ASN 指纹的冷却限流
- 可选 Cloudflare Turnstile 人机验证
- 可选国家/地区 API 访问限制
- 响应式页面、PWA 清单和边缘静态资源缓存

## 架构

本项目使用一个 Cloudflare Worker 同时承载 API 与静态资源，不需要单独创建 Pages 项目、KV、D1 或传统服务器。

```text
二维码 / 浏览器
      │
      ├── 静态页面 ──> Cloudflare Workers Static Assets
      │
      └── /api/* ───> Worker
                         ├── Turnstile 校验（可选）
                         ├── Durable Object：限流、独立会话与 alarm 调度
                         └── PushPlus API ──> 车主微信
                                                  │
                                                  └── 私密确认链接
```

- `public/`：呼叫页、车主处理页和静态资源。
- `src/worker.js`：公开 API、PushPlus、Turnstile、地区限制和 Durable Object。
- `src/lib.js`：输入清理、令牌散列、电话规范化和地图坐标转换。
- `wrangler.jsonc`：Worker、Static Assets、Durable Object 绑定及公开变量。

### 相对参考项目的改进

| 方面 | 本项目的处理 |
| --- | --- |
| 并发隔离 | 每次呼叫使用独立 Durable Object 会话，不使用全局固定状态键，多个扫码请求不会相互覆盖。 |
| 边缘性能 | HTML、CSS、JS 由 Workers Static Assets 直接分发；API 才优先进入 Worker。HTML/JS/CSS 使用协商更新，SVG 等稳定资源可长期缓存。 |
| 等待开销 | 保留参考项目“无位置延迟 30 秒”的防骚扰思路，但改用 Durable Object alarm 异步调度，不在 HTTP 请求中 `setTimeout` 阻塞等待。 |
| 状态查询 | 页面首次约 300 毫秒查询状态；倒计时临近结束时以 250 毫秒–1 秒间隔确认，其他阶段逐步退避到更长间隔，兼顾响应速度与请求量。 |
| 一致性 | Durable Object 串行处理同一会话及同一限流指纹的更新，避免并发写入竞争。 |
| 电话隐私 | 电话不写入 HTML、二维码或公开配置；仅在 PushPlus 受理后，持有本次 caller token 的页面才可读取。 |
| 链接隐私 | 呼叫者与车主使用不同的随机令牌；验证时使用 SHA-256 摘要。车主令牌放在 URL fragment 中，页面读取后立即从地址栏移除。 |
| 数据生命周期 | alarm 同时负责延迟通知和会话清理；默认 1 小时后删除全部会话数据，而不是长期保留位置和回复。 |

## 使用流程

1. 路人扫描二维码，填写留言，可选择共享位置。
2. Worker 校验来源、地区、Turnstile 和冷却时间，并创建独立会话。
3. 已共享位置时立即发送；未共享位置时进入默认 30 秒缓冲，页面说明这是为避免误触或不在车辆附近的呼叫，并按服务端 `notifyAt` 显示倒计时。
4. 缓冲期间，呼叫者可以取消；也可以授权位置后立即发送。关闭页面不会中断倒计时，因为发送由 Durable Object alarm 调度。
5. PushPlus 受理请求后才允许呼叫者按需获取电话；这不代表微信客户端已经展示或车主已经阅读。车主收到并打开私密链接后，可查看请求、回复及选择是否共享位置。
6. 呼叫页轮询会话状态，展示通知进度和车主回复；会话到期后自动失效。

## 准备工作

- Cloudflare 账号
- Node.js 22 或更高版本（当前 Wrangler 依赖要求 Node.js `>= 22`）
- 已关注并绑定微信的 [PushPlus](https://www.pushplus.plus/) 账号及 token
- 可选：Cloudflare Turnstile 站点
- 可选：托管在 Cloudflare 的自定义域名

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，至少填入：

```dotenv
PUSHPLUS_TOKEN="你的-pushplus-token"
PHONE_NUMBER="13800138000"
```

启动本地服务：

```bash
npm run dev
```

按终端显示的地址访问，通常是 `http://localhost:8787`。提交前可运行：

```bash
npm run check
```

`.dev.vars` 已被 `.gitignore` 忽略，不要把真实 token、手机号或 Turnstile secret 写入仓库。手机号可以不配置；此时页面不会显示获取电话按钮。

## 配置

### 公开变量

公开或非敏感配置位于 `wrangler.jsonc` 的 `vars`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PUBLIC_OWNER_NAME` | `车主` | 呼叫页显示的称呼。 |
| `PUBLIC_CAR_LABEL` | `一辆临时停靠的车` | 车辆描述，避免公开车牌等敏感信息。 |
| `PUBLIC_NOTICE` | `感谢理解，我会尽快赶来` | 预留的公开提示语。 |
| `REQUEST_COOLDOWN_SECONDS` | `90` | 同一 IP/ASN 指纹的呼叫冷却时间，代码限制为 10–900 秒。 |
| `SESSION_TTL_SECONDS` | `3600` | 会话有效期，代码限制为 300–86400 秒。 |
| `DELAY_WITHOUT_LOCATION_SECONDS` | `30` | 未共享位置时的防骚扰缓冲，代码限制为 5–120 秒。设置为范围外的数字会被截断到边界。 |
| `PUSHPLUS_ENDPOINT` | `https://www.pushplus.plus/send` | PushPlus 接口地址。 |
| `PUBLIC_BASE_URL` | 自动取当前域名 | 可选，固定通知内车主链接的 HTTPS origin。 |
| `TURNSTILE_SITE_KEY` | 未配置 | 可选，Turnstile 公钥。 |
| `ALLOWED_COUNTRIES` | 未配置 | 可选，允许访问 API 的两位国家/地区代码，逗号分隔。 |
| `ENVIRONMENT` | `production` | 生产环境标识。 |

修改 `vars` 会整体替换该环境的普通变量，因此不要遗漏原有配置。敏感值不要放在这里。

### PushPlus

1. 登录 PushPlus，完成微信渠道绑定并取得 token。
2. 本地开发将 token 写入 `.dev.vars`。
3. 生产环境使用 Wrangler Secret：

```bash
npx wrangler secret put PUSHPLUS_TOKEN
```

代码固定以 `wechat` 渠道发送 HTML 消息。PushPlus 会接收到留言、呼叫者主动共享的位置链接和车主私密确认链接；如果不希望第三方通知服务处理位置信息，请不要共享位置，或自行替换通知服务实现。接口返回 `code: 200` 只代表 PushPlus 平台已受理，不等于微信客户端一定已经展示通知。

### 手机号

生产环境配置：

```bash
npx wrangler secret put PHONE_NUMBER
```

支持可选的 `+` 号和 6–20 位数字，空格、括号和连字符会被移除。电话不会出现在静态页面、二维码或 PushPlus 消息中，但呼叫者点击获取后，完整号码会进入其浏览器并用于 `tel:` 链接；这属于“按需披露”，并非匿名通话或号码中转。

### Turnstile

在 Cloudflare Dashboard 创建 Turnstile widget，将每个实际访问入口都加入允许的 hostname，例如自定义域名、仍对外开放的 `*.workers.dev` 域名；本地调试按 Turnstile 控制台要求添加 `localhost`，或使用官方测试 key。

把 site key 加到 `wrangler.jsonc` 的 `vars`：

```jsonc
"TURNSTILE_SITE_KEY": "你的-site-key"
```

再保存 secret key：

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

两个值必须同时存在。仅配置其中一个时，呼叫接口会拒绝请求；不使用 Turnstile 时应同时移除二者。

本地可在 `.dev.vars` 中同时设置 `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY`。

### 国家/地区限制

在 `wrangler.jsonc` 的 `vars` 中加入：

```jsonc
"ALLOWED_COUNTRIES": "CN,HK"
```

值为 Cloudflare 提供的 ISO 3166-1 alpha-2 国家/地区代码。限制只应用于 `/api/*`，静态页面仍可被加载；被限制地区无法读取配置或发起呼叫。启用后，生产环境中缺少 Cloudflare 国家信息的 API 请求也会被拒绝。

本地调试若没有 `request.cf.country`，可暂不设置该变量，或在 `.dev.vars` 中使用 `ENVIRONMENT="development"`。如需阻断静态页面和其他路径，请另外配置 Cloudflare WAF 规则。

## 部署到 Cloudflare

首次部署前登录：

```bash
npx wrangler login
npm run check
npm run deploy
```

`wrangler deploy` 会上传 Worker、静态资源，创建 `MOVECAR_SESSION` Durable Object 绑定，并应用 `v1` SQLite class migration。首次部署完成后，再写入生产 secrets：

```bash
npx wrangler secret put PUSHPLUS_TOKEN
npx wrangler secret put PHONE_NUMBER
# 启用 Turnstile 时再执行
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Secret 命令会提示输入值，不要把值直接写进 shell 命令或聊天记录。之后访问部署输出中的 `https://<worker>.<subdomain>.workers.dev`，实际完成一次“通知—打开车主链接—回复—取号”测试。

`wrangler secret put` 会为 Worker 创建新版本并立即部署，因此上面的多个 Secret 命令会分别触发部署。全部写入后，以最后一次部署的版本为准，再进行完整测试。

如果通过 Cloudflare Dashboard 添加变量或 Secret，保存后还需要在 **Deployments / Versions** 中把包含这些配置的最新版本部署到 100% 流量。只创建版本但不部署时，线上仍会继续运行旧版本，可用下面的命令核对：

```bash
npx wrangler versions list
npx wrangler deployments list
```

生产环境是否真正存在加密 Secret，可只查看名称而不读取值：

```bash
npx wrangler secret list
```

如绑定自定义域名，域名必须是当前 Cloudflare 账号中的 active zone，目标 hostname 不能已有 CNAME 记录。在 Cloudflare Dashboard 的 Worker 设置中进入 **Settings → Domains & Routes → Add → Custom Domain** 添加；Cloudflare 会创建 DNS 记录和证书。通常代码会根据当前请求自动生成正确链接；如果前面还有代理、存在多个域名或希望始终使用主域名，请设置：

```jsonc
"PUBLIC_BASE_URL": "https://move.example.com"
```

该值必须是 HTTPS origin，不要带路径。

## 制作二维码

二维码只应包含公开呼叫首页，例如：

```text
https://move.example.com/
```

不要把手机号、`owner.html` 链接、`session`、`token` 或任何 Secret 编入二维码。建议使用较高容错级别生成后打印、覆膜，并用不同手机实际扫描验证。二维码旁可写“扫码通知车主”；若以后更换域名，需要重新生成二维码。

## API 流程

| 接口 | 凭证 | 用途 |
| --- | --- | --- |
| `GET /api/config` | 无 | 返回公开文案、Turnstile site key 和是否配置电话。 |
| `POST /api/request` | 同源请求；可选 Turnstile | 创建会话并统一返回 `202`、`scheduled` 和 `notifyAt`。带位置时 `notifyAt` 为当前时间，由 alarm 尽快异步推送；无位置时默认延迟 30 秒。 |
| `GET /api/session/:id/status` | `Authorization: Bearer <token>` | 按 caller/owner 角色返回各自可见的状态、回复或位置。 |
| `GET /api/session/:id/phone` | caller token | 仅在 PushPlus 受理通知后返回电话。 |
| `POST /api/session/:id/expedite` | caller token、同源请求 | 在延迟期间提交有效位置并立即尝试推送。 |
| `POST /api/session/:id/cancel` | caller token、同源请求 | 在 `scheduled` 状态取消尚未发送的通知。 |
| `POST /api/session/:id/confirm` | owner token、同源请求 | 车主确认并写入回复及可选位置。 |

典型状态为 `scheduled → sending → accepted → confirmed`；其中 `accepted` 只表示 PushPlus 已受理，不代表车主已经阅读。取消后为 `cancelled`，重试耗尽后为 `push_failed`。无位置延迟通知失败时，Durable Object 最多再进行两次 alarm 重试。随机令牌是本次会话的实际访问凭证，应像密码一样保护。状态 API 不使用 Cookie；清理浏览器会话、令牌泄漏或会话过期后，无法恢复该次访问。

公开会话编号是 Cloudflare `newUniqueId()` 生成的 64 位十六进制 Durable Object ID。Worker 会先用 `idFromString()` 校验，格式伪造不会创建新的命名对象。

## 安全与隐私说明

- 服务端使用 caller/owner token 的 SHA-256 摘要鉴权。为让 alarm 在无人保持页面连接时生成 PushPlus 链接，延迟会话会在 Durable Object 私有存储中暂存 owner token；PushPlus 受理或呼叫取消后立即清空，整个会话到期时删除。
- 限流指纹由 IP 与 ASN 散列生成；代码不把原始 IP 写入会话存储。
- 留言会清理控制字符、限制为 80 字，并在 PushPlus HTML 中转义。
- JSON 请求体限制为 4 KiB；变更接口检查浏览器请求来源标记。
- 静态页面和 API 设置 CSP、禁止 framing、禁用 Referer 或搜索引擎索引车主页。
- 位置只在用户主动授权后读取，最多保留到会话过期，但会同时发送到相应浏览器；呼叫者位置还可能进入 PushPlus 通知。
- 车主确认链接包含 owner token。虽然 token 位于 fragment 且页面会立即清除地址栏，但仍不要转发通知、截图或复制该链接。
- 电话保护依赖 caller token 和 PushPlus 已受理的会话状态；倒计时、发送中、取消或推送失败时都不能获取。它不具备虚拟号码、防录屏、防复制或通话中转能力，也不能证明微信已经展示通知。
- Turnstile、地区限制和冷却限流用于降低滥用风险，不能代替 Cloudflare WAF、告警和日常日志检查。
- `observability.enabled` 当前为 `true`。不要把 token、手机号、完整请求体或位置写入日志；现有错误日志仅记录推送失败原因和未处理异常。

## 免费额度与成本注意事项

本项目没有传统服务器，但不代表所有流量永久免费。实际用量会涉及 Workers 请求、Workers Static Assets、Durable Objects 请求/存储/alarm 和 Workers Observability；PushPlus 也有独立于 Cloudflare 的服务策略与额度。

- 不在文档中固化免费额度数字，因为 Cloudflare 套餐、计费单位和地区可用性会变化。部署前查看 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/) 与 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
- 呼叫创建会访问一个限流对象和一个会话对象；所有通知都通过 alarm 异步调度，并可能产生最多两次失败重试。等待页每次状态轮询也会产生 Worker/DO 请求。前端已使用退避轮询，但公开二维码遭批量扫描仍可能消耗额度。
- 会话默认一小时删除，缩短 `SESSION_TTL_SECONDS` 可减少数据保留时间；过短会影响车主打开通知和回复。
- 开启 Observability 可能产生额外日志用量。请在 Cloudflare Dashboard 设置用量提醒并定期检查分析数据。
- 有无位置都不会让创建请求等待 PushPlus；alarm 会异步尝试推送，失败时按状态重试，耗尽后变为 `push_failed`。PushPlus 的可用性、频率限制和微信实际送达能力不由本项目保证。
- `public/_headers` 当前让 HTML、JS、CSS 使用 `no-cache`/重新验证，SVG 使用一年 `immutable` 缓存；页面中的 JS/CSS URL 还带版本参数，用于规避早期长期缓存留下的旧资源。若更新同名 SVG，请同步更换文件名或版本化 URL。

## 常见问题

### 页面能打开，但通知失败

确认已设置生产环境 `PUSHPLUS_TOKEN`、PushPlus 微信渠道已绑定，且 Dashboard 日志中没有上游接口错误。首次只执行 `wrangler deploy` 而未写入 secret 时，页面仍可打开，创建接口也会先返回 `202`；随后 alarm 尝试发送及重试，最终转为 `push_failed`。

### Turnstile 一直失败

确认 site key 与 secret key 属于同一个 widget，当前域名在允许列表中，并且两个变量都已配置。自定义域名和 `workers.dev` 是不同 hostname。

### 地区限制后本地接口返回 403

本地请求通常没有真实的 Cloudflare 国家信息。移除本地 `ALLOWED_COUNTRIES`，或在 `.dev.vars` 中设置 `ENVIRONMENT="development"`。

### 推送里的车主链接域名不对

将 `PUBLIC_BASE_URL` 设置为最终的 HTTPS origin 后重新部署；不要添加 `/owner.html` 或其他路径。
