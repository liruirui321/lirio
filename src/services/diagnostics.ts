import { invoke } from '@tauri-apps/api/core';
import { getAccountState } from './accountService';
import { loadSpeakState } from './speakService';

export type DiagStage = 'asr' | 'llm' | 'tts' | 'api' | 'import';

export interface DiagEvent {
  at: string;
  stage: DiagStage;
  route: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

interface RustEnvironmentDiagnostics {
  os: string;
  arch: string;
  hasLocalWhisper: boolean;
  hasLocalEdgeTts: boolean;
  systemProxy: string;
  directHealthOk: boolean;
  directHealthStatus: number | null;
  directHealthMs: number;
  directHealthError: string | null;
}

const MAX_EVENTS = 12;
const recentEvents: DiagEvent[] = [];

function redactDiagError(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/https?:\/\/[^/\s]+/gi, (m) => {
      try {
        return new URL(m).origin;
      } catch {
        return '[url]';
      }
    })
    .slice(0, 140);
}

export function recordDiagEvent(ev: Omit<DiagEvent, 'at'>): void {
  recentEvents.push({
    at: new Date().toISOString().slice(11, 19),
    stage: ev.stage,
    route: ev.route,
    durationMs: Math.max(0, Math.round(ev.durationMs)),
    ok: ev.ok,
    ...(ev.error ? { error: redactDiagError(ev.error) } : {}),
  });
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_EVENTS);
  }
}

function safeHostname(rawUrl?: string): string {
  try {
    return new URL((rawUrl || '').trim()).hostname || '';
  } catch {
    return '';
  }
}

async function measureWebviewHealth(serverUrl: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const resp = await fetch(`${serverUrl}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
    return { ok: resp.ok, ms: Math.round(performance.now() - t0), ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: redactDiagError(String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectSanitizedDiagnostics(
  appVersion: string,
): Promise<{ summaryText: string; data: Record<string, unknown> }> {
  const acct = getAccountState();
  const speakCfg = loadSpeakState().config;
  const serverUrl = (acct.serverUrl || 'https://lirio.deltae.tech').replace(/\/+$/, '');
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const [rustEnv, webHealth] = await Promise.all([
    inTauri
      ? invoke<RustEnvironmentDiagnostics>('diagnose_environment', { serverUrl }).catch(() => null)
      : Promise.resolve(null),
    measureWebviewHealth(serverUrl),
  ]);

  const directMs = rustEnv?.directHealthMs ?? null;
  const proxyDetourLikely =
    Boolean(rustEnv?.directHealthOk && directMs !== null && webHealth.ms > Math.max(800, directMs * 3));

  const data: Record<string, unknown> = {
    appVersion,
    runtime: inTauri ? 'tauri' : 'web',
    loggedIn: Boolean(acct.token),
    aiMode: acct.aiMode,
    proCloudSpeech: acct.proCloudSpeech,
    serverHost: safeHostname(serverUrl),
    configFlags: {
      activeProvider: speakCfg.activeProvider,
      textApiHost: safeHostname(speakCfg.textApiUrl),
      textModel: speakCfg.textModel || '',
      hasCustomTextKey: Boolean((speakCfg.textApiKey || '').trim()),
      speechMode: speakCfg.speechMode || 'local',
      ttsProvider: speakCfg.ttsProvider || 'edge',
      asrProvider: speakCfg.asrProvider || 'local_whisper',
      hasCustomSpeechKey: Boolean((speakCfg.speechApiKey || '').trim()),
      silenceMs: speakCfg.silenceMs,
    },
    environment: rustEnv
      ? {
          os: rustEnv.os,
          arch: rustEnv.arch,
          hasLocalWhisper: rustEnv.hasLocalWhisper,
          hasLocalEdgeTts: rustEnv.hasLocalEdgeTts,
          systemProxy: rustEnv.systemProxy,
        }
      : {
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : '',
        },
    networkProbe: {
      directHealthOk: rustEnv?.directHealthOk ?? null,
      directHealthMs: directMs,
      directHealthError: rustEnv?.directHealthError ?? null,
      webviewHealthOk: webHealth.ok,
      webviewHealthMs: webHealth.ms,
      webviewHealthError: webHealth.error ?? null,
      proxyDetourLikely,
    },
    recentPerf: recentEvents.slice(-8),
  };

  const summaryText = `### 环境诊断快照（已脱敏）\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { summaryText, data };
}
