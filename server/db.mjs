import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TRIAL_UNITS = 50000; // ¥5.00 welcome trial credit

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
      db.prepare(
        `INSERT INTO ledger (id, user_id, kind, feature, provider, model, input_units, output_units, amount_units, balance_after_units, note, created_at)
         VALUES (?, ?, 'bonus', '新用户注册赠金', 'lirio', 'trial', 0, 0, ?, ?, '注册即赠 ¥5.00 AI 体验金', ?)`,
      ).run(ledgerId, userId, trialUnits, trialUnits, now);
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
  { userId, amountUnits, kind = 'recharge', feature = '余额充值', note = '', upgradeToPro = true },
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
