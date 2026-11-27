import { invoke } from '@tauri-apps/api/core';

export interface StorageInfo {
  activeDir: string;
  defaultDir: string;
  isCustom: boolean;
  exists: boolean;
  totalBytes: number;
  fileCount: number;
  migratedFiles: number;
}

export const STATE_SYNC_KEYS = [
  { localStorageKey: 'aboboo-corpus-state-v1', diskKey: 'corpus_state_v1' },
  { localStorageKey: 'aboboo-speak-state-v2', diskKey: 'speak_state_v2' },
  { localStorageKey: 'lirio-account-v1', diskKey: 'lirio_account_v1' },
  { localStorageKey: 'lirio-device-id-v1', diskKey: 'lirio_device_v1' },
];

const CLOUD_SYNC_AT_KEY = 'lirio-last-cloud-sync-at';
const STUDY_DISK_KEYS = new Set(['corpus_state_v1', 'speak_state_v2']);
let cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;
let cloudSyncInFlight = false;

export function getLastCloudSyncAt(): number | null {
  try {
    const raw = localStorage.getItem(CLOUD_SYNC_AT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setLastCloudSyncAt(ts: number): void {
  try {
    localStorage.setItem(CLOUD_SYNC_AT_KEY, String(ts));
  } catch {}
}

export function saveStateBackup(diskKey: string, jsonString: string): void {
  try {
    void invoke('app_state_save', { key: diskKey, value: jsonString }).catch(() => {});
  } catch {
    // Ignore when running outside Tauri webview
  }
  if (STUDY_DISK_KEYS.has(diskKey)) {
    scheduleCloudSync();
  }
}

export async function hydrateStateFromDisk(
  keys: Array<{ localStorageKey: string; diskKey: string }> = STATE_SYNC_KEYS,
): Promise<boolean> {
  let restoredAny = false;
  for (const { localStorageKey, diskKey } of keys) {
    let localValid = false;
    try {
      const existing = localStorage.getItem(localStorageKey);
      if (existing && existing.trim().length > 2) {
        JSON.parse(existing);
        localValid = true;
      }
    } catch {
      localValid = false;
    }
    if (localValid) continue;

    try {
      const diskVal = await invoke<string | null>('app_state_load', { key: diskKey });
      if (diskVal && diskVal.trim().length > 2) {
        JSON.parse(diskVal);
        localStorage.setItem(localStorageKey, diskVal);
        restoredAny = true;
      }
    } catch {
      // Ignore missing or unreadable disk backup
    }
  }
  return restoredAny;
}

function stripSecretsFromSpeakState(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  const cfg = obj.config;
  if (!cfg || typeof cfg !== 'object') return obj;
  const cfgObj = cfg as Record<string, unknown>;
  const providersRaw = cfgObj.providers;
  let cleanProviders = providersRaw;
  if (providersRaw && typeof providersRaw === 'object') {
    const provClone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(providersRaw as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        provClone[k] = { ...(v as Record<string, unknown>), apiKey: '' };
      } else {
        provClone[k] = v;
      }
    }
    cleanProviders = provClone;
  }
  return {
    ...obj,
    config: {
      ...cfgObj,
      textApiKey: '',
      speechApiKey: '',
      providers: cleanProviders,
    },
  };
}

function stripSecretsFromAccountState(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  return { ...(raw as Record<string, unknown>), token: null };
}

function mergeLocalSpeakSecrets(incoming: unknown, existingLocalRaw: string | null): unknown {
  const sanitized = stripSecretsFromSpeakState(incoming);
  if (!existingLocalRaw || !sanitized || typeof sanitized !== 'object') return sanitized;
  try {
    const localParsed = JSON.parse(existingLocalRaw) as Record<string, unknown>;
    const localCfg = localParsed?.config as Record<string, unknown> | undefined;
    const outObj = sanitized as Record<string, unknown>;
    const outCfg = (outObj.config as Record<string, unknown> | undefined) || {};
    if (!localCfg || typeof localCfg !== 'object') return sanitized;

    const mergedProviders: Record<string, unknown> =
      outCfg.providers && typeof outCfg.providers === 'object'
        ? { ...(outCfg.providers as Record<string, unknown>) }
        : {};
    if (localCfg.providers && typeof localCfg.providers === 'object') {
      for (const [k, lv] of Object.entries(localCfg.providers as Record<string, unknown>)) {
        if (lv && typeof lv === 'object' && typeof (lv as Record<string, unknown>).apiKey === 'string') {
          const curEntry =
            mergedProviders[k] && typeof mergedProviders[k] === 'object'
              ? (mergedProviders[k] as Record<string, unknown>)
              : {};
          mergedProviders[k] = {
            ...curEntry,
            apiKey: (lv as Record<string, unknown>).apiKey,
          };
        }
      }
    }

    return {
      ...outObj,
      config: {
        ...outCfg,
        textApiKey: typeof localCfg.textApiKey === 'string' ? localCfg.textApiKey : '',
        speechApiKey: typeof localCfg.speechApiKey === 'string' ? localCfg.speechApiKey : '',
        providers: mergedProviders,
      },
    };
  } catch {
    return sanitized;
  }
}

export function exportAllStateJson(): string {
  const payload: Record<string, unknown> = {
    app: 'Lirio',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: {},
  };
  const entries: Record<string, unknown> = {};
  for (const { localStorageKey } of STATE_SYNC_KEYS) {
    try {
      const raw = localStorage.getItem(localStorageKey);
      if (raw) {
        let parsed = JSON.parse(raw);
        if (localStorageKey === 'aboboo-speak-state-v2') {
          parsed = stripSecretsFromSpeakState(parsed);
        } else if (localStorageKey === 'lirio-account-v1') {
          parsed = stripSecretsFromAccountState(parsed);
        }
        entries[localStorageKey] = parsed;
      }
    } catch {}
  }
  for (const extraKey of ['aboboo-theme', 'aboboo-last-listening', 'aboboo-dict-input-style']) {
    try {
      const raw = localStorage.getItem(extraKey);
      if (raw !== null) entries[extraKey] = raw;
    } catch {}
  }
  payload.entries = entries;
  return JSON.stringify(payload, null, 2);
}

export function importAllStateJson(raw: string): { restoredKeys: number } {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error('无效的 Lirio 备份文件格式');
  }
  const allowedJsonKeys = new Set(STATE_SYNC_KEYS.map((k) => k.localStorageKey));
  const diskByLocalKey = new Map(STATE_SYNC_KEYS.map((k) => [k.localStorageKey, k.diskKey]));
  const allowedPlainKeys = new Set(['aboboo-theme', 'aboboo-last-listening', 'aboboo-dict-input-style']);
  let restoredKeys = 0;

  for (const [k, v] of Object.entries(parsed.entries as Record<string, unknown>)) {
    if (allowedJsonKeys.has(k) && v && typeof v === 'object') {
      const serialized = JSON.stringify(v);
      localStorage.setItem(k, serialized);
      const dk = diskByLocalKey.get(k);
      if (dk) saveStateBackup(dk, serialized);
      restoredKeys++;
    } else if (allowedPlainKeys.has(k) && typeof v === 'string') {
      localStorage.setItem(k, v);
      restoredKeys++;
    }
  }
  if (restoredKeys === 0) {
    throw new Error('备份文件中未包含可恢复的数据字段');
  }
  return { restoredKeys };
}

export async function flushAllStateToDisk(): Promise<void> {
  for (const { localStorageKey, diskKey } of STATE_SYNC_KEYS) {
    try {
      const raw = localStorage.getItem(localStorageKey);
      if (raw && raw.trim().length > 2) {
        await invoke('app_state_save', { key: diskKey, value: raw });
      }
    } catch {
      // Ignore outside Tauri or transient write failures
    }
  }
}

export async function forceReloadStateFromDisk(): Promise<number> {
  let loaded = 0;
  for (const { localStorageKey, diskKey } of STATE_SYNC_KEYS) {
    try {
      const diskVal = await invoke<string | null>('app_state_load', { key: diskKey });
      if (diskVal && diskVal.trim().length > 2) {
        JSON.parse(diskVal);
        localStorage.setItem(localStorageKey, diskVal);
        loaded++;
      }
    } catch {}
  }
  return loaded;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  return invoke<StorageInfo>('get_storage_info');
}

export async function setStorageDir(newDir: string, migrate: boolean): Promise<StorageInfo> {
  return invoke<StorageInfo>('set_storage_dir', { newDir, migrate });
}

export async function resetStorageDir(migrate: boolean): Promise<StorageInfo> {
  return invoke<StorageInfo>('reset_storage_dir', { migrate });
}

export async function openStorageDir(): Promise<void> {
  return invoke<void>('open_storage_dir');
}

export function formatBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const SYNC_STUDY_JSON_KEYS = [
  { localStorageKey: 'aboboo-corpus-state-v1', diskKey: 'corpus_state_v1' },
  { localStorageKey: 'aboboo-speak-state-v2', diskKey: 'speak_state_v2' },
];
const SYNC_STUDY_PLAIN_KEYS = ['aboboo-theme', 'aboboo-last-listening', 'aboboo-dict-input-style'];

export function exportSyncableStateJson(): string {
  const entries: Record<string, unknown> = {};
  for (const { localStorageKey } of SYNC_STUDY_JSON_KEYS) {
    try {
      const raw = localStorage.getItem(localStorageKey);
      if (raw) {
        let parsed = JSON.parse(raw);
        if (localStorageKey === 'aboboo-speak-state-v2') {
          parsed = stripSecretsFromSpeakState(parsed);
        }
        entries[localStorageKey] = parsed;
      }
    } catch {}
  }
  for (const k of SYNC_STUDY_PLAIN_KEYS) {
    try {
      const raw = localStorage.getItem(k);
      if (raw !== null) entries[k] = raw;
    } catch {}
  }
  return JSON.stringify(
    {
      app: 'Lirio',
      version: 1,
      syncedAt: new Date().toISOString(),
      entries,
    },
    null,
    0,
  );
}

export function applySyncedStateJson(raw: string): number {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error('无效的云端同步数据格式');
  }
  const diskByLocal = new Map(SYNC_STUDY_JSON_KEYS.map((k) => [k.localStorageKey, k.diskKey]));
  const plainSet = new Set(SYNC_STUDY_PLAIN_KEYS);
  let restored = 0;

  for (const [k, v] of Object.entries(parsed.entries as Record<string, unknown>)) {
    const dk = diskByLocal.get(k);
    if (dk && v && typeof v === 'object') {
      const valueToSave =
        k === 'aboboo-speak-state-v2'
          ? mergeLocalSpeakSecrets(v, localStorage.getItem(k))
          : v;
      const serialized = JSON.stringify(valueToSave);
      localStorage.setItem(k, serialized);
      try {
        void invoke('app_state_save', { key: dk, value: serialized }).catch(() => {});
      } catch {}
      restored++;
    } else if (plainSet.has(k) && typeof v === 'string') {
      localStorage.setItem(k, v);
      restored++;
    }
  }
  return restored;
}

function getCloudAuthContext(): { serverUrl: string; token: string; deviceName: string } | null {
  try {
    const raw = localStorage.getItem('lirio-account-v1');
    if (!raw) return null;
    const acct = JSON.parse(raw);
    const token = String(acct?.token || '').trim();
    if (!token) return null;
    const serverUrl = String(acct?.serverUrl || 'https://lirio.deltae.tech').replace(/\/+$/, '');
    let deviceName = 'Lirio Device';
    try {
      const devRaw = localStorage.getItem('lirio-device-id-v1');
      if (devRaw) {
        const d = JSON.parse(devRaw);
        if (d?.deviceName) deviceName = String(d.deviceName);
      }
    } catch {}
    return { serverUrl, token, deviceName };
  } catch {
    return null;
  }
}

export async function syncStateToCloudNow(): Promise<{ updatedAt: number; byteSize: number } | null> {
  const ctx = getCloudAuthContext();
  if (!ctx || cloudSyncInFlight) return null;
  const payload = exportSyncableStateJson();
  cloudSyncInFlight = true;
  try {
    const resp = await fetch(`${ctx.serverUrl}/api/sync/state`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.token}`,
      },
      body: JSON.stringify({ payload, deviceName: ctx.deviceName }),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    if (data?.snapshot?.updatedAt) {
      setLastCloudSyncAt(Number(data.snapshot.updatedAt));
      return {
        updatedAt: Number(data.snapshot.updatedAt),
        byteSize: Number(data.snapshot.byteSize || 0),
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    cloudSyncInFlight = false;
  }
}

export function scheduleCloudSync(delayMs = 6000): void {
  if (!getCloudAuthContext()) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    void syncStateToCloudNow();
  }, delayMs);
}

export async function restoreStateFromCloudIfLocalEmpty(): Promise<boolean> {
  const ctx = getCloudAuthContext();
  if (!ctx) return false;
  const hasLocalStudy = SYNC_STUDY_JSON_KEYS.some(({ localStorageKey }) => {
    try {
      const raw = localStorage.getItem(localStorageKey);
      return Boolean(raw && raw.trim().length > 2);
    } catch {
      return false;
    }
  });
  if (hasLocalStudy) return false;

  try {
    const resp = await fetch(`${ctx.serverUrl}/api/sync/state`, {
      headers: { Authorization: `Bearer ${ctx.token}` },
    });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => null);
    const snap = data?.snapshot;
    if (!snap?.payload) return false;
    const count = applySyncedStateJson(String(snap.payload));
    if (snap.updatedAt) setLastCloudSyncAt(Number(snap.updatedAt));
    return count > 0;
  } catch {
    return false;
  }
}
