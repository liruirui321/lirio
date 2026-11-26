import { DatabaseSync } from 'node:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TRIAL_UNITS = 5000; // 50 积分 welcome trial credit

export function openDatabase(dbPath = process.env.LIRIO_DB_PATH || path.join(__dirname, 'lirio.db')) {
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'pro_trial',
      balance_units INTEGER NOT NULL DEFAULT 0,
      total_recharged_units INTEGER NOT NULL DEFAULT 0,
      total_spent_units INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      feature TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_units INTEGER NOT NULL DEFAULT 0,
      output_units INTEGER NOT NULL DEFAULT 0,
      amount_units INTEGER NOT NULL,
      balance_after_units INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      label TEXT NOT NULL,
      amount_units INTEGER NOT NULL,
      upgrade_to_pro INTEGER NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      redeemed_by TEXT,
      redeemed_at INTEGER,
      FOREIGN KEY(redeemed_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_redeem_codes_created ON redeem_codes(created_at DESC);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_no TEXT UNIQUE NOT NULL,
      plan_id TEXT NOT NULL,
      label TEXT NOT NULL,
      pay_yuan REAL NOT NULL,
      amount_units INTEGER NOT NULL,
      upgrade_to_pro INTEGER NOT NULL DEFAULT 1,
      buyer_email TEXT NOT NULL,
      pay_channel TEXT NOT NULL DEFAULT 'wechat',
      status TEXT NOT NULL DEFAULT 'pending',
      issued_code TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      paid_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(buyer_email, created_at DESC);

    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, device_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS feedbacks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      user_tier TEXT NOT NULL DEFAULT 'pro_trial',
      category TEXT NOT NULL DEFAULT 'feature',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      attachment_name TEXT NOT NULL DEFAULT '',
      attachment_content TEXT NOT NULL DEFAULT '',
      attachment_size INTEGER NOT NULL DEFAULT 0,
      app_version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      github_issue_number INTEGER,
      github_issue_url TEXT NOT NULL DEFAULT '',
      admin_reply TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks(user_id, created_at DESC);
  `);

  return db;
}

export function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tier: row.tier,
    balanceUnits: Number(row.balance_units),
    totalRechargedUnits: Number(row.total_recharged_units),
    totalSpentUnits: Number(row.total_spent_units),
    createdAt: Number(row.created_at),
  };
}

export function serializeLedger(row) {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    inputUnits: Number(row.input_units),
    outputUnits: Number(row.output_units),
    amountUnits: Number(row.amount_units),
    balanceAfterUnits: Number(row.balance_after_units),
    note: row.note,
    createdAt: Number(row.created_at),
  };
}

export function getUserByEmail(db, email) {
  const normalized = String(email || '').trim().toLowerCase();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalized) || null;
}

export function getUserById(db, userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

export function listAllUsers(db) {
  const rows = db
    .prepare('SELECT * FROM users ORDER BY created_at DESC, rowid DESC')
    .all();
  return rows.map(serializeUser);
}

export function listRecentLedger(db, limit = 30) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
  const rows = db
    .prepare(
      `SELECT l.*, u.email AS user_email, u.name AS user_name
       FROM ledger l
       LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC, l.rowid DESC
       LIMIT ?`,
    )
    .all(safeLimit);
  return rows.map((row) => ({
    ...serializeLedger(row),
    userEmail: row.user_email || '',
    userName: row.user_name || '',
  }));
}

export function listUserLedger(db, userId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = db
    .prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, safeLimit);
  return rows.map(serializeLedger);
}

export function createUserWithTrial(db, { email, name, passwordHash, trialUnits = DEFAULT_TRIAL_UNITS }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim() || normalizedEmail.split('@')[0] || 'Lirio User';
  const now = Date.now();
  const userId = randomUUID();
  const ledgerId = randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, tier, balance_units, total_recharged_units, total_spent_units, created_at)
       VALUES (?, ?, ?, ?, 'pro_trial', ?, 0, 0, ?)`,
    ).run(userId, normalizedEmail, cleanName, passwordHash, trialUnits, now);

    if (trialUnits > 0) {
      const trialNote = `注册即赠 ${Math.round(trialUnits / 100)} 积分体验额度`;
      db.prepare(
        `INSERT INTO ledger (id, user_id, kind, feature, provider, model, input_units, output_units, amount_units, balance_after_units, note, created_at)
         VALUES (?, ?, 'bonus', '新用户注册赠积分', 'lirio', 'trial', 0, 0, ?, ?, ?, ?)`,
      ).run(ledgerId, userId, trialUnits, trialUnits, trialNote, now);
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }

  return serializeUser(getUserById(db, userId));
}

export function creditUserBalance(
  db,
  { userId, amountUnits, kind = 'recharge', feature = '积分充值', note = '', upgradeToPro = true },
) {
  const credit = Math.max(1, Math.round(Number(amountUnits) || 0));
  const now = Date.now();
  const ledgerId = randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = getUserById(db, userId);
    if (!user) throw new Error('USER_NOT_FOUND');

    const newBalance = Number(user.balance_units) + credit;
    const newRecharged = Number(user.total_recharged_units) + credit;
    const newTier = upgradeToPro ? 'pro' : user.tier;

    db.prepare(
      'UPDATE users SET balance_units = ?, total_recharged_units = ?, tier = ? WHERE id = ?',
    ).run(newBalance, newRecharged, newTier, userId);

    db.prepare(
      `INSERT INTO ledger (id, user_id, kind, feature, provider, model, input_units, output_units, amount_units, balance_after_units, note, created_at)
       VALUES (?, ?, ?, ?, 'lirio', 'billing', 0, 0, ?, ?, ?, ?)`,
    ).run(ledgerId, userId, kind, feature, credit, newBalance, note, now);

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }

  const updated = serializeUser(getUserById(db, userId));
  const entry = serializeLedger(db.prepare('SELECT * FROM ledger WHERE id = ?').get(ledgerId));
  return { user: updated, entry };
}

export function deductUserBalance(
  db,
  {
    userId,
    costUnits,
    feature = 'AI 对话',
    provider = 'lirio',
    model = 'deepseek-chat',
    inputUnits = 0,
    outputUnits = 0,
    note = '',
  },
) {
  const cost = Math.max(1, Math.round(Number(costUnits) || 1));
  const now = Date.now();
  const ledgerId = randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = getUserById(db, userId);
    if (!user) throw new Error('USER_NOT_FOUND');

    const prevBal = Number(user.balance_units);
    if (prevBal <= 0) {
      throw new Error('INSUFFICIENT_BALANCE');
    }
    // Deduct up to remaining balance so single final turn doesn't drive account deeply negative
    const actualDeduct = Math.min(prevBal, cost);
    const newBalance = prevBal - actualDeduct;
    const newSpent = Number(user.total_spent_units) + actualDeduct;

    db.prepare(
      'UPDATE users SET balance_units = ?, total_spent_units = ? WHERE id = ?',
    ).run(newBalance, newSpent, userId);

    db.prepare(
      `INSERT INTO ledger (id, user_id, kind, feature, provider, model, input_units, output_units, amount_units, balance_after_units, note, created_at)
       VALUES (?, ?, 'usage', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ledgerId,
      userId,
      feature,
      provider,
      model,
      Math.max(0, Math.round(inputUnits)),
      Math.max(0, Math.round(outputUnits)),
      -actualDeduct,
      newBalance,
      note,
      now,
    );

    db.exec('COMMIT');
    const updated = serializeUser(getUserById(db, userId));
    const entry = serializeLedger(db.prepare('SELECT * FROM ledger WHERE id = ?').get(ledgerId));
    return { user: updated, entry, deductedUnits: actualDeduct };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateRandomCodeString(prefix = 'LIRIO') {
  const block = () => {
    let out = '';
    for (let i = 0; i < 4; i++) {
      out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    }
    return out;
  };
  return `${prefix}-${block()}-${block()}-${block()}`;
}

export function normalizeRedeemCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

export function serializeRedeemCode(row) {
  if (!row) return null;
  return {
    code: row.code,
    planId: row.plan_id,
    label: row.label,
    amountUnits: Number(row.amount_units),
    upgradeToPro: Number(row.upgrade_to_pro) === 1,
    note: row.note || '',
    createdAt: Number(row.created_at),
    redeemedBy: row.redeemed_by || null,
    redeemedByEmail: row.redeemed_by_email || null,
    redeemedAt: row.redeemed_at ? Number(row.redeemed_at) : null,
  };
}

export function createRedeemCodes(
  db,
  {
    count = 1,
    planId = 'pro_99',
    label = '¥99 Lirio Pro · 永久版（含 1,000 积分）',
    amountUnits = 100000,
    upgradeToPro = true,
    note = '',
    prefix = 'LIRIO',
    exactCodes = null,
  } = {},
) {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO redeem_codes (code, plan_id, label, amount_units, upgrade_to_pro, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const created = [];
  if (Array.isArray(exactCodes) && exactCodes.length) {
    for (const raw of exactCodes) {
      const code = normalizeRedeemCode(raw);
      if (!code) continue;
      stmt.run(code, planId, label, Math.max(0, Math.round(amountUnits)), upgradeToPro ? 1 : 0, note, now);
      created.push(
        serializeRedeemCode({
          code,
          plan_id: planId,
          label,
          amount_units: Math.max(0, Math.round(amountUnits)),
          upgrade_to_pro: upgradeToPro ? 1 : 0,
          note,
          created_at: now,
          redeemed_by: null,
          redeemed_at: null,
        }),
      );
    }
    return created;
  }

  const targetCount = Math.max(1, Math.min(100, Math.round(Number(count) || 1)));
  for (let i = 0; i < targetCount; i++) {
    let code = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateRandomCodeString(prefix);
      const exists = db.prepare('SELECT 1 FROM redeem_codes WHERE code = ?').get(candidate);
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('CODE_GENERATION_FAILED');
    stmt.run(code, planId, label, Math.max(0, Math.round(amountUnits)), upgradeToPro ? 1 : 0, note, now + i);
    created.push(
      serializeRedeemCode({
        code,
        plan_id: planId,
        label,
        amount_units: Math.max(0, Math.round(amountUnits)),
        upgrade_to_pro: upgradeToPro ? 1 : 0,
        note,
        created_at: now + i,
        redeemed_by: null,
        redeemed_at: null,
      }),
    );
  }
  return created;
}

export function listRedeemCodes(db, limit = 60) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 60));
  const rows = db
    .prepare(
      `SELECT rc.*, u.email AS redeemed_by_email
       FROM redeem_codes rc
       LEFT JOIN users u ON rc.redeemed_by = u.id
       ORDER BY rc.created_at DESC
       LIMIT ?`,
    )
    .all(safeLimit);
  return rows.map(serializeRedeemCode);
}

export function redeemCodeForUser(db, { userId, rawCode }) {
  const code = normalizeRedeemCode(rawCode);
  if (!code) throw new Error('INVALID_CODE');
  const now = Date.now();
  const ledgerId = randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = getUserById(db, userId);
    if (!user) throw new Error('USER_NOT_FOUND');

    const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(code);
    if (!row) throw new Error('CODE_NOT_FOUND');
    if (row.redeemed_by || row.redeemed_at) throw new Error('CODE_ALREADY_REDEEMED');

    const claim = db
      .prepare('UPDATE redeem_codes SET redeemed_by = ?, redeemed_at = ? WHERE code = ? AND redeemed_by IS NULL')
      .run(userId, now, code);
    if (!claim || claim.changes !== 1) throw new Error('CODE_ALREADY_REDEEMED');

    const units = Math.max(0, Math.round(Number(row.amount_units) || 0));
    const newBalance = Number(user.balance_units) + units;
    const newRecharged = Number(user.total_recharged_units) + units;
    const newTier = Number(row.upgrade_to_pro) === 1 ? 'pro' : user.tier;

    db.prepare(
      'UPDATE users SET balance_units = ?, total_recharged_units = ?, tier = ? WHERE id = ?',
    ).run(newBalance, newRecharged, newTier, userId);

    const ledgerNote = row.note ? `${row.note} · 卡密 ${code}` : `卡密 ${code}`;
    db.prepare(
      `INSERT INTO ledger (id, user_id, kind, feature, provider, model, input_units, output_units, amount_units, balance_after_units, note, created_at)
       VALUES (?, ?, 'recharge', ?, 'redeem', 'redeem-code', 0, 0, ?, ?, ?, ?)`,
    ).run(ledgerId, userId, row.label || '卡密兑换', units, newBalance, ledgerNote, now);

    db.exec('COMMIT');
    const updatedUser = serializeUser(getUserById(db, userId));
    const entry = serializeLedger(db.prepare('SELECT * FROM ledger WHERE id = ?').get(ledgerId));
    const redeemedRow = db
      .prepare(
        `SELECT rc.*, u.email AS redeemed_by_email
         FROM redeem_codes rc LEFT JOIN users u ON rc.redeemed_by = u.id WHERE rc.code = ?`,
      )
      .get(code);
    return {
      user: updatedUser,
      entry,
      redeemCode: serializeRedeemCode(redeemedRow),
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

export const DEFAULT_STORE_SETTINGS = {
  wechatQr: '',
  alipayQr: '',
  shopUrlPro99: '',
  shopUrlTopup10: '',
  shopUrlTopup30: '',
  supportContact: '售后联系：support@lirio.app',
  paymentNotice: '扫码付款时请在备注栏填写订单号，确认收款后页面将自动弹出卡密兑换码。',
};

export function getStoreSettings(db) {
  const rows = db.prepare('SELECT key, value FROM store_settings').all();
  const out = { ...DEFAULT_STORE_SETTINGS };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_STORE_SETTINGS, row.key)) {
      out[row.key] = String(row.value || '');
    }
  }
  return out;
}

export function saveStoreSettings(db, patch = {}) {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO store_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  for (const key of Object.keys(DEFAULT_STORE_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      stmt.run(key, String(patch[key] ?? ''), now);
    }
  }
  return getStoreSettings(db);
}

export function serializeOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNo: row.order_no,
    planId: row.plan_id,
    label: row.label,
    payYuan: Number(row.pay_yuan),
    amountUnits: Number(row.amount_units),
    upgradeToPro: Number(row.upgrade_to_pro) === 1,
    buyerEmail: row.buyer_email,
    payChannel: row.pay_channel || 'wechat',
    status: row.status || 'pending',
    issuedCode: row.issued_code || null,
    note: row.note || '',
    createdAt: Number(row.created_at),
    paidAt: row.paid_at ? Number(row.paid_at) : null,
  };
}

function generateOrderNo() {
  const d = new Date();
  const ymd =
    String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return `LR-${ymd}-${suffix}`;
}

export function createOrder(
  db,
  {
    planId,
    label,
    payYuan,
    amountUnits,
    upgradeToPro = true,
    buyerEmail,
    payChannel = 'wechat',
    note = '',
  },
) {
  const id = randomUUID();
  const now = Date.now();
  const cleanEmail = String(buyerEmail || '').trim().toLowerCase();
  const cleanChannel = payChannel === 'alipay' ? 'alipay' : 'wechat';
  let orderNo = '';
  for (let i = 0; i < 8; i++) {
    const candidate = generateOrderNo();
    const exists = db.prepare('SELECT 1 FROM orders WHERE order_no = ?').get(candidate);
    if (!exists) {
      orderNo = candidate;
      break;
    }
  }
  if (!orderNo) throw new Error('ORDER_NO_GENERATION_FAILED');
  db.prepare(
    `INSERT INTO orders (id, order_no, plan_id, label, pay_yuan, amount_units, upgrade_to_pro, buyer_email, pay_channel, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    orderNo,
    planId,
    label,
    Number(payYuan) || 0,
    Math.max(0, Math.round(Number(amountUnits) || 0)),
    upgradeToPro ? 1 : 0,
    cleanEmail,
    cleanChannel,
    String(note || ''),
    now,
  );
  return getOrderByNo(db, orderNo);
}

export function getOrderByNo(db, orderNo) {
  const clean = String(orderNo || '').trim().toUpperCase();
  if (!clean) return null;
  const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(clean);
  return serializeOrder(row);
}

export function listOrders(db, limit = 80) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 80));
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(safeLimit);
  return rows.map(serializeOrder);
}

export function lookupOrdersByEmail(db, email, { orderNo = '', limit = 15 } = {}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return [];
  const cleanNo = String(orderNo || '').trim().toUpperCase();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 15));
  const rows = cleanNo
    ? db
        .prepare('SELECT * FROM orders WHERE buyer_email = ? AND order_no = ? ORDER BY created_at DESC LIMIT ?')
        .all(cleanEmail, cleanNo, safeLimit)
    : db
        .prepare('SELECT * FROM orders WHERE buyer_email = ? ORDER BY created_at DESC LIMIT ?')
        .all(cleanEmail, safeLimit);
  return rows.map(serializeOrder);
}

export function confirmOrderAndIssueCode(db, { orderNo, note = '' }) {
  const cleanOrderNo = String(orderNo || '').trim().toUpperCase();
  if (!cleanOrderNo) throw new Error('ORDER_NOT_FOUND');
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(cleanOrderNo);
    if (!row) throw new Error('ORDER_NOT_FOUND');
    if (row.status === 'paid' && row.issued_code) {
      const codeRow = db
        .prepare(
          `SELECT rc.*, u.email AS redeemed_by_email
           FROM redeem_codes rc LEFT JOIN users u ON rc.redeemed_by = u.id WHERE rc.code = ?`,
        )
        .get(row.issued_code);
      db.exec('COMMIT');
      return { order: serializeOrder(row), redeemCode: serializeRedeemCode(codeRow), alreadyPaid: true };
    }
    if (row.status === 'cancelled') throw new Error('ORDER_CANCELLED');

    let code = '';
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = generateRandomCodeString('LIRIO');
      const exists = db.prepare('SELECT 1 FROM redeem_codes WHERE code = ?').get(candidate);
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('CODE_GENERATION_FAILED');

    const codeNote = `订单 ${row.order_no} · ${row.buyer_email}`;
    db.prepare(
      `INSERT INTO redeem_codes (code, plan_id, label, amount_units, upgrade_to_pro, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      code,
      row.plan_id,
      row.label,
      Number(row.amount_units),
      Number(row.upgrade_to_pro) === 1 ? 1 : 0,
      codeNote,
      now,
    );

    const updatedNote = note ? String(note) : row.note || '';
    const upd = db
      .prepare(
        `UPDATE orders SET status = 'paid', issued_code = ?, paid_at = ?, note = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(code, now, updatedNote, row.id);
    if (!upd || upd.changes !== 1) throw new Error('ORDER_STATE_CONFLICT');

    db.exec('COMMIT');
    const updatedOrder = serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id));
    const codeRow = db
      .prepare(
        `SELECT rc.*, u.email AS redeemed_by_email
         FROM redeem_codes rc LEFT JOIN users u ON rc.redeemed_by = u.id WHERE rc.code = ?`,
      )
      .get(code);
    return { order: updatedOrder, redeemCode: serializeRedeemCode(codeRow), alreadyPaid: false };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

export function cancelOrder(db, { orderNo }) {
  const cleanOrderNo = String(orderNo || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(cleanOrderNo);
  if (!row) throw new Error('ORDER_NOT_FOUND');
  if (row.status !== 'pending') throw new Error('ORDER_NOT_PENDING');
  db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(row.id);
  return getOrderByNo(db, cleanOrderNo);
}

export function listUnusedRedeemCodes(db, planId = '') {
  const cleanPlan = String(planId || '').trim();
  const rows = cleanPlan
    ? db
        .prepare('SELECT * FROM redeem_codes WHERE redeemed_by IS NULL AND plan_id = ? ORDER BY created_at DESC')
        .all(cleanPlan)
    : db.prepare('SELECT * FROM redeem_codes WHERE redeemed_by IS NULL ORDER BY created_at DESC').all();
  return rows.map(serializeRedeemCode);
}

export function serializeDevice(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    deviceName: row.device_name || row.device_id,
    platform: row.platform || '',
    lastSeenAt: Number(row.last_seen_at),
    createdAt: Number(row.created_at),
  };
}

export function listUserDevices(db, userId) {
  const nonLegacy = db
    .prepare(
      `SELECT * FROM user_devices
       WHERE user_id = ? AND device_id != 'legacy-web'
       ORDER BY last_seen_at DESC, created_at DESC`,
    )
    .all(userId);
  if (nonLegacy.length > 0) {
    return nonLegacy.map(serializeDevice);
  }
  const allRows = db
    .prepare(
      `SELECT * FROM user_devices
       WHERE user_id = ?
       ORDER BY last_seen_at DESC, created_at DESC`,
    )
    .all(userId);
  return allRows.map(serializeDevice);
}

export function registerUserDevice(
  db,
  { userId, deviceId, deviceName = '', platform = '', maxDevices = 3 } = {},
) {
  const cleanDid = String(deviceId || '').trim() || 'legacy-web';
  const cleanName = String(deviceName || cleanDid).trim().slice(0, 80);
  const cleanPlatform = String(platform || '').trim().slice(0, 40);
  const cap = Math.max(1, Math.round(Number(maxDevices) || 3));
  const now = Date.now();
  const id = randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO user_devices (id, user_id, device_id, device_name, platform, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET
         device_name = CASE WHEN excluded.device_name != '' THEN excluded.device_name ELSE user_devices.device_name END,
         platform = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE user_devices.platform END,
         last_seen_at = excluded.last_seen_at`,
    ).run(id, userId, cleanDid, cleanName, cleanPlatform, now, now);

    let evictedCount = 0;
    if (cleanDid !== 'legacy-web') {
      const rows = db
        .prepare(
          `SELECT id, device_id FROM user_devices
           WHERE user_id = ? AND device_id != 'legacy-web'
           ORDER BY last_seen_at DESC, created_at DESC`,
        )
        .all(userId);
      if (rows.length > cap) {
        const delStmt = db.prepare('DELETE FROM user_devices WHERE id = ?');
        for (const extra of rows.slice(cap)) {
          delStmt.run(extra.id);
          evictedCount++;
        }
      }
    }

    db.exec('COMMIT');
    return {
      devices: listUserDevices(db, userId),
      evictedCount,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

export function isUserDeviceActive(db, userId, deviceId) {
  const cleanDid = String(deviceId || '').trim();
  if (!cleanDid || cleanDid === 'legacy-web') return true;
  const row = db
    .prepare('SELECT 1 FROM user_devices WHERE user_id = ? AND device_id = ?')
    .get(userId, cleanDid);
  return Boolean(row);
}

export function touchUserDevice(db, userId, deviceId) {
  const cleanDid = String(deviceId || '').trim();
  if (!cleanDid || cleanDid === 'legacy-web') return;
  db.prepare('UPDATE user_devices SET last_seen_at = ? WHERE user_id = ? AND device_id = ?').run(
    Date.now(),
    userId,
    cleanDid,
  );
}

export function removeUserDevice(db, userId, deviceId) {
  const cleanDid = String(deviceId || '').trim();
  if (!cleanDid) return false;
  const res = db
    .prepare('DELETE FROM user_devices WHERE user_id = ? AND device_id = ?')
    .run(userId, cleanDid);
  return Boolean(res && res.changes > 0);
}

export function serializeFeedback(row, { includeAttachment = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name || '',
    userTier: row.user_tier || 'pro_trial',
    category: row.category || 'feature',
    title: row.title,
    content: row.content,
    attachmentName: row.attachment_name || '',
    attachmentSize: Number(row.attachment_size || 0),
    appVersion: row.app_version || '',
    status: row.status || 'open',
    githubIssueNumber: row.github_issue_number ? Number(row.github_issue_number) : null,
    githubIssueUrl: row.github_issue_url || '',
    adminReply: row.admin_reply || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (includeAttachment) {
    return { ...base, attachmentContent: row.attachment_content || '' };
  }
  return base;
}

export function createFeedback(
  db,
  {
    userId,
    userEmail,
    userName = '',
    userTier = 'pro_trial',
    category = 'feature',
    title,
    content,
    attachmentName = '',
    attachmentContent = '',
    appVersion = '',
    githubIssueNumber = null,
    githubIssueUrl = '',
  },
) {
  const id = randomUUID();
  const now = Date.now();
  const attBytes = attachmentContent ? Buffer.byteLength(String(attachmentContent), 'utf8') : 0;
  db.prepare(
    `INSERT INTO feedbacks (
      id, user_id, user_email, user_name, user_tier, category, title, content,
      attachment_name, attachment_content, attachment_size, app_version,
      status, github_issue_number, github_issue_url, admin_reply, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, '', ?, ?)`,
  ).run(
    id,
    userId,
    String(userEmail || '').trim().toLowerCase(),
    String(userName || ''),
    String(userTier || 'pro_trial'),
    String(category || 'feature'),
    String(title || '').trim(),
    String(content || '').trim(),
    String(attachmentName || ''),
    String(attachmentContent || ''),
    attBytes,
    String(appVersion || ''),
    githubIssueNumber ? Number(githubIssueNumber) : null,
    String(githubIssueUrl || ''),
    now,
    now,
  );
  return getFeedbackById(db, id, { includeAttachment: false });
}

export function getFeedbackById(db, id, { includeAttachment = true } = {}) {
  const row = db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(String(id || ''));
  return serializeFeedback(row, { includeAttachment });
}

export function listUserFeedbacks(db, userId, limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = db
    .prepare('SELECT * FROM feedbacks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, safeLimit);
  return rows.map((r) => serializeFeedback(r, { includeAttachment: false }));
}

export function listAllFeedbacks(db, limit = 100) {
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
  const rows = db
    .prepare('SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT ?')
    .all(safeLimit);
  return rows.map((r) => serializeFeedback(r, { includeAttachment: false }));
}

export function updateFeedback(db, { id, status, adminReply, githubIssueNumber, githubIssueUrl }) {
  const row = db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(String(id || ''));
  if (!row) return null;
  const now = Date.now();
  const nextStatus = status !== undefined ? String(status) : row.status;
  const nextReply = adminReply !== undefined ? String(adminReply) : row.admin_reply;
  const nextNum =
    githubIssueNumber !== undefined
      ? githubIssueNumber
        ? Number(githubIssueNumber)
        : null
      : row.github_issue_number;
  const nextUrl = githubIssueUrl !== undefined ? String(githubIssueUrl) : row.github_issue_url;
  db.prepare(
    `UPDATE feedbacks
     SET status = ?, admin_reply = ?, github_issue_number = ?, github_issue_url = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextStatus, nextReply, nextNum, nextUrl, now, row.id);
  return getFeedbackById(db, row.id, { includeAttachment: false });
}
