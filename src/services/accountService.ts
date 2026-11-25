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

export interface AccountState {
  serverUrl: string;
  token: string | null;
  user: AccountUser | null;
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
const DEFAULT_STATE: AccountState = {
  serverUrl: 'http://127.0.0.1:8787',
  token: null,
  user: null,
  aiMode: 'byok',
  proCloudSpeech: false,
};

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
      return {
        ...DEFAULT_STATE,
        ...(parsed || {}),
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
      updateAccountState({ token: null, user: null, aiMode: 'byok' });
    }
    throw new Error(data?.error || `请求失败 (${resp.status})`);
  }
  return data as T;
}

export async function registerAccount(opts: { email: string; password: string; name?: string }) {
  const res = await apiFetch<{ token: string; user: AccountUser; ledger: LedgerEntry[] }>(
    '/api/auth/register',
    { method: 'POST', body: JSON.stringify(opts) },
  );
  updateAccountState({ token: res.token, user: res.user, aiMode: 'pro_balance', proCloudSpeech: false });
  return res;
}

export async function loginAccount(opts: { email: string; password: string }) {
  const res = await apiFetch<{ token: string; user: AccountUser; ledger: LedgerEntry[] }>(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify(opts) },
  );
  updateAccountState({ token: res.token, user: res.user, aiMode: 'pro_balance', proCloudSpeech: false });
  return res;
}

export function logoutAccount() {
  updateAccountState({ token: null, user: null, aiMode: 'byok' });
}

export async function refreshAccountMe(): Promise<{ user: AccountUser; ledger: LedgerEntry[] } | null> {
  const st = getAccountState();
  if (!st.token) return null;
  const res = await apiFetch<{ user: AccountUser; ledger: LedgerEntry[] }>('/api/auth/me');
  updateAccountState({ user: res.user });
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

export async function redeemCode(code: string): Promise<{
  user: AccountUser;
  entry: LedgerEntry;
  ledger: LedgerEntry[];
}> {
  const res = await apiFetch<{ user: AccountUser; entry: LedgerEntry; ledger: LedgerEntry[] }>(
    '/api/billing/redeem',
    { method: 'POST', body: JSON.stringify({ code }) },
  );
  updateAccountState({ user: res.user, aiMode: 'pro_balance' });
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
