import assert from 'node:assert/strict';
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
  // Peak: 0.5*400 + 0.5*20000 + 80000 = 90200 units (¥9.02); Off-peak is exact half = 45100 units (¥4.51)
  assert.equal(peakCost, 90200);
  assert.equal(offPeakCost, 45100);
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

  console.log('ALL LIRIO PRO SERVER TESTS PASSED (8/8)');
} finally {
  server.close();
}
