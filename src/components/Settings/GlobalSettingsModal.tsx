import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import type { Accent } from '../../services/corpusService';
import {
  DEFAULT_RECHARGE_PACKS,
  fetchBillingLedger,
  formatYuan,
  getAccountState,
  loginAccount,
  logoutAccount,
  rechargeAccount,
  refreshAccountMe,
  registerAccount,
  subscribeAccount,
  updateAccountState,
  type AccountState,
  type LedgerEntry,
} from '../../services/accountService';
import { exportAllStateJson, importAllStateJson } from '../../services/stateSync';
import {
  PROVIDER_META,
  loadSpeakState,
  saveSpeakState,
  subscribeSpeakState,
  testProviderConnection,
  type AsrProviderId,
  type ProviderId,
  type SpeakConfig,
  type SpeakPersistedState,
  type TtsProviderId,
} from '../../services/speakService';
import { IconClose, IconEye, IconMoon, IconReplay, IconSun } from '../Icons';

export type GlobalSettingsTab = 'account' | 'ai' | 'data';

const ACCENT_OPTS: SelectOption[] = [
  { value: 'uk', label: '英音 UK' },
  { value: 'us', label: '美音 US' },
  { value: 'au', label: '澳音 AU' },
  { value: 'in', label: '印音 IN' },
];

const SILENCE_OPTS: SelectOption[] = [
  { value: '1200', label: '1.2 秒停顿发送' },
  { value: '1800', label: '1.8 秒停顿发送' },
  { value: '2400', label: '2.4 秒停顿发送' },
];

const TTS_OPTS: SelectOption[] = [
  { value: 'edge', label: 'Edge TTS（免费神经语音）' },
  { value: 'openai', label: 'OpenAI TTS（tts-1）' },
  { value: 'macos', label: 'macOS 系统离线语音' },
];

const ASR_OPTS: SelectOption[] = [
  { value: 'local_whisper', label: '本地 Whisper（离线免费）' },
  { value: 'openai', label: 'OpenAI Whisper API' },
];

const VOICE_OPTS: SelectOption[] = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'fable', label: 'Fable（英伦感）' },
  { value: 'nova', label: 'Nova' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'shimmer', label: 'Shimmer' },
];

function formatLedgerUsage(entry: LedgerEntry): string {
  if (entry.kind !== 'usage') return entry.note || '—';
  if (entry.outputUnits > 0 && entry.model !== 'whisper-1') {
    return `${entry.inputUnits + entry.outputUnits} tok`;
  }
  return entry.note || `${entry.inputUnits}`;
}

export function GlobalSettingsModal({
  open: isOpen,
  initialTab = 'account',
  onClose,
  theme,
  onThemeChange,
}: {
  open: boolean;
  initialTab?: GlobalSettingsTab;
  onClose: () => void;
  theme: 'light' | 'dark';
  onThemeChange: (next: 'light' | 'dark') => void;
}) {
  const [tab, setTab] = useState<GlobalSettingsTab>(initialTab);
  const [persisted, setPersisted] = useState<SpeakPersistedState>(() => loadSpeakState());
  const [account, setAccount] = useState<AccountState>(() => getAccountState());
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [showServerUrl, setShowServerUrl] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerBusy, setLedgerBusy] = useState(false);

  const [showApiKey, setShowApiKey] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyData, setBusyData] = useState(false);

  useEffect(() => {
    if (isOpen) setTab(initialTab);
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    setPersisted(loadSpeakState());
    const acct = getAccountState();
    setAccount(acct);
    setStatusMsg('');
    setErrorMsg('');
    if (acct.token) {
      setLedgerBusy(true);
      refreshAccountMe()
        .then((res) => {
          if (res?.ledger) setLedger(res.ledger);
        })
        .catch(() => {})
        .finally(() => setLedgerBusy(false));
    } else {
      setLedger([]);
    }
    const unsubSpeak = subscribeSpeakState((next) => setPersisted(next));
    const unsubAcct = subscribeAccount((next) => setAccount(next));
    return () => {
      unsubSpeak();
      unsubAcct();
    };
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
            saveSpeakState({
              ...cur,
              config: {
                ...cur.config,
                providers: {
                  ...cur.config.providers,
                  deepseek: { ...cur.config.providers.deepseek, apiKey: key },
                },
              },
            });
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const config = persisted.config;
  const activeProviderLabel =
    account.aiMode === 'pro_balance'
      ? 'Lirio Pro 余额托管'
      : PROVIDER_META.find((p) => p.id === config.activeProvider)?.label || config.activeProvider;

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

  const handleAuthSubmit = async () => {
    setAuthBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res =
        authMode === 'register'
          ? await registerAccount({ email, password, name: nickname })
          : await loginAccount({ email, password });
      setLedger(res.ledger || []);
      setPassword('');
      setStatusMsg(
        authMode === 'register'
          ? `注册成功！已赠送 ${formatYuan(res.user.balanceUnits)} 体验金，并切换至余额托管模式。`
          : `欢迎回来，${res.user.name}！当前余额 ${formatYuan(res.user.balanceUnits)}。`,
      );
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRecharge = async (packageId: string) => {
    setAuthBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await rechargeAccount(packageId);
      setLedger(res.ledger || []);
      setStatusMsg(`充值成功！到账 ${formatYuan(res.entry.amountUnits)}，当前余额 ${formatYuan(res.user.balanceUnits)}`);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRefreshLedger = async () => {
    setLedgerBusy(true);
    setErrorMsg('');
    try {
      const res = await fetchBillingLedger(50);
      setLedger(res.ledger || []);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setLedgerBusy(false);
    }
  };

  const handleTestConn = async () => {
    setTestingConn(true);
    setErrorMsg('');
    setStatusMsg(`正在测试「${activeProviderLabel}」连接…`);
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

  const needsSpeechKey =
    config.ttsProvider === 'openai' || config.asrProvider === 'openai';

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2>用户设置</h2>
            <div className="seg-pill" role="tablist">
              <button
                type="button"
                className={tab === 'account' ? 'active' : ''}
                onClick={() => setTab('account')}
              >
                账户与余额
              </button>
              <button
                type="button"
                className={tab === 'ai' ? 'active' : ''}
                onClick={() => setTab('ai')}
              >
                AI 与语音配置
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

        {tab === 'account' && (
          <div className="settings-tab-body">
            <div className="settings-section-title">全局 AI 计费模式（所有模块共用此设置）</div>
            <div className="settings-theme-row">
              <button
                type="button"
                className={`provider-card${account.aiMode === 'pro_balance' ? ' active' : ''}`}
                onClick={() => updateAccountState({ aiMode: 'pro_balance' })}
              >
                <strong>Lirio Pro 余额托管</strong>
                <small>免填 API Key，登录即用，按实际消耗实时扣减余额并记录账单</small>
              </button>
              <button
                type="button"
                className={`provider-card${account.aiMode === 'byok' ? ' active' : ''}`}
                onClick={() => updateAccountState({ aiMode: 'byok' })}
              >
                <strong>自有 API Key（BYOK）</strong>
                <small>使用你在「AI 与语音配置」填写的文本/语音 Key，不扣账号余额</small>
              </button>
            </div>

            {!account.user ? (
              <div className="account-auth-card">
                <div className="account-auth-head">
                  <div className="seg-pill">
                    <button
                      type="button"
                      className={authMode === 'login' ? 'active' : ''}
                      onClick={() => setAuthMode('login')}
                    >
                      登录账号
                    </button>
                    <button
                      type="button"
                      className={authMode === 'register' ? 'active' : ''}
                      onClick={() => setAuthMode('register')}
                    >
                      新用户注册（赠 ¥5）
                    </button>
                  </div>
                  <button
                    type="button"
                    className="dict-slow-btn"
                    onClick={() => setShowServerUrl((s) => !s)}
                  >
                    服务器地址
                  </button>
                </div>

                {showServerUrl && (
                  <div className="speak-field">
                    <label>Lirio Pro 服务端 URL</label>
                    <input
                      type="text"
                      value={account.serverUrl}
                      onChange={(e) => updateAccountState({ serverUrl: e.target.value })}
                    />
                  </div>
                )}

                <div className="settings-two-col">
                  <div className="speak-field">
                    <label>邮箱</label>
                    <input
                      type="email"
                      value={email}
                      placeholder="name@example.com"
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="speak-field">
                    <label>密码（至少 6 位）</label>
                    <input
                      type="password"
                      value={password}
                      placeholder="••••••"
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && email && password) void handleAuthSubmit();
                      }}
                    />
                  </div>
                </div>

                {authMode === 'register' && (
                  <div className="speak-field">
                    <label>昵称（可选）</label>
                    <input
                      type="text"
                      value={nickname}
                      placeholder="你的称呼…"
                      onChange={(e) => setNickname(e.target.value)}
                    />
                  </div>
                )}

                <div className="import-modal-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={authBusy || !email.trim() || password.length < 6}
                    onClick={() => void handleAuthSubmit()}
                  >
                    {authBusy
                      ? '请稍候…'
                      : authMode === 'register'
                        ? '注册并领取 ¥5 体验金'
                        : '登录'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="account-profile-card">
                  <div className="account-profile-top">
                    <div className="account-avatar">{account.user.name.slice(0, 1).toUpperCase()}</div>
                    <div className="account-profile-info">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>{account.user.name}</strong>
                        <span className={`tier-badge small${account.user.tier === 'pro' ? ' pro' : ''}`}>
                          {account.user.tier === 'pro' ? 'PRO 会员' : '体验版'}
                        </span>
                      </div>
                      <small>{account.user.email}</small>
                    </div>
                    <button type="button" onClick={logoutAccount}>
                      退出登录
                    </button>
                  </div>

                  <div className="account-balance-strip">
                    <div className="account-balance-main">
                      <span>当前可用余额</span>
                      <strong>{formatYuan(account.user.balanceUnits, 2)}</strong>
                    </div>
                    <div className="account-balance-stats">
                      <span>累计充值 {formatYuan(account.user.totalRechargedUnits, 2)}</span>
                      <span>累计消耗 {formatYuan(account.user.totalSpentUnits, 4)}</span>
                    </div>
                  </div>

                  <div className="account-recharge-grid">
                    {DEFAULT_RECHARGE_PACKS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="recharge-pack-btn"
                        disabled={authBusy}
                        onClick={() => void handleRecharge(p.id)}
                      >
                        <strong>{p.label}</strong>
                        <small>{p.note}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="ledger-section">
                  <div className="ledger-head">
                    <span>消费与充值账单明细</span>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={ledgerBusy}
                      title="刷新账单"
                      aria-label="刷新账单"
                      onClick={() => void handleRefreshLedger()}
                    >
                      <IconReplay size={14} />
                    </button>
                  </div>
                  {ledger.length === 0 ? (
                    <div className="corpus-empty" style={{ padding: 14 }}>
                      {ledgerBusy ? '正在读取账单…' : '暂无账单流水。'}
                    </div>
                  ) : (
                    <div className="ledger-list">
                      {ledger.map((row) => {
                        const isPlus = row.amountUnits >= 0;
                        return (
                          <div key={row.id} className="ledger-row">
                            <div className="ledger-col-main">
                              <strong>{row.feature}</strong>
                              <small>
                                {new Date(row.createdAt).toLocaleString()} · {formatLedgerUsage(row)}
                              </small>
                            </div>
                            <div className="ledger-col-amt">
                              <strong className={isPlus ? 'plus' : 'minus'}>
                                {isPlus ? '+' : '-'}
                                {formatYuan(Math.abs(row.amountUnits), isPlus ? 2 : 4)}
                              </strong>
                              <small>余 {formatYuan(row.balanceAfterUnits, 2)}</small>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'ai' && (
          <div className="settings-tab-body">
            {account.aiMode === 'pro_balance' && (
              <div className="corpus-banner" style={{ borderRadius: 10 }}>
                当前为「Lirio Pro 余额托管」模式：文本 AI 自动走平台通道并扣减余额（当前 {formatYuan(account.user?.balanceUnits, 2)}）；切换到「自有 API Key」后将使用下方自有配置。
              </div>
            )}

            <div className="settings-section-title">自有文本 AI 引擎（BYOK 模式生效）</div>
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
              语音合成与识别（TTS / ASR · 全局生效）
            </div>
            {account.aiMode === 'pro_balance' && (
              <label className="settings-check-line">
                <input
                  type="checkbox"
                  checked={account.proCloudSpeech}
                  onChange={(e) => updateAccountState({ proCloudSpeech: e.target.checked })}
                />
                语音合成与识别也使用 Lirio 云端高清（按量扣余额；关闭则使用免费 Edge TTS 与本机 Whisper）
              </label>
            )}

            <div className="settings-two-col">
              <div className="speak-field">
                <label>朗读 / 考官语音（TTS）</label>
                <CustomSelect
                  value={config.ttsProvider || 'edge'}
                  options={TTS_OPTS}
                  minWidth={180}
                  onChange={(v) => updateConfig({ ttsProvider: v as TtsProviderId })}
                />
              </div>
              <div className="speak-field">
                <label>语音转文字（ASR）</label>
                <CustomSelect
                  value={config.asrProvider || 'local_whisper'}
                  options={ASR_OPTS}
                  minWidth={180}
                  onChange={(v) => updateConfig({ asrProvider: v as AsrProviderId })}
                />
              </div>
            </div>

            {needsSpeechKey && (
              <div className="provider-form">
                <div className="settings-two-col">
                  <div className="speak-field">
                    <label>语音 API Key（留空则复用上方 OpenAI Key）</label>
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={config.speechApiKey || ''}
                      placeholder="sk-..."
                      onChange={(e) => updateConfig({ speechApiKey: e.target.value })}
                    />
                  </div>
                  <div className="speak-field">
                    <label>语音 Base URL</label>
                    <input
                      type="text"
                      value={config.speechBaseUrl || 'https://api.openai.com/v1'}
                      onChange={(e) => updateConfig({ speechBaseUrl: e.target.value })}
                    />
                  </div>
                </div>
                {config.ttsProvider === 'openai' && (
                  <div className="speak-field">
                    <label>OpenAI 音色</label>
                    <CustomSelect
                      value={config.speechVoice || 'alloy'}
                      options={VOICE_OPTS}
                      minWidth={150}
                      onChange={(v) => updateConfig({ speechVoice: v })}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="settings-inline-row">
              <div className="speak-field">
                <label>默认口音</label>
                <CustomSelect
                  value={config.accent}
                  options={ACCENT_OPTS}
                  minWidth={110}
                  onChange={(val) => updateConfig({ accent: val as Accent })}
                />
              </div>
              <div className="speak-field">
                <label>通话断句等待</label>
                <CustomSelect
                  value={String(config.silenceMs)}
                  options={SILENCE_OPTS}
                  minWidth={155}
                  onChange={(v) => updateConfig({ silenceMs: Number(v) })}
                />
              </div>
            </div>

            <label className="settings-check-line">
              <input
                type="checkbox"
                checked={config.showLiveSubtitles}
                onChange={(e) => updateConfig({ showLiveSubtitles: e.target.checked })}
              />
              对话通话时在光球下方显示渐隐实时字幕
            </label>

            <div className="import-modal-actions">
              <button type="button" disabled={testingConn} onClick={() => void handleTestConn()}>
                {testingConn ? '测试中…' : '测试当前 AI 连接'}
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
