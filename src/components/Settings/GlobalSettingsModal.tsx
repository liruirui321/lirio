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
import { IconClose, IconEye, IconMoon, IconSun } from '../Icons';

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

  // Silent auto-detect local DeepSeek key if empty
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
              config: {
                ...cur.config,
                textApiKey: key,
              },
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
    setStatusMsg('正在测试文本模型连接…');
    try {
      await testProviderConnection(config);
      setStatusMsg(
        config.textMode === 'local'
          ? '连接成功：本地离线模型已就绪'
          : `连接成功：${config.textModel || '自定义文本 API'} 已就绪`,
      );
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
            {/* 1. Generic Text Model */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="settings-section-title">1. 文本模型（通用 OpenAI 接口格式）</span>
              <div className="seg-pill">
                <button
                  type="button"
                  className={config.textMode !== 'local' ? 'active' : ''}
                  onClick={() => updateConfig({ textMode: 'api' })}
                >
                  自定义 API
                </button>
                <button
                  type="button"
                  className={config.textMode === 'local' ? 'active' : ''}
                  onClick={() => updateConfig({ textMode: 'local' })}
                >
                  本地离线模型
                </button>
              </div>
            </div>

            {config.textMode === 'local' ? (
              <div className="provider-form">
                <small style={{ color: 'var(--muted)' }}>
                  使用本机内置离线 Qwen 模型，无需填写 URL 与 API Key。
                </small>
              </div>
            ) : (
              <div className="provider-form">
                <div className="settings-two-col">
                  <div className="speak-field">
                    <label>API URL</label>
                    <input
                      type="text"
                      value={config.textApiUrl || ''}
                      placeholder="https://api.deepseek.com/v1"
                      onChange={(e) => updateConfig({ textApiUrl: e.target.value })}
                    />
                  </div>
                  <div className="speak-field">
                    <label>模型名称（Model）</label>
                    <input
                      type="text"
                      value={config.textModel || ''}
                      placeholder="如 deepseek-chat / gpt-4o-mini"
                      onChange={(e) => updateConfig({ textModel: e.target.value })}
                    />
                  </div>
                </div>
                <div className="speak-field">
                  <label>API Key（仅保存在本机）</label>
                  <div className="settings-key-row">
                    <input
                      type={showTextKey ? 'text' : 'password'}
                      value={config.textApiKey || ''}
                      placeholder="填入文本模型 API Key…"
                      onChange={(e) => updateConfig({ textApiKey: e.target.value })}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title={showTextKey ? '隐藏 Key' : '显示 Key'}
                      aria-label="切换密钥可见性"
                      onClick={() => setShowTextKey((s) => !s)}
                    >
                      <IconEye size={15} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 2. Generic Speech Synthesis Model */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
              <span className="settings-section-title">2. 语音合成模型</span>
              <div className="seg-pill">
                <button
                  type="button"
                  className={config.speechMode !== 'api' ? 'active' : ''}
                  onClick={() => updateConfig({ speechMode: 'local' })}
                >
                  本地免费语音
                </button>
                <button
                  type="button"
                  className={config.speechMode === 'api' ? 'active' : ''}
                  onClick={() => updateConfig({ speechMode: 'api' })}
                >
                  自定义语音 API
                </button>
              </div>
            </div>

            <div className="provider-form">
              <div className="settings-inline-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="speak-field">
                  <label>默认口音</label>
                  <CustomSelect
                    value={config.accent}
                    options={ACCENT_OPTS}
                    minWidth={130}
                    onChange={(val) => updateConfig({ accent: val as Accent })}
                  />
                </div>
                {config.speechMode !== 'api' && (
                  <small style={{ color: 'var(--muted)', flex: 1 }}>
                    默认使用本地神经语音（Edge TTS），离线自动回退 macOS 系统语音，无需 API Key。
                  </small>
                )}
              </div>

              {config.speechMode === 'api' && (
                <>
                  <div className="settings-two-col">
                    <div className="speak-field">
                      <label>语音 API URL</label>
                      <input
                        type="text"
                        value={config.speechBaseUrl || ''}
                        placeholder="https://api.openai.com/v1"
                        onChange={(e) => updateConfig({ speechBaseUrl: e.target.value })}
                      />
                    </div>
                    <div className="speak-field">
                      <label>语音模型 & 音色</label>
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
                          style={{ width: 92 }}
                          onChange={(e) => updateConfig({ speechVoice: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="speak-field">
                    <label>语音 API Key（仅保存在本机）</label>
                    <div className="settings-key-row">
                      <input
                        type={showSpeechKey ? 'text' : 'password'}
                        value={config.speechApiKey || ''}
                        placeholder="填入语音合成 API Key…"
                        onChange={(e) => updateConfig({ speechApiKey: e.target.value })}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title={showSpeechKey ? '隐藏 Key' : '显示 Key'}
                        aria-label="切换语音密钥可见性"
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
