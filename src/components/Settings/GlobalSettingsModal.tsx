import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import type { Accent } from '../../services/corpusService';
import { exportAllStateJson, importAllStateJson } from '../../services/stateSync';
import {
  PROVIDER_META,
  loadSpeakState,
  saveSpeakState,
  subscribeSpeakState,
  testProviderConnection,
  type ProviderId,
  type SpeakConfig,
  type SpeakPersistedState,
  type TtsProviderId,
} from '../../services/speakService';
import { IconClose, IconEye, IconMoon, IconSun } from '../Icons';

export type GlobalSettingsTab = 'ai' | 'data';

const ACCENT_OPTS: SelectOption[] = [
  { value: 'uk', label: '英音 UK' },
  { value: 'us', label: '美音 US' },
  { value: 'au', label: '澳音 AU' },
  { value: 'in', label: '印音 IN' },
];

const TTS_OPTS: SelectOption[] = [
  { value: 'edge', label: 'Edge TTS（默认免费）' },
  { value: 'openai', label: 'OpenAI TTS（tts-1）' },
  { value: 'macos', label: 'macOS 离线语音' },
];

const VOICE_OPTS: SelectOption[] = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'fable', label: 'Fable（英伦感）' },
  { value: 'nova', label: 'Nova' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'shimmer', label: 'Shimmer' },
];

export function GlobalSettingsModal({
  open: isOpen,
  onClose,
  theme,
  onThemeChange,
}: {
  open: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  onThemeChange: (next: 'light' | 'dark') => void;
}) {
  const [tab, setTab] = useState<GlobalSettingsTab>('ai');
  const [persisted, setPersisted] = useState<SpeakPersistedState>(() => loadSpeakState());
  const [showApiKey, setShowApiKey] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyData, setBusyData] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setPersisted(loadSpeakState());
    setStatusMsg('');
    setErrorMsg('');
    return subscribeSpeakState((next) => setPersisted(next));
  }, [isOpen]);

  // Silent auto-detect local DeepSeek key if empty
  useEffect(() => {
    if (!isOpen) return;
    const latest = loadSpeakState();
    if (!latest.config.providers.deepseek.apiKey) {
      invoke<string | null>('speak_auto_detect_deepseek')
        .then((key) => {
          if (key) {
            const cur = loadSpeakState();
            const next: SpeakPersistedState = {
              ...cur,
              config: {
                ...cur.config,
                providers: {
                  ...cur.config.providers,
                  deepseek: { ...cur.config.providers.deepseek, apiKey: key },
                },
              },
            };
            saveSpeakState(next);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const config = persisted.config;
  const activeProviderLabel =
    PROVIDER_META.find((p) => p.id === config.activeProvider)?.label || config.activeProvider;

  const updateConfig = (patch: Partial<SpeakConfig>) => {
    const latest = loadSpeakState();
    const next: SpeakPersistedState = {
      ...latest,
      config: { ...latest.config, ...patch },
    };
    saveSpeakState(next);
    setPersisted(next);
  };

  const updateProviderField = (
    pid: Exclude<ProviderId, 'local'>,
    patch: Partial<{ baseUrl: string; apiKey: string; model: string }>,
  ) => {
    const latest = loadSpeakState();
    const next: SpeakPersistedState = {
      ...latest,
      config: {
        ...latest.config,
        providers: {
          ...latest.config.providers,
          [pid]: { ...latest.config.providers[pid], ...patch },
        },
      },
    };
    saveSpeakState(next);
    setPersisted(next);
  };

  const handleTestConn = async () => {
    setTestingConn(true);
    setErrorMsg('');
    setStatusMsg('正在测试文本模型连接…');
    try {
      await testProviderConnection(config);
      setStatusMsg(`连接成功：${activeProviderLabel} 已就绪`);
    } catch (e) {
      setStatusMsg('');
      setErrorMsg('连接测试失败：' + String(e));
    } finally {
      setTestingConn(false);
    }
  };

  const handleExportBackup = async () => {
    setBusyData(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const target = await save({
        defaultPath: `lirio-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'Lirio 备份文件', extensions: ['json'] }],
      });
      if (!target) return;
      const payload = exportAllStateJson();
      await writeFile(target, new TextEncoder().encode(payload));
      setStatusMsg('学习记录与词库已导出。');
    } catch (e) {
      setErrorMsg('导出失败：' + String(e));
    } finally {
      setBusyData(false);
    }
  };

  const handleImportBackup = async () => {
    setBusyData(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: 'Lirio 备份文件', extensions: ['json'] }],
      });
      if (!picked || typeof picked !== 'string') return;
      const raw = await readTextFile(picked);
      const { restoredKeys } = importAllStateJson(raw);
      setStatusMsg(`已恢复 ${restoredKeys} 项本地数据，正在刷新界面…`);
      setTimeout(() => window.location.reload(), 650);
    } catch (e) {
      setErrorMsg('恢复失败：' + String(e));
    } finally {
      setBusyData(false);
    }
  };

  return (
    <div className="import-modal-backdrop" onClick={onClose}>
      <div
        className="import-modal global-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="全局用户设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="import-modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h2>用户设置</h2>
            <div className="seg-pill" role="tablist">
              <button
                type="button"
                className={tab === 'ai' ? 'active' : ''}
                onClick={() => setTab('ai')}
              >
                模型配置
              </button>
              <button
                type="button"
                className={tab === 'data' ? 'active' : ''}
                onClick={() => setTab('data')}
              >
                外观与数据
              </button>
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭设置" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>

        {(statusMsg || errorMsg) && (
          <div
            className={errorMsg ? 'app-error' : 'corpus-banner'}
            style={{ borderRadius: 10, padding: '8px 12px' }}
            onClick={() => {
              setStatusMsg('');
              setErrorMsg('');
            }}
          >
            {errorMsg || statusMsg}
          </div>
        )}

        {tab === 'ai' && (
          <div className="settings-tab-body">
            <div className="settings-section-title">1. 文本模型</div>
            <div className="provider-grid compact">
              {PROVIDER_META.map((p) => {
                const active = config.activeProvider === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`provider-card${active ? ' active' : ''}`}
                    onClick={() => updateConfig({ activeProvider: p.id })}
                  >
                    <strong>{p.label}</strong>
                    <small>{p.hint}</small>
                  </button>
                );
              })}
            </div>

            {config.activeProvider !== 'local' && (() => {
              const pid = config.activeProvider;
              const prof = config.providers[pid];
              return (
                <div className="provider-form">
                  <div className="settings-two-col">
                    <div className="speak-field">
                      <label>API Base URL</label>
                      <input
                        type="text"
                        value={prof.baseUrl}
                        onChange={(e) => updateProviderField(pid, { baseUrl: e.target.value })}
                      />
                    </div>
                    <div className="speak-field">
                      <label>Model</label>
                      <input
                        type="text"
                        value={prof.model}
                        onChange={(e) => updateProviderField(pid, { model: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="speak-field">
                    <label>API Key（仅保存在本机）</label>
                    <div className="settings-key-row">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={prof.apiKey}
                        placeholder="填入对应平台的 API Key…"
                        onChange={(e) => updateProviderField(pid, { apiKey: e.target.value })}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title={showApiKey ? '隐藏 Key' : '显示 Key'}
                        aria-label="切换密钥可见性"
                        onClick={() => setShowApiKey((s) => !s)}
                      >
                        <IconEye size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="settings-section-title" style={{ marginTop: 4 }}>
              2. 语音合成模型
            </div>
            <div className="settings-two-col">
              <div className="speak-field">
                <label>语音合成引擎</label>
                <CustomSelect
                  value={config.ttsProvider || 'edge'}
                  options={TTS_OPTS}
                  minWidth={180}
                  onChange={(v) => updateConfig({ ttsProvider: v as TtsProviderId })}
                />
              </div>
              <div className="speak-field">
                <label>默认口音</label>
                <CustomSelect
                  value={config.accent}
                  options={ACCENT_OPTS}
                  minWidth={130}
                  onChange={(val) => updateConfig({ accent: val as Accent })}
                />
              </div>
            </div>

            {config.ttsProvider === 'openai' && (
              <div className="provider-form">
                <div className="settings-two-col">
                  <div className="speak-field">
                    <label>语音 API Key</label>
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={config.speechApiKey || ''}
                      placeholder="留空则自动复用上方 OpenAI Key"
                      onChange={(e) => updateConfig({ speechApiKey: e.target.value })}
                    />
                  </div>
                  <div className="speak-field">
                    <label>音色</label>
                    <CustomSelect
                      value={config.speechVoice || 'alloy'}
                      options={VOICE_OPTS}
                      minWidth={150}
                      onChange={(v) => updateConfig({ speechVoice: v })}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="import-modal-actions">
              <button type="button" disabled={testingConn} onClick={() => void handleTestConn()}>
                {testingConn ? '测试中…' : '测试连接'}
              </button>
              <button type="button" className="primary" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        )}

        {tab === 'data' && (
          <div className="settings-tab-body">
            <div className="settings-section-title">界面外观</div>
            <div className="settings-theme-row">
              <button
                type="button"
                className={`provider-card${theme === 'light' ? ' active' : ''}`}
                onClick={() => onThemeChange('light')}
              >
                <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <IconSun size={15} /> Warm Paper（浅色暖纸）
                </strong>
                <small>适合白天长时间专注精听与记词</small>
              </button>
              <button
                type="button"
                className={`provider-card${theme === 'dark' ? ' active' : ''}`}
                onClick={() => onThemeChange('dark')}
              >
                <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <IconMoon size={15} /> Warm Ink（夜间墨纸）
                </strong>
                <small>低眩光暗色调，柔和护眼</small>
              </button>
            </div>

            <div className="settings-section-title" style={{ marginTop: 6 }}>
              学习记录自动备份与迁移
            </div>
            <div className="settings-data-card">
              <p>
                所有单词听写进度、错词本、口语记忆与复盘记录已实时镜像保存至本机应用数据目录（防止缓存清理丢失）。你也可以随时导出单文件手动迁移到其他设备。
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button type="button" disabled={busyData} onClick={() => void handleExportBackup()}>
                  导出全部学习记录 (.json)
                </button>
                <button type="button" disabled={busyData} onClick={() => void handleImportBackup()}>
                  从备份文件恢复
                </button>
              </div>
            </div>

            <div className="import-modal-actions">
              <button type="button" className="primary" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
