import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.mjs';
import {
  DEFAULT_TRIAL_UNITS,
  createUserWithTrial,
  creditUserBalance,
  deductUserBalance,
  getUserByEmail,
  getUserById,
  listUserLedger,
  openDatabase,
  serializeUser,
} from './db.mjs';
import {
  RECHARGE_PACKS,
  calculateAsrCostUnits,
  calculateChatCostUnits,
  calculateTtsCostUnits,
  getDeepSeekPeriodLabel,
} from './pricing.mjs';
import { forwardChatCompletion, forwardTranscribe, forwardTts } from './aiProxy.mjs';

export function seedDemoUser(db) {
  const email = 'tester@lirio.app';
  const existing = getUserByEmail(db, email);
  if (existing) return serializeUser(existing);

  const created = createUserWithTrial(db, {
    email,
    name: 'Lirio 测试官',
    passwordHash: hashPassword('lirio123'),
    trialUnits: 0,
  });
  const credited = creditUserBalance(db, {
    userId: created.id,
    amountUnits: 1_000_000, // ¥100.00
    kind: 'recharge',
    feature: '测试官初始充值 ¥100',
    note: '测试账号预充值 ¥100.00（用于验证峰谷与语音计费）',
    upgradeToPro: true,
  });
  return credited.user;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('无效的 JSON 请求体'));
      }
    });
    req.on('error', reject);
  });
}

function authenticateRequest(req, db) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const payload = verifyToken(match[1]);
  if (!payload) return null;
  const row = getUserById(db, payload.sub);
  return row ? serializeUser(row) : null;
}

export function createLirioServer({ dbPath } = {}) {
  const db = openDatabase(dbPath);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'lirio-pro-server', packs: RECHARGE_PACKS });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/register') {
        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const name = String(body.name || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          sendJson(res, 400, { error: '请输入有效的邮箱地址。' });
          return;
        }
        if (password.length < 6) {
          sendJson(res, 400, { error: '密码长度至少为 6 位。' });
          return;
        }
        if (getUserByEmail(db, email)) {
          sendJson(res, 409, { error: '该邮箱已注册，请直接登录。' });
          return;
        }
        const passwordHash = hashPassword(password);
        const user = createUserWithTrial(db, {
          email,
          name,
          passwordHash,
          trialUnits: DEFAULT_TRIAL_UNITS,
        });
        const token = signToken({ sub: user.id, email: user.email });
        const ledger = listUserLedger(db, user.id, 30);
        sendJson(res, 201, { token, user, ledger, packs: RECHARGE_PACKS });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const row = getUserByEmail(db, email);
        if (!row || !verifyPassword(password, row.password_hash)) {
          sendJson(res, 401, { error: '邮箱或密码不正确。' });
          return;
        }
        const user = serializeUser(row);
        const token = signToken({ sub: user.id, email: user.email });
        const ledger = listUserLedger(db, user.id, 30);
        sendJson(res, 200, { token, user, ledger, packs: RECHARGE_PACKS });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const user = authenticateRequest(req, db);
        if (!user) {
          sendJson(res, 401, { error: '登录已过期或未登录。' });
          return;
        }
        const ledger = listUserLedger(db, user.id, 30);
        sendJson(res, 200, { user, ledger, packs: RECHARGE_PACKS });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/billing/ledger') {
        const user = authenticateRequest(req, db);
        if (!user) {
          sendJson(res, 401, { error: '请先登录。' });
          return;
        }
        const limit = Number(url.searchParams.get('limit') || 50);
        const ledger = listUserLedger(db, user.id, limit);
        sendJson(res, 200, { user, ledger, packs: RECHARGE_PACKS });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/billing/recharge') {
        const user = authenticateRequest(req, db);
        if (!user) {
          sendJson(res, 401, { error: '请先登录再充值。' });
          return;
        }
        const body = await readJsonBody(req);
        const pack = RECHARGE_PACKS.find((p) => p.id === body.packageId);
        if (!pack) {
          sendJson(res, 400, { error: '无效的充值套餐。' });
          return;
        }
        // Payment gateway verification hook (Stripe / Alipay / WeChat Pay callback token check goes here in production)
        const result = creditUserBalance(db, {
          userId: user.id,
          amountUnits: pack.creditUnits,
          kind: 'recharge',
          feature: pack.label,
          note: pack.note,
          upgradeToPro: true,
        });
        const ledger = listUserLedger(db, user.id, 50);
        sendJson(res, 200, { user: result.user, entry: result.entry, ledger });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/chat') {
        const user = authenticateRequest(req, db);
        if (!user) {
          sendJson(res, 401, { error: '请先登录 Lirio 账号。' });
          return;
        }
        if (user.balanceUnits <= 0) {
          sendJson(res, 402, { error: '当前余额不足，请在「用户设置 → 账户与余额」中充值后继续。' });
          return;
        }
        const body = await readJsonBody(req);
        if (!Array.isArray(body.messages) || !body.messages.length) {
          sendJson(res, 400, { error: '缺少对话消息体。' });
          return;
        }
        const aiRes = await forwardChatCompletion({
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          maxTokens: body.maxTokens,
        });
        const costUnits = calculateChatCostUnits(
          aiRes.model,
          aiRes.usage.promptTokens,
          aiRes.usage.completionTokens,
          {
            cacheHitTokens: aiRes.usage.cacheHitTokens,
            cacheMissTokens: aiRes.usage.cacheMissTokens,
          },
        );
        const periodLabel = aiRes.model.toLowerCase().includes('deepseek')
          ? ` · ${getDeepSeekPeriodLabel()}`
          : '';
        const note =
          aiRes.usage.cacheHitTokens !== undefined
            ? `命中 ${aiRes.usage.cacheHitTokens} + 未命中 ${aiRes.usage.cacheMissTokens} / 输出 ${aiRes.usage.completionTokens} tok${periodLabel}`
            : `${aiRes.usage.promptTokens} in / ${aiRes.usage.completionTokens} out tok${periodLabel}`;
        const settled = deductUserBalance(db, {
          userId: user.id,
          costUnits,
          feature: String(body.feature || 'AI 对话'),
          provider: aiRes.provider,
          model: aiRes.model,
          inputUnits: aiRes.usage.promptTokens,
          outputUnits: aiRes.usage.completionTokens,
          note,
        });
        sendJson(res, 200, {
          content: aiRes.content,
          model: aiRes.model,
          usage: aiRes.usage,
          costUnits: settled.deductedUnits,
          balanceUnits: settled.user.balanceUnits,
          totalSpentUnits: settled.user.totalSpentUnits,
          user: settled.user,
          entry: settled.entry,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/tts') {
        const user = authenticateRequest(req, db);
        if (!user) {
          sendJson(res, 401, { error: '请先登录 Lirio 账号。' });
          return;
        }
        if (user.balanceUnits <= 0) {
          sendJson(res, 402, { error: '当前余额不足，请充值或切换免费 Edge 语音。' });
          return;
        }
        const body = await readJsonBody(req);
        const ttsRes = await forwardTts({
          text: body.text,
          accent: body.accent,
          voice: body.voice,
        });
        const costUnits = calculateTtsCostUnits(ttsRes.chars);
        const settled = deductUserBalance(db, {
          userId: user.id,
          costUnits,
          feature: String(body.feature || '云端语音合成'),
          provider: ttsRes.provider,
          model: ttsRes.model,
          inputUnits: ttsRes.chars,
          outputUnits: 0,
          note: `${ttsRes.chars} 字符 · ${ttsRes.voice}`,
        });
        sendJson(res, 200, {
          audioBase64: ttsRes.audioBase64,
          mime: ttsRes.mime,
          chars: ttsRes.chars,
          model: ttsRes.model,
          costUnits: settled.deductedUnits,
          balanceUnits: settled.user.balanceUnits,
          totalSpentUnits: settled.user.totalSpentUnits,
          user: settled.user,
          entry: settled.entry,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/transcribe') {
        const user = authenticateRequest(req, db);
        if (!user) {
          sendJson(res, 401, { error: '请先登录 Lirio 账号。' });
          return;
        }
        if (user.balanceUnits <= 0) {
          sendJson(res, 402, { error: '当前余额不足，请充值或切换免费本地 Whisper。' });
          return;
        }
        const body = await readJsonBody(req);
        const asrRes = await forwardTranscribe({
          wavBase64: body.wavBase64,
          durationSec: body.durationSec,
        });
        const costUnits = calculateAsrCostUnits(asrRes.durationSec);
        const settled = deductUserBalance(db, {
          userId: user.id,
          costUnits,
          feature: String(body.feature || '云端语音识别'),
          provider: asrRes.provider,
          model: asrRes.model,
          inputUnits: asrRes.durationSec,
          outputUnits: asrRes.text.length,
          note: `${asrRes.durationSec} 秒音频`,
        });
        sendJson(res, 200, {
          text: asrRes.text,
          model: asrRes.model,
          durationSec: asrRes.durationSec,
          costUnits: settled.deductedUnits,
          balanceUnits: settled.user.balanceUnits,
          totalSpentUnits: settled.user.totalSpentUnits,
          user: settled.user,
          entry: settled.entry,
        });
        return;
      }

      sendJson(res, 404, { error: '接口不存在。' });
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg === 'INSUFFICIENT_BALANCE') {
        sendJson(res, 402, { error: '当前余额不足，请充值后继续。' });
        return;
      }
      sendJson(res, 500, { error: msg });
    }
  });

  server.on('close', () => {
    try {
      db.close();
    } catch {}
  });

  return { server, db };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const { server, db } = createLirioServer();
  if (process.env.LIRIO_SEED_DEMO === '1' || process.env.LIRIO_SEED_DEMO === 'true') {
    const demo = seedDemoUser(db);
    console.log(`[lirio-pro-server] demo tester ready: ${demo.email} balance=${demo.balanceUnits}`);
  }
  server.listen(port, '127.0.0.1', () => {
    console.log(`[lirio-pro-server] listening on http://127.0.0.1:${port}`);
  });
}
