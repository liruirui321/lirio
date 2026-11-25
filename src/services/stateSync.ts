import { invoke } from '@tauri-apps/api/core';

export const STATE_SYNC_KEYS = [
  { localStorageKey: 'aboboo-corpus-state-v1', diskKey: 'corpus_state_v1' },
  { localStorageKey: 'aboboo-speak-state-v2', diskKey: 'speak_state_v2' },
];

export function saveStateBackup(diskKey: string, jsonString: string): void {
  try {
    void invoke('app_state_save', { key: diskKey, value: jsonString }).catch(() => {});
  } catch {
    // Ignore when running outside Tauri webview
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
      if (raw) entries[localStorageKey] = JSON.parse(raw);
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
