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
  createOrder,
  createRedeemCodes,
  createUserWithTrial,
  creditUserBalance,
  deductUserBalance,
  getOrderByNo,
  getStoreSettings,
  getUserByEmail,
  getUserById,
  listAllUsers,
  listOrders,
  listRecentLedger,
  listRedeemCodes,
  listUnusedRedeemCodes,
  listUserLedger,
  lookupOrdersByEmail,
  openDatabase,
  redeemCodeForUser,
  saveStoreSettings,
  serializeUser,
} from './db.mjs';
import {
  RECHARGE_PACKS,
  calculateAsrCostUnits,
  calculateChatCostUnits,
  calculateTtsCostUnits,
  formatYuan,
  getDeepSeekPeriodLabel,
  getDeepSeekRatesPer1M,
  isDeepSeekPeakBeijing,
} from './pricing.mjs';
import { forwardChatCompletion, forwardTranscribe, forwardTts } from './aiProxy.mjs';

export const CODE_PRESETS = [
  {
    id: 'pro_99',
    payYuan: 99,
    label: '¥99 买断卡密（含 ¥10 余额）',
    shortTitle: 'Lirio 永久买断版',
    badge: '最推荐 · 永久买断',
    subtitle: '四端软件永久使用 + 本地免费语音与切分 + 赠 ¥10 对话余额',
    amountUnits: 100000, // ¥10.00
    upgradeToPro: true,
    note: '¥99 买断激活 + ¥10 初始对话余额',
  },
  {
    id: 'topup_10',
    payYuan: 10,
    label: '¥10 余额充值码',
    shortTitle: '¥10 对话充值码',
    badge: '轻度按量',
    subtitle: '约 80–270 场雅思模考 · 余额永不过期',
    amountUnits: 100000, // ¥10.00
    upgradeToPro: false,
    note: '余额充值 ¥10.00',
  },
  {
    id: 'topup_30',
    payYuan: 30,
    label: '¥30 余额充值码（赠 ¥5）',
    shortTitle: '¥30 冲刺充值码',
    badge: '超值赠 ¥5',
    subtitle: '实付 ¥30 到账 ¥35 · 重度备考首选',
    amountUnits: 350000, // ¥35.00
    upgradeToPro: false,
    note: '充值 ¥30.00 + 赠送 ¥5.00',
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
  <p>请输入管理员口令（LIRIO_ADMIN_TOKEN）以查看余额流水与生成卡密。</p>
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
      label: '¥99 买断卡密（含 ¥10 余额）',
      amountUnits: 100000,
      upgradeToPro: true,
      note: '演示 ¥99 买断卡密',
      exactCodes: ['LIRIO-DEMO-9900-PRO1'],
    });
    createRedeemCodes(db, {
      planId: 'topup_30',
      label: '¥30 余额充值码（赠 ¥5）',
      amountUnits: 350000,
      upgradeToPro: false,
      note: '演示 ¥30 充值卡密（含 ¥35 额度）',
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

function sendJson(res, status, data, headOnly = false) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  });
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
  const users = listAllUsers(db);
  const ledger = listRecentLedger(db, 50);
  const codes = listRedeemCodes(db, 100);
  const orders = listOrders(db, 100);
  const storeSettings = getStoreSettings(db);

  const paidOrders = orders.filter((o) => o.status === 'paid');
  const pendingOrders = orders.filter((o) => o.status === 'pending');
  const stats = {
    totalUsers: users.length,
    proUsers: users.filter((u) => u.tier === 'pro').length,
    totalBalanceUnits: users.reduce((sum, u) => sum + Number(u.balanceUnits || 0), 0),
    totalSpentUnits: users.reduce((sum, u) => sum + Number(u.totalSpentUnits || 0), 0),
    totalOrders: orders.length,
    paidOrders: paidOrders.length,
    pendingOrders: pendingOrders.length,
    totalRevenueYuan: paidOrders.reduce((sum, o) => sum + Number(o.payYuan || 0), 0),
    unusedCodes: codes.filter((c) => !c.redeemedAt).length,
    usedCodes: codes.filter((c) => Boolean(c.redeemedAt)).length,
  };

  return {
    ok: true,
    service: 'lirio-pro-server',
    isPeak,
    period: getDeepSeekPeriodLabel(),
    rates: {
      deepseek: getDeepSeekRatesPer1M(),
      ttsPer1kCharsYuan: 0.03,
    },
    stats,
    users,
    ledger,
    codes,
    orders,
    storeSettings,
    codePresets: CODE_PRESETS,
  };
}

function renderDashboardHtml(overview, { adminAuthEnabled = false } = {}) {
  const periodBadge = overview.isPeak ? '高峰价（工作日 09-12 / 14-18）' : '空闲价';
  const initialJson = JSON.stringify(overview).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Lirio Pro 运营管理台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #FBF9F5; color: #1D1B18; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 26px 20px 52px; display: flex; flex-direction: column; gap: 16px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; font-weight: 700; }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #E9F2EC; color: #3D6B52; font-weight: 600; }
  .pill.peak { background: #F8EFE3; color: #9A5B13; }
  .btn { border: 1px solid #E4DFD4; background: #FFFDF9; color: #1D1B18; border-radius: 999px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-family: inherit; }
  .btn:hover { border-color: #3D6B52; color: #3D6B52; }
  .btn.primary { background: #3D6B52; border-color: #3D6B52; color: #fff; font-weight: 600; }
  .btn.primary:hover { background: #315843; color: #fff; }
  .btn.danger { color: #B85C38; }
  .btn.danger:hover { border-color: #B85C38; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .kpi { background: #FFFDF9; border: 1px solid #EAE5DB; border-radius: 16px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
  .kpi.alert { border-color: #D9A05B; background: #FFF9F0; cursor: pointer; }
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
  .strong { font-weight: 600; }
  .sub { font-size: 11.5px; color: #7C766D; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #E9F2EC; color: #3D6B52; font-weight: 600; display: inline-block; white-space: nowrap; }
  .tag.pending { background: #F8EFE3; color: #9A5B13; }
  .tag.used, .tag.cancelled { background: #F0ECE3; color: #7C766D; }
  .plus { color: #3D6B52; font-weight: 600; }
  .minus { color: #B85C38; font-weight: 600; }
  .empty { text-align: center; color: #8D867C; padding: 20px; }
  .code-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; letter-spacing: 0.03em; }
  .copy-btn { border: 1px solid #E4DFD4; background: transparent; color: #5F5A52; border-radius: 999px; padding: 3px 9px; font-size: 11px; cursor: pointer; font-family: inherit; }
  .copy-btn:hover { border-color: #3D6B52; color: #3D6B52; }
  .status-msg { font-size: 12px; color: #3D6B52; font-weight: 500; }
  .rates { background: #FFFDF9; border: 1px solid #EAE5DB; border-radius: 14px; padding: 12px 16px; font-size: 12.5px; color: #5F5A52; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .qr-card { border: 1px solid #EAE5DB; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #FBF9F5; }
  .qr-preview { width: 148px; height: 148px; border-radius: 10px; border: 1px dashed #D9D2C5; background: #fff; display: grid; place-items: center; overflow: hidden; font-size: 12px; color: #8D867C; }
  .qr-preview img { width: 100%; height: 100%; object-fit: contain; }
  .field-col { display: flex; flex-direction: column; gap: 5px; }
  .field-col label { font-size: 12px; font-weight: 600; color: #4A453E; }
  @media (max-width: 820px) {
    .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .settings-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title-row">
      <h1>Lirio Pro 运营管理台</h1>
      <span class="pill">运行中</span>
      <span id="periodPill" class="pill${overview.isPeak ? ' peak' : ''}">${escapeHtml(periodBadge)}</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      ${adminAuthEnabled ? '<button class="btn" id="adminLogoutBtn" type="button">退出管理</button>' : '<span class="pill peak">未设管理口令（仅限本机）</span>'}
      <a class="btn" href="/site/" target="_blank" rel="noopener noreferrer">官网与购卡页 ↗</a>
      <button class="btn" id="refreshBtn" type="button">刷新</button>
    </div>
  </div>

  <div class="kpi-grid" id="kpiGrid">
    <div class="kpi"><span class="kpi-label">累计已收款</span><span class="kpi-val" id="kpiRev">¥${overview.stats.totalRevenueYuan.toFixed(2)}</span><span class="kpi-sub" id="kpiPaidSub">${overview.stats.paidOrders} 笔已发卡</span></div>
    <div class="kpi${overview.stats.pendingOrders > 0 ? ' alert' : ''}" id="kpiPendingCard"><span class="kpi-label">待核单付款</span><span class="kpi-val" id="kpiPending">${overview.stats.pendingOrders}</span><span class="kpi-sub">点击前往审核发卡</span></div>
    <div class="kpi"><span class="kpi-label">注册用户 / PRO</span><span class="kpi-val" id="kpiUsers">${overview.stats.totalUsers} / ${overview.stats.proUsers}</span><span class="kpi-sub" id="kpiBalSub">总余额 ${escapeHtml(formatYuan(overview.stats.totalBalanceUnits, 2))}</span></div>
    <div class="kpi"><span class="kpi-label">卡密库存（可用/已用）</span><span class="kpi-val" id="kpiCodes">${overview.stats.unusedCodes} / ${overview.stats.usedCodes}</span><span class="kpi-sub">支持单码与批量导出</span></div>
  </div>

  <div class="tabs" id="adminTabs">
    <button type="button" class="tab-btn active" data-tab="orders">购卡订单 <span class="tab-badge" id="pendingTabBadge">${overview.stats.pendingOrders}</span></button>
    <button type="button" class="tab-btn" data-tab="codes">卡密发码中心</button>
    <button type="button" class="tab-btn" data-tab="settings">收款与店铺配置</button>
    <button type="button" class="tab-btn" data-tab="users">用户与流水</button>
  </div>

  <section class="panel active" id="panel-orders">
    <div class="card">
      <div class="toolbar-row">
        <div class="filter-group" id="orderFilterChips">
          <button type="button" class="chip active" data-order-status="all">全部</button>
          <button type="button" class="chip" data-order-status="pending">待确认</button>
          <button type="button" class="chip" data-order-status="paid">已发卡</button>
          <button type="button" class="chip" data-order-status="cancelled">已取消</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span id="orderMsg" class="status-msg"></span>
          <input id="orderSearch" class="search-input" type="search" placeholder="搜索订单号 / 邮箱 / 卡密" />
        </div>
      </div>
      <table>
        <thead><tr><th>时间 / 订单号</th><th>买家邮箱</th><th>套餐 / 渠道</th><th class="num">实付</th><th>状态 / 发放卡密</th><th class="num">操作</th></tr></thead>
        <tbody id="ordersBody"></tbody>
      </table>
    </div>
  </section>

  <section class="panel" id="panel-codes">
    <div class="card">
      <div class="toolbar-row">
        <div class="filter-group">
          <select id="codePreset">
            <option value="pro_99">¥99 买断卡密（含 ¥10 余额）</option>
            <option value="topup_10">¥10 余额充值码</option>
            <option value="topup_30">¥30 余额充值码（赠 ¥5）</option>
          </select>
          <label class="sub">数量 <input id="codeCount" type="number" min="1" max="100" value="5" style="width:68px;text-align:center;" /></label>
          <button class="btn primary" id="genCodeBtn" type="button">生成卡密</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span id="codeMsg" class="status-msg"></span>
          <a class="btn" href="/api/admin/codes/export" download="lirio-unused-codes.txt">导出未兑换 TXT</a>
          <button class="btn" id="copyUnusedBtn" type="button">复制全部未兑换</button>
        </div>
      </div>
      <div class="toolbar-row" style="margin-bottom:8px;">
        <div class="filter-group" id="codeFilterChips">
          <button type="button" class="chip active" data-code-status="all">全部</button>
          <button type="button" class="chip" data-code-status="unused">可用</button>
          <button type="button" class="chip" data-code-status="used">已兑换</button>
        </div>
        <input id="codeSearch" class="search-input" type="search" placeholder="搜索卡密或核销邮箱" />
      </div>
      <table>
        <thead><tr><th>卡密</th><th>类型 / 备注</th><th class="num">面额</th><th>状态</th><th class="num">操作</th></tr></thead>
        <tbody id="codesBody"></tbody>
      </table>
    </div>
  </section>

  <section class="panel" id="panel-settings">
    <div class="card">
      <div class="toolbar-row">
        <h2 style="margin:0;">收款码与第三方店铺配置（保存后官网 /site/ 与 App 买码同步生效）</h2>
        <div style="display:flex;gap:8px;align-items:center;">
          <span id="settingsMsg" class="status-msg"></span>
          <button type="button" class="btn primary" id="saveSettingsBtn">保存配置</button>
        </div>
      </div>
      <div class="settings-grid">
        <div class="qr-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>微信收款码</strong>
            <button type="button" class="copy-btn" id="clearWechatQr">清除</button>
          </div>
          <div class="qr-preview" id="wechatQrPreview">未上传</div>
          <input type="file" id="wechatQrFile" accept="image/*" />
          <input type="text" id="wechatQrInput" placeholder="或直接填写收款码图片链接 / Data URL" />
        </div>
        <div class="qr-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>支付宝收款码</strong>
            <button type="button" class="copy-btn" id="clearAlipayQr">清除</button>
          </div>
          <div class="qr-preview" id="alipayQrPreview">未上传</div>
          <input type="file" id="alipayQrFile" accept="image/*" />
          <input type="text" id="alipayQrInput" placeholder="或直接填写收款码图片链接 / Data URL" />
        </div>
      </div>
      <div class="settings-grid" style="margin-top:14px;">
        <div class="field-col">
          <label>¥99 买断卡密第三方店铺链接（可选：面包多/爱发电/发卡网）</label>
          <input type="url" id="shopUrlPro99" placeholder="留空则默认走官网扫码下单" />
        </div>
        <div class="field-col">
          <label>¥10 充值卡密第三方店铺链接（可选）</label>
          <input type="url" id="shopUrlTopup10" placeholder="留空则默认走官网扫码下单" />
        </div>
        <div class="field-col">
          <label>¥30 充值卡密第三方店铺链接（可选）</label>
          <input type="url" id="shopUrlTopup30" placeholder="留空则默认走官网扫码下单" />
        </div>
        <div class="field-col">
          <label>售后联系方式（展示在官网查询区与支付页）</label>
          <input type="text" id="supportContactInput" placeholder="例如 售后微信 / 邮箱：support@lirio.app" />
        </div>
      </div>
      <div class="field-col" style="margin-top:12px;">
        <label>付款提示语</label>
        <input type="text" id="paymentNoticeInput" />
      </div>
    </div>
  </section>

  <section class="panel" id="panel-users">
    <div class="rates">
      <span>文本：输入 ¥3~6 / 缓存 ¥0.06~0.12 / 输出 ¥12~24（每百万 tok）</span>
      <span>本地语音与音频自动切分：¥0（0 Token）</span>
      <span>可选云端语音：¥0.03 / 千字</span>
    </div>
    <div class="card">
      <div class="toolbar-row">
        <h2 style="margin:0;">账号与余额</h2>
        <input id="userSearch" class="search-input" type="search" placeholder="搜索昵称或邮箱" />
      </div>
      <table>
        <thead><tr><th>账号</th><th>身份</th><th class="num">当前余额</th><th class="num">累计充值</th><th class="num">累计消费</th></tr></thead>
        <tbody id="usersBody"></tbody>
      </table>
    </div>
    <div class="card">
      <h2>最近计费流水</h2>
      <table>
        <thead><tr><th>时间</th><th>账号</th><th>项目</th><th>明细</th><th class="num">金额</th><th class="num">余额</th></tr></thead>
        <tbody id="ledgerBody"></tbody>
      </table>
    </div>
  </section>
</div>
<script>
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const yuan = (u, d = 2) => '¥' + ((Number(u) || 0) / 10000).toFixed(d);
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
let state = ${initialJson};
let orderFilter = 'all';
let codeFilter = 'all';
let settingsDirty = false;

function switchTab(name) {
  document.querySelectorAll('#adminTabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}
document.getElementById('adminTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});
document.getElementById('kpiPendingCard').addEventListener('click', () => {
  orderFilter = 'pending';
  document.querySelectorAll('#orderFilterChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.orderStatus === 'pending'));
  renderOrders();
  switchTab('orders');
});

function renderKpis() {
  const st = state.stats || {};
  document.getElementById('kpiRev').textContent = '¥' + Number(st.totalRevenueYuan || 0).toFixed(2);
  document.getElementById('kpiPaidSub').textContent = (st.paidOrders || 0) + ' 笔已发卡';
  document.getElementById('kpiPending').textContent = String(st.pendingOrders || 0);
  document.getElementById('pendingTabBadge').textContent = String(st.pendingOrders || 0);
  document.getElementById('kpiPendingCard').className = 'kpi' + ((st.pendingOrders || 0) > 0 ? ' alert' : '');
  document.getElementById('kpiUsers').textContent = (st.totalUsers || 0) + ' / ' + (st.proUsers || 0);
  document.getElementById('kpiBalSub').textContent = '总余额 ' + yuan(st.totalBalanceUnits || 0, 2);
  document.getElementById('kpiCodes').textContent = (st.unusedCodes || 0) + ' / ' + (st.usedCodes || 0);
}

function renderOrders() {
  const q = (document.getElementById('orderSearch').value || '').trim().toLowerCase();
  const list = (state.orders || []).filter((o) => {
    if (orderFilter !== 'all' && o.status !== orderFilter) return false;
    if (!q) return true;
    return [o.orderNo, o.buyerEmail, o.issuedCode, o.label].some((v) => String(v || '').toLowerCase().includes(q));
  });
  document.getElementById('ordersBody').innerHTML = list.length ? list.map((o) => {
    const ch = o.payChannel === 'alipay' ? '支付宝' : '微信支付';
    let stHtml = '<span class="tag pending">待确认收款</span>';
    let actHtml = '<button class="btn primary" type="button" data-confirm-order="' + esc(o.orderNo) + '">确认收款并发卡</button> <button class="btn danger" type="button" data-cancel-order="' + esc(o.orderNo) + '">取消</button>';
    if (o.status === 'paid') {
      stHtml = '<span class="tag">已发卡</span> <span class="code-mono" style="margin-left:6px;">' + esc(o.issuedCode || '') + '</span>';
      actHtml = '<button class="copy-btn" type="button" data-copy="' + esc(o.issuedCode || '') + '">复制卡密</button>';
    } else if (o.status === 'cancelled') {
      stHtml = '<span class="tag cancelled">已取消</span>';
      actHtml = '<span class="sub">-</span>';
    }
    return '<tr><td><strong class="code-mono">' + esc(o.orderNo) + '</strong><div class="sub">' + esc(fmtTime(o.createdAt)) + '</div></td>' +
      '<td>' + esc(o.buyerEmail) + '</td>' +
      '<td>' + esc(o.label) + '<div class="sub">' + ch + '</div></td>' +
      '<td class="num strong">¥' + Number(o.payYuan || 0).toFixed(2) + '</td>' +
      '<td>' + stHtml + '</td>' +
      '<td class="num">' + actHtml + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="empty">暂无符合条件的订单</td></tr>';
}

function renderCodes() {
  const q = (document.getElementById('codeSearch').value || '').trim().toLowerCase();
  const list = (state.codes || []).filter((c) => {
    if (codeFilter === 'unused' && c.redeemedAt) return false;
    if (codeFilter === 'used' && !c.redeemedAt) return false;
    if (!q) return true;
    return [c.code, c.redeemedByEmail, c.label, c.note].some((v) => String(v || '').toLowerCase().includes(q));
  });
  document.getElementById('codesBody').innerHTML = list.length ? list.map((c) => {
    const status = c.redeemedAt
      ? '<span class="tag used">已用 (' + esc(c.redeemedByEmail || '-') + ')</span>'
      : '<span class="tag">可用</span>';
    return '<tr><td class="code-mono">' + esc(c.code) + '</td><td>' + esc(c.label) + (c.note ? '<div class="sub">' + esc(c.note) + '</div>' : '') + '</td>' +
      '<td class="num strong">' + yuan(c.amountUnits, 2) + '</td><td>' + status + '</td>' +
      '<td class="num"><button class="copy-btn" type="button" data-copy="' + esc(c.code) + '">复制</button></td></tr>';
  }).join('') : '<tr><td colspan="5" class="empty">暂无符合条件的卡密</td></tr>';
}

function renderUsersAndLedger() {
  const q = (document.getElementById('userSearch').value || '').trim().toLowerCase();
  const users = (state.users || []).filter((u) => !q || String(u.name || '').toLowerCase().includes(q) || String(u.email || '').toLowerCase().includes(q));
  document.getElementById('usersBody').innerHTML = users.length ? users.map((u) =>
    '<tr><td><strong>' + esc(u.name) + '</strong><div class="sub">' + esc(u.email) + '</div></td>' +
    '<td><span class="tag">' + (u.tier === 'pro' ? 'PRO' : 'TRIAL') + '</span></td>' +
    '<td class="num strong">' + yuan(u.balanceUnits, 4) + '</td>' +
    '<td class="num">' + yuan(u.totalRechargedUnits, 2) + '</td>' +
    '<td class="num">' + yuan(u.totalSpentUnits, 4) + '</td></tr>'
  ).join('') : '<tr><td colspan="5" class="empty">暂无账号</td></tr>';
  document.getElementById('ledgerBody').innerHTML = (state.ledger || []).length ? state.ledger.map((r) => {
    const plus = r.amountUnits >= 0;
    return '<tr><td class="sub">' + esc(fmtTime(r.createdAt)) + '</td><td class="sub">' + esc(r.userEmail || r.userName || '-') + '</td>' +
      '<td>' + esc(r.feature) + '</td><td class="sub">' + esc(r.note || r.model || '-') + '</td>' +
      '<td class="num ' + (plus ? 'plus' : 'minus') + '">' + (plus ? '+' : '-') + yuan(Math.abs(r.amountUnits), plus ? 2 : 4) + '</td>' +
      '<td class="num">' + yuan(r.balanceAfterUnits, 4) + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="empty">暂无计费流水</td></tr>';
}

function syncQrPreview(previewId, val) {
  const el = document.getElementById(previewId);
  el.innerHTML = val ? '<img src="' + esc(val) + '" alt="收款码" />' : '未上传';
}

function hydrateSettingsForm() {
  if (settingsDirty) return;
  const s = state.storeSettings || {};
  document.getElementById('wechatQrInput').value = s.wechatQr || '';
  document.getElementById('alipayQrInput').value = s.alipayQr || '';
  document.getElementById('shopUrlPro99').value = s.shopUrlPro99 || '';
  document.getElementById('shopUrlTopup10').value = s.shopUrlTopup10 || '';
  document.getElementById('shopUrlTopup30').value = s.shopUrlTopup30 || '';
  document.getElementById('supportContactInput').value = s.supportContact || '';
  document.getElementById('paymentNoticeInput').value = s.paymentNotice || '';
  syncQrPreview('wechatQrPreview', s.wechatQr || '');
  syncQrPreview('alipayQrPreview', s.alipayQr || '');
}

function renderAll() {
  const pp = document.getElementById('periodPill');
  pp.textContent = state.isPeak ? '高峰价（工作日 09-12 / 14-18）' : '空闲价';
  pp.className = 'pill' + (state.isPeak ? ' peak' : '');
  renderKpis();
  renderOrders();
  renderCodes();
  renderUsersAndLedger();
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

document.getElementById('wechatQrFile').addEventListener('change', (e) => compressQrFile(e.target.files[0], 'wechatQrInput', 'wechatQrPreview'));
document.getElementById('alipayQrFile').addEventListener('change', (e) => compressQrFile(e.target.files[0], 'alipayQrInput', 'alipayQrPreview'));
document.getElementById('wechatQrInput').addEventListener('input', (e) => { settingsDirty = true; syncQrPreview('wechatQrPreview', e.target.value.trim()); });
document.getElementById('alipayQrInput').addEventListener('input', (e) => { settingsDirty = true; syncQrPreview('alipayQrPreview', e.target.value.trim()); });
document.getElementById('clearWechatQr').addEventListener('click', () => { settingsDirty = true; document.getElementById('wechatQrInput').value = ''; syncQrPreview('wechatQrPreview', ''); });
document.getElementById('clearAlipayQr').addEventListener('click', () => { settingsDirty = true; document.getElementById('alipayQrInput').value = ''; syncQrPreview('alipayQrPreview', ''); });
['shopUrlPro99', 'shopUrlTopup10', 'shopUrlTopup30', 'supportContactInput', 'paymentNoticeInput'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => { settingsDirty = true; });
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const msg = document.getElementById('settingsMsg');
  msg.textContent = '保存中…';
  const payload = {
    wechatQr: document.getElementById('wechatQrInput').value.trim(),
    alipayQr: document.getElementById('alipayQrInput').value.trim(),
    shopUrlPro99: document.getElementById('shopUrlPro99').value.trim(),
    shopUrlTopup10: document.getElementById('shopUrlTopup10').value.trim(),
    shopUrlTopup30: document.getElementById('shopUrlTopup30').value.trim(),
    supportContact: document.getElementById('supportContactInput').value.trim(),
    paymentNotice: document.getElementById('paymentNoticeInput').value.trim(),
  };
  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    settingsDirty = false;
    msg.textContent = '已保存并同步到官网 /site/';
    await reloadOverview();
  } else {
    msg.textContent = data.error || '保存失败';
  }
});

document.getElementById('orderFilterChips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-order-status]');
  if (!c) return;
  orderFilter = c.dataset.orderStatus;
  document.querySelectorAll('#orderFilterChips .chip').forEach((el) => el.classList.toggle('active', el === c));
  renderOrders();
});
document.getElementById('orderSearch').addEventListener('input', renderOrders);
document.getElementById('codeFilterChips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-code-status]');
  if (!c) return;
  codeFilter = c.dataset.codeStatus;
  document.querySelectorAll('#codeFilterChips .chip').forEach((el) => el.classList.toggle('active', el === c));
  renderCodes();
});
document.getElementById('codeSearch').addEventListener('input', renderCodes);
document.getElementById('userSearch').addEventListener('input', renderUsersAndLedger);

document.getElementById('ordersBody').addEventListener('click', async (e) => {
  const confirmBtn = e.target.closest('[data-confirm-order]');
  const cancelBtn = e.target.closest('[data-cancel-order]');
  const copyBtn = e.target.closest('[data-copy]');
  const msg = document.getElementById('orderMsg');
  if (confirmBtn) {
    const no = confirmBtn.dataset.confirmOrder;
    msg.textContent = '正在核单并生成卡密…';
    const res = await fetch('/api/orders/' + encodeURIComponent(no) + '/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    msg.textContent = res.ok ? ('订单 ' + no + ' 已发卡：' + (data.order?.issuedCode || '')) : (data.error || '发卡失败');
    await reloadOverview();
  } else if (cancelBtn) {
    const no = cancelBtn.dataset.cancelOrder;
    const res = await fetch('/api/orders/' + encodeURIComponent(no) + '/cancel', { method: 'POST' });
    msg.textContent = res.ok ? ('已取消订单 ' + no) : '取消失败';
    await reloadOverview();
  } else if (copyBtn) {
    await navigator.clipboard.writeText(copyBtn.dataset.copy);
    msg.textContent = '已复制 ' + copyBtn.dataset.copy;
  }
});

document.getElementById('genCodeBtn').addEventListener('click', async () => {
  const presetId = document.getElementById('codePreset').value;
  const count = Number(document.getElementById('codeCount').value) || 5;
  const msg = document.getElementById('codeMsg');
  msg.textContent = '生成中…';
  const res = await fetch('/api/admin/codes/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetId, count }),
  });
  const data = await res.json().catch(() => ({}));
  msg.textContent = res.ok ? ('已生成 ' + (data.codes?.length || 0) + ' 个卡密') : (data.error || '生成失败');
  await reloadOverview();
});

document.getElementById('copyUnusedBtn').addEventListener('click', async () => {
  const unused = (state.codes || []).filter((c) => !c.redeemedAt).map((c) => c.code);
  const msg = document.getElementById('codeMsg');
  if (!unused.length) { msg.textContent = '暂无未兑换卡密'; return; }
  await navigator.clipboard.writeText(unused.join('\\n'));
  msg.textContent = '已复制 ' + unused.length + ' 个未兑换卡密';
});

document.getElementById('codesBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  await navigator.clipboard.writeText(btn.dataset.copy);
  document.getElementById('codeMsg').textContent = '已复制 ' + btn.dataset.copy;
});

document.getElementById('refreshBtn').addEventListener('click', reloadOverview);
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
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
          res.writeHead(302, { Location: '/site/' });
          res.end();
          return;
        }
        const rel = pathname.slice('/site/'.length) || 'index.html';
        const resolved = path.resolve(WEBSITE_DIR, rel);
        if (resolved !== WEBSITE_DIR && !resolved.startsWith(WEBSITE_DIR + path.sep)) {
          sendJson(res, 404, { error: '页面不存在。' }, headOnly);
          return;
        }
        const target = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
          ? resolved
          : rel === ''
            ? path.join(WEBSITE_DIR, 'index.html')
            : null;
        if (!target || !fs.existsSync(target)) {
          sendJson(res, 404, { error: '页面不存在。' }, headOnly);
          return;
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
                    : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        if (headOnly) {
          res.end();
        } else {
          fs.createReadStream(target).pipe(res);
        }
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
        const user = authenticateRequest(req, db);
        if (!user) {
          sendJson(res, 401, { error: '请先登录再兑换卡密。' });
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
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
          sendJson(res, 400, { error: '请输入有效的邮箱地址（用于查询与接收卡密）。' });
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
        const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          sendJson(res, 400, { error: '请输入下单时填写的有效邮箱地址。' }, headOnly);
          return;
        }
        const orderNo = String(url.searchParams.get('orderNo') || '').trim().toUpperCase();
        const orders = lookupOrdersByEmail(db, email, { orderNo, limit: 15 });
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
        const orderNo = decodeURIComponent(getOrderMatch[1]);
        const order = getOrderByNo(db, orderNo);
        if (!order) {
          sendJson(res, 404, { error: '订单不存在。' }, headOnly);
          return;
        }
        const qEmail = String(url.searchParams.get('email') || '').trim().toLowerCase();
        const explicitAdmin = Boolean(getAdminToken() && isAdminAuthorized(req));
        if (!explicitAdmin && qEmail !== order.buyerEmail) {
          sendJson(res, 403, { error: '下单邮箱不匹配，无权查看该订单。' }, headOnly);
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
    console.log(`[lirio-pro-server] (${check.mode}) listening on http://${host}:${port}`);
  });
}
