# Lirio Pro Server（账号认证 + 余额充值 + 按量计费 AI 代理）

零外部 npm 依赖，基于 Node.js 原生 `node:http`、`node:sqlite` 与 `node:crypto` 运行。

## 启动方式

```bash
# 本地真实代理模式（配置自己的平台主 Key）
LIRIO_LLM_PROVIDER=deepseek \
LIRIO_LLM_API_KEY=sk-xxx \
node server/index.mjs

# 本地免上游 Key 联调演示模式（Mock AI 返回 + 真实 SQLite 扣费与账单流水）
LIRIO_MOCK_AI=1 node server/index.mjs
```

## 自动化集成测试

```bash
node server/test.mjs
```

## 计费精度与套餐

- 内部货币精度为 `10,000 units = ¥1.00 CNY`（`1 unit = ¥0.0001`），可精确核算单次对话 Token、TTS 字符数和 Whisper 秒数。
- 新用户注册即赠 `¥5.00` 体验金（可在 `server/db.mjs` 修改 `DEFAULT_TRIAL_UNITS`）。
- 充值接口 `POST /api/billing/recharge` 预留了支付回调验签位，接入 Stripe / 支付宝 / 微信支付回调即可上线生产。
