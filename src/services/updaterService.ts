import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up_to_date'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  progressPct?: number;
  error?: string;
  dismissed?: boolean;
}

let state: UpdateState = {
  status: 'idle',
  currentVersion: '0.5.2',
};

let pendingUpdate: Update | null = null;
const listeners = new Set<(next: UpdateState) => void>();

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch {}
  });
}

export function getUpdateState(): UpdateState {
  return state;
}

export function subscribeUpdateState(listener: (next: UpdateState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissUpdateToast(): void {
  setState({ dismissed: true });
}

export async function initAppVersion(): Promise<string> {
  try {
    const v = await getVersion();
    if (v && v !== state.currentVersion) {
      setState({ currentVersion: v });
    }
    return v;
  } catch {
    return state.currentVersion;
  }
}

export async function checkForAppUpdate(opts?: { silent?: boolean }): Promise<UpdateState> {
  const silent = Boolean(opts?.silent);
  if (state.status === 'checking' || state.status === 'downloading') {
    return state;
  }
  await initAppVersion();
  setState({ status: 'checking', error: undefined });
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      setState({
        status: 'available',
        availableVersion: update.version,
        releaseNotes: update.body,
        progressPct: 0,
        dismissed: false,
      });
    } else {
      pendingUpdate = null;
      setState({
        status: silent ? 'idle' : 'up_to_date',
        availableVersion: undefined,
      });
    }
  } catch {
    pendingUpdate = null;
    setState({
      status: silent ? 'idle' : 'error',
      error: silent ? undefined : '暂未检测到可下载更新（请确认网络或已发布更新源）',
    });
  }
  return state;
}

export async function downloadAndInstallUpdate(): Promise<void> {
  if (!pendingUpdate) return;
  setState({ status: 'downloading', progressPct: 0, error: undefined, dismissed: false });
  let totalBytes = 0;
  let downloadedBytes = 0;
  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        totalBytes = event.data.contentLength || 0;
        downloadedBytes = 0;
        setState({ progressPct: 0 });
      } else if (event.event === 'Progress') {
        downloadedBytes += event.data.chunkLength || 0;
        if (totalBytes > 0) {
          const pct = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
          setState({ progressPct: pct });
        }
      } else if (event.event === 'Finished') {
        setState({ progressPct: 100 });
      }
    });
    setState({ status: 'ready', progressPct: 100, dismissed: false });
  } catch {
    setState({
      status: 'error',
      error: '下载或安装更新失败，请稍后重试',
    });
  }
}

export async function relaunchAfterUpdate(): Promise<void> {
  await relaunch();
}
