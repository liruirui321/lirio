import type { Accent } from './corpusService';
import { saveStateBackup } from './stateSync';

export type AiMode = 'byok' | 'pro_balance';

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  tier: string;
  balanceUnits: number;
  totalRechargedUnits: number;
  totalSpentUnits: number;
  createdAt: number;
}

export interface AccountEntitlement {
  status: 'lifetime' | 'trial' | 'expired';
  hasAccess: boolean;
  isLifetime: boolean;
  trialEndsAt: number;
  offlineValidUntil: number;
  maxDevices: number;
  verifiedAt: number;
  signedProof?: string;
}

export interface BoundDevice {
  deviceId: string;
  deviceName: string;
  platform: string;
  lastSeenAt: number;
  createdAt: number;
}

export interface LocalAccessResult {
  allowed: boolean;
  mode?: 'lifetime' | 'trial';
  reason?: 'unauthenticated' | 'trial_expired' | 'offline_expired';
  message?: string;
  trialEndsAt?: number;
  trialRemainingHours?: number;
  offlineValidUntil?: number;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  kind: 'bonus' | 'recharge' | 'usage';
  feature: string;
  provider: string;
  model: string;
  inputUnits: number;
  outputUnits: number;
  amountUnits: number;
  balanceAfterUnits: number;
  note: string;
  createdAt: number;
}

export interface RechargePack {
  id: string;
  label: string;
  payYuan: number;
  bonusYuan: number;
  creditUnits: number;
  note: string;
}

export interface StorePreset {
  id: string;
  payYuan: number;
  label: string;
  shortTitle?: string;
  badge?: string;
  subtitle?: string;
  amountUnits: number;
  upgradeToPro: boolean;
  note?: string;
}

export interface StoreSettings {
  wechatQr: string;
  alipayQr: string;
  shopUrlPro99: string;
  shopUrlTopup10: string;
  shopUrlTopup30: string;
  supportContact: string;
  paymentNotice: string;
}

export interface StoreConfig {
  presets: StorePreset[];
  settings: StoreSettings;
  sandboxPayEnabled: boolean;
}

export interface StoreOrder {
  id: string;
  orderNo: string;
  planId: string;
  label: string;
  payYuan: number;
  amountUnits: number;
  upgradeToPro: boolean;
  buyerEmail: string;
  payChannel: 'wechat' | 'alipay';
  status: 'pending' | 'paid' | 'cancelled';
  issuedCode: string | null;
  note: string;
  createdAt: number;
  paidAt: number | null;
}

export interface AccountState {
  serverUrl: string;
  token: string | null;
  user: AccountUser | null;
  entitlement?: AccountEntitlement | null;
  devices?: BoundDevice[];
  lastAuthNotice?: string | null;
  aiMode: AiMode;
  proCloudSpeech: boolean;
}

export interface LastChargeEvent {
  amountUnits: number;
  feature: string;
  balanceAfterUnits: number;
  at: number;
}

export const DEFAULT_RECHARGE_PACKS: RechargePack[] = [
  { id: 'pack_10', label: '轻享包 ¥10', payYuan: 10, bonusYuan: 0, creditUnits: 100000, note: '¥10.00' },
  { id: 'pack_30', label: '备考包 ¥30（送¥3）', payYuan: 30, bonusYuan: 3, creditUnits: 330000, note: '到账 ¥33.00' },
  { id: 'pack_100', label: '冲刺 Pro ¥100（送¥15）', payYuan: 100, bonusYuan: 15, creditUnits: 1150000, note: '到账 ¥115.00' },
];

const ACCOUNT_KEY = 'lirio-account-v1';
const BUILD_DEFAULT_SERVER_URL = (
  (import.meta.env?.VITE_LIRIO_SERVER_URL as string | undefined) || 'http://127.0.0.1:8787'
)
  .trim()
  .replace(/\/+$/, '');

function isLocalhostUrl(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(url || '').trim());
}

const DEFAULT_STATE: AccountState = {
  serverUrl: BUILD_DEFAULT_SERVER_URL || 'http://127.0.0.1:8787',
  token: null,
  user: null,
  entitlement: null,
  devices: [],
  lastAuthNotice: null,
  aiMode: 'byok',
  proCloudSpeech: false,
};

const DEVICE_STORAGE_KEY = 'lirio-device-id-v1';

export function getDeviceIdentity(): { deviceId: string; deviceName: string; platform: string } {
  let deviceId = '';
  try {
    const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId.trim()) {
        deviceId = parsed.deviceId.trim();
      }
    }
  } catch {}
  if (!deviceId) {
    deviceId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const serialized = JSON.stringify({ deviceId });
      localStorage.setItem(DEVICE_STORAGE_KEY, serialized);
      saveStateBackup('lirio_device_v1', serialized);
    } catch {}
  }

  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();
  let platform = 'desktop';
  let deviceName = 'Lirio 桌面设备';
  if (/iphone|ipad|ipod/.test(ua)) {
    platform = 'ios';
    deviceName = /ipad/.test(ua) ? 'iPad' : 'iPhone';
  } else if (/android/.test(ua)) {
    platform = 'android';
    deviceName = 'Android 设备';
  } else if (/mac/.test(ua)) {
    platform = 'macos';
    deviceName = 'Mac 电脑';
  } else if (/win/.test(ua)) {
    platform = 'windows';
    deviceName = 'Windows 电脑';
  } else if (/linux/.test(ua)) {
    platform = 'linux';
    deviceName = 'Linux 设备';
  }
  return { deviceId, deviceName, platform };
}

export function evaluateLocalAccess(st: AccountState = getAccountState()): LocalAccessResult {
  if (!st.token || !st.user) {
    return {
      allowed: false,
      reason: 'unauthenticated',
      message: st.lastAuthNotice || '',
    };
  }
  const now = Date.now();
  const ent = st.entitlement;
  if (st.user.tier === 'pro') {
    const graceUntil = ent?.offlineValidUntil ?? st.user.createdAt + 14 * 86400 * 1000;
    if (now <= graceUntil) {
      return {
        allowed: true,
        mode: 'lifetime',
        offlineValidUntil: graceUntil,
      };
    }
    return {
      allowed: false,
      reason: 'offline_expired',
      offlineValidUntil: graceUntil,
      message: '当前设备离线使用已超过 14 天，请联网验证一次终身通行证授权。',
    };
  }

  const trialEndsAt = ent?.trialEndsAt ?? st.user.createdAt + 3 * 86400 * 1000;
  if (now < trialEndsAt) {
    return {
      allowed: true,
      mode: 'trial',
      trialEndsAt,
      trialRemainingHours: Math.max(1, Math.ceil((trialEndsAt - now) / 3600000)),
    };
  }
  return {
    allowed: false,
    reason: 'trial_expired',
    trialEndsAt,
    message: '3 天全功能免费体验已结束，请输入 Lirio 终身通行证激活码永久解锁。',
  };
}

const listeners = new Set<(state: AccountState) => void>();
const lastChargeListeners = new Set<(event: LastChargeEvent) => void>();

export function subscribeAccount(listener: (state: AccountState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeLastCharge(listener: (event: LastChargeEvent) => void): () => void {
  lastChargeListeners.add(listener);
  return () => {
    lastChargeListeners.delete(listener);
  };
}

function emitLastCharge(event: LastChargeEvent) {
  lastChargeListeners.forEach((fn) => {
    try {
      fn(event);
    } catch {}
  });
}

export function getAccountState(): AccountState {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const shouldUpgradeUrl =
        !isLocalhostUrl(BUILD_DEFAULT_SERVER_URL) &&
        parsed?.serverUrl === 'http://127.0.0.1:8787' &&
        !parsed?.token;
      return {
        ...DEFAULT_STATE,
        ...(parsed || {}),
        serverUrl: shouldUpgradeUrl
          ? BUILD_DEFAULT_SERVER_URL
          : parsed?.serverUrl || DEFAULT_STATE.serverUrl,
        aiMode: parsed?.aiMode === 'pro_balance' ? 'pro_balance' : 'byok',
        proCloudSpeech: Boolean(parsed?.proCloudSpeech),
      };
    }
  } catch {}
  return { ...DEFAULT_STATE };
}

export function saveAccountState(next: AccountState) {
  try {
    const raw = JSON.stringify(next);
    localStorage.setItem(ACCOUNT_KEY, raw);
    saveStateBackup('lirio_account_v1', raw);
  } catch {}
  listeners.forEach((fn) => {
    try {
      fn(next);
    } catch {}
  });
}

export function updateAccountState(patch: Partial<AccountState>): AccountState {
  const next = { ...getAccountState(), ...patch };
  saveAccountState(next);
  return next;
}

export function formatYuan(units: number | undefined | null, decimals = 2): string {
  const v = (Number(units) || 0) / 10000;
  return `¥${v.toFixed(decimals)}`;
}

export function formatSmartYuan(units: number | undefined | null): string {
  const raw = Math.round(Math.abs(Number(units) || 0));
  return formatYuan(units, raw % 100 === 0 ? 2 : 4);
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const st = getAccountState();
  const base = (st.serverUrl || DEFAULT_STATE.serverUrl).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((opts.headers as Record<string, string>) || {}),
  };
  if (st.token) {
    headers.Authorization = `Bearer ${st.token}`;
  }
  let resp: Response;
  try {
    resp = await fetch(`${base}${path}`, { ...opts, headers });
  } catch (e) {
    throw new Error(`无法连接 Lirio 计费服务器（${base}），请确认服务端已启动：${String(e)}`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 401 && st.token && !path.startsWith('/api/auth/login')) {
      updateAccountState({
        token: null,
        user: null,
        entitlement: null,
        devices: [],
        aiMode: 'byok',
        lastAuthNotice: data?.error || '登录状态已失效，请重新登录。',
      });
    }
    throw new Error(data?.error || `请求失败 (${resp.status})`);
  }
  return data as T;
}

export async function registerAccount(opts: { email: string; password: string; name?: string }) {
  const dev = getDeviceIdentity();
  const res = await apiFetch<{
    token: string;
    user: AccountUser;
    ledger: LedgerEntry[];
    entitlement?: AccountEntitlement;
    devices?: BoundDevice[];
  }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ ...opts, ...dev }) });
  updateAccountState({
    token: res.token,
    user: res.user,
    entitlement: res.entitlement || null,
    devices: res.devices || [],
    lastAuthNotice: null,
    aiMode: 'pro_balance',
    proCloudSpeech: false,
  });
  return res;
}

export async function loginAccount(opts: { email: string; password: string }) {
  const dev = getDeviceIdentity();
  const res = await apiFetch<{
    token: string;
    user: AccountUser;
    ledger: LedgerEntry[];
    entitlement?: AccountEntitlement;
    devices?: BoundDevice[];
  }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ ...opts, ...dev }) });
  updateAccountState({
    token: res.token,
    user: res.user,
    entitlement: res.entitlement || null,
    devices: res.devices || [],
    lastAuthNotice: null,
    aiMode: 'pro_balance',
    proCloudSpeech: false,
  });
  return res;
}

export function logoutAccount() {
  updateAccountState({
    token: null,
    user: null,
    entitlement: null,
    devices: [],
    lastAuthNotice: null,
    aiMode: 'byok',
  });
}

export async function refreshAccountMe(): Promise<{
  user: AccountUser;
  ledger: LedgerEntry[];
  entitlement?: AccountEntitlement;
  devices?: BoundDevice[];
} | null> {
  const st = getAccountState();
  if (!st.token) return null;
  const res = await apiFetch<{
    user: AccountUser;
    ledger: LedgerEntry[];
    entitlement?: AccountEntitlement;
    devices?: BoundDevice[];
  }>('/api/auth/me');
  updateAccountState({
    user: res.user,
    ...(res.entitlement ? { entitlement: res.entitlement } : {}),
    ...(res.devices ? { devices: res.devices } : {}),
    lastAuthNotice: null,
  });
  return res;
}

export async function removeBoundDevice(deviceId: string): Promise<{ devices: BoundDevice[] }> {
  const res = await apiFetch<{ ok: boolean; devices: BoundDevice[] }>('/api/auth/devices/remove', {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  });
  updateAccountState({ devices: res.devices || [] });
  return res;
}

export async function fetchBillingLedger(limit = 50): Promise<{ user: AccountUser; ledger: LedgerEntry[] }> {
  const res = await apiFetch<{ user: AccountUser; ledger: LedgerEntry[] }>(
    `/api/billing/ledger?limit=${limit}`,
  );
  updateAccountState({ user: res.user });
  return res;
}

export async function rechargeAccount(packageId: string): Promise<{
  user: AccountUser;
  entry: LedgerEntry;
  ledger: LedgerEntry[];
}> {
  const res = await apiFetch<{ user: AccountUser; entry: LedgerEntry; ledger: LedgerEntry[] }>(
    '/api/billing/recharge',
    { method: 'POST', body: JSON.stringify({ packageId }) },
  );
  updateAccountState({ user: res.user, aiMode: 'pro_balance' });
  return res;
}

export function getStoreWebsiteUrl(): string {
  const st = getAccountState();
  const base = (st.serverUrl || DEFAULT_STATE.serverUrl).replace(/\/+$/, '');
  return `${base}/site/#buy`;
}

export async function fetchStoreConfig(): Promise<StoreConfig> {
  return apiFetch<StoreConfig>('/api/store/config');
}

export async function createStoreOrder(opts: {
  planId: string;
  buyerEmail: string;
  payChannel: 'wechat' | 'alipay';
}): Promise<{ order: StoreOrder; settings: StoreSettings; sandboxPayEnabled: boolean }> {
  return apiFetch<{ order: StoreOrder; settings: StoreSettings; sandboxPayEnabled: boolean }>('/api/orders', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export async function fetchStoreOrder(
  orderNo: string,
  email: string,
): Promise<{ order: StoreOrder; sandboxPayEnabled: boolean }> {
  return apiFetch<{ order: StoreOrder; sandboxPayEnabled: boolean }>(
    `/api/orders/${encodeURIComponent(orderNo)}?email=${encodeURIComponent(email)}`,
  );
}

export async function simulatePayStoreOrder(
  orderNo: string,
  email: string,
): Promise<{ order: StoreOrder }> {
  return apiFetch<{ order: StoreOrder }>(`/api/orders/${encodeURIComponent(orderNo)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ simulate: true, email }),
  });
}

export async function redeemCode(code: string): Promise<{
  user: AccountUser;
  entry: LedgerEntry;
  ledger: LedgerEntry[];
  entitlement?: AccountEntitlement;
  devices?: BoundDevice[];
}> {
  const res = await apiFetch<{
    user: AccountUser;
    entry: LedgerEntry;
    ledger: LedgerEntry[];
    entitlement?: AccountEntitlement;
    devices?: BoundDevice[];
  }>('/api/billing/redeem', { method: 'POST', body: JSON.stringify({ code }) });
  updateAccountState({
    user: res.user,
    ...(res.entitlement ? { entitlement: res.entitlement } : {}),
    ...(res.devices ? { devices: res.devices } : {}),
    lastAuthNotice: null,
    aiMode: 'pro_balance',
  });
  return res;
}

export async function proxyChat(opts: {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  feature?: string;
}): Promise<string> {
  const st = getAccountState();
  if (!st.token) {
    throw new Error('当前处于「Lirio Pro 余额托管」模式，请先点击右上角头像或设置登录账号。');
  }
  const res = await apiFetch<{ content: string; costUnits?: number; user: AccountUser }>('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  if (res.user) updateAccountState({ user: res.user });
  if (res.costUnits && res.costUnits > 0) {
    emitLastCharge({
      amountUnits: res.costUnits,
      feature: opts.feature || 'AI 对话',
      balanceAfterUnits: res.user?.balanceUnits ?? 0,
      at: Date.now(),
    });
  }
  return res.content;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
}

export async function proxyTts(text: string, accent: Accent, voice?: string, feature = '云端语音合成'): Promise<string> {
  const st = getAccountState();
  if (!st.token) {
    throw new Error('请先登录 Lirio 账号后再使用云端语音。');
  }
  const res = await apiFetch<{ audioBase64: string; mime: string; costUnits?: number; user: AccountUser }>('/api/ai/tts', {
    method: 'POST',
    body: JSON.stringify({ text, accent, voice, feature }),
  });
  if (res.user) updateAccountState({ user: res.user });
  if (res.costUnits && res.costUnits > 0) {
    emitLastCharge({
      amountUnits: res.costUnits,
      feature,
      balanceAfterUnits: res.user?.balanceUnits ?? 0,
      at: Date.now(),
    });
  }
  return base64ToBlobUrl(res.audioBase64, res.mime);
}

export async function proxyTranscribe(wavBytes: Uint8Array, feature = '云端语音识别'): Promise<string> {
  const st = getAccountState();
  if (!st.token) {
    throw new Error('请先登录 Lirio 账号后再使用云端识别。');
  }
  const approxSec = Math.max(1, Math.round(wavBytes.length / 32000));
  const res = await apiFetch<{ text: string; costUnits?: number; user: AccountUser }>('/api/ai/transcribe', {
    method: 'POST',
    body: JSON.stringify({
      wavBase64: uint8ToBase64(wavBytes),
      durationSec: approxSec,
      feature,
    }),
  });
  if (res.user) updateAccountState({ user: res.user });
  if (res.costUnits && res.costUnits > 0) {
    emitLastCharge({
      amountUnits: res.costUnits,
      feature,
      balanceAfterUnits: res.user?.balanceUnits ?? 0,
      at: Date.now(),
    });
  }
  return res.text;
}
