import { invoke } from '@tauri-apps/api/core';

export type MicPermissionStatus = 'granted' | 'prompt' | 'denied' | 'unsupported';

const FIRST_RUN_MIC_KEY = 'lirio-mic-prompt-v1';

export function hasDismissedFirstRunMicPrompt(): boolean {
  try {
    return Boolean(localStorage.getItem(FIRST_RUN_MIC_KEY));
  } catch {
    return false;
  }
}

export function markFirstRunMicPrompt(val: 'granted' | 'later'): void {
  try {
    localStorage.setItem(FIRST_RUN_MIC_KEY, val);
  } catch {}
}

export async function checkMicPermission(): Promise<MicPermissionStatus> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unsupported';
  }

  let queried: MicPermissionStatus | null = null;
  if (navigator.permissions?.query) {
    try {
      const res = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (res.state === 'granted' || res.state === 'denied' || res.state === 'prompt') {
        queried = res.state;
      }
    } catch {
      // Safari / WKWebView may throw for 'microphone' permission query
    }
  }

  if (queried === 'granted' || queried === 'denied') {
    return queried;
  }

  if (navigator.mediaDevices.enumerateDevices) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devs.filter((d) => d.kind === 'audioinput');
      if (audioInputs.some((d) => Boolean(d.label && d.label.trim()))) {
        return 'granted';
      }
    } catch {}
  }

  return queried || 'prompt';
}

export async function requestMicPermission(): Promise<{
  ok: boolean;
  status: MicPermissionStatus;
  error?: string;
}> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      status: 'unsupported',
      error: '当前运行环境不支持麦克风录音，请使用 Lirio 客户端。',
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    markFirstRunMicPrompt('granted');
    return { ok: true, status: 'granted' };
  } catch (err) {
    const name = String((err as { name?: string })?.name || '');
    const msg = String((err as { message?: string })?.message || err || '');
    if (
      name === 'NotFoundError' ||
      name === 'DevicesNotFoundError' ||
      /not found|no device/i.test(msg)
    ) {
      return {
        ok: false,
        status: 'unsupported',
        error: '未检测到可用麦克风设备，请检查设备连接。',
      };
    }
    if (
      name === 'NotAllowedError' ||
      name === 'PermissionDeniedError' ||
      name === 'SecurityError' ||
      /denied|not allowed|permission/i.test(msg)
    ) {
      return {
        ok: false,
        status: 'denied',
        error: '麦克风权限未开启，请在系统设置中允许 Lirio 使用麦克风。',
      };
    }
    return {
      ok: false,
      status: 'denied',
      error: `无法访问麦克风：${msg || '未知错误'}`,
    };
  }
}

export async function openSystemMicSettings(): Promise<void> {
  await invoke('open_mic_settings');
}
