import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLirioServer, seedDemoUser } from './index.mjs';
import { creditUserBalance, deductUserBalance } from './db.mjs';
import { calculateChatCostUnits, calculateTtsCostUnits } from './pricing.mjs';

process.env.LIRIO_MOCK_AI = '1';
process.env.LIRIO_JWT_SECRET = 'test-secret-key';

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

  console.log('ALL LIRIO PRO SERVER TESTS PASSED (11/11)');
} finally {
  server.close();
}
