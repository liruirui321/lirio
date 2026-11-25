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
import { IconClose, IconEye, IconReplay } from '../Icons';

export type GlobalSettingsTab = 'ai' | 'data';

const ACCENT_OPTS: SelectOption[] = [
  { value: 'uk', label: '英音 UK' },
  { value: 'us', label: '美音 US' },
  { value: 'au', label: '澳音 AU' },
  { value: 'in', label: '印音 IN' },
];

function isDeepSeekPeakNow(now = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = bj.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

function formatLedgerUsage(entry: LedgerEntry): string {
  if (entry.kind !== 'usage') return entry.note || '';
  const period = entry.note?.includes('高峰价')
    ? ' · 高峰价'
    : entry.note?.includes('空闲价')
      ? ' · 空闲价'
      : '';
  if (entry.outputUnits > 0 && entry.model !== 'whisper-1') {
    return `${entry.inputUnits + entry.outputUnits} tok${period}`;
  }
  return `${entry.inputUnits} 字`;
}

export function GlobalSettingsModal({
  open: isOpen,
  initialTab = 'ai',
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

  const [showTextKey, setShowTextKey] = useState(false);
  const [showSpeechKey, setShowSpeechKey] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyData, setBusyData] = useState(false);
  const [typingSound, setTypingSound] = useState<boolean>(() => isTypingSoundEnabled());

  useEffect(() => {
    if (isOpen) setTab(initialTab);
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    setPersisted(loadSpeakState());
    setTypingSound(isTypingSoundEnabled());
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

  const handleSelectMode = (mode: 'pro_balance' | 'byok') => {
    setStatusMsg('');
    setErrorMsg('');
    updateAccountState({ aiMode: mode });
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
      setStatusMsg(authMode === 'register' ? `已赠 ${formatYuan(res.user.balanceUnits, 2)}` : '已登录');
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
      setStatusMsg(`+${formatYuan(res.entry.amountUnits, 2)}`);
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
            <div className="seg-pill settings-mode-bar" role="tablist">
              <button
                type="button"
                className={account.aiMode === 'pro_balance' ? 'active' : ''}
                onClick={() => handleSelectMode('pro_balance')}
              >
                官方 API
              </button>
              <button
                type="button"
                className={account.aiMode === 'byok' ? 'active' : ''}
                onClick={() => handleSelectMode('byok')}
              >
                自配置
              </button>
            </div>

            {account.aiMode === 'pro_balance' ? (
              !account.user ? (
                <div className="account-auth-card">
                  <div className="account-auth-head">
                    <div className="seg-pill">
                      <button
                        type="button"
                        className={authMode === 'login' ? 'active' : ''}
                        onClick={() => setAuthMode('login')}
                      >
                        登录
                      </button>
                      <button
                        type="button"
                        className={authMode === 'register' ? 'active' : ''}
                        onClick={() => setAuthMode('register')}
                      >
                        注册（赠 ¥5）
                      </button>
                    </div>
                    <button
                      type="button"
                      className="dict-slow-btn"
                      onClick={() => setShowServerUrl((s) => !s)}
                    >
                      服务地址
                    </button>
                  </div>

                  {showServerUrl && (
                    <div className="speak-field">
                      <label>Server URL</label>
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
                      <label>密码</label>
                      <input
                        type="password"
                        value={password}
                        placeholder="至少 6 位"
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && email && password) void handleAuthSubmit();
                        }}
                      />
                    </div>
                  </div>

                  {authMode === 'register' && (
                    <div className="speak-field">
                      <label>昵称</label>
                      <input
                        type="text"
                        value={nickname}
                        placeholder="可选"
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
                      {authBusy ? '请稍候…' : authMode === 'register' ? '注册' : '登录'}
                    </button>
                  </div>
                  <div className="settings-rate-tip" style={{ textAlign: 'center' }}>
                    按量扣费 · 文本 ¥1~2/百万 tok · 语音 ¥0.03/千字
                  </div>
                </div>
              ) : (
                <>
                  <div className="account-profile-card">
                    <div className="account-profile-top">
                      <div className="account-avatar">{account.user.name.slice(0, 1).toUpperCase()}</div>
                      <div className="account-profile-info">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <strong>{account.user.name}</strong>
                          <span className={`tier-badge small${account.user.tier === 'pro' ? ' pro' : ''}`}>
                            {account.user.tier === 'pro' ? 'PRO' : 'TRIAL'}
                          </span>
                        </div>
                        <small>{account.user.email}</small>
                      </div>
                      <button type="button" onClick={logoutAccount}>
                        退出
                      </button>
                    </div>

                    <div className="account-balance-strip">
                      <div className="account-balance-main">
                        <span>余额</span>
                        <strong>{formatYuan(account.user.balanceUnits, 4)}</strong>
                      </div>
                      <div className="account-balance-stats">
                        <span>已充 {formatYuan(account.user.totalRechargedUnits, 2)} · 已用 {formatYuan(account.user.totalSpentUnits, 4)}</span>
                      </div>
                    </div>

                    <div className="settings-pricing-mini">
                      <div className="pricing-mini-row">
                        <span>
                          文本 <span className="pricing-period-tag">{isDeepSeekPeakNow() ? '高峰' : '空闲'}</span>
                        </span>
                        <span>
                          {isDeepSeekPeakNow()
                            ? '输入 ¥2 / 缓存 ¥0.04 / 输出 ¥8'
                            : '输入 ¥1 / 缓存 ¥0.02 / 输出 ¥4'}{' '}
                          /百万
                        </span>
                      </div>
                      <div className="pricing-mini-row">
                        <span>语音</span>
                        <span>{account.proCloudSpeech ? '¥0.03 / 千字' : '本地免费'}</span>
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
                          <strong>¥{p.payYuan}</strong>
                          <small>{p.bonusYuan > 0 ? `+¥${p.bonusYuan}` : '按量'}</small>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="settings-row-between">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>口音</span>
                      <CustomSelect
                        value={config.accent}
                        options={ACCENT_OPTS}
                        minWidth={112}
                        onChange={(val) => updateConfig({ accent: val as Accent })}
                      />
                    </div>
                    <label
                      className="settings-check-line"
                      title="按 ¥0.03/千字扣余额，关闭则使用免费本地语音"
                    >
                      <input
                        type="checkbox"
                        checked={account.proCloudSpeech}
                        onChange={(e) => updateAccountState({ proCloudSpeech: e.target.checked })}
                      />
                      云端语音
                    </label>
                  </div>

                  <div className="ledger-section">
                    <div className="ledger-head">
                      <span>账单</span>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={ledgerBusy}
                        title="刷新"
                        aria-label="刷新账单"
                        onClick={() => void handleRefreshLedger()}
                      >
                        <IconReplay size={14} />
                      </button>
                    </div>
                    {ledger.length === 0 ? (
                      <div className="corpus-empty" style={{ padding: 12 }}>
                        {ledgerBusy ? '加载中…' : '暂无记录'}
                      </div>
                    ) : (
                      <div className="ledger-list">
                        {ledger.map((row) => {
                          const isPlus = row.amountUnits >= 0;
                          const usage = formatLedgerUsage(row);
                          const timeStr = new Date(row.createdAt).toLocaleString([], {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          });
                          return (
                            <div key={row.id} className="ledger-row">
                              <div className="ledger-col-main">
                                <strong>{row.feature}</strong>
                                <small>
                                  {timeStr}
                                  {usage ? ` · ${usage}` : ''}
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

                  <div className="import-modal-actions">
                    <button type="button" disabled={testingConn} onClick={() => void handleTestConn()}>
                      {testingConn ? '测试中…' : '测试'}
                    </button>
                    <button type="button" className="primary" onClick={onClose}>
                      完成
                    </button>
                  </div>
                </>
              )
            ) : (
              <>
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
              </>
            )}
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
