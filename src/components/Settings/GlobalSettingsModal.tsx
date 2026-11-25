import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import type { Accent } from '../../services/corpusService';
import { exportAllStateJson, importAllStateJson } from '../../services/stateSync';
import {
  loadSpeakState,
  saveSpeakState,
  subscribeSpeakState,
  testProviderConnection,
  type SpeakConfig,
  type SpeakPersistedState,
} from '../../services/speakService';
import {
  isTypingSoundEnabled,
  playTypingClick,
  setTypingSoundEnabled,
} from '../../services/typingSound';
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  getUpdateState,
  initAppVersion,
  relaunchAfterUpdate,
  subscribeUpdateState,
  type UpdateState,
} from '../../services/updaterService';
import { IconClose, IconEye } from '../Icons';

export type GlobalSettingsTab = 'ai' | 'data';

const ACCENT_OPTS: SelectOption[] = [
  { value: 'uk', label: '英音 UK' },
  { value: 'us', label: '美音 US' },
  { value: 'au', label: '澳音 AU' },
  { value: 'in', label: '印音 IN' },
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
  const [showTextKey, setShowTextKey] = useState(false);
  const [showSpeechKey, setShowSpeechKey] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyData, setBusyData] = useState(false);
  const [typingSound, setTypingSound] = useState<boolean>(() => isTypingSoundEnabled());
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [updateState, setUpdateState] = useState<UpdateState>(() => getUpdateState());

  useEffect(() => {
    if (!isOpen) return;
    setPersisted(loadSpeakState());
    setTypingSound(isTypingSoundEnabled());
    setShowGuide(false);
    setUpdateState(getUpdateState());
    void initAppVersion();
    setStatusMsg('');
    setErrorMsg('');
    const unsubSpeak = subscribeSpeakState((next) => setPersisted(next));
    const unsubUpd = subscribeUpdateState((next) => setUpdateState(next));
    return () => {
      unsubSpeak();
      unsubUpd();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const latest = loadSpeakState();
    if (!latest.config.textApiKey && (latest.config.textApiUrl || '').includes('deepseek')) {
      invoke<string | null>('speak_auto_detect_deepseek')
        .then((key) => {
          if (key) {
            const cur = loadSpeakState();
            saveSpeakState({
              ...cur,
              config: { ...cur.config, textApiKey: key },
            });
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const config = persisted.config;

  const updateConfig = (patch: Partial<SpeakConfig>) => {
    const latest = loadSpeakState();
    const next: SpeakPersistedState = {
      ...latest,
      config: { ...latest.config, ...patch },
    };
    saveSpeakState(next);
    setPersisted(next);
  };

  const handleTestConn = async () => {
    setTestingConn(true);
    setErrorMsg('');
    setStatusMsg('测试中…');
    try {
      await testProviderConnection(config);
      setStatusMsg('已连接');
    } catch (e) {
      setStatusMsg('');
      setErrorMsg(String(e));
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
      await writeFile(target, new TextEncoder().encode(exportAllStateJson()));
      setStatusMsg('已导出');
    } catch (e) {
      setErrorMsg(String(e));
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
      setStatusMsg(`已恢复 ${restoredKeys} 项，即将刷新…`);
      setTimeout(() => window.location.reload(), 650);
    } catch (e) {
      setErrorMsg(String(e));
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
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="import-modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h2>设置</h2>
            <div className="seg-pill" role="tablist">
              <button
                type="button"
                className={tab === 'ai' ? 'active' : ''}
                onClick={() => setTab('ai')}
              >
                AI
              </button>
              <button
                type="button"
                className={tab === 'data' ? 'active' : ''}
                onClick={() => setTab('data')}
              >
                通用
              </button>
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>

        {(statusMsg || errorMsg) && (
          <div
            className={errorMsg ? 'app-error' : 'corpus-banner'}
            style={{ borderRadius: 10, padding: '7px 12px' }}
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
            <div className="settings-row-between">
              <span className="settings-section-title">文本模型</span>
              <div className="seg-pill">
                <button
                  type="button"
                  className={config.textMode !== 'local' ? 'active' : ''}
                  onClick={() => updateConfig({ textMode: 'api' })}
                >
                  API
                </button>
                <button
                  type="button"
                  className={config.textMode === 'local' ? 'active' : ''}
                  onClick={() => updateConfig({ textMode: 'local' })}
                >
                  本地
                </button>
              </div>
            </div>

            {config.textMode === 'local' ? (
              <div className="provider-form">
                <small style={{ color: 'var(--muted)' }}>内置离线 Qwen</small>
              </div>
            ) : (
              <div className="provider-form">
                <div className="settings-two-col">
                  <div className="speak-field">
                    <label>URL</label>
                    <input
                      type="text"
                      value={config.textApiUrl || ''}
                      placeholder="https://api.deepseek.com/v1"
                      onChange={(e) => updateConfig({ textApiUrl: e.target.value })}
                    />
                  </div>
                  <div className="speak-field">
                    <label>Model</label>
                    <input
                      type="text"
                      value={config.textModel || ''}
                      placeholder="deepseek-chat"
                      onChange={(e) => updateConfig({ textModel: e.target.value })}
                    />
                  </div>
                </div>
                <div className="speak-field">
                  <label>API Key</label>
                  <div className="settings-key-row">
                    <input
                      type={showTextKey ? 'text' : 'password'}
                      value={config.textApiKey || ''}
                      placeholder="sk-..."
                      onChange={(e) => updateConfig({ textApiKey: e.target.value })}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title={showTextKey ? '隐藏' : '显示'}
                      aria-label="切换密钥"
                      onClick={() => setShowTextKey((s) => !s)}
                    >
                      <IconEye size={15} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="settings-row-between" style={{ marginTop: 2 }}>
              <span className="settings-section-title">语音合成</span>
              <div className="seg-pill">
                <button
                  type="button"
                  className={config.speechMode !== 'api' ? 'active' : ''}
                  onClick={() => updateConfig({ speechMode: 'local' })}
                >
                  本地
                </button>
                <button
                  type="button"
                  className={config.speechMode === 'api' ? 'active' : ''}
                  onClick={() => updateConfig({ speechMode: 'api' })}
                >
                  API
                </button>
              </div>
            </div>

            <div className="provider-form">
              <div className="settings-row-between">
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>口音</span>
                <CustomSelect
                  value={config.accent}
                  options={ACCENT_OPTS}
                  minWidth={118}
                  onChange={(val) => updateConfig({ accent: val as Accent })}
                />
              </div>

              {config.speechMode === 'api' && (
                <>
                  <div className="settings-two-col">
                    <div className="speak-field">
                      <label>URL</label>
                      <input
                        type="text"
                        value={config.speechBaseUrl || ''}
                        placeholder="https://api.openai.com/v1"
                        onChange={(e) => updateConfig({ speechBaseUrl: e.target.value })}
                      />
                    </div>
                    <div className="speak-field">
                      <label>Model / Voice</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="text"
                          value={config.speechModel || ''}
                          placeholder="tts-1"
                          onChange={(e) => updateConfig({ speechModel: e.target.value })}
                        />
                        <input
                          type="text"
                          value={config.speechVoice || ''}
                          placeholder="alloy"
                          style={{ width: 84 }}
                          onChange={(e) => updateConfig({ speechVoice: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="speak-field">
                    <label>API Key</label>
                    <div className="settings-key-row">
                      <input
                        type={showSpeechKey ? 'text' : 'password'}
                        value={config.speechApiKey || ''}
                        placeholder="sk-..."
                        onChange={(e) => updateConfig({ speechApiKey: e.target.value })}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title={showSpeechKey ? '隐藏' : '显示'}
                        aria-label="切换语音密钥"
                        onClick={() => setShowSpeechKey((s) => !s)}
                      >
                        <IconEye size={15} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="import-modal-actions">
              <button type="button" disabled={testingConn} onClick={() => void handleTestConn()}>
                {testingConn ? '测试中…' : '测试'}
              </button>
              <button type="button" className="primary" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        )}

        {tab === 'data' && (
          <div className="settings-tab-body">
            <div className="provider-form">
              <div className="settings-row-between">
                <span className="settings-section-title">外观</span>
                <div className="seg-pill">
                  <button
                    type="button"
                    className={theme === 'light' ? 'active' : ''}
                    onClick={() => onThemeChange('light')}
                  >
                    浅色
                  </button>
                  <button
                    type="button"
                    className={theme === 'dark' ? 'active' : ''}
                    onClick={() => onThemeChange('dark')}
                  >
                    深色
                  </button>
                </div>
              </div>

              <div className="settings-row-between">
                <span className="settings-section-title">打字音效</span>
                <div className="seg-pill">
                  <button
                    type="button"
                    className={typingSound ? 'active' : ''}
                    onClick={() => {
                      setTypingSoundEnabled(true);
                      setTypingSound(true);
                      playTypingClick('char');
                    }}
                  >
                    开启
                  </button>
                  <button
                    type="button"
                    className={!typingSound ? 'active' : ''}
                    onClick={() => {
                      setTypingSoundEnabled(false);
                      setTypingSound(false);
                    }}
                  >
                    关闭
                  </button>
                </div>
              </div>

              <div className="settings-row-between">
                <span className="settings-section-title">数据</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" disabled={busyData} onClick={() => void handleExportBackup()}>
                    导出备份
                  </button>
                  <button type="button" disabled={busyData} onClick={() => void handleImportBackup()}>
                    导入恢复
                  </button>
                </div>
              </div>

              <div className="settings-row-between">
                <div className="settings-version-meta">
                  <span className="settings-section-title">版本</span>
                  <small>
                    v{updateState.currentVersion}
                    {updateState.status === 'up_to_date' && ' · 已是最新'}
                    {updateState.status === 'error' && ' · 暂未检测到更新'}
                  </small>
                </div>
                {updateState.status === 'available' ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void downloadAndInstallUpdate()}
                  >
                    下载 v{updateState.availableVersion}
                  </button>
                ) : updateState.status === 'downloading' ? (
                  <button type="button" disabled>
                    下载中 {updateState.progressPct ?? 0}%
                  </button>
                ) : updateState.status === 'ready' ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void relaunchAfterUpdate()}
                  >
                    立即重启
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={updateState.status === 'checking'}
                    onClick={() => void checkForAppUpdate({ silent: false })}
                  >
                    {updateState.status === 'checking' ? '检查中…' : '检查更新'}
                  </button>
                )}
              </div>

              <div className="settings-row-between">
                <div className="settings-version-meta">
                  <span className="settings-section-title">手册</span>
                  <small>费用与使用说明</small>
                </div>
                <button type="button" onClick={() => setShowGuide((v) => !v)}>
                  {showGuide ? '收起' : '查看'}
                </button>
              </div>
            </div>

            {showGuide && (
              <div className="settings-guide-card">
                <div className="guide-block">
                  <strong>完全免费 · 0 Token（本地运行）</strong>
                  <p>
                    自定义上传音频与自动意群切分（本地 Whisper + 本地分句）、默认本地语音朗读与识别、听写与错词本均永久免费。
                  </p>
                </div>
                <div className="guide-block">
                  <strong>DeepSeek 文本估算（¥10 约可用 250–800 场模考）</strong>
                  <ul>
                    <li>雅思全真模考 + 四维复盘：约 1–1.4 万 tok（约 ¥0.012–¥0.040 / 场）</li>
                    <li>双语闲聊 10 轮 + 复盘：约 0.8–1.1 万 tok（约 ¥0.010–¥0.035 / 次）</li>
                    <li>听力错因 AI 诊断：约 1–1.5 千 tok（约 ¥0.002–¥0.004 / 次）</li>
                  </ul>
                </div>
              </div>
            )}

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
