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
  createRedeemCodes,
  createUserWithTrial,
  creditUserBalance,
  deductUserBalance,
  getUserByEmail,
  getUserById,
  listAllUsers,
  listRecentLedger,
  listRedeemCodes,
  listUserLedger,
  openDatabase,
  redeemCodeForUser,
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
    label: '¥99 买断卡密（含 ¥10 余额）',
    amountUnits: 100000, // ¥10.00
    upgradeToPro: true,
    note: '¥99 买断激活 + ¥10 初始对话余额',
  },
  {
    id: 'topup_10',
    label: '¥10 余额充值码',
    amountUnits: 100000, // ¥10.00
    upgradeToPro: false,
    note: '余额充值 ¥10.00',
  },
  {
    id: 'topup_30',
    label: '¥30 余额充值码（赠 ¥5）',
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
  return {
    ok: true,
    service: 'lirio-pro-server',
    isPeak,
    period: getDeepSeekPeriodLabel(),
    rates: {
      deepseek: getDeepSeekRatesPer1M(),
      ttsPer1kCharsYuan: 0.03,
    },
    users: listAllUsers(db),
    ledger: listRecentLedger(db, 40),
    codes: listRedeemCodes(db, 60),
    codePresets: CODE_PRESETS,
  };
}

function renderDashboardHtml(overview, { adminAuthEnabled = false } = {}) {
  const periodBadge = overview.isPeak ? '高峰价（工作日 09-12 / 14-18）' : '空闲价';
  const userRows = overview.users.length
    ? overview.users
        .map(
          (u) => `<tr>
            <td><strong>${escapeHtml(u.name)}</strong><div class="sub">${escapeHtml(u.email)}</div></td>
            <td><span class="tag">${u.tier === 'pro' ? 'PRO' : 'TRIAL'}</span></td>
            <td class="num strong">${escapeHtml(formatYuan(u.balanceUnits, 4))}</td>
            <td class="num">${escapeHtml(formatYuan(u.totalRechargedUnits, 2))}</td>
            <td class="num">${escapeHtml(formatYuan(u.totalSpentUnits, 4))}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty">暂无账号</td></tr>';

  const ledgerRows = overview.ledger.length
    ? overview.ledger
        .map((r) => {
          const isPlus = r.amountUnits >= 0;
          const time = new Date(r.createdAt).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          return `<tr>
            <td class="sub">${escapeHtml(time)}</td>
            <td class="sub">${escapeHtml(r.userEmail || r.userName || '-')}</td>
            <td>${escapeHtml(r.feature)}</td>
            <td class="sub">${escapeHtml(r.note || r.model || '-')}</td>
            <td class="num ${isPlus ? 'plus' : 'minus'}">${isPlus ? '+' : '-'}${escapeHtml(formatYuan(Math.abs(r.amountUnits), isPlus ? 2 : 4))}</td>
            <td class="num">${escapeHtml(formatYuan(r.balanceAfterUnits, 4))}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="empty">暂无计费流水</td></tr>';

  const codeRows = (overview.codes || []).length
    ? overview.codes
        .map((c) => {
          const status = c.redeemedAt
            ? `<span class="tag used">已用 (${escapeHtml(c.redeemedByEmail || '-')})</span>`
            : '<span class="tag">可用</span>';
          return `<tr>
            <td class="code-mono">${escapeHtml(c.code)}</td>
            <td>${escapeHtml(c.label)}</td>
            <td class="num strong">${escapeHtml(formatYuan(c.amountUnits, 2))}</td>
            <td>${status}</td>
            <td class="num"><button class="copy-btn" type="button" data-copy="${escapeHtml(c.code)}">复制</button></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">暂无卡密</td></tr>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Lirio Pro 计费服务</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #FBF9F5; color: #1D1B18; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 28px 20px 44px; display: flex; flex-direction: column; gap: 16px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #E9F2EC; color: #3D6B52; font-weight: 500; }
  .pill.peak { background: #F8EFE3; color: #9A5B13; }
  .btn { border: 1px solid #E4DFD4; background: #FFFDF9; color: #1D1B18; border-radius: 999px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
  .btn:hover { border-color: #3D6B52; color: #3D6B52; }
  .rates { background: #FFFDF9; border: 1px solid #EAE5DB; border-radius: 14px; padding: 12px 16px; font-size: 12.5px; color: #5F5A52; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .card { background: #FFFDF9; border: 1px solid #EAE5DB; border-radius: 16px; padding: 14px 16px; overflow-x: auto; }
  .card h2 { margin: 0 0 10px; font-size: 13px; color: #5F5A52; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px 8px; border-bottom: 1px solid #F0ECE3; vertical-align: middle; }
  th { font-size: 11.5px; color: #7C766D; font-weight: 500; }
  tr:last-child td { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .strong { font-weight: 600; }
  .sub { font-size: 11.5px; color: #7C766D; }
  .tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: #E9F2EC; color: #3D6B52; font-weight: 600; }
  .plus { color: #3D6B52; font-weight: 600; }
  .minus { color: #B85C38; font-weight: 600; }
  .empty { text-align: center; color: #8D867C; padding: 18px; }
  .code-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
  .code-bar select, .code-bar input { border: 1px solid #E4DFD4; background: #FFFDF9; color: #1D1B18; border-radius: 999px; padding: 6px 12px; font-size: 12.5px; font-family: inherit; }
  .code-bar input[type="number"] { width: 70px; text-align: center; }
  .btn.primary { background: #3D6B52; border-color: #3D6B52; color: #fff; }
  .btn.primary:hover { background: #315843; color: #fff; }
  .code-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; letter-spacing: 0.03em; }
  .tag.used { background: #F0ECE3; color: #7C766D; }
  .copy-btn { border: 1px solid #E4DFD4; background: transparent; color: #5F5A52; border-radius: 999px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .copy-btn:hover { border-color: #3D6B52; color: #3D6B52; }
  .code-msg { font-size: 12px; color: #3D6B52; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title-row">
      <h1>Lirio Pro 计费服务</h1>
      <span class="pill">运行中</span>
      <span id="periodPill" class="pill${overview.isPeak ? ' peak' : ''}">${escapeHtml(periodBadge)}</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      ${adminAuthEnabled ? '<button class="btn" id="adminLogoutBtn" type="button">退出管理</button>' : '<span class="pill peak">未设管理口令（仅限本机）</span>'}
      <a class="btn" href="/site" style="text-decoration:none;">官网下载页</a>
      <button class="btn" id="refreshBtn" type="button">刷新</button>
    </div>
  </div>

  <div class="rates">
    <span>文本：输入 ¥3~6 / 缓存 ¥0.06~0.12 / 输出 ¥12~24（每百万 tok）</span>
    <span>本地语音与音频自动切分：¥0（0 Token）</span>
    <span>可选云端语音：¥0.03 / 千字</span>
  </div>

  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
      <h2 style="margin:0;">卡密发码中心</h2>
      <div style="display:flex;gap:8px;align-items:center;">
        <span id="codeMsg" class="code-msg"></span>
        <button class="btn" id="copyUnusedBtn" type="button">复制全部未兑换</button>
      </div>
    </div>
    <div class="code-bar">
      <select id="codePreset">
        <option value="pro_99">¥99 买断卡密（含 ¥10 余额）</option>
        <option value="topup_10">¥10 余额充值码</option>
        <option value="topup_30">¥30 余额充值码（赠 ¥5）</option>
      </select>
      <label class="sub">数量 <input id="codeCount" type="number" min="1" max="50" value="5" /></label>
      <button class="btn primary" id="genCodeBtn" type="button">生成卡密</button>
    </div>
    <table>
      <thead><tr><th>卡密</th><th>类型</th><th class="num">面额</th><th>状态</th><th class="num">操作</th></tr></thead>
      <tbody id="codesBody">${codeRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>账号与余额</h2>
    <table>
      <thead><tr><th>账号</th><th>身份</th><th class="num">当前余额</th><th class="num">累计充值</th><th class="num">累计消费</th></tr></thead>
      <tbody id="usersBody">${userRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>最近计费流水</h2>
    <table>
      <thead><tr><th>时间</th><th>账号</th><th>项目</th><th>明细</th><th class="num">金额</th><th class="num">余额</th></tr></thead>
      <tbody id="ledgerBody">${ledgerRows}</tbody>
    </table>
  </div>
</div>
<script>
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const yuan = (u, d = 2) => '¥' + ((Number(u) || 0) / 10000).toFixed(d);
let latestCodes = [];
function renderCodes(list) {
  latestCodes = list || [];
  document.getElementById('codesBody').innerHTML = latestCodes.length ? latestCodes.map((c) => {
    const status = c.redeemedAt
      ? '<span class="tag used">已用 (' + esc(c.redeemedByEmail || '-') + ')</span>'
      : '<span class="tag">可用</span>';
    return '<tr><td class="code-mono">' + esc(c.code) + '</td><td>' + esc(c.label) + '</td>' +
      '<td class="num strong">' + yuan(c.amountUnits, 2) + '</td><td>' + status + '</td>' +
      '<td class="num"><button class="copy-btn" type="button" data-copy="' + esc(c.code) + '">复制</button></td></tr>';
  }).join('') : '<tr><td colspan="5" class="empty">暂无卡密</td></tr>';
}
async function reloadOverview() {
  const res = await fetch('/api/overview');
  if (!res.ok) return;
  const data = await res.json();
  const pp = document.getElementById('periodPill');
  pp.textContent = data.isPeak ? '高峰价（工作日 09-12 / 14-18）' : '空闲价';
  pp.className = 'pill' + (data.isPeak ? ' peak' : '');
  document.getElementById('usersBody').innerHTML = data.users.length ? data.users.map((u) =>
    '<tr><td><strong>' + esc(u.name) + '</strong><div class="sub">' + esc(u.email) + '</div></td>' +
    '<td><span class="tag">' + (u.tier === 'pro' ? 'PRO' : 'TRIAL') + '</span></td>' +
    '<td class="num strong">' + yuan(u.balanceUnits, 4) + '</td>' +
    '<td class="num">' + yuan(u.totalRechargedUnits, 2) + '</td>' +
    '<td class="num">' + yuan(u.totalSpentUnits, 4) + '</td></tr>'
  ).join('') : '<tr><td colspan="5" class="empty">暂无账号</td></tr>';
  document.getElementById('ledgerBody').innerHTML = data.ledger.length ? data.ledger.map((r) => {
    const plus = r.amountUnits >= 0;
    const t = new Date(r.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return '<tr><td class="sub">' + esc(t) + '</td><td class="sub">' + esc(r.userEmail || r.userName || '-') + '</td>' +
      '<td>' + esc(r.feature) + '</td><td class="sub">' + esc(r.note || r.model || '-') + '</td>' +
      '<td class="num ' + (plus ? 'plus' : 'minus') + '">' + (plus ? '+' : '-') + yuan(Math.abs(r.amountUnits), plus ? 2 : 4) + '</td>' +
      '<td class="num">' + yuan(r.balanceAfterUnits, 4) + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="empty">暂无计费流水</td></tr>';
  renderCodes(data.codes || []);
}
document.getElementById('genCodeBtn').addEventListener('click', async () => {
  const presetId = document.getElementById('codePreset').value;
  const count = Number(document.getElementById('codeCount').value) || 5;
  const msg = document.getElementById('codeMsg');
  msg.textContent = '生成中...';
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
  const unused = (latestCodes.length ? latestCodes : Array.from(document.querySelectorAll('#codesBody tr')).filter((tr) => !tr.querySelector('.used')).map((tr) => ({ code: tr.querySelector('.code-mono')?.textContent })).filter((x) => x.code))
    .filter((c) => !c.redeemedAt)
    .map((c) => c.code);
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
