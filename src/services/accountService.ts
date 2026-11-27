import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Accent } from './corpusService';
import { recordDiagEvent } from './diagnostics';
import { isMobileDevice, isWindowsPlatform, shouldDefaultCloudSpeech } from './platform';
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

export type FeedbackCategory = 'feature' | 'vocab' | 'listening' | 'bug';
export type FeedbackStatus = 'open' | 'planned' | 'done' | 'declined';

export interface FeedbackItem {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  userTier: string;
  category: FeedbackCategory;
  title: string;
  content: string;
  attachmentName: string;
  attachmentSize: number;
  appVersion: string;
  status: FeedbackStatus;
  githubIssueNumber: number | null;
  githubIssueUrl: string;
  adminReply: string;
  createdAt: number;
  updatedAt: number;
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
  (import.meta.env?.VITE_LIRIO_SERVER_URL as string | undefined) || 'https://lirio.deltae.tech'
)
  .trim()
  .replace(/\/+$/, '');

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

export function evaluateLocalAccess(_st: AccountState = getAccountState()): LocalAccessResult {
  return {
    allowed: true,
    mode: 'lifetime',
  };
}

const listeners = new Set<(state: AccountState) => void>();

export function subscribeAccount(listener: (state: AccountState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAccountState(): AccountState {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_STATE,
        ...(parsed || {}),
        serverUrl: DEFAULT_STATE.serverUrl,
        aiMode: parsed?.aiMode === 'pro_balance' ? 'pro_balance' : 'byok',
        proCloudSpeech:
          typeof parsed?.proCloudSpeech === 'boolean'
            ? parsed.proCloudSpeech
            : shouldDefaultCloudSpeech(),
      };
    }
  } catch {}
  if (isMobileDevice()) {
    return {
      ...DEFAULT_STATE,
      aiMode: 'pro_balance',
      proCloudSpeech: true,
    };
  }
  if (isWindowsPlatform()) {
    return {
      ...DEFAULT_STATE,
      proCloudSpeech: true,
    };
  }
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

export function validateAccountId(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!/^[a-zA-Z0-9._@-]{4,32}$/.test(s) || !/[a-zA-Z0-9]/.test(s)) {
    return '账号需为 4–32 位字母、数字或下划线（不含空格）。';
  }
  return null;
}

export function validatePassword(raw: string): string | null {
  const p = String(raw || '');
  if (p.length < 6 || p.length > 32) {
    return '密码长度需为 6–32 位。';
  }
  if (/\s/.test(p)) {
    return '密码不能包含空格。';
  }
  return null;
}

export const POINTS_PER_YUAN = 100;
export const UNITS_PER_POINT = 100;

export function unitsToPoints(units: number | undefined | null): number {
  return Math.round((Number(units) || 0) / UNITS_PER_POINT);
}

export function formatPoints(units: number | undefined | null, withUnit = true): string {
  const num = unitsToPoints(units).toLocaleString('en-US');
  return withUnit ? `${num} 积分` : num;
}

export function formatYuan(units: number | undefined | null, decimals = 2): string {
  const v = (Number(units) || 0) / 10000;
  return `¥${v.toFixed(decimals)}`;
}

export function formatSmartYuan(units: number | undefined | null): string {
  const raw = Math.round(Math.abs(Number(units) || 0));
  return formatYuan(units, raw % 100 === 0 ? 2 : 4);
}

interface DirectHttpResponse {
  status: number;
  contentType: string;
  bodyText?: string | null;
  bodyBytes?: number[] | null;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x4000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

let lastDirectWarmAt = 0;
export function warmDirectConnection(): void {
  const st = getAccountState();
  const base = (st.serverUrl || DEFAULT_STATE.serverUrl).replace(/\/+$/, '');
  if (!shouldUseDirectRustTransport(base)) return;
  const now = Date.now();
  if (now - lastDirectWarmAt < 20_000) return;
  lastDirectWarmAt = now;
  void invoke('lirio_direct_request', {
    method: 'GET',
    url: `${base}/api/health`,
    headers: {},
    bodyText: null,
    bodyBytes: null,
    bodyBase64: null,
    timeoutSecs: 6,
  }).catch(() => {});
}

function shouldUseDirectRustTransport(baseUrl: string): boolean {
  if (!isTauriRuntime()) return false;
  const lower = baseUrl.trim().toLowerCase();
  return (
    lower.startsWith('https://lirio.deltae.tech') ||
    lower.startsWith('http://127.0.0.1:') ||
    lower.startsWith('http://localhost:')
  );
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

  let status = 0;
  let data: Record<string, unknown> = {};

  let handledDirect = false;
  if (shouldUseDirectRustTransport(base) && (typeof opts.body === 'string' || opts.body === undefined)) {
    try {
      const directResp = await invoke<DirectHttpResponse>('lirio_direct_request', {
        method: (opts.method || 'GET').toUpperCase(),
        url: `${base}${path}`,
        headers,
        bodyText: typeof opts.body === 'string' ? opts.body : null,
        bodyBytes: null,
        bodyBase64: null,
        timeoutSecs: 45,
      });
      status = directResp.status;
      if (directResp.bodyText) {
        try {
          data = JSON.parse(directResp.bodyText) as Record<string, unknown>;
        } catch {
          data = {};
        }
      }
      handledDirect = true;
    } catch {
      handledDirect = false;
    }
  }

  if (!handledDirect) {
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, { ...opts, headers });
    } catch {
      throw new Error('无法连接 Lirio 服务，请检查网络连接后重试。');
    }
    status = resp.status;
    data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  }

  if (status < 200 || status >= 300) {
    if (status === 401 && st.token && !path.startsWith('/api/auth/login')) {
      updateAccountState({
        token: null,
        user: null,
        entitlement: null,
        devices: [],
        aiMode: 'byok',
        lastAuthNotice:
          typeof data?.error === 'string' ? data.error : '登录状态已失效，请重新登录。',
      });
    }
    throw new Error(typeof data?.error === 'string' ? data.error : `请求失败 (${status})`);
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
  const keepCloudSpeech = getAccountState().proCloudSpeech || shouldDefaultCloudSpeech();
  updateAccountState({
    token: res.token,
    user: res.user,
    entitlement: res.entitlement || null,
    devices: res.devices || [],
    lastAuthNotice: null,
    aiMode: 'pro_balance',
    proCloudSpeech: keepCloudSpeech,
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
  const keepCloudSpeech = getAccountState().proCloudSpeech || shouldDefaultCloudSpeech();
  updateAccountState({
    token: res.token,
    user: res.user,
    entitlement: res.entitlement || null,
    devices: res.devices || [],
    lastAuthNotice: null,
    aiMode: 'pro_balance',
    proCloudSpeech: keepCloudSpeech,
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
  return `${base}/#buy`;
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

export async function submitFeedback(opts: {
  category: FeedbackCategory;
  title: string;
  content: string;
  attachmentName?: string;
  attachmentContent?: string;
  appVersion?: string;
}): Promise<{ feedback: FeedbackItem; githubSynced: boolean; githubNewIssueUrl: string }> {
  return apiFetch<{ feedback: FeedbackItem; githubSynced: boolean; githubNewIssueUrl: string }>(
    '/api/feedback',
    { method: 'POST', body: JSON.stringify(opts) },
  );
}

export async function fetchMyFeedbacks(): Promise<{ feedbacks: FeedbackItem[]; repoUrl: string }> {
  return apiFetch<{ feedbacks: FeedbackItem[]; repoUrl: string }>('/api/feedback/mine');
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
    throw new Error('当前处于「Lirio 云端账号」模式，请先点击右上角头像或设置登录账号。');
  }
  const res = await apiFetch<{ content: string; costUnits?: number; user: AccountUser }>('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  if (res.user) updateAccountState({ user: res.user });
  return res.content;
}

export async function proxyChatStream(
  opts: {
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    feature?: string;
  },
  onDelta: (delta: string) => void,
): Promise<string> {
  const st = getAccountState();
  if (!st.token) {
    throw new Error('当前处于「Lirio 云端账号」模式，请先点击右上角头像或设置登录账号。');
  }
  const base = (st.serverUrl || DEFAULT_STATE.serverUrl).replace(/\/+$/, '');
  const t0 = performance.now();

  if (shouldUseDirectRustTransport(base)) {
    const streamId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let unlisten: (() => void) | null = null;
    let receivedDelta = false;
    try {
      unlisten = await listen<{
        streamId: string;
        delta?: string | null;
        error?: string | null;
        status?: number | null;
      }>('lirio-chat-stream', (event) => {
        const p = event.payload;
        if (!p || p.streamId !== streamId) return;
        if (typeof p.delta === 'string' && p.delta.length > 0) {
          receivedDelta = true;
          onDelta(p.delta);
        }
      });

      const res = await invoke<{ status: number; content: string }>('lirio_direct_chat_stream', {
        streamId,
        url: `${base}/api/ai/chat/stream`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          Authorization: `Bearer ${st.token}`,
        },
        bodyText: JSON.stringify(opts),
      });
      recordDiagEvent({ stage: 'llm', route: 'direct-sse', durationMs: performance.now() - t0, ok: true });
      return String(res.content || '').trim();
    } catch (err) {
      const msg = String(err);
      const httpMatch = msg.match(/^HTTP_(\d+):([\s\S]*)$/);
      if (httpMatch) {
        const code = Number(httpMatch[1]);
        const detail = httpMatch[2] || `请求失败 (${code})`;
        if (code === 401) handleUnauthorized(401, st, detail);
        if (code !== 404) {
          recordDiagEvent({
            stage: 'llm',
            route: 'direct-sse',
            durationMs: performance.now() - t0,
            ok: false,
            error: detail,
          });
          throw new Error(detail);
        }
      } else if (receivedDelta) {
        recordDiagEvent({
          stage: 'llm',
          route: 'direct-sse',
          durationMs: performance.now() - t0,
          ok: false,
          error: msg,
        });
        throw new Error(msg);
      }
      // Transport failure before first delta or 404: fall through to WebView fetch / non-stream fallback
    } finally {
      unlisten?.();
    }
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}/api/ai/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: `Bearer ${st.token}`,
      },
      body: JSON.stringify(opts),
    });
  } catch (err) {
    recordDiagEvent({
      stage: 'llm',
      route: 'webview-sse',
      durationMs: performance.now() - t0,
      ok: false,
      error: String(err),
    });
    throw new Error('无法连接 Lirio 服务，请检查网络连接后重试。');
  }

  if (resp.status === 404) {
    const full = await proxyChat(opts);
    if (full) onDelta(full);
    recordDiagEvent({ stage: 'llm', route: 'fallback-chat', durationMs: performance.now() - t0, ok: true });
    return full;
  }

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    handleUnauthorized(resp.status, st, data?.error);
    const errMsg = data?.error || `请求失败 (${resp.status})`;
    recordDiagEvent({ stage: 'llm', route: 'webview-sse', durationMs: performance.now() - t0, ok: false, error: errMsg });
    throw new Error(errMsg);
  }

  if (!ct.includes('text/event-stream') || !resp.body) {
    const data = (await resp.json().catch(() => ({}))) as { content?: string; user?: AccountUser };
    if (data.user) updateAccountState({ user: data.user });
    const full = String(data.content || '').trim();
    if (full) onDelta(full);
    recordDiagEvent({ stage: 'llm', route: 'webview-json', durationMs: performance.now() - t0, ok: true });
    return full;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let assembled = '';
  let finalContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nlIdx;
    while ((nlIdx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nlIdx).trim();
      buf = buf.slice(nlIdx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let evt: { delta?: string; done?: boolean; content?: string; error?: string };
      try {
        evt = JSON.parse(raw);
      } catch {
        continue;
      }
      if (evt.error) {
        recordDiagEvent({ stage: 'llm', route: 'webview-sse', durationMs: performance.now() - t0, ok: false, error: evt.error });
        throw new Error(evt.error);
      }
      if (typeof evt.delta === 'string' && evt.delta.length > 0) {
        assembled += evt.delta;
        onDelta(evt.delta);
      }
      if (evt.done && typeof evt.content === 'string') {
        finalContent = evt.content;
      }
    }
  }

  recordDiagEvent({ stage: 'llm', route: 'webview-sse', durationMs: performance.now() - t0, ok: true });
  return (finalContent || assembled).trim();
}

function base64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
}

function handleUnauthorized(status: number, st: AccountState, errorMsg?: string) {
  if (status === 401 && st.token) {
    updateAccountState({
      token: null,
      user: null,
      entitlement: null,
      devices: [],
      aiMode: 'byok',
      lastAuthNotice: errorMsg || '登录状态已失效，请重新登录。',
    });
  }
}

export async function proxyTts(text: string, accent: Accent, voice?: string, feature = '云端语音合成'): Promise<string> {
  const st = getAccountState();
  if (!st.token) {
    throw new Error('请先登录 Lirio 账号后再使用云端语音。');
  }
  const base = (st.serverUrl || DEFAULT_STATE.serverUrl).replace(/\/+$/, '');
  const t0 = performance.now();
  const payload = JSON.stringify({ text, accent, voice, feature });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg, application/json',
    Authorization: `Bearer ${st.token}`,
  };

  if (shouldUseDirectRustTransport(base)) {
    try {
      const directResp = await invoke<DirectHttpResponse>('lirio_direct_request', {
        method: 'POST',
        url: `${base}/api/ai/tts`,
        headers,
        bodyText: payload,
        bodyBytes: null,
        bodyBase64: null,
        timeoutSecs: 30,
      });
      if (directResp.status >= 200 && directResp.status < 300) {
        if (directResp.bodyBytes && directResp.bodyBytes.length > 0) {
          recordDiagEvent({ stage: 'tts', route: 'direct-tts', durationMs: performance.now() - t0, ok: true });
          return URL.createObjectURL(
            new Blob([new Uint8Array(directResp.bodyBytes)], { type: directResp.contentType || 'audio/mpeg' }),
          );
        }
        if (directResp.bodyText) {
          const res = JSON.parse(directResp.bodyText) as { audioBase64: string; mime: string; user?: AccountUser };
          if (res.user) updateAccountState({ user: res.user });
          recordDiagEvent({ stage: 'tts', route: 'direct-tts', durationMs: performance.now() - t0, ok: true });
          return base64ToBlobUrl(res.audioBase64, res.mime);
        }
      } else {
        const errData = directResp.bodyText ? (JSON.parse(directResp.bodyText) as { error?: string }) : {};
        handleUnauthorized(directResp.status, st, errData?.error);
        const errMsg = errData?.error || `请求失败 (${directResp.status})`;
        recordDiagEvent({ stage: 'tts', route: 'direct-tts', durationMs: performance.now() - t0, ok: false, error: errMsg });
        throw new Error(errMsg);
      }
    } catch (err) {
      if (err instanceof Error && !err.message.startsWith('直连请求失败')) {
        throw err;
      }
    }
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}/api/ai/tts`, {
      method: 'POST',
      headers,
      body: payload,
    });
  } catch (err) {
    recordDiagEvent({ stage: 'tts', route: 'webview-tts', durationMs: performance.now() - t0, ok: false, error: String(err) });
    throw new Error('无法连接 Lirio 服务，请检查网络连接后重试。');
  }
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    handleUnauthorized(resp.status, st, data?.error);
    const errMsg = data?.error || `请求失败 (${resp.status})`;
    recordDiagEvent({ stage: 'tts', route: 'webview-tts', durationMs: performance.now() - t0, ok: false, error: errMsg });
    throw new Error(errMsg);
  }
  if (ct.startsWith('audio/')) {
    recordDiagEvent({ stage: 'tts', route: 'webview-tts', durationMs: performance.now() - t0, ok: true });
    return URL.createObjectURL(await resp.blob());
  }
  const res = (await resp.json()) as { audioBase64: string; mime: string; user?: AccountUser };
  if (res.user) updateAccountState({ user: res.user });
  recordDiagEvent({ stage: 'tts', route: 'webview-tts', durationMs: performance.now() - t0, ok: true });
  return base64ToBlobUrl(res.audioBase64, res.mime);
}

export async function proxyTranscribe(wavBytes: Uint8Array, _feature = '云端语音识别'): Promise<string> {
  const st = getAccountState();
  if (!st.token) {
    throw new Error('请先登录 Lirio 账号后再使用云端识别。');
  }
  const approxSec = Math.max(1, Math.round(wavBytes.length / 32000));
  const base = (st.serverUrl || DEFAULT_STATE.serverUrl).replace(/\/+$/, '');
  const t0 = performance.now();
  const headers = {
    'Content-Type': 'audio/wav',
    'X-Audio-Duration': String(approxSec),
    Authorization: `Bearer ${st.token}`,
  };

  if (shouldUseDirectRustTransport(base)) {
    try {
      const directResp = await invoke<DirectHttpResponse>('lirio_direct_request', {
        method: 'POST',
        url: `${base}/api/ai/transcribe`,
        headers,
        bodyText: null,
        bodyBytes: null,
        bodyBase64: bytesToBase64(wavBytes),
        timeoutSecs: 45,
      });
      const data = directResp.bodyText
        ? (JSON.parse(directResp.bodyText) as { text?: string; error?: string; user?: AccountUser })
        : {};
      if (directResp.status < 200 || directResp.status >= 300) {
        handleUnauthorized(directResp.status, st, data?.error);
        const errMsg = data?.error || `请求失败 (${directResp.status})`;
        recordDiagEvent({ stage: 'asr', route: 'direct-asr', durationMs: performance.now() - t0, ok: false, error: errMsg });
        throw new Error(errMsg);
      }
      if (data.user) updateAccountState({ user: data.user });
      recordDiagEvent({ stage: 'asr', route: 'direct-asr', durationMs: performance.now() - t0, ok: true });
      return String(data.text || '').trim();
    } catch (err) {
      if (err instanceof Error && !err.message.startsWith('直连请求失败')) {
        throw err;
      }
    }
  }

  let resp: Response;
  try {
    const safeBytes = new Uint8Array(wavBytes.byteLength);
    safeBytes.set(wavBytes);
    resp = await fetch(`${base}/api/ai/transcribe`, {
      method: 'POST',
      headers,
      body: new Blob([safeBytes.buffer], { type: 'audio/wav' }),
    });
  } catch (err) {
    recordDiagEvent({ stage: 'asr', route: 'webview-asr', durationMs: performance.now() - t0, ok: false, error: String(err) });
    throw new Error('无法连接 Lirio 服务，请检查网络连接后重试。');
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    handleUnauthorized(resp.status, st, data?.error);
    const errMsg = data?.error || `请求失败 (${resp.status})`;
    recordDiagEvent({ stage: 'asr', route: 'webview-asr', durationMs: performance.now() - t0, ok: false, error: errMsg });
    throw new Error(errMsg);
  }
  if (data.user) updateAccountState({ user: data.user });
  recordDiagEvent({ stage: 'asr', route: 'webview-asr', durationMs: performance.now() - t0, ok: true });
  return String(data.text || '').trim();
}

export interface StreamAsrToken {
  provider: 'tencent' | 'soniox';
  wsUrl: string;
  model: string;
  apiKey?: string;
  voiceId?: string;
  singleUse?: boolean;
  expiresAt: number;
  expiresInSeconds: number;
}

export type SonioxStreamToken = StreamAsrToken;

export async function fetchStreamAsrToken(): Promise<StreamAsrToken | null> {
  const st = getAccountState();
  if (!st.token) return null;
  const base = (st.serverUrl || DEFAULT_STATE.serverUrl).replace(/\/+$/, '');
  const t0 = performance.now();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${st.token}`,
  };

  const parseTokenResponse = (status: number, rawText: string | null | undefined, route: string): StreamAsrToken | null => {
    const data = rawText ? (JSON.parse(rawText) as Partial<StreamAsrToken> & { error?: string }) : {};
    if (status === 401) {
      handleUnauthorized(401, st, data?.error);
      recordDiagEvent({ stage: 'asr', route, durationMs: performance.now() - t0, ok: false, error: '401' });
      return null;
    }
    const provider: 'tencent' | 'soniox' = data?.provider === 'tencent' ? 'tencent' : 'soniox';
    const hasValidAuth = provider === 'tencent' ? Boolean(data?.wsUrl) : Boolean(data?.apiKey && data?.wsUrl);
    if (status < 200 || status >= 300 || !hasValidAuth) {
      recordDiagEvent({
        stage: 'asr',
        route,
        durationMs: performance.now() - t0,
        ok: false,
        error: data?.error || `status=${status}`,
      });
      return null;
    }
    recordDiagEvent({ stage: 'asr', route, durationMs: performance.now() - t0, ok: true });
    return {
      provider,
      wsUrl: String(data.wsUrl),
      model: String(data.model || (provider === 'tencent' ? '16k_zh_large' : 'stt-rt-v6')),
      ...(data.apiKey ? { apiKey: String(data.apiKey) } : {}),
      ...(data.voiceId ? { voiceId: String(data.voiceId) } : {}),
      singleUse: Boolean(data.singleUse ?? provider === 'tencent'),
      expiresAt: Number(data.expiresAt) || Date.now() + 1800_000,
      expiresInSeconds: Number(data.expiresInSeconds) || 1800,
    };
  };

  if (shouldUseDirectRustTransport(base)) {
    try {
      const directResp = await invoke<DirectHttpResponse>('lirio_direct_request', {
        method: 'POST',
        url: `${base}/api/ai/asr-stream-token`,
        headers,
        bodyText: '{}',
        bodyBytes: null,
        bodyBase64: null,
        timeoutSecs: 10,
      });
      return parseTokenResponse(directResp.status, directResp.bodyText, 'direct-asr-token');
    } catch (err) {
      if (err instanceof Error && !err.message.startsWith('直连请求失败')) {
        recordDiagEvent({ stage: 'asr', route: 'direct-asr-token', durationMs: performance.now() - t0, ok: false, error: String(err) });
        return null;
      }
    }
  }

  try {
    const resp = await fetch(`${base}/api/ai/asr-stream-token`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const rawText = await resp.text().catch(() => '');
    return parseTokenResponse(resp.status, rawText, 'webview-asr-token');
  } catch (err) {
    recordDiagEvent({ stage: 'asr', route: 'webview-asr-token', durationMs: performance.now() - t0, ok: false, error: String(err) });
    return null;
  }
}

export interface CommunityConfig {
  qqGroupNumber: string;
  qqGroupName: string;
  qqGroupQr: string;
  qqGroupLink: string;
  communityNote: string;
  supportContact: string;
}

export interface CloudSyncMeta {
  updatedAt: number;
  deviceName: string;
  byteSize: number;
}

export async function fetchCommunityConfig(): Promise<CommunityConfig> {
  const res = await apiFetch<{ ok: boolean; community: CommunityConfig }>('/api/community/config');
  return res.community;
}

export async function pushCloudSyncSnapshot(payload: string): Promise<CloudSyncMeta> {
  const { deviceName } = getDeviceIdentity();
  const res = await apiFetch<{ ok: boolean; snapshot: CloudSyncMeta }>('/api/sync/state', {
    method: 'PUT',
    body: JSON.stringify({ payload, deviceName }),
  });
  return res.snapshot;
}

export async function pullCloudSyncSnapshot(): Promise<(CloudSyncMeta & { payload: string }) | null> {
  const res = await apiFetch<{ ok: boolean; snapshot: (CloudSyncMeta & { payload: string }) | null }>('/api/sync/state');
  return res.snapshot;
}
