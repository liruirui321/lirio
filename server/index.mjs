import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  constantTimeEquals,
  createSignedAdminCookieValue,
  hashPassword,
  isProductionMode,
  isWeakJwtSecret,
  signToken,
  verifyPassword,
  verifySignedAdminCookieValue,
  verifyToken,
} from './auth.mjs';
import {
  DEFAULT_TRIAL_UNITS,
  cancelOrder,
  confirmOrderAndIssueCode,
  createFeedback,
  createOrder,
  createRedeemCodes,
  createUserWithTrial,
  creditUserBalance,
  deductUserBalance,
  getFeedbackById,
  getOrderByNo,
  getStoreSettings,
  getUserByEmail,
  getUserById,
  getUserSyncSnapshot,
  isUserDeviceActive,
  listAllFeedbacks,
  listAllUsers,
  listOrders,
  listRecentLedger,
  listRedeemCodes,
  listUnusedRedeemCodes,
  listUserDevices,
  listUserFeedbacks,
  listUserLedger,
  listUserSyncMeta,
  lookupOrdersByEmail,
  openDatabase,
  redeemCodeForUser,
  registerUserDevice,
  removeUserDevice,
  saveStoreSettings,
  saveUserSyncSnapshot,
  serializeUser,
  touchUserDevice,
  updateFeedback,
} from './db.mjs';
import {
  RECHARGE_PACKS,
  calculateAsrCostUnits,
  calculateChatCostUnits,
  calculateTtsCostUnits,
  formatPoints,
  formatYuan,
  getDeepSeekPeriodLabel,
  getDeepSeekRatesPer1M,
  isDeepSeekPeakBeijing,
} from './pricing.mjs';
import {
  createSonioxStreamToken,
  forwardChatCompletion,
  forwardChatCompletionStream,
  forwardTranscribe,
  forwardTts,
  warmupEdgeWorker,
} from './aiProxy.mjs';

function isValidAccountId(raw) {
  const s = String(raw || '').trim();
  return /^[a-zA-Z0-9._@-]{4,32}$/.test(s) && /[a-zA-Z0-9]/.test(s);
}

function validatePasswordStrength(raw) {
  const p = String(raw || '');
  if (p.length < 6 || p.length > 32) return '密码长度需为 6–32 位。';
  if (/\s/.test(p)) return '密码不能包含空格。';
  return null;
}

export const CODE_PRESETS = [
  {
    id: 'pro_99',
    payYuan: 99,
    label: '¥99 Lirio Pro · 永久版（含 1,000 积分）',
    shortTitle: 'Lirio Pro',
    badge: 'Pro 授权',
    subtitle: '支持 3 台设备 · 含 1,000 积分',
    amountUnits: 100000, // 1,000 积分
    upgradeToPro: true,
    note: '开通 Lirio Pro · 永久版 + 赠 1,000 积分',
  },
  {
    id: 'topup_10',
    payYuan: 10,
    label: '¥10 积分加油包（1,000 积分）',
    shortTitle: '1,000 积分加油包',
    badge: '按量消耗',
    subtitle: '按量消耗积分 · 长期有效',
    amountUnits: 100000, // 1,000 积分
    upgradeToPro: false,
    note: '积分加油包 1,000 积分',
  },
  {
    id: 'topup_30',
    payYuan: 30,
    label: '¥30 积分加油包（3,500 积分）',
    shortTitle: '3,500 积分加油包',
    badge: '赠 500 积分',
    subtitle: '实付 ¥30 得 3,500 积分 · 长期有效',
    amountUnits: 350000, // 3,500 积分
    upgradeToPro: false,
    note: '积分加油包 3,000 积分 + 赠 500 积分',
  },
];

const __serverDir = path.dirname(fileURLToPath(import.meta.url));

export function loadEnvFileIfPresent(envPath = path.join(__serverDir, '.env')) {
  if (!fs.existsSync(envPath)) return false;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.replace(/^export\s+/, '');
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    let val = cleaned.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return true;
}

function getAdminToken(env = process.env) {
  return String(env.LIRIO_ADMIN_TOKEN || env.LIRIO_ADMIN_KEY || '').trim();
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isAdminAuthorized(req) {
  const expected = getAdminToken();
  if (!expected) return !isProductionMode();
  const headerToken = String(req.headers['x-admin-token'] || req.headers['x-admin-key'] || '').trim();
  if (headerToken && constantTimeEquals(headerToken, expected)) return true;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  if (bearer && constantTimeEquals(bearer, expected)) return true;
  const cookies = parseCookies(req);
  if (cookies.lirio_admin && verifySignedAdminCookieValue(cookies.lirio_admin, expected)) return true;
  return false;
}

export function validateProductionConfig(env = process.env) {
  if (!isProductionMode(env)) {
    return { ok: true, mode: 'development', warnings: [] };
  }
  const errors = [];
  if (isWeakJwtSecret(env.LIRIO_JWT_SECRET)) {
    errors.push('LIRIO_JWT_SECRET 未设置或强度不足（生产环境需 >=32 位强随机字符串，可用 openssl rand -hex 32 生成）');
  }
  const adminToken = getAdminToken(env);
  if (!adminToken || adminToken.length < 16 || /change-this|placeholder|example/i.test(adminToken)) {
    errors.push('LIRIO_ADMIN_TOKEN 未设置或强度不足（生产环境需 >=16 位强随机口令）');
  }
  if (env.LIRIO_SEED_DEMO === '1' || env.LIRIO_SEED_DEMO === 'true') {
    errors.push('生产环境禁止开启 LIRIO_SEED_DEMO=1（避免暴露预设余额测试账号）');
  }
  if (env.LIRIO_MOCK_AI === '1' || env.LIRIO_MOCK_AI === 'true') {
    errors.push('生产环境禁止开启 LIRIO_MOCK_AI=1');
  }
  const provider = String(env.LIRIO_LLM_PROVIDER || 'deepseek').toLowerCase();
  const llmKey = String(
    env.LIRIO_LLM_API_KEY || (provider === 'deepseek' ? env.DEEPSEEK_API_KEY || '' : ''),
  ).trim();
  if (!llmKey || /^sk-your-/i.test(llmKey)) {
    errors.push('生产环境必须配置有效的 LIRIO_LLM_API_KEY');
  }
  if (errors.length) {
    throw new Error(`生产环境安全检查未通过：\n- ${errors.join('\n- ')}`);
  }
  return { ok: true, mode: 'production', warnings: [] };
}

function renderAdminLoginHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Lirio Pro 管理登录</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #FBF9F5; color: #1D1B18; }
  .box { width: min(380px, 90vw); background: #FFFDF9; border: 1px solid #EAE5DB; border-radius: 18px; padding: 24px 22px; box-sizing: border-box; }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  p { margin: 0 0 16px; font-size: 13px; color: #6F6A62; line-height: 1.5; }
  form { display: flex; flex-direction: column; gap: 10px; }
  input { border: 1px solid #E4DFD4; background: #FBF9F5; color: #1D1B18; border-radius: 10px; padding: 10px 12px; font-size: 14px; outline: none; }
  input:focus { border-color: #3D6B52; }
  button { border: 0; background: #3D6B52; color: #fff; border-radius: 999px; padding: 10px 16px; font-size: 13.5px; font-weight: 500; cursor: pointer; }
  button:hover { background: #315843; }
  .err { min-height: 18px; font-size: 12.5px; color: #B85C38; }
</style>
</head>
<body>
<div class="box">
  <h1>Lirio Pro 管理后台</h1>
  <p>请输入管理员口令（LIRIO_ADMIN_TOKEN）以查看积分流水与生成卡密。</p>
  <form id="loginForm">
    <input id="tokenInput" type="password" placeholder="输入 LIRIO_ADMIN_TOKEN" autocomplete="current-password" required />
    <button type="submit">进入看板</button>
    <div id="errMsg" class="err"></div>
  </form>
</div>
<script>
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('errMsg');
  err.textContent = '';
  const token = document.getElementById('tokenInput').value;
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.ok) { location.reload(); return; }
  const data = await res.json().catch(() => ({}));
  err.textContent = data.error || '登录失败';
});
</script>
</body>
</html>`;
}

export function seedDemoUser(db) {
  const existingCodes = listRedeemCodes(db, 1);
  if (!existingCodes.length) {
    createRedeemCodes(db, {
      planId: 'pro_99',
      label: '¥99 Lirio Pro · 永久版（含 1,000 积分）',
      amountUnits: 100000,
      upgradeToPro: true,
      note: '演示 ¥99 买断卡密（含 1,000 积分）',
      exactCodes: ['LIRIO-DEMO-9900-PRO1'],
    });
    createRedeemCodes(db, {
      planId: 'topup_30',
      label: '¥30 积分加油包（3,500 积分）',
      amountUnits: 350000,
      upgradeToPro: false,
      note: '演示 ¥30 充值卡密（含 3,500 积分）',
      exactCodes: ['LIRIO-DEMO-3000-TOP1'],
    });
  }

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

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'https://lirio.deltae.tech',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

function getAllowedCorsOrigin(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return '';
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) return origin;
  const extra = String(process.env.LIRIO_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin) ? origin : '';
}

function getClientIp(req) {
  const xff = String(req?.headers?.['x-forwarded-for'] || '').trim();
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  const realIp = String(req?.headers?.['x-real-ip'] || '').trim();
  if (realIp) return realIp;
  return String(req?.socket?.remoteAddress || '127.0.0.1');
}

function sanitizeSyncPayload(rawPayload) {
  const parsed = JSON.parse(rawPayload);
  if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
    const speakEntry = parsed.entries['aboboo-speak-state-v2'];
    if (speakEntry && typeof speakEntry === 'object' && speakEntry.config && typeof speakEntry.config === 'object') {
      speakEntry.config.textApiKey = '';
      speakEntry.config.speechApiKey = '';
      if (speakEntry.config.providers && typeof speakEntry.config.providers === 'object') {
        for (const p of Object.values(speakEntry.config.providers)) {
          if (p && typeof p === 'object' && 'apiKey' in p) {
            p.apiKey = '';
          }
        }
      }
    }
    const acctEntry = parsed.entries['lirio-account-v1'];
    if (acctEntry && typeof acctEntry === 'object' && 'token' in acctEntry) {
      acctEntry.token = null;
    }
  }
  return JSON.stringify(parsed);
}

function sanitizePublicError(err) {
  const raw = String(err?.message || err || '');
  const redacted = raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/https?:\/\/\S+/gi, '[upstream]');
  if (!redacted || /(TypeError|ReferenceError|SyntaxError|SQLITE_|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|at\s+\S+:\d+)/i.test(redacted)) {
    return '服务暂时异常，请稍后重试。';
  }
  return redacted;
}

function sendJson(res, status, data, headOnly = false) {
  const corsOrigin = res._lirioCorsOrigin || '';
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key, X-Audio-Duration, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, HEAD, OPTIONS',
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
  }
  res.writeHead(status, headers);
  res.end(headOnly ? undefined : JSON.stringify(data));
}

function sendHtml(res, status, html, headOnly = false) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(headOnly ? undefined : html);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = path.resolve(SERVER_DIR, '..', 'website');

function getReleasesDir() {
  return process.env.LIRIO_RELEASES_DIR || path.join(SERVER_DIR, 'releases');
}

function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function buildOverview(db) {
  const isPeak = isDeepSeekPeakBeijing();
  const syncMeta = listUserSyncMeta(db);
  const syncByUser = new Map(syncMeta.map((s) => [s.userId, s]));
  const users = listAllUsers(db).map((u) => {
    const sync = syncByUser.get(u.id);
    return {
      ...u,
      syncUpdatedAt: sync?.updatedAt || null,
      syncDeviceName: sync?.deviceName || '',
      syncByteSize: sync?.byteSize || 0,
    };
  });
  const ledger = listRecentLedger(db, 50);
  const codes = listRedeemCodes(db, 100);
  const orders = listOrders(db, 100);
  const feedbacks = listAllFeedbacks(db, 100);
  const storeSettings = getStoreSettings(db);

  const paidOrders = orders.filter((o) => o.status === 'paid');
  const pendingOrders = orders.filter((o) => o.status === 'pending');
  const stats = {
    totalUsers: users.length,
    syncedUsers: syncMeta.length,
    proUsers: users.filter((u) => u.tier === 'pro').length,
    totalBalanceUnits: users.reduce((sum, u) => sum + Number(u.balanceUnits || 0), 0),
    totalSpentUnits: users.reduce((sum, u) => sum + Number(u.totalSpentUnits || 0), 0),
    totalOrders: orders.length,
    paidOrders: paidOrders.length,
    pendingOrders: pendingOrders.length,
    totalRevenueYuan: paidOrders.reduce((sum, o) => sum + Number(o.payYuan || 0), 0),
    unusedCodes: codes.filter((c) => !c.redeemedAt).length,
    usedCodes: codes.filter((c) => Boolean(c.redeemedAt)).length,
    openFeedbacks: feedbacks.filter((f) => f.status === 'open').length,
  };

  return {
    ok: true,
    service: 'lirio-server',
    isPeak,
    period: getDeepSeekPeriodLabel(),
    rates: {
      pointsPerYuan: 100,
      deepseek: getDeepSeekRatesPer1M(),
      ttsPer1kCharsYuan: 0.15,
      ttsPointsPer1kBytes: 15,
    },
    stats,
    users,
    ledger,
    codes,
    orders,
    feedbacks,
    githubConfigured: Boolean(String(process.env.LIRIO_GITHUB_TOKEN || '').trim()),
    githubRepo: getGithubRepo(),
    storeSettings,
    codePresets: CODE_PRESETS,
  };
}

function renderDashboardHtml(overview, { adminAuthEnabled = false } = {}) {
  const initialJson = JSON.stringify(overview).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Lirio 管理后台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #FBF9F5; color: #1D1B18; }
  .wrap { max-width: 1020px; margin: 0 auto; padding: 26px 20px 52px; display: flex; flex-direction: column; gap: 16px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; font-weight: 700; }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #E9F2EC; color: #3D6B52; font-weight: 600; }
  .pill.peak { background: #F8EFE3; color: #9A5B13; }
  .btn { border: 1px solid #E4DFD4; background: #FFFDF9; color: #1D1B18; border-radius: 999px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-family: inherit; }
  .btn:hover { border-color: #3D6B52; color: #3D6B52; }
  .btn.primary { background: #3D6B52; border-color: #3D6B52; color: #fff; font-weight: 600; }
  .btn.primary:hover { background: #315843; color: #fff; }
  .kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .kpi { background: #FFFDF9; border: 1px solid #EAE5DB; border-radius: 16px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
  .kpi-label { font-size: 12px; color: #7C766D; }
  .kpi-val { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: #1D1B18; }
  .kpi-sub { font-size: 11.5px; color: #7C766D; font-variant-numeric: tabular-nums; }
  .tabs { display: flex; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid #EAE5DB; padding-bottom: 10px; }
  .tab-btn { border: 1px solid transparent; background: transparent; color: #6C665D; border-radius: 999px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px; }
  .tab-btn.active { background: #3D6B52; color: #fff; }
  .tab-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: rgba(184, 92, 56, 0.16); color: #B85C38; }
  .tab-btn.active .tab-badge { background: rgba(255, 255, 255, 0.24); color: #fff; }
  .panel { display: none; flex-direction: column; gap: 14px; }
  .panel.active { display: flex; }
  .card { background: #FFFDF9; border: 1px solid #EAE5DB; border-radius: 16px; padding: 16px 18px; overflow-x: auto; }
  .card h2 { margin: 0 0 10px; font-size: 14px; color: #4A453E; font-weight: 600; }
  .toolbar-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .filter-group { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip { border: 1px solid #E4DFD4; background: #FBF9F5; color: #5F5A52; border-radius: 999px; padding: 4px 11px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .chip.active { background: #E9F2EC; border-color: #3D6B52; color: #3D6B52; font-weight: 600; }
  input, select, textarea { border: 1px solid #E4DFD4; background: #FBF9F5; color: #1D1B18; border-radius: 10px; padding: 7px 11px; font-size: 12.5px; font-family: inherit; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: #3D6B52; }
  .search-input { min-width: 210px; border-radius: 999px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #F0ECE3; vertical-align: middle; }
  th { font-size: 11.5px; color: #7C766D; font-weight: 500; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sub { font-size: 11.5px; color: #7C766D; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #E9F2EC; color: #3D6B52; font-weight: 600; display: inline-block; white-space: nowrap; }
  .empty { text-align: center; color: #8D867C; padding: 20px; }
  .copy-btn { border: 1px solid #E4DFD4; background: transparent; color: #5F5A52; border-radius: 999px; padding: 3px 9px; font-size: 11px; cursor: pointer; font-family: inherit; text-decoration: none; display: inline-block; }
  .copy-btn:hover { border-color: #3D6B52; color: #3D6B52; }
  .status-msg { font-size: 12px; color: #3D6B52; font-weight: 500; }
  .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .qr-card { border: 1px solid #EAE5DB; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #FBF9F5; }
  .qr-preview { width: 168px; height: 168px; border-radius: 10px; border: 1px dashed #D9D2C5; background: #fff; display: grid; place-items: center; overflow: hidden; font-size: 12px; color: #8D867C; }
  .qr-preview img { width: 100%; height: 100%; object-fit: contain; }
  .field-col { display: flex; flex-direction: column; gap: 5px; }
  .field-col label { font-size: 12px; font-weight: 600; color: #4A453E; }
  @media (max-width: 820px) {
    .kpi-grid { grid-template-columns: 1fr; }
    .settings-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title-row">
      <h1>Lirio 管理后台</h1>
      <span class="pill">运行中</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      ${adminAuthEnabled ? '<button class="btn" id="adminLogoutBtn" type="button">退出管理</button>' : '<span class="pill peak">未设管理口令（仅限本机）</span>'}
      <a class="btn" href="/" target="_blank" rel="noopener noreferrer">官网主页 ↗</a>
      <button class="btn" id="refreshBtn" type="button">刷新</button>
    </div>
  </div>

  <div class="kpi-grid" id="kpiGrid">
    <div class="kpi"><span class="kpi-label">待处理反馈</span><span class="kpi-val" id="kpiOpenFeedbacks">${overview.stats.openFeedbacks}</span><span class="kpi-sub" id="kpiFeedbackSub">共 ${overview.feedbacks.length} 条记录</span></div>
    <div class="kpi"><span class="kpi-label">注册账号</span><span class="kpi-val" id="kpiUsers">${overview.stats.totalUsers}</span><span class="kpi-sub">登录可云端同步与对话</span></div>
    <div class="kpi"><span class="kpi-label">已开启云同步</span><span class="kpi-val" id="kpiSyncedUsers">${overview.stats.syncedUsers || 0}</span><span class="kpi-sub">本地与云端双备份</span></div>
  </div>

  <div class="tabs" id="adminTabs">
    <button type="button" class="tab-btn active" data-tab="feedbacks">用户反馈与建议 <span class="tab-badge" id="feedbackTabBadge">${overview.stats.openFeedbacks}</span></button>
    <button type="button" class="tab-btn" data-tab="settings">QQ 交流群配置</button>
    <button type="button" class="tab-btn" data-tab="users">账号与云同步</button>
  </div>

  <section class="panel active" id="panel-feedbacks">
    <div class="card">
      <div class="toolbar-row">
        <div class="filter-group" id="feedbackFilterChips">
          <button type="button" class="chip active" data-fb-status="all">全部</button>
          <button type="button" class="chip" data-fb-status="open">待评估</button>
          <button type="button" class="chip" data-fb-status="planned">已采纳</button>
          <button type="button" class="chip" data-fb-status="done">已上线</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span id="fbMsg" class="status-msg"></span>
          <span class="sub">${overview.githubConfigured ? 'GitHub Issue 自动同步已开启' : '未配置 LIRIO_GITHUB_TOKEN（站内收件箱）'}</span>
        </div>
      </div>
      <table>
        <thead><tr><th>时间 / 分类</th><th>提交账号</th><th>标题与正文 / 附件</th><th>GitHub</th><th>状态与回复</th></tr></thead>
        <tbody id="feedbacksBody"></tbody>
      </table>
    </div>
  </section>

  <section class="panel" id="panel-settings">
    <div class="card">
      <div class="toolbar-row">
        <h2 style="margin:0;">QQ 交流群设置（保存后官网主页与客户端内同步展示）</h2>
        <div style="display:flex;gap:8px;align-items:center;">
          <span id="settingsMsg" class="status-msg"></span>
          <button type="button" class="btn primary" id="saveSettingsBtn">保存配置</button>
        </div>
      </div>
      <div class="settings-grid">
        <div class="qr-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>QQ 群二维码</strong>
            <button type="button" class="copy-btn" id="clearQqQr">清除</button>
          </div>
          <div class="qr-preview" id="qqGroupQrPreview">未上传</div>
          <input type="file" id="qqGroupQrFile" accept="image/*" />
          <input type="text" id="qqGroupQrInput" placeholder="或粘贴二维码图片链接 / Data URL" />
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="field-col">
            <label>群名称</label>
            <input type="text" id="qqGroupNameInput" placeholder="例如 Lirio 学习交流群" />
          </div>
          <div class="field-col">
            <label>QQ 群号</label>
            <input type="text" id="qqGroupNumberInput" placeholder="例如 123456789" />
          </div>
          <div class="field-col">
            <label>一键加群链接（选填）</label>
            <input type="url" id="qqGroupLinkInput" placeholder="https://qm.qq.com/..." />
          </div>
          <div class="field-col">
            <label>交流群简介</label>
            <input type="text" id="communityNoteInput" placeholder="交流英语学习方法、分享精听素材与使用建议。" />
          </div>
          <div class="field-col">
            <label>补充联系方式（选填）</label>
            <input type="text" id="supportContactInput" placeholder="例如邮箱或微信号" />
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-users">
    <div class="card">
      <div class="toolbar-row">
        <h2 style="margin:0;">注册账号与云端备份</h2>
        <input id="userSearch" class="search-input" type="search" placeholder="搜索昵称或账号" />
      </div>
      <table>
        <thead><tr><th>账号</th><th>注册时间</th><th>最近云同步</th><th class="num">云备份大小</th></tr></thead>
        <tbody id="usersBody"></tbody>
      </table>
    </div>
  </section>
</div>
<script>
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
const fmtSize = (b) => !b ? '-' : (b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB');
let state = ${initialJson};
let fbFilter = 'all';
let settingsDirty = false;

function switchTab(name) {
  document.querySelectorAll('#adminTabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}
document.getElementById('adminTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

function renderKpis() {
  const st = state.stats || {};
  const fbs = state.feedbacks || [];
  document.getElementById('kpiOpenFeedbacks').textContent = String(st.openFeedbacks || 0);
  document.getElementById('kpiFeedbackSub').textContent = '共 ' + fbs.length + ' 条记录';
  document.getElementById('kpiUsers').textContent = String(st.totalUsers || 0);
  document.getElementById('kpiSyncedUsers').textContent = String(st.syncedUsers || 0);
  document.getElementById('feedbackTabBadge').textContent = String(st.openFeedbacks || 0);
}

function renderUsers() {
  const q = (document.getElementById('userSearch').value || '').trim().toLowerCase();
  const users = (state.users || []).filter((u) => !q || String(u.name || '').toLowerCase().includes(q) || String(u.email || '').toLowerCase().includes(q));
  document.getElementById('usersBody').innerHTML = users.length ? users.map((u) =>
    '<tr><td><strong>' + esc(u.name) + '</strong><div class="sub">' + esc(u.email) + '</div></td>' +
    '<td class="sub">' + esc(fmtTime(u.createdAt)) + '</td>' +
    '<td class="sub">' + (u.syncUpdatedAt ? esc(fmtTime(u.syncUpdatedAt)) + (u.syncDeviceName ? ' · ' + esc(u.syncDeviceName) : '') : '尚未同步') + '</td>' +
    '<td class="num">' + esc(fmtSize(u.syncByteSize)) + '</td></tr>'
  ).join('') : '<tr><td colspan="4" class="empty">暂无注册账号</td></tr>';
}

function syncQrPreview(previewId, val) {
  const el = document.getElementById(previewId);
  el.innerHTML = val ? '<img src="' + esc(val) + '" alt="QQ群二维码" />' : '未上传';
}

function hydrateSettingsForm() {
  if (settingsDirty) return;
  const s = state.storeSettings || {};
  document.getElementById('qqGroupQrInput').value = s.qqGroupQr || '';
  document.getElementById('qqGroupNameInput').value = s.qqGroupName || '';
  document.getElementById('qqGroupNumberInput').value = s.qqGroupNumber || '';
  document.getElementById('qqGroupLinkInput').value = s.qqGroupLink || '';
  document.getElementById('communityNoteInput').value = s.communityNote || '';
  document.getElementById('supportContactInput').value = s.supportContact || '';
  syncQrPreview('qqGroupQrPreview', s.qqGroupQr || '');
}

function renderFeedbacks() {
  const catLabel = { feature: '功能建议', vocab: '词本投稿', listening: '听力/播客', bug: '问题反馈' };
  const list = (state.feedbacks || []).filter((f) => fbFilter === 'all' || f.status === fbFilter);
  document.getElementById('feedbacksBody').innerHTML = list.length ? list.map((f) => {
    const attHtml = f.attachmentName
      ? '<div style="margin-top:4px;"><a class="copy-btn" href="/api/admin/feedbacks/' + esc(f.id) + '/attachment">下载附件：' + esc(f.attachmentName) + '</a></div>'
      : '';
    const ghHtml = f.githubIssueUrl
      ? '<a class="copy-btn" href="' + esc(f.githubIssueUrl) + '" target="_blank" rel="noopener noreferrer">#' + esc(f.githubIssueNumber || '') + ' ↗</a>'
      : '<span class="sub">站内记录</span>';
    return '<tr><td><span class="tag">' + esc(catLabel[f.category] || f.category) + '</span><div class="sub">' + esc(fmtTime(f.createdAt)) + '</div></td>' +
      '<td><strong>' + esc(f.userEmail) + '</strong>' + (f.appVersion ? '<div class="sub">v' + esc(f.appVersion) + '</div>' : '') + '</td>' +
      '<td><strong>' + esc(f.title) + '</strong><div class="sub" style="white-space:pre-wrap;max-width:340px;">' + esc((f.content || '').slice(0, 260)) + '</div>' + attHtml + '</td>' +
      '<td>' + ghHtml + '</td>' +
      '<td><div style="display:flex;gap:6px;flex-direction:column;min-width:190px;">' +
        '<select data-fb-status-sel="' + esc(f.id) + '">' +
          '<option value="open"' + (f.status === 'open' ? ' selected' : '') + '>待评估</option>' +
          '<option value="planned"' + (f.status === 'planned' ? ' selected' : '') + '>已采纳</option>' +
          '<option value="done"' + (f.status === 'done' ? ' selected' : '') + '>已上线</option>' +
          '<option value="declined"' + (f.status === 'declined' ? ' selected' : '') + '>暂不考虑</option>' +
        '</select>' +
        '<input type="text" data-fb-reply="' + esc(f.id) + '" value="' + esc(f.adminReply || '') + '" placeholder="回复用户一句话…" />' +
        '<button type="button" class="btn primary" data-fb-save="' + esc(f.id) + '">保存状态</button>' +
      '</div></td></tr>';
  }).join('') : '<tr><td colspan="5" class="empty">暂无符合条件的用户反馈</td></tr>';
}

function renderAll() {
  renderKpis();
  renderFeedbacks();
  renderUsers();
  hydrateSettingsForm();
}

async function reloadOverview() {
  const res = await fetch('/api/overview');
  if (!res.ok) return;
  state = await res.json();
  renderAll();
}

function compressQrFile(file, inputId, previewId) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 520;
      const scale = Math.min(1, maxDim / Math.max(img.width || maxDim, img.height || maxDim));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      document.getElementById(inputId).value = dataUrl;
      syncQrPreview(previewId, dataUrl);
      settingsDirty = true;
    };
    img.src = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

document.getElementById('qqGroupQrFile').addEventListener('change', (e) => compressQrFile(e.target.files[0], 'qqGroupQrInput', 'qqGroupQrPreview'));
document.getElementById('qqGroupQrInput').addEventListener('input', (e) => { settingsDirty = true; syncQrPreview('qqGroupQrPreview', e.target.value.trim()); });
document.getElementById('clearQqQr').addEventListener('click', () => { settingsDirty = true; document.getElementById('qqGroupQrInput').value = ''; syncQrPreview('qqGroupQrPreview', ''); });
['qqGroupNameInput', 'qqGroupNumberInput', 'qqGroupLinkInput', 'communityNoteInput', 'supportContactInput'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => { settingsDirty = true; });
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const msg = document.getElementById('settingsMsg');
  msg.textContent = '保存中…';
  const payload = {
    qqGroupQr: document.getElementById('qqGroupQrInput').value.trim(),
    qqGroupName: document.getElementById('qqGroupNameInput').value.trim(),
    qqGroupNumber: document.getElementById('qqGroupNumberInput').value.trim(),
    qqGroupLink: document.getElementById('qqGroupLinkInput').value.trim(),
    communityNote: document.getElementById('communityNoteInput').value.trim(),
    supportContact: document.getElementById('supportContactInput').value.trim(),
  };
  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    settingsDirty = false;
    msg.textContent = '已保存并同步到官网与客户端';
    await reloadOverview();
  } else {
    msg.textContent = data.error || '保存失败';
  }
});

document.getElementById('userSearch').addEventListener('input', renderUsers);
document.getElementById('refreshBtn').addEventListener('click', reloadOverview);
document.getElementById('feedbackFilterChips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-fb-status]');
  if (!c) return;
  fbFilter = c.dataset.fbStatus;
  document.querySelectorAll('#feedbackFilterChips .chip').forEach((el) => el.classList.toggle('active', el === c));
  renderFeedbacks();
});
document.getElementById('feedbacksBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-fb-save]');
  if (!btn) return;
  const id = btn.dataset.fbSave;
  const statusEl = document.querySelector('[data-fb-status-sel="' + id + '"]');
  const replyEl = document.querySelector('[data-fb-reply="' + id + '"]');
  const msg = document.getElementById('fbMsg');
  msg.textContent = '保存中…';
  const res = await fetch('/api/admin/feedbacks/' + encodeURIComponent(id) + '/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: statusEl?.value, adminReply: replyEl?.value || '' }),
  });
  msg.textContent = res.ok ? '已更新状态与回复' : '更新失败';
  await reloadOverview();
});
const logoutBtn = document.getElementById('adminLogoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    location.reload();
  });
}

renderAll();
</script>
</body>
</html>`;
}

function readBinaryBody(req, maxBytes = 12 * 1024 * 1024) {
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
      resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  const buf = await readBinaryBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('无效的 JSON 请求体');
  }
}

function getMaxDevices() {
  return Math.max(1, Number(process.env.LIRIO_MAX_DEVICES || 3));
}

function getGithubRepo() {
  return String(process.env.LIRIO_GITHUB_REPO || 'liruirui321/lirio').trim();
}

function buildGithubIssuePayload({
  category,
  title,
  content,
  userEmail,
  userName,
  userTier,
  appVersion,
  attachmentName,
  attachmentContent,
}) {
  const catMeta = {
    feature: { tag: '[功能建议]', labels: ['feedback', 'enhancement'] },
    vocab: { tag: '[词本投稿]', labels: ['feedback', 'vocab'] },
    listening: { tag: '[听力/播客建议]', labels: ['feedback', 'listening'] },
    bug: { tag: '[问题反馈]', labels: ['feedback', 'bug'] },
  }[category] || { tag: '[需求反馈]', labels: ['feedback'] };

  const repo = getGithubRepo();
  const issueTitle = `${catMeta.tag} ${String(title || '').trim()}`.slice(0, 140);
  const tierLabel = userTier === 'pro' ? 'Lirio Pro · 永久版' : '3天体验用户';
  const metaLine = `- 提交来源：Lirio 客户端\n- 账号身份：${tierLabel}${appVersion ? ` · v${appVersion}` : ''}\n- 联系邮箱：${userEmail}${userName ? ` (${userName})` : ''}`;
  let issueBody = `${metaLine}\n\n### 需求详情\n\n${String(content || '').trim()}`;
  if (attachmentName && attachmentContent) {
    const truncated = String(attachmentContent).slice(0, 25000);
    const bytes = Buffer.byteLength(String(attachmentContent), 'utf8');
    issueBody += `\n\n<details>\n<summary>用户上传文本附件：${attachmentName} (${bytes} bytes)</summary>\n\n\`\`\`\n${truncated}\n\`\`\`\n</details>`;
  }

  const shortBody = issueBody.slice(0, 2600);
  const newIssueUrl = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(shortBody)}`;
  return {
    repo,
    title: issueTitle,
    body: issueBody,
    labels: catMeta.labels,
    newIssueUrl,
  };
}

async function tryCreateGithubIssue(payload) {
  const ghToken = String(process.env.LIRIO_GITHUB_TOKEN || '').trim();
  if (process.env.LIRIO_MOCK_GITHUB === '1') {
    return {
      synced: true,
      issueNumber: 101,
      issueUrl: `https://github.com/${payload.repo}/issues/101`,
      newIssueUrl: payload.newIssueUrl,
    };
  }
  if (!ghToken) {
    return {
      synced: false,
      issueNumber: null,
      issueUrl: '',
      newIssueUrl: payload.newIssueUrl,
    };
  }
  try {
    const resp = await fetch(`https://api.github.com/repos/${payload.repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'lirio-pro-server',
      },
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        labels: payload.labels,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data?.number && data?.html_url) {
      return {
        synced: true,
        issueNumber: Number(data.number),
        issueUrl: String(data.html_url),
        newIssueUrl: payload.newIssueUrl,
      };
    }
  } catch {}
  return {
    synced: false,
    issueNumber: null,
    issueUrl: '',
    newIssueUrl: payload.newIssueUrl,
  };
}

function getTrialDays() {
  return Math.max(1, Number(process.env.LIRIO_TRIAL_DAYS || 3));
}

function getOfflineGraceDays() {
  return Math.max(1, Number(process.env.LIRIO_OFFLINE_GRACE_DAYS || 14));
}

export function buildEntitlement(user, { deviceId = 'legacy-web' } = {}) {
  const now = Date.now();
  const isLifetime = user.tier === 'pro';
  const trialEndsAt = Number(user.createdAt || now) + getTrialDays() * 86400 * 1000;
  const trialActive = !isLifetime && now < trialEndsAt;
  const hasAccess = isLifetime || trialActive;
  const status = isLifetime ? 'lifetime' : trialActive ? 'trial' : 'expired';
  const offlineValidUntil = isLifetime ? now + getOfflineGraceDays() * 86400 * 1000 : trialEndsAt;
  const signedProof = signToken(
    { sub: user.id, kind: 'entitlement', status, tier: user.tier, did: deviceId, offlineValidUntil },
    getOfflineGraceDays() * 86400,
  );
  return {
    status,
    hasAccess,
    isLifetime,
    trialEndsAt,
    offlineValidUntil,
    maxDevices: getMaxDevices(),
    verifiedAt: now,
    signedProof,
  };
}

function authenticateRequestDetailed(req, db) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return { user: null, deviceId: 'legacy-web', revoked: false };
  const payload = verifyToken(match[1]);
  if (!payload) return { user: null, deviceId: 'legacy-web', revoked: false };
  const deviceId = String(payload.did || 'legacy-web');
  const row = getUserById(db, payload.sub);
  if (!row) return { user: null, deviceId, revoked: false };
  if (deviceId !== 'legacy-web' && !isUserDeviceActive(db, row.id, deviceId)) {
    return { user: null, deviceId, revoked: true };
  }
  touchUserDevice(db, row.id, deviceId);
  return { user: serializeUser(row), deviceId, revoked: false };
}

function requireAuthenticatedUser(req, res, db, fallbackMsg = '登录已过期或未登录。') {
  const authState = authenticateRequestDetailed(req, db);
  if (!authState.user) {
    sendJson(
      res,
      401,
      authState.revoked
        ? {
            error: `该设备登录已失效（账号已在其他设备登录并超出 ${getMaxDevices()} 台设备上限），请重新登录。`,
            code: 'DEVICE_REVOKED',
          }
        : { error: fallbackMsg },
    );
    return null;
  }
  return authState;
}

function serveWebsiteFile(res, rel, headOnly = false) {
  const cleanRel = String(rel || '').replace(/^\/+/, '') || 'index.html';
  const resolved = path.resolve(WEBSITE_DIR, cleanRel);
  if (resolved !== WEBSITE_DIR && !resolved.startsWith(WEBSITE_DIR + path.sep)) {
    return false;
  }
  const target =
    fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      ? resolved
      : cleanRel === 'index.html'
        ? path.join(WEBSITE_DIR, 'index.html')
        : null;
  if (!target || !fs.existsSync(target)) {
    return false;
  }
  const ext = path.extname(target).toLowerCase();
  const mime =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : ext === '.json'
            ? 'application/json; charset=utf-8'
            : ext === '.png'
              ? 'image/png'
              : ext === '.svg'
                ? 'image/svg+xml'
                : ext === '.ico'
                  ? 'image/x-icon'
                  : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  if (headOnly) {
    res.end();
  } else {
    fs.createReadStream(target).pipe(res);
  }
  return true;
}

export function createLirioServer({ dbPath } = {}) {
  const db = openDatabase(dbPath);
  const rateBuckets = new Map();

  function rateLimitDisabled() {
    return process.env.LIRIO_DISABLE_RATE_LIMIT === '1';
  }

  function pruneBuckets(now) {
    if (rateBuckets.size <= 2000) return;
    for (const [k, b] of rateBuckets.entries()) {
      if (b.resetAt <= now) rateBuckets.delete(k);
    }
  }

  function getWindowUsage(key, windowMs) {
    const now = Date.now();
    const b = rateBuckets.get(key);
    if (!b || b.resetAt <= now) return { count: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
    return { count: b.count, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }

  function addWindowUsage(key, amount, windowMs) {
    const now = Date.now();
    pruneBuckets(now);
    const b = rateBuckets.get(key);
    if (!b || b.resetAt <= now) {
      rateBuckets.set(key, { count: amount, resetAt: now + windowMs });
      return amount;
    }
    b.count += amount;
    return b.count;
  }

  function consumeRateLimit(res, key, limit, windowMs, msg) {
    if (rateLimitDisabled()) return true;
    const now = Date.now();
    pruneBuckets(now);
    const b = rateBuckets.get(key);
    if (!b || b.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (b.count >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      sendJson(res, 429, { error: msg, retryAfterSec });
      return false;
    }
    b.count += 1;
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const corsOrigin = getAllowedCorsOrigin(req);
    res._lirioCorsOrigin = corsOrigin;
    const clientIp = getClientIp(req);

    if (req.method === 'OPTIONS') {
      const headers = {
        'Vary': 'Origin',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key, X-Audio-Duration, Accept',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, HEAD, OPTIONS',
        'Access-Control-Max-Age': '86400',
      };
      if (corsOrigin) {
        headers['Access-Control-Allow-Origin'] = corsOrigin;
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const headOnly = req.method === 'HEAD';

    try {
      if (isRead && pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && pathname === '/api/admin/login') {
        if (
          !consumeRateLimit(
            res,
            `admin-login:${clientIp}`,
            Math.max(1, Number(process.env.LIRIO_RL_ADMIN_LOGIN_PER_15M || 8)),
            15 * 60 * 1000,
            '管理员登录尝试过于频繁，请 15 分钟后再试。',
          )
        ) {
          return;
        }
        const expected = getAdminToken();
        if (!expected) {
          sendJson(res, 200, { ok: true, mode: 'no_admin_token' });
          return;
        }
        const body = await readJsonBody(req);
        const supplied = String(body.token || '').trim();
        if (!constantTimeEquals(supplied, expected)) {
          sendJson(res, 401, { error: '管理员口令不正确。' });
          return;
        }
        const secureAttr =
          req.headers['x-forwarded-proto'] === 'https' || isProductionMode() ? '; Secure' : '';
        const cookieVal = encodeURIComponent(createSignedAdminCookieValue(expected));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `lirio_admin=${cookieVal}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secureAttr}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/admin/logout') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': 'lirio_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (isRead && pathname === '/api/overview') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' }, headOnly);
          return;
        }
        sendJson(res, 200, buildOverview(db), headOnly);
        return;
      }

      if (isRead && pathname === '/') {
        if (!serveWebsiteFile(res, 'index.html', headOnly)) {
          sendJson(res, 404, { error: '页面不存在。' }, headOnly);
        }
        return;
      }

      if (
        isRead &&
        (pathname === '/styles.css' ||
          pathname === '/app.js' ||
          pathname === '/versions.json' ||
          pathname.startsWith('/assets/'))
      ) {
        if (!serveWebsiteFile(res, pathname.slice(1), headOnly)) {
          sendJson(res, 404, { error: '文件不存在。' }, headOnly);
        }
        return;
      }

      if (isRead && (pathname === '/admin' || pathname === '/admin/')) {
        const accept = String(req.headers.accept || '');
        const wantsJsonOnly = accept.includes('application/json') && !accept.includes('text/html');
        if (!isAdminAuthorized(req)) {
          if (wantsJsonOnly) {
            sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' }, headOnly);
          } else {
            sendHtml(res, 401, renderAdminLoginHtml(), headOnly);
          }
          return;
        }
        const overview = buildOverview(db);
        if (wantsJsonOnly) {
          sendJson(
            res,
            200,
            {
              ...overview,
              endpoints: [
                '/api/health',
                '/api/overview',
                '/api/admin/login',
                '/api/admin/logout',
                '/api/auth/register',
                '/api/auth/login',
                '/api/auth/me',
                '/api/billing/ledger',
                '/api/billing/recharge',
                '/api/billing/redeem',
                '/api/admin/codes',
                '/api/admin/codes/generate',
                '/api/ai/chat',
                '/api/ai/tts',
                '/api/ai/transcribe',
                '/api/ai/asr-stream-token',
              ],
            },
            headOnly,
          );
          return;
        }
        sendHtml(
          res,
          200,
          renderDashboardHtml(overview, { adminAuthEnabled: Boolean(getAdminToken()) }),
          headOnly,
        );
        return;
      }

      if (isRead && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'lirio-pro-server', packs: RECHARGE_PACKS }, headOnly);
        return;
      }

      if (isRead && pathname.startsWith('/api/updates/')) {
        const parts = pathname.slice('/api/updates/'.length).split('/').filter(Boolean);
        const [target, arch, currentVersion] = parts;
        const manifestPath = path.join(getReleasesDir(), 'latest.json');
        if (!target || !arch || !currentVersion || !fs.existsSync(manifestPath)) {
          res.writeHead(204);
          res.end();
          return;
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const platformKey = `${target}-${arch}`;
        const plat = manifest?.platforms?.[platformKey];
        if (!plat || !manifest.version || compareSemver(manifest.version, currentVersion) <= 0) {
          res.writeHead(204);
          res.end();
          return;
        }
        sendJson(
          res,
          200,
          {
            version: manifest.version,
            notes: manifest.notes || '',
            pub_date: manifest.pub_date || new Date().toISOString(),
            url: plat.url,
            signature: plat.signature,
          },
          headOnly,
        );
        return;
      }

      if (isRead && pathname.startsWith('/releases/')) {
        const rawName = decodeURIComponent(pathname.slice('/releases/'.length));
        const safeName = path.basename(rawName);
        if (!safeName || safeName !== rawName || safeName.startsWith('.')) {
          sendJson(res, 404, { error: '文件不存在。' }, headOnly);
          return;
        }
        const filePath = path.join(getReleasesDir(), safeName);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          sendJson(res, 404, { error: '文件不存在。' }, headOnly);
          return;
        }
        const ext = path.extname(safeName).toLowerCase();
        const ctype =
          ext === '.json'
            ? 'application/json; charset=utf-8'
            : ext === '.sig'
              ? 'text/plain; charset=utf-8'
              : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': fs.statSync(filePath).size });
        if (headOnly) {
          res.end();
        } else {
          fs.createReadStream(filePath).pipe(res);
        }
        return;
      }

      if (isRead && (pathname === '/site' || pathname.startsWith('/site/'))) {
        if (pathname === '/site') {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        const rel = pathname.slice('/site/'.length) || 'index.html';
        if (!serveWebsiteFile(res, rel, headOnly)) {
          sendJson(res, 404, { error: '页面不存在。' }, headOnly);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/register') {
        if (
          !consumeRateLimit(
            res,
            `reg:${clientIp}`,
            Math.max(1, Number(process.env.LIRIO_RL_REG_PER_DAY || 5)),
            24 * 60 * 60 * 1000,
            '今日当前网络注册次数已达上限，请明天再试。',
          )
        ) {
          return;
        }
        const body = await readJsonBody(req);
        const email = String(body.account || body.username || body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const name = String(body.name || '').trim();
        if (!isValidAccountId(email)) {
          sendJson(res, 400, { error: '账号需为 4–32 位字母、数字、下划线或邮箱格式，不含空格。' });
          return;
        }
        const pwdErr = validatePasswordStrength(password);
        if (pwdErr) {
          sendJson(res, 400, { error: pwdErr });
          return;
        }
        if (name.length > 24) {
          sendJson(res, 400, { error: '昵称最多 24 个字符。' });
          return;
        }
        if (getUserByEmail(db, email)) {
          sendJson(res, 409, { error: '该账号已被注册，请换一个或直接登录。' });
          return;
        }
        const passwordHash = hashPassword(password);
        const user = createUserWithTrial(db, {
          email,
          name,
          passwordHash,
          trialUnits: DEFAULT_TRIAL_UNITS,
        });
        const deviceId = String(body.deviceId || 'legacy-web').trim() || 'legacy-web';
        const regDev = registerUserDevice(db, {
          userId: user.id,
          deviceId,
          deviceName: body.deviceName,
          platform: body.platform,
          maxDevices: getMaxDevices(),
        });
        const token = signToken({ sub: user.id, email: user.email, did: deviceId });
        const ledger = listUserLedger(db, user.id, 30);
        sendJson(res, 201, {
          token,
          user,
          ledger,
          packs: RECHARGE_PACKS,
          entitlement: buildEntitlement(user, { deviceId }),
          devices: regDev.devices,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/login') {
        if (
          !consumeRateLimit(
            res,
            `login:${clientIp}`,
            Math.max(1, Number(process.env.LIRIO_RL_LOGIN_PER_15M || 15)),
            15 * 60 * 1000,
            '登录尝试过于频繁，请稍后再试。',
          )
        ) {
          return;
        }
        const body = await readJsonBody(req);
        const email = String(body.account || body.username || body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const row = getUserByEmail(db, email);
        if (!row || !verifyPassword(password, row.password_hash)) {
          sendJson(res, 401, { error: '账号或密码不正确。' });
          return;
        }
        const user = serializeUser(row);
        const deviceId = String(body.deviceId || 'legacy-web').trim() || 'legacy-web';
        const regDev = registerUserDevice(db, {
          userId: user.id,
          deviceId,
          deviceName: body.deviceName,
          platform: body.platform,
          maxDevices: getMaxDevices(),
        });
        const token = signToken({ sub: user.id, email: user.email, did: deviceId });
        const ledger = listUserLedger(db, user.id, 30);
        sendJson(res, 200, {
          token,
          user,
          ledger,
          packs: RECHARGE_PACKS,
          entitlement: buildEntitlement(user, { deviceId }),
          devices: regDev.devices,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const authState = requireAuthenticatedUser(req, res, db, '登录已过期或未登录。');
        if (!authState) return;
        const { user, deviceId } = authState;
        const ledger = listUserLedger(db, user.id, 30);
        sendJson(res, 200, {
          user,
          ledger,
          packs: RECHARGE_PACKS,
          entitlement: buildEntitlement(user, { deviceId }),
          devices: listUserDevices(db, user.id),
        });
        return;
      }

      if (isRead && pathname === '/api/auth/devices') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录。');
        if (!authState) return;
        sendJson(
          res,
          200,
          {
            ok: true,
            maxDevices: getMaxDevices(),
            currentDeviceId: authState.deviceId,
            devices: listUserDevices(db, authState.user.id),
          },
          headOnly,
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/devices/remove') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录。');
        if (!authState) return;
        const body = await readJsonBody(req);
        const targetId = String(body.deviceId || '').trim();
        if (!targetId) {
          sendJson(res, 400, { error: '缺少设备编号。' });
          return;
        }
        removeUserDevice(db, authState.user.id, targetId);
        sendJson(res, 200, {
          ok: true,
          devices: listUserDevices(db, authState.user.id),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/billing/ledger') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录。');
        if (!authState) return;
        const limit = Number(url.searchParams.get('limit') || 50);
        const ledger = listUserLedger(db, authState.user.id, limit);
        sendJson(res, 200, { user: authState.user, ledger, packs: RECHARGE_PACKS });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/billing/recharge') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录再充值。');
        if (!authState) return;
        const user = authState.user;
        if (isProductionMode() && process.env.LIRIO_ALLOW_DIRECT_RECHARGE !== '1' && !isAdminAuthorized(req)) {
          sendJson(res, 403, { error: '生产环境已关闭无验签直充接口，请使用卡密兑换码（/api/billing/redeem）。' });
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

      if (req.method === 'POST' && pathname === '/api/billing/redeem') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录再兑换卡密。');
        if (!authState) return;
        const { user, deviceId } = authState;
        const redeemLimit = Math.max(1, Number(process.env.LIRIO_RL_REDEEM_PER_15M || 10));
        if (
          !consumeRateLimit(res, `redeem-u:${user.id}`, redeemLimit, 15 * 60 * 1000, '兑换尝试过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `redeem-ip:${clientIp}`, redeemLimit * 2, 15 * 60 * 1000, '兑换尝试过于频繁，请稍后再试。')
        ) {
          return;
        }
        const body = await readJsonBody(req);
        try {
          const result = redeemCodeForUser(db, { userId: user.id, rawCode: body.code });
          const ledger = listUserLedger(db, user.id, 50);
          sendJson(res, 200, {
            user: result.user,
            entry: result.entry,
            redeemCode: result.redeemCode,
            ledger,
            entitlement: buildEntitlement(result.user, { deviceId }),
            devices: listUserDevices(db, user.id),
          });
        } catch (err) {
          const codeErr = err?.message || String(err);
          if (codeErr === 'INVALID_CODE') {
            sendJson(res, 400, { error: '请输入卡密兑换码。' });
            return;
          }
          if (codeErr === 'CODE_NOT_FOUND') {
            sendJson(res, 404, { error: '卡密无效，请核对后重试。' });
            return;
          }
          if (codeErr === 'CODE_ALREADY_REDEEMED') {
            sendJson(res, 409, { error: '该卡密已被使用，无法重复兑换。' });
            return;
          }
          throw err;
        }
        return;
      }

      if (isRead && pathname === '/api/admin/codes') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' });
          return;
        }
        const limit = Number(url.searchParams.get('limit') || 60);
        sendJson(res, 200, { ok: true, presets: CODE_PRESETS, codes: listRedeemCodes(db, limit) }, headOnly);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/admin/codes/generate') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' });
          return;
        }
        const body = await readJsonBody(req);
        const preset = CODE_PRESETS.find((p) => p.id === body.presetId) || CODE_PRESETS[0];
        const count = Math.max(1, Math.min(100, Math.round(Number(body.count) || 1)));
        const amountUnits = body.amountUnits !== undefined ? Number(body.amountUnits) : preset.amountUnits;
        const upgradeToPro = body.upgradeToPro !== undefined ? Boolean(body.upgradeToPro) : preset.upgradeToPro;
        const label = String(body.label || preset.label);
        const note = String(body.note ?? preset.note ?? '');
        const codes = createRedeemCodes(db, {
          count,
          planId: preset.id,
          label,
          amountUnits,
          upgradeToPro,
          note,
        });
        sendJson(res, 201, { ok: true, codes });
        return;
      }

      if (isRead && pathname === '/api/admin/codes/export') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' }, headOnly);
          return;
        }
        const planId = url.searchParams.get('planId') || '';
        const unused = listUnusedRedeemCodes(db, planId);
        const txt = unused.map((c) => c.code).join('\n') + (unused.length ? '\n' : '');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="lirio-unused-codes.txt"',
          'Cache-Control': 'no-store',
        });
        res.end(headOnly ? undefined : txt);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/feedback') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录账号再提交需求或建议。');
        if (!authState) return;
        const user = authState.user;
        const body = await readJsonBody(req, 1024 * 1024);
        const category = ['feature', 'vocab', 'listening', 'bug'].includes(body.category)
          ? body.category
          : 'feature';
        const title = String(body.title || '').trim();
        const content = String(body.content || '').trim();
        if (title.length < 2 || title.length > 120) {
          sendJson(res, 400, { error: '请填写 2–120 字的需求标题。' });
          return;
        }
        if (content.length < 4 || content.length > 20000) {
          sendJson(res, 400, { error: '请填写 4–20000 字的详细说明。' });
          return;
        }
        const attachmentName = String(body.attachmentName || '').trim();
        const attachmentContent = String(body.attachmentContent || '');
        if (attachmentName || attachmentContent) {
          const cleanName = path.basename(attachmentName || 'attachment.txt');
          if (!/\.(txt|csv|md|json|srt|lrc)$/i.test(cleanName)) {
            sendJson(res, 400, { error: '仅支持上传文本格式材料（.txt / .csv / .md / .json / .srt / .lrc），音频请直接在本地导入。' });
            return;
          }
          if (Buffer.byteLength(attachmentContent, 'utf8') > 512 * 1024) {
            sendJson(res, 400, { error: '上传的文本附件需在 512 KB 以内。' });
            return;
          }
        }
        const safeAttachmentName = attachmentName ? path.basename(attachmentName) : '';
        const appVersion = String(body.appVersion || '').trim().slice(0, 32);
        const ghPayload = buildGithubIssuePayload({
          category,
          title,
          content,
          userEmail: user.email,
          userName: user.name,
          userTier: user.tier,
          appVersion,
          attachmentName: safeAttachmentName,
          attachmentContent,
        });
        const ghRes = await tryCreateGithubIssue(ghPayload);
        const feedback = createFeedback(db, {
          userId: user.id,
          userEmail: user.email,
          userName: user.name,
          userTier: user.tier,
          category,
          title,
          content,
          attachmentName: safeAttachmentName,
          attachmentContent,
          appVersion,
          githubIssueNumber: ghRes.issueNumber,
          githubIssueUrl: ghRes.issueUrl,
        });
        sendJson(res, 201, {
          ok: true,
          feedback,
          githubSynced: ghRes.synced,
          githubNewIssueUrl: ghRes.newIssueUrl,
        });
        return;
      }

      if (isRead && pathname === '/api/feedback/mine') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录。');
        if (!authState) return;
        sendJson(
          res,
          200,
          {
            ok: true,
            feedbacks: listUserFeedbacks(db, authState.user.id, 30),
            repoUrl: `https://github.com/${getGithubRepo()}/issues`,
          },
          headOnly,
        );
        return;
      }

      if (isRead && pathname === '/api/admin/feedbacks') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' }, headOnly);
          return;
        }
        sendJson(
          res,
          200,
          {
            ok: true,
            feedbacks: listAllFeedbacks(db, 100),
            githubConfigured: Boolean(String(process.env.LIRIO_GITHUB_TOKEN || '').trim()),
          },
          headOnly,
        );
        return;
      }

      const fbAttachmentMatch = pathname.match(/^\/api\/admin\/feedbacks\/([^/]+)\/attachment$/);
      if (isRead && fbAttachmentMatch) {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' }, headOnly);
          return;
        }
        const item = getFeedbackById(db, decodeURIComponent(fbAttachmentMatch[1]), { includeAttachment: true });
        if (!item || !item.attachmentName) {
          sendJson(res, 404, { error: '附件不存在。' }, headOnly);
          return;
        }
        const safeName = item.attachmentName.replace(/["\r\n]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="feedback-attachment.txt"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
          'Cache-Control': 'no-store',
        });
        res.end(headOnly ? undefined : item.attachmentContent);
        return;
      }

      const fbStatusMatch = pathname.match(/^\/api\/admin\/feedbacks\/([^/]+)\/status$/);
      if (req.method === 'POST' && fbStatusMatch) {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' });
          return;
        }
        const body = await readJsonBody(req);
        const status = ['open', 'planned', 'done', 'declined'].includes(body.status) ? body.status : 'open';
        const updated = updateFeedback(db, {
          id: decodeURIComponent(fbStatusMatch[1]),
          status,
          adminReply: body.adminReply !== undefined ? String(body.adminReply) : undefined,
        });
        if (!updated) {
          sendJson(res, 404, { error: '反馈记录不存在。' });
          return;
        }
        sendJson(res, 200, { ok: true, feedback: updated });
        return;
      }

      if (isRead && pathname === '/api/admin/orders') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' }, headOnly);
          return;
        }
        sendJson(res, 200, { ok: true, orders: listOrders(db, 100) }, headOnly);
        return;
      }

      if (isRead && pathname === '/api/admin/settings') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' }, headOnly);
          return;
        }
        sendJson(res, 200, { ok: true, settings: getStoreSettings(db) }, headOnly);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/admin/settings') {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' });
          return;
        }
        const body = await readJsonBody(req, 4 * 1024 * 1024);
        const settings = saveStoreSettings(db, body);
        sendJson(res, 200, { ok: true, settings });
        return;
      }

      if (isRead && pathname === '/api/community/config') {
        const st = getStoreSettings(db);
        sendJson(
          res,
          200,
          {
            ok: true,
            community: {
              qqGroupNumber: st.qqGroupNumber || '966587892',
              qqGroupName: st.qqGroupName || 'Lirio 使用交流群',
              qqGroupQr: st.qqGroupQr || 'https://lirio.deltae.tech/assets/qq-group-qr.png',
              qqGroupLink: st.qqGroupLink || '',
              communityNote: st.communityNote || '交流英语学习方法、分享精听素材、反馈建议与第一时间获取更新。',
              supportContact: st.supportContact || '',
            },
          },
          headOnly,
        );
        return;
      }

      if (isRead && pathname === '/api/sync/state') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号。');
        if (!authState) return;
        const snapshot = getUserSyncSnapshot(db, authState.user.id);
        sendJson(res, 200, { ok: true, snapshot }, headOnly);
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/sync/state') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号。');
        if (!authState) return;
        const body = await readJsonBody(req, 4 * 1024 * 1024);
        const rawPayload =
          typeof body.payload === 'string'
            ? body.payload
            : body.payload && typeof body.payload === 'object'
              ? JSON.stringify(body.payload)
              : '';
        if (!rawPayload || rawPayload.length < 2) {
          sendJson(res, 400, { error: '同步内容不能为空。' });
          return;
        }
        let sanitizedPayload;
        try {
          sanitizedPayload = sanitizeSyncPayload(rawPayload);
        } catch {
          sendJson(res, 400, { error: '同步数据格式无效。' });
          return;
        }
        const snapshot = saveUserSyncSnapshot(db, {
          userId: authState.user.id,
          payload: sanitizedPayload,
          deviceName: String(body.deviceName || ''),
        });
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (isRead && pathname === '/api/store/config') {
        sendJson(
          res,
          200,
          {
            ok: true,
            presets: CODE_PRESETS,
            settings: getStoreSettings(db),
            sandboxPayEnabled: !isProductionMode(),
          },
          headOnly,
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/api/orders') {
        const body = await readJsonBody(req);
        const preset = CODE_PRESETS.find((p) => p.id === body.planId);
        if (!preset) {
          sendJson(res, 400, { error: '无效的卡密套餐。' });
          return;
        }
        const buyerEmail = String(body.buyerEmail || '').trim().toLowerCase();
        if (!isValidAccountId(buyerEmail)) {
          sendJson(res, 400, { error: '请输入有效的 Lirio 账号（4–32 位）。' });
          return;
        }
        const existingUser = getUserByEmail(db, buyerEmail);
        if (!existingUser) {
          sendJson(res, 404, {
            error: '该账号尚未注册，请先下载并在 Lirio 客户端中注册账号后再购买卡密。',
          });
          return;
        }
        const order = createOrder(db, {
          planId: preset.id,
          label: preset.label,
          payYuan: preset.payYuan,
          amountUnits: preset.amountUnits,
          upgradeToPro: preset.upgradeToPro,
          buyerEmail,
          payChannel: body.payChannel === 'alipay' ? 'alipay' : 'wechat',
          note: String(body.note || ''),
        });
        sendJson(res, 201, {
          ok: true,
          order,
          settings: getStoreSettings(db),
          sandboxPayEnabled: !isProductionMode(),
        });
        return;
      }

      if (isRead && pathname === '/api/orders/lookup') {
        const isExplicitAdmin = Boolean(getAdminToken() && isAdminAuthorized(req));
        const authState = isExplicitAdmin
          ? null
          : requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号后查询订单。');
        if (!isExplicitAdmin && !authState) return;
        const requestedEmail = String(url.searchParams.get('email') || '').trim().toLowerCase();
        const targetEmail = isExplicitAdmin ? requestedEmail : requestedEmail || authState.user.email;
        if (!isValidAccountId(targetEmail)) {
          sendJson(res, 400, { error: '请输入下单时填写的账号或邮箱（4–32 位）。' }, headOnly);
          return;
        }
        if (!isExplicitAdmin && targetEmail !== authState.user.email) {
          sendJson(res, 403, { error: '无权查询其他账号的订单。' }, headOnly);
          return;
        }
        const orderNo = String(url.searchParams.get('orderNo') || '').trim().toUpperCase();
        const orders = lookupOrdersByEmail(db, targetEmail, { orderNo, limit: 15 });
        sendJson(res, 200, { ok: true, orders }, headOnly);
        return;
      }

      const confirmOrderMatch = pathname.match(/^\/api\/orders\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmOrderMatch) {
        const orderNo = decodeURIComponent(confirmOrderMatch[1]);
        const existingOrder = getOrderByNo(db, orderNo);
        if (!existingOrder) {
          sendJson(res, 404, { error: '订单不存在。' });
          return;
        }
        const body = await readJsonBody(req);
        const adminOk = isAdminAuthorized(req);
        const devSandboxOk =
          !isProductionMode() &&
          body.simulate === true &&
          String(body.email || '').trim().toLowerCase() === existingOrder.buyerEmail;
        if (!adminOk && !devSandboxOk) {
          sendJson(res, 401, { error: '需要管理员口令或有效支付回调签名。' });
          return;
        }
        try {
          const result = confirmOrderAndIssueCode(db, { orderNo, note: body.note || '' });
          sendJson(res, 200, {
            ok: true,
            order: result.order,
            redeemCode: result.redeemCode,
            alreadyPaid: result.alreadyPaid,
          });
        } catch (err) {
          const codeErr = err?.message || String(err);
          if (codeErr === 'ORDER_CANCELLED') {
            sendJson(res, 409, { error: '该订单已取消，无法发卡。' });
            return;
          }
          throw err;
        }
        return;
      }

      const cancelOrderMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelOrderMatch) {
        if (!isAdminAuthorized(req)) {
          sendJson(res, 401, { error: '需要管理员口令（LIRIO_ADMIN_TOKEN）。' });
          return;
        }
        const orderNo = decodeURIComponent(cancelOrderMatch[1]);
        try {
          const order = cancelOrder(db, { orderNo });
          sendJson(res, 200, { ok: true, order });
        } catch (err) {
          const codeErr = err?.message || String(err);
          if (codeErr === 'ORDER_NOT_FOUND') {
            sendJson(res, 404, { error: '订单不存在。' });
            return;
          }
          if (codeErr === 'ORDER_NOT_PENDING') {
            sendJson(res, 409, { error: '仅待付款订单可取消。' });
            return;
          }
          throw err;
        }
        return;
      }

      const getOrderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (isRead && getOrderMatch) {
        const isExplicitAdmin = Boolean(getAdminToken() && isAdminAuthorized(req));
        const authState = isExplicitAdmin
          ? null
          : requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号后查看订单。');
        if (!isExplicitAdmin && !authState) return;
        const orderNo = decodeURIComponent(getOrderMatch[1]);
        const order = getOrderByNo(db, orderNo);
        if (!order) {
          sendJson(res, 404, { error: '订单不存在。' }, headOnly);
          return;
        }
        const qEmail = String(url.searchParams.get('email') || '').trim().toLowerCase();
        if (!isExplicitAdmin && (authState.user.email !== order.buyerEmail || (qEmail && qEmail !== order.buyerEmail))) {
          sendJson(res, 403, { error: '无权查看其他账号的订单。' }, headOnly);
          return;
        }
        sendJson(
          res,
          200,
          { ok: true, order, sandboxPayEnabled: !isProductionMode() },
          headOnly,
        );
        return;
      }

      const checkAndParseChatBody = async () => {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号。');
        if (!authState) return null;
        const user = authState.user;

        const userRpm = Math.max(1, Number(process.env.LIRIO_BETA_CHAT_RPM || 20));
        const userDailyReq = Math.max(1, Number(process.env.LIRIO_BETA_CHAT_DAILY_REQ || 120));
        const userDailyTokens = Math.max(100, Number(process.env.LIRIO_BETA_CHAT_DAILY_TOKENS || 150000));
        const ipRpm = Math.max(1, Number(process.env.LIRIO_BETA_CHAT_IP_RPM || 40));
        const ipDailyReq = Math.max(1, Number(process.env.LIRIO_BETA_CHAT_IP_DAILY_REQ || 240));
        const ipDailyTokens = Math.max(100, Number(process.env.LIRIO_BETA_CHAT_IP_DAILY_TOKENS || 300000));

        if (!rateLimitDisabled()) {
          const uTok = getWindowUsage(`chat-tok-u:${user.id}`, 86400000);
          if (uTok.count >= userDailyTokens) {
            res.setHeader('Retry-After', String(uTok.retryAfterSec));
            sendJson(res, 429, { error: '今日免费公测对话额度已用完，请明天再试或填写自带 API Key。', retryAfterSec: uTok.retryAfterSec });
            return null;
          }
          const ipTok = getWindowUsage(`chat-tok-ip:${clientIp}`, 86400000);
          if (ipTok.count >= ipDailyTokens) {
            res.setHeader('Retry-After', String(ipTok.retryAfterSec));
            sendJson(res, 429, { error: '当前网络今日公测对话额度已达上限，请明天再试或填写自带 API Key。', retryAfterSec: ipTok.retryAfterSec });
            return null;
          }
        }
        if (
          !consumeRateLimit(res, `chat-rpm-u:${user.id}`, userRpm, 60000, '发送太快了，请稍等片刻再试。') ||
          !consumeRateLimit(res, `chat-rpm-ip:${clientIp}`, ipRpm, 60000, '当前网络请求过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `chat-day-u:${user.id}`, userDailyReq, 86400000, '今日免费公测对话次数已达上限，请明天再试或使用自带 Key。') ||
          !consumeRateLimit(res, `chat-day-ip:${clientIp}`, ipDailyReq, 86400000, '当前网络今日对话次数已达上限，请明天再试。')
        ) {
          return null;
        }

        const body = await readJsonBody(req, 512 * 1024);
        if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 32) {
          sendJson(res, 400, { error: '对话消息数量需在 1–32 条之间。' });
          return null;
        }
        let totalChars = 0;
        for (const m of body.messages) {
          if (!m || typeof m !== 'object' || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
            sendJson(res, 400, { error: '对话消息格式无效。' });
            return null;
          }
          totalChars += m.content.length;
          if (totalChars > 24000) {
            sendJson(res, 400, { error: '单次对话上下文过长（最多 24000 字符）。' });
            return null;
          }
        }
        const safeMaxTokens = Math.min(Math.max(64, Number(body.maxTokens) || 1200), 2048);
        return { user, body, safeMaxTokens };
      };

      if (req.method === 'POST' && pathname === '/api/ai/chat') {
        const ctx = await checkAndParseChatBody();
        if (!ctx) return;
        const { user, body, safeMaxTokens } = ctx;

        const aiRes = await forwardChatCompletion({
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          maxTokens: safeMaxTokens,
        });
        if (!rateLimitDisabled()) {
          const usedTokens = Number(aiRes.usage?.totalTokens || 0);
          if (usedTokens > 0) {
            addWindowUsage(`chat-tok-u:${user.id}`, usedTokens, 86400000);
            addWindowUsage(`chat-tok-ip:${clientIp}`, usedTokens, 86400000);
          }
        }
        sendJson(res, 200, {
          content: aiRes.content,
          model: aiRes.model,
          usage: aiRes.usage,
          costUnits: 0,
          balanceUnits: user.balanceUnits,
          totalSpentUnits: user.totalSpentUnits,
          user,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/chat/stream') {
        const ctx = await checkAndParseChatBody();
        if (!ctx) return;
        const { user, body, safeMaxTokens } = ctx;

        const sseHeaders = {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Vary': 'Origin',
        };
        if (corsOrigin) {
          sseHeaders['Access-Control-Allow-Origin'] = corsOrigin;
        }
        res.writeHead(200, sseHeaders);
        try {
          const aiRes = await forwardChatCompletionStream({
            messages: body.messages,
            temperature: body.temperature ?? 0.7,
            maxTokens: safeMaxTokens,
            onDelta: (delta) => {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ delta })}\n\n`);
              }
            },
          });
          if (!rateLimitDisabled()) {
            const usedTokens = Number(aiRes.usage?.totalTokens || 0);
            if (usedTokens > 0) {
              addWindowUsage(`chat-tok-u:${user.id}`, usedTokens, 86400000);
              addWindowUsage(`chat-tok-ip:${clientIp}`, usedTokens, 86400000);
            }
          }
          if (!res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({ done: true, content: aiRes.content, model: aiRes.model, usage: aiRes.usage })}\n\n`,
            );
            res.end();
          }
        } catch (streamErr) {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: sanitizePublicError(streamErr) })}\n\n`);
            res.end();
          }
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/tts') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号。');
        if (!authState) return;
        const user = authState.user;

        const ttsRpm = Math.max(1, Number(process.env.LIRIO_BETA_TTS_RPM || 30));
        const ttsDaily = Math.max(1, Number(process.env.LIRIO_BETA_TTS_DAILY || 300));
        if (
          !consumeRateLimit(res, `tts-rpm-u:${user.id}`, ttsRpm, 60000, '朗读请求过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `tts-rpm-ip:${clientIp}`, ttsRpm * 2, 60000, '当前网络朗读请求过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `tts-day-u:${user.id}`, ttsDaily, 86400000, '今日朗读次数已达公测上限，请明天再试。') ||
          !consumeRateLimit(res, `tts-day-ip:${clientIp}`, Math.max(ttsDaily, 500), 86400000, '当前网络今日朗读次数已达上限，请明天再试。')
        ) {
          return;
        }

        const body = await readJsonBody(req, 64 * 1024);
        const cleanText = String(body.text || '').trim();
        if (!cleanText || cleanText.length > 1200) {
          sendJson(res, 400, { error: !cleanText ? '朗读文本不能为空。' : '朗读文本过长（单次最多 1200 字符）。' });
          return;
        }

        const ttsRes = await forwardTts({
          text: cleanText,
          accent: body.accent,
          voice: body.voice,
        });
        if (String(req.headers.accept || '').includes('audio/mpeg')) {
          const buf = ttsRes.audioBuf || Buffer.from(ttsRes.audioBase64 || '', 'base64');
          const audioHeaders = {
            'Content-Type': ttsRes.mime || 'audio/mpeg',
            'Content-Length': buf.length,
            'Vary': 'Origin',
            'Cache-Control': 'private, max-age=3600',
          };
          if (corsOrigin) {
            audioHeaders['Access-Control-Allow-Origin'] = corsOrigin;
          }
          res.writeHead(200, audioHeaders);
          res.end(buf);
          return;
        }
        sendJson(res, 200, {
          audioBase64: ttsRes.audioBase64,
          mime: ttsRes.mime,
          chars: ttsRes.chars,
          model: ttsRes.model,
          costUnits: 0,
          balanceUnits: user.balanceUnits,
          totalSpentUnits: user.totalSpentUnits,
          user,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/transcribe') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号。');
        if (!authState) return;
        const user = authState.user;

        const asrRpm = Math.max(1, Number(process.env.LIRIO_BETA_ASR_RPM || 12));
        const asrDaily = Math.max(1, Number(process.env.LIRIO_BETA_ASR_DAILY || 60));
        if (
          !consumeRateLimit(res, `asr-rpm-u:${user.id}`, asrRpm, 60000, '语音识别过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `asr-rpm-ip:${clientIp}`, Math.max(asrRpm, 20), 60000, '当前网络语音识别过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `asr-day-u:${user.id}`, asrDaily, 86400000, '今日云端语音识别次数已达公测上限，请明天再试。') ||
          !consumeRateLimit(res, `asr-day-ip:${clientIp}`, Math.max(asrDaily, 100), 86400000, '当前网络今日语音识别次数已达上限，请明天再试。')
        ) {
          return;
        }

        const ct = String(req.headers['content-type'] || '').toLowerCase();
        const isBinaryAudio = ct.startsWith('audio/') || ct.startsWith('application/octet-stream');
        const asrRes = isBinaryAudio
          ? await forwardTranscribe({
              wavBuf: await readBinaryBody(req, 5 * 1024 * 1024),
              mimeType: ct,
              durationSec: Number(req.headers['x-audio-duration'] || 0) || undefined,
            })
          : await (async () => {
              const body = await readJsonBody(req, 7 * 1024 * 1024);
              return forwardTranscribe({
                wavBase64: body.wavBase64,
                durationSec: body.durationSec,
              });
            })();
        sendJson(res, 200, {
          text: asrRes.text,
          model: asrRes.model,
          durationSec: asrRes.durationSec,
          costUnits: 0,
          balanceUnits: user.balanceUnits,
          totalSpentUnits: user.totalSpentUnits,
          user,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/asr-stream-token') {
        const authState = requireAuthenticatedUser(req, res, db, '请先登录 Lirio 账号。');
        if (!authState) return;
        const user = authState.user;

        const rpm = Math.max(1, Number(process.env.LIRIO_BETA_ASR_STREAM_RPM || 20));
        const daily = Math.max(1, Number(process.env.LIRIO_BETA_ASR_STREAM_DAILY || 120));
        if (
          !consumeRateLimit(res, `asr-stream-rpm-u:${user.id}`, rpm, 60000, '实时语音授权过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `asr-stream-rpm-ip:${clientIp}`, Math.max(rpm, 30), 60000, '当前网络实时语音授权过于频繁，请稍后再试。') ||
          !consumeRateLimit(res, `asr-stream-day-u:${user.id}`, daily, 86400000, '今日实时语音识别次数已达上限，请明天再试。') ||
          !consumeRateLimit(res, `asr-stream-day-ip:${clientIp}`, Math.max(daily, 200), 86400000, '当前网络今日实时语音识别次数已达上限，请明天再试。')
        ) {
          return;
        }

        try {
          const tokenRes = await createSonioxStreamToken({ userId: user.id });
          sendJson(res, 200, { ok: true, ...tokenRes });
        } catch (err) {
          if (err?.code === 'SONIOX_NOT_CONFIGURED') {
            sendJson(res, 503, { error: err.message, configured: false });
            return;
          }
          throw err;
        }
        return;
      }

      sendJson(res, 404, { error: '接口不存在。' });
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg === 'INSUFFICIENT_BALANCE') {
        sendJson(res, 402, { error: '当前积分不足，请充值积分后继续。' });
        return;
      }
      if (msg === '请求体过大') {
        sendJson(res, 413, { error: msg });
        return;
      }
      if (msg === '无效的 JSON 请求体') {
        sendJson(res, 400, { error: msg });
        return;
      }
      const safeMsg = sanitizePublicError(err);
      if (safeMsg === '服务暂时异常，请稍后重试。') {
        console.error('[SERVER-ERR]', msg.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'));
      }
      sendJson(res, 500, { error: safeMsg });
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
  loadEnvFileIfPresent();
  const check = validateProductionConfig();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const { server, db } = createLirioServer();
  if (!isProductionMode() && (process.env.LIRIO_SEED_DEMO === '1' || process.env.LIRIO_SEED_DEMO === 'true')) {
    const demo = seedDemoUser(db);
    console.log(`[lirio-pro-server] demo tester ready: ${demo.email} balance=${demo.balanceUnits}`);
  }
  server.listen(port, host, () => {
    if (!process.env.LIRIO_MOCK_AI) {
      warmupEdgeWorker();
    }
    console.log(`[lirio-pro-server] (${check.mode}) listening on http://${host}:${port}`);
  });
}
