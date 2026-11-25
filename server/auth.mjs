import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DEV_FALLBACK_SECRET = randomBytes(32).toString('hex');

export function isProductionMode(env = process.env) {
  return (
    env.NODE_ENV === 'production' ||
    env.LIRIO_PRODUCTION === '1' ||
    env.LIRIO_PRODUCTION === 'true'
  );
}

export function isWeakJwtSecret(secret) {
  const s = String(secret || '').trim();
  if (s.length < 32) return true;
  return /change-this|example|placeholder|dev-secret|your-secret/i.test(s);
}

function getJwtSecret() {
  const configured = String(process.env.LIRIO_JWT_SECRET || '').trim();
  if (isProductionMode() && isWeakJwtSecret(configured)) {
    throw new Error('生产环境必须设置强随机 LIRIO_JWT_SECRET（至少 32 位，不可使用占位值）。');
  }
  return configured || DEV_FALLBACK_SECRET;
}

export function constantTimeEquals(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || !sb) return false;
  const ba = Buffer.from(sa, 'utf8');
  const bb = Buffer.from(sb, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createSignedAdminCookieValue(adminToken) {
  return createHmac('sha256', String(adminToken || ''))
    .update('lirio-admin-session-v1')
    .digest('hex');
}

export function verifySignedAdminCookieValue(cookieVal, adminToken) {
  if (!cookieVal || !adminToken) return false;
  const expected = createSignedAdminCookieValue(adminToken);
  return constantTimeEquals(cookieVal, expected);
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signToken(payload, ttlSeconds = 30 * 24 * 3600) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const body = base64UrlEncode(
    JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + ttlSeconds }),
  );
  const sig = createHmac('sha256', getJwtSecret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', getJwtSecret()).update(`${header}.${body}`).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(body));
    if (!parsed || typeof parsed.sub !== 'string') return null;
    if (typeof parsed.exp === 'number' && parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
