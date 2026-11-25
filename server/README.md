# Lirio Pro Server（账号认证 + 卡密发码 + 按量计费 AI 代理）

零外部 npm 依赖，基于 Node.js 原生 `node:http`、`node:sqlite` 与 `node:crypto` 运行。

## 本地开发与联调

```bash
# 本地免上游 Key 联调演示模式（Mock AI + 测试账号 tester@lirio.app + 演示卡密）
LIRIO_MOCK_AI=1 LIRIO_SEED_DEMO=1 node server/index.mjs

# 自动化集成测试（13 项全覆盖）
node server/test.mjs
```

## 公网部署安全三步收口

1. **生成强随机密钥与管理员口令**（写进 `server/.env`，该文件已被 `.gitignore` 忽略，切勿提交）：
   ```bash
   cp server/.env.example server/.env
   # 用以下命令生成并填入 LIRIO_JWT_SECRET 与 LIRIO_ADMIN_TOKEN：
   openssl rand -hex 32
   ```
   服务端在 `NODE_ENV=production` 启动时会自动校验：
   - 必须设置非占位的强随机 `LIRIO_JWT_SECRET`（>=32 位）、`LIRIO_ADMIN_TOKEN`（>=16 位）与 `LIRIO_LLM_API_KEY`。
   - 禁止开启 `LIRIO_SEED_DEMO=1` 与 `LIRIO_MOCK_AI=1`（开启会拒绝启动，防止测试余额账号暴露到公网）。
   - 关闭未验签的 `/api/billing/recharge` 直充接口（仅开放 `/api/billing/redeem` 单次原子核销卡密）。
   - 访问 `/` 或 `/api/overview`、`/api/admin/codes*` 必须通过管理员口令登录（HttpOnly 签名 Cookie 或 `X-Admin-Token` Header）。

2. **启动后台并配置 HTTPS 反向代理**（建议服务器只监听 `127.0.0.1:8787`，由 Caddy/Nginx 终止 TLS）：
   ```bash
   NODE_ENV=production node server/index.mjs
   ```
   Caddy 示例：
   ```caddyfile
   api.yourdomain.com {
     reverse_proxy 127.0.0.1:8787
   }
   ```

3. **打包线上客户端（注入正式 HTTPS 接口域名）**：
   ```bash
   VITE_LIRIO_SERVER_URL=https://api.yourdomain.com npm run build
   ```
   或在 GitHub Repository Secrets 中配置 `VITE_LIRIO_SERVER_URL`，触发 `.github/workflows/release.yml` 自动打包全平台安装包。
