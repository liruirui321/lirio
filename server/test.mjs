import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLirioServer, seedDemoUser, validateProductionConfig } from './index.mjs';
import { creditUserBalance, deductUserBalance } from './db.mjs';
import { calculateChatCostUnits, calculateTtsCostUnits } from './pricing.mjs';

process.env.LIRIO_MOCK_AI = '1';
process.env.LIRIO_JWT_SECRET = 'lirio-test-jwt-secret-key-at-least-32-bytes-long-2026';

const { server, db } = createLirioServer({ dbPath: ':memory:' });

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function req(method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  return { status: res.status, json };
}

try {
  // 1. Register creates user + ¥5.00 (50000 units) welcome credit + 1 bonus ledger row
  const reg = await req('POST', '/api/auth/register', {
    email: 'learner@lirio.app',
    password: 'password123',
    name: 'Cherry',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.user.balanceUnits, 50000);
  assert.equal(reg.json.user.tier, 'pro_trial');
  assert.equal(reg.json.ledger.length, 1);
  assert.equal(reg.json.ledger[0].kind, 'bonus');
  const userId = reg.json.user.id;

  // 2. Duplicate email returns 409
  const dup = await req('POST', '/api/auth/register', {
    email: 'learner@lirio.app',
    password: 'password123',
  });
  assert.equal(dup.status, 409);

  // 3. Wrong password returns 401; valid login returns token + profile
  const badLogin = await req('POST', '/api/auth/login', {
    email: 'learner@lirio.app',
    password: 'wrong-password',
  });
  assert.equal(badLogin.status, 401);

  const login = await req('POST', '/api/auth/login', {
    email: 'learner@lirio.app',
    password: 'password123',
  });
  assert.equal(login.status, 200);
  const token = login.json.token;
  assert.ok(token);

  // 4. Recharge pack_30 credits 330000 units, upgrades tier to 'pro', writes 'recharge' ledger entry
  const rech = await req('POST', '/api/billing/recharge', { packageId: 'pack_30' }, token);
  assert.equal(rech.status, 200);
  assert.equal(rech.json.user.tier, 'pro');
  assert.equal(rech.json.user.balanceUnits, 380000);
  assert.equal(rech.json.entry.kind, 'recharge');
  assert.equal(rech.json.entry.amountUnits, 330000);

  // 5. Metered /api/ai/chat, /api/ai/tts, /api/ai/transcribe deduct balance accurately
  const chat = await req(
    'POST',
    '/api/ai/chat',
    {
      feature: '口语陪练',
      messages: [
        { role: 'system', content: 'You are a helpful friend.' },
        { role: 'user', content: 'Hello, how is your day?' },
      ],
    },
    token,
  );
  assert.equal(chat.status, 200);
  assert.ok(chat.json.content.length > 0);
  assert.ok(chat.json.costUnits >= 1);
  assert.equal(chat.json.balanceUnits, 380000 - chat.json.costUnits);

  const tts = await req(
    'POST',
    '/api/ai/tts',
    { text: 'Good morning, welcome to IELTS speaking part one.', accent: 'uk', feature: '云端朗读' },
    token,
  );
  assert.equal(tts.status, 200);
  assert.ok(tts.json.audioBase64.length > 5);
  assert.equal(tts.json.balanceUnits, chat.json.balanceUnits - tts.json.costUnits);

  const fakeWav = Buffer.alloc(1600, 1).toString('base64');
  const asr = await req(
    'POST',
    '/api/ai/transcribe',
    { wavBase64: fakeWav, durationSec: 5, feature: '云端识别' },
    token,
  );
  assert.equal(asr.status, 200);
  assert.ok(asr.json.text.length > 5);
  assert.equal(asr.json.balanceUnits, tts.json.balanceUnits - asr.json.costUnits);

  // Verify ledger contains all entries (bonus + recharge + 3 usages = 5)
  const ledgerRes = await req('GET', '/api/billing/ledger', null, token);
  assert.equal(ledgerRes.status, 200);
  assert.equal(ledgerRes.json.ledger.length, 5);

  // 6. When balance reaches 0, /api/ai/chat returns 402 Insufficient Balance
  const balNow = ledgerRes.json.user.balanceUnits;
  deductUserBalance(db, {
    userId,
    costUnits: balNow,
    feature: 'drain_test',
    note: 'drain to zero',
  });
  const emptyChat = await req(
    'POST',
    '/api/ai/chat',
    { messages: [{ role: 'user', content: 'Hi' }] },
    token,
  );
  assert.equal(emptyChat.status, 402);

  // Confirm creditUserBalance still works after zero balance
  const refilled = creditUserBalance(db, {
    userId,
    amountUnits: 10000,
    feature: '恢复测试',
  });
  assert.equal(refilled.user.balanceUnits, 10000);

  // 7. Verify DeepSeek peak/off-peak + cache-hit pricing & TTS rate & demo ¥100 user
  const peakDay = new Date('2026-11-25T02:30:00Z'); // 10:30 Beijing Wed (Peak)
  const offPeakDay = new Date('2026-11-25T16:30:00Z'); // 00:30 Beijing Thu (Off-peak)
  const peakCost = calculateChatCostUnits('deepseek-chat', 1_000_000, 1_000_000, {
    cacheHitTokens: 500_000,
    cacheMissTokens: 500_000,
    now: peakDay,
  });
  const offPeakCost = calculateChatCostUnits('deepseek-chat', 1_000_000, 1_000_000, {
    cacheHitTokens: 500_000,
    cacheMissTokens: 500_000,
    now: offPeakDay,
  });
  // Peak (3x): 0.5*1200 + 0.5*60000 + 240000 = 270600 units (¥27.06); Off-peak is exact half = 135300 units (¥13.53)
  assert.equal(peakCost, 270600);
  assert.equal(offPeakCost, 135300);
  // TTS: 1000 chars = ¥0.03 = 300 units
  assert.equal(calculateTtsCostUnits(1000), 300);

  const demo = seedDemoUser(db);
  assert.equal(demo.email, 'tester@lirio.app');
  assert.equal(demo.balanceUnits, 1_000_000);
  assert.equal(demo.tier, 'pro');

  // 8. Verify root dashboard (HTML + JSON negotiation) and /api/overview
  const dashHtml = await fetch(`${base}/`);
  assert.equal(dashHtml.status, 200);
  assert.ok((dashHtml.headers.get('content-type') || '').includes('text/html'));
  const htmlBody = await dashHtml.text();
  assert.ok(htmlBody.includes('Lirio Pro'));

  const dashJson = await fetch(`${base}/`, { headers: { Accept: 'application/json' } });
  assert.equal(dashJson.status, 200);
  const dashData = await dashJson.json();
  assert.equal(dashData.ok, true);

  const overviewRes = await req('GET', '/api/overview');
  assert.equal(overviewRes.status, 200);
  assert.ok(overviewRes.json.users.length >= 2);
  assert.ok(overviewRes.json.ledger.length >= 1);

  // 9. Verify auto-update feed endpoint (204 when empty/up-to-date, 200 when newer manifest exists)
  const noUpdate = await fetch(`${base}/api/updates/darwin/aarch64/0.5.2`);
  assert.equal(noUpdate.status, 204);

  const tmpRelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lirio-rel-'));
  process.env.LIRIO_RELEASES_DIR = tmpRelDir;
  try {
    fs.writeFileSync(
      path.join(tmpRelDir, 'latest.json'),
      JSON.stringify({
        version: '0.6.0',
        notes: 'Release notes',
        pub_date: '2026-11-26T00:00:00Z',
        platforms: {
          'darwin-aarch64': {
            url: `${base}/releases/Lirio-0.6.0-arm64.app.tar.gz`,
            signature: 'dummy-sig',
          },
        },
      }),
    );
    const hasUpdate = await fetch(`${base}/api/updates/darwin/aarch64/0.5.2`);
    assert.equal(hasUpdate.status, 200);
    const updJson = await hasUpdate.json();
    assert.equal(updJson.version, '0.6.0');
    assert.equal(updJson.signature, 'dummy-sig');

    const alreadyLatest = await fetch(`${base}/api/updates/darwin/aarch64/0.6.0`);
    assert.equal(alreadyLatest.status, 204);
  } finally {
    delete process.env.LIRIO_RELEASES_DIR;
    fs.rmSync(tmpRelDir, { recursive: true, force: true });
  }

  // 10. Verify 4-platform download website (/site/ and /site/versions.json)
  const siteHtml = await fetch(`${base}/site/`);
  assert.equal(siteHtml.status, 200);
  assert.ok((siteHtml.headers.get('content-type') || '').includes('text/html'));
  const siteText = await siteHtml.text();
  assert.ok(siteText.includes('Lirio'));

  const siteVer = await fetch(`${base}/site/versions.json`);
  assert.equal(siteVer.status, 200);
  const verJson = await siteVer.json();
  assert.ok(verJson.platforms.macos && verJson.platforms.windows && verJson.platforms.android && verJson.platforms.ios);

  // 11. Verify single-use redeem codes (admin generation + redemption + duplicate 409 + invalid 404)
  const genRes = await req('POST', '/api/admin/codes/generate', { presetId: 'pro_99', count: 2 });
  assert.equal(genRes.status, 201);
  assert.equal(genRes.json.codes.length, 2);
  const generatedCode = genRes.json.codes[0].code;
  assert.ok(generatedCode.startsWith('LIRIO-'));

  const listRes = await req('GET', '/api/admin/codes');
  assert.equal(listRes.status, 200);
  assert.ok(listRes.json.codes.some((c) => c.code === 'LIRIO-DEMO-9900-PRO1'));
  assert.ok(listRes.json.codes.some((c) => c.code === generatedCode));

  const badRedeem = await req('POST', '/api/billing/redeem', { code: 'LIRIO-NONE-0000-0000' }, token);
  assert.equal(badRedeem.status, 404);

  const beforeBal = refilled.user.balanceUnits;
  const goodRedeem = await req(
    'POST',
    '/api/billing/redeem',
    { code: `  ${generatedCode.toLowerCase()}  ` },
    token,
  );
  assert.equal(goodRedeem.status, 200);
  assert.equal(goodRedeem.json.user.balanceUnits, beforeBal + 100000);
  assert.equal(goodRedeem.json.user.tier, 'pro');
  assert.equal(goodRedeem.json.redeemCode.redeemedBy, userId);

  const dupRedeem = await req('POST', '/api/billing/redeem', { code: generatedCode }, token);
  assert.equal(dupRedeem.status, 409);

  // 12. Verify LIRIO_ADMIN_TOKEN protection for dashboard HTML, overview API, admin codes, and login/logout cookie
  const testAdminToken = 'lirio-super-admin-token-2026-test';
  process.env.LIRIO_ADMIN_TOKEN = testAdminToken;
  try {
    const unauthDash = await fetch(`${base}/`);
    assert.equal(unauthDash.status, 401);
    assert.ok((await unauthDash.text()).includes('LIRIO_ADMIN_TOKEN'));

    const unauthJson = await fetch(`${base}/`, { headers: { Accept: 'application/json' } });
    assert.equal(unauthJson.status, 401);

    const unauthOverview = await fetch(`${base}/api/overview`);
    assert.equal(unauthOverview.status, 401);

    const unauthCodes = await fetch(`${base}/api/admin/codes`);
    assert.equal(unauthCodes.status, 401);

    const unauthGen = await req('POST', '/api/admin/codes/generate', { presetId: 'topup_10', count: 1 });
    assert.equal(unauthGen.status, 401);

    // Public endpoints stay reachable
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/site/`)).status, 200);

    const badAdminLogin = await req('POST', '/api/admin/login', { token: 'wrong-token' });
    assert.equal(badAdminLogin.status, 401);

    const goodAdminLogin = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: testAdminToken }),
    });
    assert.equal(goodAdminLogin.status, 200);
    const setCookie = goodAdminLogin.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('lirio_admin=') && setCookie.includes('HttpOnly'));
    const cookieHeader = setCookie.split(';')[0];

    const authDash = await fetch(`${base}/`, { headers: { Cookie: cookieHeader } });
    assert.equal(authDash.status, 200);

    const authOverview = await fetch(`${base}/api/overview`, { headers: { Cookie: cookieHeader } });
    assert.equal(authOverview.status, 200);

    const headerOverview = await fetch(`${base}/api/overview`, {
      headers: { 'X-Admin-Token': testAdminToken },
    });
    assert.equal(headerOverview.status, 200);

    const adminLogout = await fetch(`${base}/api/admin/logout`, { method: 'POST' });
    assert.equal(adminLogout.status, 200);
    assert.ok((adminLogout.headers.get('set-cookie') || '').includes('Max-Age=0'));
  } finally {
    delete process.env.LIRIO_ADMIN_TOKEN;
  }

  // 13. Verify production guardrails + blocking unsigned /api/billing/recharge while keeping /api/billing/redeem working
  assert.throws(
    () => validateProductionConfig({ NODE_ENV: 'production' }),
    (err) =>
      err.message.includes('LIRIO_JWT_SECRET') &&
      err.message.includes('LIRIO_ADMIN_TOKEN') &&
      err.message.includes('LIRIO_LLM_API_KEY'),
  );
  assert.throws(
    () =>
      validateProductionConfig({
        NODE_ENV: 'production',
        LIRIO_JWT_SECRET: 'a'.repeat(32),
        LIRIO_ADMIN_TOKEN: 'b'.repeat(20),
        LIRIO_LLM_API_KEY: 'sk-real-prod-key-123456',
        LIRIO_SEED_DEMO: '1',
      }),
    (err) => err.message.includes('LIRIO_SEED_DEMO'),
  );
  const validProd = validateProductionConfig({
    NODE_ENV: 'production',
    LIRIO_JWT_SECRET: 'a'.repeat(32),
    LIRIO_ADMIN_TOKEN: 'b'.repeat(20),
    LIRIO_LLM_API_KEY: 'sk-real-prod-key-123456',
  });
  assert.equal(validProd.ok, true);
  assert.equal(validProd.mode, 'production');

  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.LIRIO_ADMIN_TOKEN = testAdminToken;
  try {
    const blockedRecharge = await req('POST', '/api/billing/recharge', { packageId: 'pack_10' }, token);
    assert.equal(blockedRecharge.status, 403);

    const prodGenRes = await fetch(`${base}/api/admin/codes/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': testAdminToken },
      body: JSON.stringify({ presetId: 'topup_10', count: 1 }),
    });
    assert.equal(prodGenRes.status, 201);
    const prodGenJson = await prodGenRes.json();
    const prodRedeem = await req('POST', '/api/billing/redeem', { code: prodGenJson.codes[0].code }, token);
    assert.equal(prodRedeem.status, 200);
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete process.env.LIRIO_ADMIN_TOKEN;
  }

  // 14. Verify storefront config, order checkout, QR settings, sandbox & admin confirmation, lookup, TXT export, and redemption
  const storeCfg1 = await req('GET', '/api/store/config');
  assert.equal(storeCfg1.status, 200);
  assert.equal(storeCfg1.json.presets.length, 3);
  assert.equal(storeCfg1.json.sandboxPayEnabled, true);

  const saveSettingsRes = await req('POST', '/api/admin/settings', {
    wechatQr: 'data:image/png;base64,iVBORw0KGgo=',
    shopUrlPro99: 'https://shop.lirio.app/pro99',
    supportContact: '售后微信：lirio-help',
  });
  assert.equal(saveSettingsRes.status, 200);
  assert.equal(saveSettingsRes.json.settings.shopUrlPro99, 'https://shop.lirio.app/pro99');

  const storeCfg2 = await req('GET', '/api/store/config');
  assert.equal(storeCfg2.json.settings.wechatQr, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(storeCfg2.json.settings.supportContact, '售后微信：lirio-help');

  const orderRes = await req('POST', '/api/orders', {
    planId: 'pro_99',
    buyerEmail: 'Buyer@Lirio.App',
    payChannel: 'wechat',
  });
  assert.equal(orderRes.status, 201);
  const ordNo = orderRes.json.order.orderNo;
  assert.ok(ordNo.startsWith('LR-'));
  assert.equal(orderRes.json.order.status, 'pending');

  const wrongOwnerGet = await req('GET', `/api/orders/${ordNo}?email=other@lirio.app`);
  assert.equal(wrongOwnerGet.status, 403);
  const ownerGet = await req('GET', `/api/orders/${ordNo}?email=buyer@lirio.app`);
  assert.equal(ownerGet.status, 200);
  assert.equal(ownerGet.json.order.orderNo, ordNo);

  const confirmOrderRes = await req('POST', `/api/orders/${ordNo}/confirm`, {
    simulate: true,
    email: 'buyer@lirio.app',
  });
  assert.equal(confirmOrderRes.status, 200);
  assert.equal(confirmOrderRes.json.order.status, 'paid');
  const issuedCode = confirmOrderRes.json.order.issuedCode;
  assert.ok(issuedCode.startsWith('LIRIO-'));

  const idempotentConfirm = await req('POST', `/api/orders/${ordNo}/confirm`, {
    simulate: true,
    email: 'buyer@lirio.app',
  });
  assert.equal(idempotentConfirm.status, 200);
  assert.equal(idempotentConfirm.json.alreadyPaid, true);
  assert.equal(idempotentConfirm.json.order.issuedCode, issuedCode);

  const lookupRes = await req('GET', '/api/orders/lookup?email=buyer@lirio.app');
  assert.equal(lookupRes.status, 200);
  assert.ok(lookupRes.json.orders.some((o) => o.orderNo === ordNo && o.issuedCode === issuedCode));

  const meBeforeOrderRedeem = await req('GET', '/api/auth/me', null, token);
  const balBeforeOrderRedeem = meBeforeOrderRedeem.json.user.balanceUnits;
  const orderRedeemRes = await req('POST', '/api/billing/redeem', { code: issuedCode }, token);
  assert.equal(orderRedeemRes.status, 200);
  assert.equal(orderRedeemRes.json.user.balanceUnits, balBeforeOrderRedeem + 100000);

  const exportRes = await fetch(`${base}/api/admin/codes/export`);
  assert.equal(exportRes.status, 200);
  assert.ok((exportRes.headers.get('content-type') || '').includes('text/plain'));
  const exportTxt = await exportRes.text();
  assert.ok(exportTxt.includes('LIRIO-DEMO-9900-PRO1'));

  process.env.NODE_ENV = 'production';
  process.env.LIRIO_ADMIN_TOKEN = testAdminToken;
  try {
    const prodOrderRes = await req('POST', '/api/orders', {
      planId: 'topup_10',
      buyerEmail: 'prod-buyer@lirio.app',
      payChannel: 'alipay',
    });
    assert.equal(prodOrderRes.status, 201);
    const prodOrdNo = prodOrderRes.json.order.orderNo;

    const blockedSandboxConfirm = await req('POST', `/api/orders/${prodOrdNo}/confirm`, {
      simulate: true,
      email: 'prod-buyer@lirio.app',
    });
    assert.equal(blockedSandboxConfirm.status, 401);

    const adminConfirmRes = await fetch(`${base}/api/orders/${prodOrdNo}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': testAdminToken },
      body: '{}',
    });
    assert.equal(adminConfirmRes.status, 200);
    const adminConfirmJson = await adminConfirmRes.json();
    assert.equal(adminConfirmJson.order.status, 'paid');
    assert.ok(adminConfirmJson.order.issuedCode.startsWith('LIRIO-'));
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete process.env.LIRIO_ADMIN_TOKEN;
  }

  // 15. Verify account-bound Lifetime Pass entitlement, 3-day trial expiry, 3-device limit eviction, and device removal
  const devEmail = 'lifetime-guard@lirio.app';
  const devReg1 = await req('POST', '/api/auth/register', {
    email: devEmail,
    password: 'password123',
    name: 'Device Tester',
    deviceId: 'dev-1',
    deviceName: 'Mac Studio',
    platform: 'macos',
  });
  assert.equal(devReg1.status, 201);
  assert.equal(devReg1.json.entitlement.status, 'trial');
  assert.equal(devReg1.json.entitlement.hasAccess, true);
  assert.equal(devReg1.json.devices.length, 1);
  const dev1Token = devReg1.json.token;
  assert.equal((await req('GET', '/api/auth/me', null, dev1Token)).status, 200);
  await new Promise((r) => setTimeout(r, 5));

  const devLogin2 = await req('POST', '/api/auth/login', {
    email: devEmail,
    password: 'password123',
    deviceId: 'dev-2',
    deviceName: 'Windows PC',
    platform: 'windows',
  });
  assert.equal(devLogin2.status, 200);
  const dev2Token = devLogin2.json.token;
  await new Promise((r) => setTimeout(r, 5));

  const devLogin3 = await req('POST', '/api/auth/login', {
    email: devEmail,
    password: 'password123',
    deviceId: 'dev-3',
    deviceName: 'Android Phone',
    platform: 'android',
  });
  assert.equal(devLogin3.status, 200);
  assert.equal(devLogin3.json.devices.length, 3);
  await new Promise((r) => setTimeout(r, 5));

  // Logging in from dev-4 evicts the oldest inactive device (dev-1)
  const devLogin4 = await req('POST', '/api/auth/login', {
    email: devEmail,
    password: 'password123',
    deviceId: 'dev-4',
    deviceName: 'Spare Laptop',
    platform: 'macos',
  });
  assert.equal(devLogin4.status, 200);
  assert.equal(devLogin4.json.devices.length, 3);
  const dev4Token = devLogin4.json.token;

  const evictedCheck = await req('GET', '/api/auth/me', null, dev1Token);
  assert.equal(evictedCheck.status, 401);
  assert.equal(evictedCheck.json.code, 'DEVICE_REVOKED');
  assert.equal((await req('GET', '/api/auth/me', null, dev4Token)).status, 200);

  // Manual removal of dev-2 revokes dev-2 immediately
  const rmDev2 = await req('POST', '/api/auth/devices/remove', { deviceId: 'dev-2' }, dev4Token);
  assert.equal(rmDev2.status, 200);
  assert.equal((await req('GET', '/api/auth/me', null, dev2Token)).status, 401);

  // Backdate created_at by 5 days -> trial expires (hasAccess=false), then Lifetime Pass code restores lifetime access
  const fiveDaysAgo = Date.now() - 5 * 86400 * 1000;
  db.prepare('UPDATE users SET created_at = ? WHERE email = ?').run(fiveDaysAgo, devEmail);
  const expiredMe = await req('GET', '/api/auth/me', null, dev4Token);
  assert.equal(expiredMe.status, 200);
  assert.equal(expiredMe.json.entitlement.status, 'expired');
  assert.equal(expiredMe.json.entitlement.hasAccess, false);

  const genPassRes = await req('POST', '/api/admin/codes/generate', { presetId: 'pro_99', count: 1 });
  assert.equal(genPassRes.status, 201);
  const activateRes = await req(
    'POST',
    '/api/billing/redeem',
    { code: genPassRes.json.codes[0].code },
    dev4Token,
  );
  assert.equal(activateRes.status, 200);
  assert.equal(activateRes.json.entitlement.status, 'lifetime');
  assert.equal(activateRes.json.entitlement.hasAccess, true);
  assert.ok(activateRes.json.entitlement.offlineValidUntil > Date.now() + 10 * 86400 * 1000);
  assert.ok(activateRes.json.entitlement.signedProof);

  console.log('ALL LIRIO PRO SERVER TESTS PASSED (15/15)');
} finally {
  server.close();
}
