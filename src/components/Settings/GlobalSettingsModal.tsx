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

  useEffect(() => {
    if (!isOpen) return;
    setPersisted(loadSpeakState());
    setStatusMsg('');
    setErrorMsg('');
    return subscribeSpeakState((next) => setPersisted(next));
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
