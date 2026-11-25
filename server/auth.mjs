import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DEV_FALLBACK_SECRET = randomBytes(32).toString('hex');

function getJwtSecret() {
  return process.env.LIRIO_JWT_SECRET || DEV_FALLBACK_SECRET;
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
