# Lirio 品牌域名、免费域名邮箱与公网上线执行方案

> **核心原则：先跑通付费用户，再花钱买基建。**  
> 在跑通首批 ¥99 永久版付费用户前，保持 **¥0 新增域名/邮箱成本**；一旦验证有稳定成交，按本方案约 **15 分钟**即可一键切换到正式品牌域名、域名客服邮箱与公网 HTTPS 生产环境。

---

## 阶段 0：0 元冷启动（拿到首批付费用户前 · 立即可用）

在你还没打算额外买域名之前，推荐用下面两种 **零新增费用** 方式直接接待首批用户：

1. **直接在管理后台修改售后联系方式（最推荐，改完即生效，无需改代码）**
   - 打开本地/当前管理后台 `/` → 进入「商店设置」。
   - 将「售后联系方式」改成你的**个人微信号**、**售后 QQ 群**或**现有个人邮箱**（例如 `Outlook` / `163` / `QQ 邮箱`）并保存，宣传页 `/site/` 会自动同步展示。
   - 对国内购买 ¥99 卡密的用户，微信/QQ 直接沟通转化率通常高于纯邮箱。
2. **备选：零费用借用腾讯云现有闲置域名先试跑**
   - 当前本机 `tccli` 账号下已持有 17 个域名（如 `agent-class.cn`、`annealing.cn`、`tuihuokeji.cn`、`lucky-code.cn` 等），如需先免费测试企业邮与 `tccli` DNS 自动化，可直接拿其中一个绑定。

---

## 阶段 1：正式品牌域名选型（2026-11-26 实测可注册清单）

当决定上线独立官网与官方客服邮箱时，以下为基于 `tccli`（腾讯云实时价格）与权威 RDAP 核查后的结果：

### 1.1 可直接注册的候选域名

| 域名 | 推荐平台 | 实测价格 / 状态 | 对应官方客服邮箱 | 适用说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`lirio.cn`**（首选） | 腾讯云（可用 `tccli` 管理） | **¥33 / 年**（可注册） | `support@lirio.cn` | 品牌短小一致、价格低、支持国内公众号/微信支付关联与 ICP 备案 |
| **`lirio.top`** | 腾讯云 | **¥14 / 年**（可注册） | `support@lirio.top` | 预算最低方案 |
| **`lirio.com.cn`** | 腾讯云 | **¥33 / 年**（可注册） | `support@lirio.com.cn` | `.cn` 的备用组合 |
| **`lirioenglish.com`** | 腾讯云 | **¥88 / 年**（可注册） | `support@lirioenglish.com` | 国际通用 `.com` 后缀，语义明确 |
| **`uselirio.com`** | 腾讯云 | **¥88 / 年**（可注册） | `support@uselirio.com` | 出海/软件产品常用命名 |
| **`getlirio.app`** | Cloudflare / Porkbun / Namecheap | 可注册（RDAP `404`） | `support@getlirio.app` | 腾讯云暂不支持 `.app` 后缀，海外免备案部署友好 |

### 1.2 已被占用域名（勿选）
- `lirio.app`（Cloudflare 托管，有效期至 `2027-09-07`）
- `lirioapp.com`、`lirio.cc`、`lirio.me`、`mylirio.com`（已有解析/注册）

### 1.3 国内备案 vs 海外免备案简明选择
- **官网与 API 放国内云服务器（如腾讯云广州/上海）**：选 **`lirio.cn`（¥33/年）**，按腾讯云指引做个人 ICP 备案，国内打开快、企业邮与微信生态兼容性最好。
- **官网与 API 放海外节点（新加坡/东京/香港 + Cloudflare）**：选 **`lirioenglish.com`** / **`uselirio.com`** / **`getlirio.app`**，无需 ICP 备案，配合 Cloudflare CDN + HTTPS 即买即用。

---

## 阶段 2：0 营业执照免费域名邮箱方案与实操 SOP

> 所有方案均**无需注册公司、无需营业执照**，仅需你名下的域名 + 个人手机号/Apple ID 即可开通。

### 2.1 四种免费方案对比

| 方案 | 费用 | 营业执照 | 核心优势 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **网易免费企业邮**（`ym.163.com`） | **免费** | **不需要**（填团队名，跳过企业认证） | 国内送达率稳，带独立中英文 WebMail 与 POP/IMAP/SMTP，账号可建 `support@`、`hi@` | 首选面向国内学习者的独立后台客服邮箱 |
| **腾讯企业邮**（企业微信免费版） | **免费** | **不需要**（个人微信扫码建团队，跳过认证） | 邮件可直接在个人微信「企业微信」插件内收发提醒，移动端体验好 | 习惯用微信实时接用户客服消息 |
| **Apple iCloud+ 自定义域名邮箱** | 随 iCloud+（¥6/月起 50GB 档可用） | **不需要** | 彻底无「企业」概念，直接在 Mac / iPhone 自带「邮件」App 原生收发，零广告 | 本身已订阅 Apple iCloud+ 的 Mac 开发者 |
| **Zoho Mail 免费版 / Cloudflare Email Routing** | **免费** | **不需要** | Cloudflare Routing 支持 0 秒转发到 QQ/Gmail；Zoho 带海外高送达率网页端 | 偏海外部署或仅需邮件转发 |

### 2.2 网易免费企业邮 + 腾讯云 `tccli` 开通流程（届时约 10 分钟）

1. **开通管理账号（人工收手机验证码）**
   - 访问 `https://ym.163.com/` → 点击「免费创建」→ 输入域名（例如 `lirio.cn`）与团队名称（如 `Lirio Studio`）。
   - 用个人手机号验证并设置管理员密码（跳过营业执照企业认证）。
2. **添加客服子账号**
   - 在网易企业邮管理后台新增成员账号：`support@<你的域名>`，用于统一收发用户售后咨询。
3. **通过本机 `tccli` 一键下发 DNS 解析记录**
   - 若域名托管在腾讯云 DNSPod，拿到邮箱后台给出的 **验证 TXT**、**MX** 与 **SPF TXT** 记录后，可用以下命令直接下发（将 `<你的域名>` 与具体记录值替换为邮箱后台提示的值）：

```bash
DOMAIN="<你的域名>"

# 1. 域名所有权验证 TXT 记录（值以邮箱后台提示为准）
tccli dnspod CreateRecord \
  --Domain "$DOMAIN" \
  --SubDomain "@" \
  --RecordType "TXT" \
  --RecordLine "默认" \
  --Value "<邮箱后台提供的验证TXT值>"

# 2. 网易免费企业邮主/备 MX 记录（具体优先级与主机名以开通页实时显示为准）
tccli dnspod CreateRecord \
  --Domain "$DOMAIN" \
  --SubDomain "@" \
  --RecordType "MX" \
  --RecordLine "默认" \
  --MX 5 \
  --Value "hzmx01.mxmail.netease.com."

tccli dnspod CreateRecord \
  --Domain "$DOMAIN" \
  --SubDomain "@" \
  --RecordType "MX" \
  --RecordLine "默认" \
  --MX 10 \
  --Value "hzmx02.mxmail.netease.com."

# 3. SPF 防伪造解析（若与第 1 步合并，注意同一主域名仅保留一条 v=spf1 记录）
tccli dnspod CreateRecord \
  --Domain "$DOMAIN" \
  --SubDomain "@" \
  --RecordType "TXT" \
  --RecordLine "默认" \
  --Value "v=spf1 include:spf.163.com -all"
```

4. **生效验收命令**
```bash
dig +short MX "$DOMAIN"
dig +short TXT "$DOMAIN"
```
看到返回对应的 `mxmail.netease.com.` 与 `v=spf1` 记录后，在邮箱后台点「验证」即可收发测试邮件。

---

## 阶段 3：绑定正式域名与上线公网检查清单

当准备正式向外发布时，同步完成以下 3 项收口即可（目前源码已全部预留支持）：

1. **替换代码中的默认示例邮箱占位符（`support@lirio.app` → 你的正式邮箱）**
   - [website/index.html](../website/index.html)
   - [website/app.js](../website/app.js)
   - [server/db.mjs](../server/db.mjs)（同时在管理后台 `/` → 商店设置里保存最新联系方式）

2. **公网服务端环境变量安全收口（参考 [server/.env.example](../server/.env.example)）**
   - `NODE_ENV=production`（启用强制管理员鉴权、禁止沙盒模拟支付）
   - `LIRIO_JWT_SECRET=<至少 32 位随机密钥，可用 openssl rand -hex 32>`
   - `LIRIO_ADMIN_TOKEN=<至少 16 位强管理员口令>`
   - `LIRIO_LLM_API_KEY=<正式 DeepSeek Key>`
   - `LIRIO_GITHUB_TOKEN=<具备 Issues:Write 的 GitHub Token>`（用于自动把用户「提需求」同步到仓库 Issue）
   - **禁止开启** `LIRIO_SEED_DEMO=1` 与 `LIRIO_MOCK_AI=1`

3. **正式客户端构建时注入正式 HTTPS 接口域名**
   - 前端构建前设置环境变量：`VITE_LIRIO_SERVER_URL=https://api.<你的域名>`
   - 这样打出的 `.dmg` / `.exe` / `.apk` 会直接锁定连接正式 HTTPS 后端，不在用户端暴露地址开关。
