import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { open as openExternalUrl } from '@tauri-apps/plugin-shell';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import type { Accent } from '../../services/corpusService';
import {
  createStoreOrder,
  evaluateLocalAccess,
  fetchBillingLedger,
  fetchMyFeedbacks,
  fetchStoreConfig,
  fetchStoreOrder,
  formatYuan,
  getAccountState,
  getDeviceIdentity,
  getStoreWebsiteUrl,
  loginAccount,
  logoutAccount,
  redeemCode,
  refreshAccountMe,
  registerAccount,
  removeBoundDevice,
  simulatePayStoreOrder,
  submitFeedback,
  subscribeAccount,
  updateAccountState,
  type AccountState,
  type FeedbackCategory,
  type FeedbackItem,
  type LedgerEntry,
  type StoreConfig,
  type StoreOrder,
} from '../../services/accountService';
import {
  exportAllStateJson,
  flushAllStateToDisk,
  forceReloadStateFromDisk,
  formatBytes,
  getStorageInfo,
  importAllStateJson,
  openStorageDir,
  resetStorageDir,
  setStorageDir,
  type StorageInfo,
} from '../../services/stateSync';
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
import { IconClose, IconEye, IconReplay } from '../Icons';

export type GlobalSettingsTab = 'ai' | 'data' | 'feedback';

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
  const [redeemInput, setRedeemInput] = useState('');
  const [showBuyPanel, setShowBuyPanel] = useState(false);
  const [storeConfig, setStoreConfig] = useState<StoreConfig | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [buyChannel, setBuyChannel] = useState<'wechat' | 'alipay'>('wechat');
  const [activeOrder, setActiveOrder] = useState<StoreOrder | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerBusy, setLedgerBusy] = useState(false);

  const [showTextKey, setShowTextKey] = useState(false);
  const [showSpeechKey, setShowSpeechKey] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyData, setBusyData] = useState(false);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [migrateOnSwitch, setMigrateOnSwitch] = useState(true);
  const [storageBusy, setStorageBusy] = useState(false);
  const [typingSound, setTypingSound] = useState<boolean>(() => isTypingSoundEnabled());
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [updateState, setUpdateState] = useState<UpdateState>(() => getUpdateState());

  const [fbCategory, setFbCategory] = useState<FeedbackCategory>('feature');
  const [fbTitle, setFbTitle] = useState('');
  const [fbContent, setFbContent] = useState('');
  const [fbAttachmentName, setFbAttachmentName] = useState('');
  const [fbAttachmentContent, setFbAttachmentContent] = useState('');
  const [fbAttachmentSize, setFbAttachmentSize] = useState(0);
  const [fbBusy, setFbBusy] = useState(false);
  const [fbList, setFbList] = useState<FeedbackItem[]>([]);
  const [fbRepoUrl, setFbRepoUrl] = useState('');
  const [fbResultLink, setFbResultLink] = useState('');

  useEffect(() => {
    if (isOpen) setTab(initialTab);
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    setPersisted(loadSpeakState());
    setTypingSound(isTypingSoundEnabled());
    setShowGuide(false);
    setUpdateState(getUpdateState());
    void initAppVersion();
    getStorageInfo().then(setStorageInfo).catch(() => {});
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
    const unsubUpd = subscribeUpdateState((next) => setUpdateState(next));
    return () => {
      unsubSpeak();
      unsubAcct();
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

  useEffect(() => {
    if (!isOpen || !showBuyPanel || !activeOrder || activeOrder.status !== 'pending') return;
    const emailForOrder = activeOrder.buyerEmail || account.user?.email || '';
    if (!emailForOrder) return;
    const timer = window.setInterval(() => {
      fetchStoreOrder(activeOrder.orderNo, emailForOrder)
        .then((res) => {
          if (res.order) setActiveOrder(res.order);
        })
        .catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [isOpen, showBuyPanel, activeOrder, account.user?.email]);

  useEffect(() => {
    if (!isOpen || tab !== 'feedback' || !account.token) return;
    fetchMyFeedbacks()
      .then((res) => {
        setFbList(res.feedbacks || []);
        setFbRepoUrl(res.repoUrl || '');
      })
      .catch(() => {});
  }, [isOpen, tab, account.token]);

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

  const handleRedeemCode = async (overrideCode?: string) => {
    const code = (overrideCode ?? redeemInput).trim();
    if (!code) {
      setErrorMsg('请输入卡密兑换码。');
      return;
    }
    setAuthBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await redeemCode(code);
      setLedger(res.ledger || []);
      if (!overrideCode) setRedeemInput('');
      setActiveOrder(null);
      setShowBuyPanel(false);
      setStatusMsg(`兑换成功 +${formatYuan(res.entry.amountUnits, 2)}`);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const openUrlSafe = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleToggleBuyPanel = async () => {
    const next = !showBuyPanel;
    setShowBuyPanel(next);
    setErrorMsg('');
    if (next && !storeConfig) {
      setStoreBusy(true);
      try {
        const cfg = await fetchStoreConfig();
        setStoreConfig(cfg);
      } catch (e) {
        setErrorMsg(String(e));
      } finally {
        setStoreBusy(false);
      }
    }
  };

  const handleCreateOrder = async (planId: string) => {
    const buyerEmail = account.user?.email || '';
    if (!buyerEmail) {
      setErrorMsg('请先登录账号再下单。');
      return;
    }
    setStoreBusy(true);
    setErrorMsg('');
    try {
      const res = await createStoreOrder({ planId, buyerEmail, payChannel: buyChannel });
      setActiveOrder(res.order);
      setStoreConfig((prev) => ({
        presets: prev?.presets || [],
        settings: res.settings,
        sandboxPayEnabled: res.sandboxPayEnabled,
      }));
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setStoreBusy(false);
    }
  };

  const handleSimulatePay = async () => {
    if (!activeOrder) return;
    setStoreBusy(true);
    setErrorMsg('');
    try {
      const res = await simulatePayStoreOrder(activeOrder.orderNo, activeOrder.buyerEmail);
      setActiveOrder(res.order);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setStoreBusy(false);
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

  const handleChangeStorageDir = async () => {
    setStorageBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: '选择 Lirio 数据存储文件夹',
      });
      if (typeof picked !== 'string' || !picked.trim()) return;
      if (migrateOnSwitch) {
        await flushAllStateToDisk();
      }
      const info = await setStorageDir(picked, migrateOnSwitch);
      setStorageInfo(info);
      if (!migrateOnSwitch) {
        await forceReloadStateFromDisk();
      }
      setStatusMsg(
        migrateOnSwitch
          ? `已切换数据目录（同步 ${info.migratedFiles} 个文件）`
          : '已切换数据目录，后续数据将存入新路径',
      );
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setStorageBusy(false);
    }
  };

  const handleResetStorageDir = async () => {
    setStorageBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      if (migrateOnSwitch) {
        await flushAllStateToDisk();
      }
      const info = await resetStorageDir(migrateOnSwitch);
      setStorageInfo(info);
      if (!migrateOnSwitch) {
        await forceReloadStateFromDisk();
      }
      setStatusMsg(
        migrateOnSwitch
          ? `已恢复默认数据目录（同步 ${info.migratedFiles} 个文件）`
          : '已恢复默认数据目录',
      );
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setStorageBusy(false);
    }
  };

  const handleOpenStorageDir = async () => {
    setErrorMsg('');
    try {
      await openStorageDir();
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handleCopyStorageDir = async () => {
    if (!storageInfo?.activeDir) return;
    try {
      await navigator.clipboard.writeText(storageInfo.activeDir);
      setStatusMsg('已复制存储路径');
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handlePickFeedbackFile = async () => {
    setErrorMsg('');
    try {
      const picked = await open({
        multiple: false,
        title: '选择文本题本或材料（≤512KB）',
        filters: [{ name: '文本文件', extensions: ['txt', 'csv', 'md', 'json', 'srt', 'lrc'] }],
      });
      if (typeof picked !== 'string' || !picked) return;
      const content = await readTextFile(picked);
      const byteSize = new TextEncoder().encode(content).length;
      if (byteSize > 512 * 1024) {
        setErrorMsg('上传文本附件不能超过 512 KB；大型听力音频请直接在软件本地导入（0 Token 自动切分）。');
        return;
      }
      const fname = picked.split(/[/\\]/).pop() || 'attachment.txt';
      setFbAttachmentName(fname);
      setFbAttachmentContent(content);
      setFbAttachmentSize(byteSize);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handleWebFeedbackFile = async (file: File | undefined) => {
    if (!file) return;
    setErrorMsg('');
    if (!/\.(txt|csv|md|json|srt|lrc)$/i.test(file.name)) {
      setErrorMsg('仅支持文本格式附件（.txt / .csv / .md / .json / .srt / .lrc），听力音频请直接本地导入。');
      return;
    }
    const content = await file.text();
    const byteSize = new TextEncoder().encode(content).length;
    if (byteSize > 512 * 1024) {
      setErrorMsg('上传文本附件不能超过 512 KB。');
      return;
    }
    setFbAttachmentName(file.name);
    setFbAttachmentContent(content);
    setFbAttachmentSize(byteSize);
  };

  const handleSubmitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    setFbBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    setFbResultLink('');
    try {
      const res = await submitFeedback({
        category: fbCategory,
        title: fbTitle,
        content: fbContent,
        attachmentName: fbAttachmentName || undefined,
        attachmentContent: fbAttachmentContent || undefined,
        appVersion: updateState.currentVersion,
      });
      setFbList((prev) => [res.feedback, ...prev]);
      setFbTitle('');
      setFbContent('');
      setFbAttachmentName('');
      setFbAttachmentContent('');
      setFbAttachmentSize(0);
      setFbResultLink(res.feedback.githubIssueUrl || res.githubNewIssueUrl || '');
      setStatusMsg(
        res.githubSynced
          ? `已提交需求并自动同步至 GitHub Issue #${res.feedback.githubIssueNumber}`
          : '已收到你的需求并记录到后台收件箱',
      );
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setFbBusy(false);
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
              <button
                type="button"
                className={tab === 'feedback' ? 'active' : ''}
                onClick={() => setTab('feedback')}
              >
                提需求
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
                    按量扣费 · 文本 ¥3~6/百万 tok · 本地语音免费
                  </div>
                  <button
                    type="button"
                    className="link-inline-btn"
                    onClick={() => void openUrlSafe(getStoreWebsiteUrl())}
                  >
                    还没激活？前往官网开通 ¥99 Lirio Pro · 永久版 ↗
                  </button>
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
                            {account.user.tier === 'pro' ? 'Pro · 永久版' : '3天体验'}
                          </span>
                        </div>
                        <small>{account.user.email}</small>
                      </div>
                      <button type="button" onClick={logoutAccount}>
                        退出
                      </button>
                    </div>

                    {(() => {
                      const accessInfo = evaluateLocalAccess(account);
                      const maxDev = account.entitlement?.maxDevices ?? 3;
                      const devs = account.devices || [];
                      const curDevId = getDeviceIdentity().deviceId;
                      return (
                        <div className="entitlement-strip">
                          <span>
                            {accessInfo.mode === 'lifetime' && accessInfo.offlineValidUntil
                              ? `Pro 永久版生效中 · 离线可用至 ${new Date(accessInfo.offlineValidUntil).toLocaleDateString('zh-CN')}`
                              : accessInfo.mode === 'trial'
                                ? `免费体验剩余约 ${accessInfo.trialRemainingHours} 小时`
                                : '授权待激活'}
                          </span>
                          {devs.length > 0 && (
                            <details className="device-details">
                              <summary>
                                已授权设备（{devs.length} / {maxDev}）
                              </summary>
                              <div className="device-list-box">
                                {devs.map((d) => (
                                  <div key={d.deviceId} className="device-row">
                                    <span>
                                      {d.deviceName || d.platform || d.deviceId.slice(0, 8)}
                                      {d.deviceId === curDevId && <em>（当前设备）</em>}
                                    </span>
                                    {d.deviceId !== curDevId && (
                                      <button
                                        type="button"
                                        className="ghost-pill-btn"
                                        disabled={authBusy}
                                        onClick={() => {
                                          setAuthBusy(true);
                                          void removeBoundDevice(d.deviceId)
                                            .then(() => setStatusMsg('已移除设备授权'))
                                            .catch((e) => setErrorMsg(String(e)))
                                            .finally(() => setAuthBusy(false));
                                        }}
                                      >
                                        下线
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      );
                    })()}

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
                            ? '输入 ¥6 / 缓存 ¥0.12 / 输出 ¥24'
                            : '输入 ¥3 / 缓存 ¥0.06 / 输出 ¥12'}{' '}
                          /百万
                        </span>
                      </div>
                      <div className="pricing-mini-row">
                        <span>语音</span>
                        <span>{account.proCloudSpeech ? '¥0.03 / 千字' : '本地免费'}</span>
                      </div>
                    </div>

                    <div className="redeem-code-wrap">
                      <div className="redeem-code-row">
                        <input
                          type="text"
                          value={redeemInput}
                          onChange={(e) => setRedeemInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !authBusy) {
                              e.preventDefault();
                              void handleRedeemCode();
                            }
                          }}
                          placeholder="输入卡密兑换码（如 LIRIO-XXXX-XXXX-XXXX）"
                          spellCheck={false}
                          autoCapitalize="characters"
                          disabled={authBusy}
                        />
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={authBusy || !redeemInput.trim()}
                          onClick={() => void handleRedeemCode()}
                        >
                          兑换
                        </button>
                      </div>
                      <div className="sub">支持 ¥99 Lirio Pro · 永久版激活码与 AI 对话加油包，兑换后立即到账</div>
                    </div>

                    <div className="redeem-actions-row">
                      <button
                        type="button"
                        className="ghost-pill-btn"
                        onClick={() => void handleToggleBuyPanel()}
                      >
                        {showBuyPanel ? '收起购卡' : '购买卡密'}
                      </button>
                      <button
                        type="button"
                        className="ghost-pill-btn"
                        onClick={() => void openUrlSafe(getStoreWebsiteUrl())}
                      >
                        官网购卡页 ↗
                      </button>
                    </div>

                    {showBuyPanel && (
                      <div className="buy-code-panel">
                        {!activeOrder ? (
                          <>
                            <div className="buy-channel-bar">
                              <span>支付方式</span>
                              <div className="buy-channel-pills">
                                <button
                                  type="button"
                                  className={buyChannel === 'wechat' ? 'active' : ''}
                                  onClick={() => setBuyChannel('wechat')}
                                >
                                  微信支付
                                </button>
                                <button
                                  type="button"
                                  className={buyChannel === 'alipay' ? 'active' : ''}
                                  onClick={() => setBuyChannel('alipay')}
                                >
                                  支付宝
                                </button>
                              </div>
                            </div>
                            {storeBusy && !storeConfig?.presets?.length ? (
                              <div className="sub">正在加载卡密套餐…</div>
                            ) : (
                              <div className="buy-pack-grid">
                                {(storeConfig?.presets || []).map((p) => {
                                  const st = storeConfig?.settings;
                                  const extUrl =
                                    p.id === 'pro_99'
                                      ? st?.shopUrlPro99
                                      : p.id === 'topup_10'
                                        ? st?.shopUrlTopup10
                                        : st?.shopUrlTopup30;
                                  return (
                                    <div key={p.id} className="buy-pack-card">
                                      <div className="buy-pack-head">
                                        <strong>{p.shortTitle || p.label}</strong>
                                        <span>¥{p.payYuan}</span>
                                      </div>
                                      <small>{p.subtitle || p.note}</small>
                                      <div className="buy-pack-btns">
                                        {extUrl ? (
                                          <button
                                            type="button"
                                            className="ghost-pill-btn"
                                            onClick={() => void openUrlSafe(extUrl)}
                                          >
                                            店铺购卡 ↗
                                          </button>
                                        ) : null}
                                        <button
                                          type="button"
                                          className="primary-btn"
                                          disabled={storeBusy}
                                          onClick={() => void handleCreateOrder(p.id)}
                                        >
                                          应用内下单
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        ) : activeOrder.status === 'paid' && activeOrder.issuedCode ? (
                          <div className="buy-order-box">
                            <div className="sub">收款已确认 · 卡密已生成（{activeOrder.orderNo}）</div>
                            <div className="buy-issued-code">{activeOrder.issuedCode}</div>
                            <div className="redeem-actions-row">
                              <button
                                type="button"
                                className="primary-btn"
                                disabled={authBusy}
                                onClick={() => void handleRedeemCode(activeOrder.issuedCode!)}
                              >
                                一键立即兑换到当前账号
                              </button>
                              <button
                                type="button"
                                className="ghost-pill-btn"
                                onClick={() => setActiveOrder(null)}
                              >
                                返回
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="buy-order-box">
                            <div className="buy-pack-head">
                              <strong>订单 {activeOrder.orderNo}</strong>
                              <span>实付 ¥{activeOrder.payYuan}</span>
                            </div>
                            {((buyChannel === 'alipay' ? storeConfig?.settings?.alipayQr : storeConfig?.settings?.wechatQr) || '') ? (
                              <img
                                className="buy-qr-img"
                                src={buyChannel === 'alipay' ? storeConfig!.settings.alipayQr : storeConfig!.settings.wechatQr}
                                alt="收款码"
                              />
                            ) : (
                              <div className="sub">店主尚未上传二维码，可点击「官网购卡页」查看详情或联系客服</div>
                            )}
                            <div className="sub">
                              {storeConfig?.settings?.paymentNotice || '付款后页面每 2.5 秒自动查询核实并出码…'}
                            </div>
                            <div className="redeem-actions-row">
                              {storeConfig?.sandboxPayEnabled && (
                                <button
                                  type="button"
                                  className="ghost-pill-btn"
                                  disabled={storeBusy}
                                  onClick={() => void handleSimulatePay()}
                                >
                                  本地演示：模拟支付并出码
                                </button>
                              )}
                              <button
                                type="button"
                                className="ghost-pill-btn"
                                onClick={() => setActiveOrder(null)}
                              >
                                取消返回
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
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
                  <span className="settings-section-title">文本模型（DeepSeek / OpenAI 兼容 API）</span>
                </div>

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

              <div className="storage-path-card">
                <div className="storage-path-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="settings-section-title">数据存储位置</span>
                    {storageInfo && (
                      <span className={`tier-badge small${storageInfo.isCustom ? ' pro' : ''}`}>
                        {storageInfo.isCustom ? '自定义目录' : '系统默认'}
                      </span>
                    )}
                  </div>
                  {storageInfo && (
                    <small style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {formatBytes(storageInfo.totalBytes)} · {storageInfo.fileCount} 个文件
                    </small>
                  )}
                </div>

                <div className="storage-path-box" title={storageInfo?.activeDir || ''}>
                  {storageInfo
                    ? storageInfo.activeDir
                    : '网页预览模式（数据暂存浏览器本地 Storage；请用导出备份迁移）'}
                </div>

                {storageInfo && (
                  <>
                    <div className="storage-path-actions">
                      <button
                        type="button"
                        disabled={storageBusy}
                        onClick={() => void handleChangeStorageDir()}
                      >
                        {storageBusy ? '处理中…' : '更改目录'}
                      </button>
                      <button
                        type="button"
                        disabled={storageBusy}
                        onClick={() => void handleOpenStorageDir()}
                      >
                        打开文件夹
                      </button>
                      <button type="button" onClick={() => void handleCopyStorageDir()}>
                        复制路径
                      </button>
                      {storageInfo.isCustom && (
                        <button
                          type="button"
                          disabled={storageBusy}
                          onClick={() => void handleResetStorageDir()}
                        >
                          恢复默认
                        </button>
                      )}
                    </div>
                    <label className="storage-migrate-check">
                      <input
                        type="checkbox"
                        checked={migrateOnSwitch}
                        onChange={(e) => setMigrateOnSwitch(e.target.checked)}
                      />
                      <span>切换时自动复制并迁移当前数据（取消勾选可直接加载目标文件夹已有备份）</span>
                    </label>
                  </>
                )}
                <small className="storage-path-hint">
                  包含精听材料库（library）、听写提交记录（submissions）、错词与口语进度（lirio_state）及音频缓存；迁移电脑时直接复制此文件夹即可。
                </small>
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
                  <strong>官方余额估算（¥10 约可用 80–270 场模考）</strong>
                  <ul>
                    <li>雅思全真模考 + 地道表达复盘：约 1–1.4 万 tok（约 ¥0.036–¥0.120 / 场）</li>
                    <li>双语闲聊 10 轮 + 复盘：约 0.8–1.1 万 tok（约 ¥0.030–¥0.105 / 次）</li>
                    <li>听力错因 AI 诊断：约 1–1.5 千 tok（约 ¥0.006–¥0.012 / 次）</li>
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

        {tab === 'feedback' && (
          <div className="settings-tab-body">
            <div className="feedback-policy-note">
              <strong>欢迎向作者提需求（直连 GitHub 仓库 Issue 跟进）</strong>
              <p>
                · 本通道主要收集 <strong>功能建议、体验改进、Bug 反馈</strong> 与轻量纯文本单词词表投稿。<br />
                · <strong>关于听力音频材料</strong>：建议优先用顶部「导入音频」在自己本机完成识别与 0 Token 自动切分；如果由软件端打包大量音频更新，会让安装包体积持续膨胀，还请谅解。如有优质公开播客链接或文本题本，欢迎留言或上传文本附件，我们会酌情纳入后续版本。
              </p>
            </div>

            {!account.token ? (
              <div className="account-auth-box">
                <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--muted)' }}>
                  请先在「AI」标签页登录你的 Lirio 账号后再提交需求或查看处理进度。
                </p>
                <button type="button" className="primary-btn" onClick={() => setTab('ai')}>
                  前往登录账号
                </button>
              </div>
            ) : (
              <>
                <form className="provider-form" onSubmit={(e) => void handleSubmitFeedback(e)}>
                  <div className="feedback-cat-pills">
                    {(
                      [
                        ['feature', '功能优化'],
                        ['vocab', '单词题本投稿'],
                        ['listening', '播客/听力建议'],
                        ['bug', '问题反馈'],
                      ] as const
                    ).map(([k, lbl]) => (
                      <button
                        key={k}
                        type="button"
                        className={fbCategory === k ? 'active' : ''}
                        onClick={() => setFbCategory(k)}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>

                  <div className="speak-field">
                    <label>需求标题</label>
                    <input
                      type="text"
                      value={fbTitle}
                      placeholder="例如：希望听写模式增加错词导出 PDF / 投稿雅思环保核心词表"
                      required
                      onChange={(e) => setFbTitle(e.target.value)}
                    />
                  </div>

                  <div className="speak-field">
                    <label>详细说明或材料内容</label>
                    <textarea
                      rows={4}
                      value={fbContent}
                      placeholder="描述你希望怎么优化、在哪个页面使用，或粘贴想投稿的词表 / 公开播客 RSS 链接…"
                      required
                      onChange={(e) => setFbContent(e.target.value)}
                    />
                  </div>

                  <div className="feedback-attachment-row">
                    <button type="button" onClick={() => void handlePickFeedbackFile()}>
                      上传文本材料/词本 (.txt/.csv/.md)
                    </button>
                    <label className="ghost-pill-btn" style={{ cursor: 'pointer' }}>
                      网页选文件
                      <input
                        type="file"
                        accept=".txt,.csv,.md,.json,.srt,.lrc"
                        style={{ display: 'none' }}
                        onChange={(e) => void handleWebFeedbackFile(e.target.files?.[0])}
                      />
                    </label>
                    {fbAttachmentName && (
                      <span className="sub">
                        已选：{fbAttachmentName} ({formatBytes(fbAttachmentSize)})
                        <button
                          type="button"
                          className="link-inline-btn"
                          style={{ marginLeft: 6 }}
                          onClick={() => {
                            setFbAttachmentName('');
                            setFbAttachmentContent('');
                            setFbAttachmentSize(0);
                          }}
                        >
                          移除
                        </button>
                      </span>
                    )}
                  </div>

                  <div className="import-modal-actions">
                    {fbRepoUrl && (
                      <button
                        type="button"
                        onClick={() => void openUrlSafe(fbRepoUrl)}
                      >
                        GitHub Issues ↗
                      </button>
                    )}
                    <button
                      type="submit"
                      className="primary"
                      disabled={fbBusy || fbTitle.trim().length < 2 || fbContent.trim().length < 4}
                    >
                      {fbBusy ? '正在提交…' : '提交需求'}
                    </button>
                  </div>
                </form>

                {fbResultLink && (
                  <div className="feedback-sync-bar">
                    <span>可直接在 GitHub 查看或补充该需求详情：</span>
                    <button
                      type="button"
                      className="link-inline-btn"
                      onClick={() => void openUrlSafe(fbResultLink)}
                    >
                      打开 GitHub Issue ↗
                    </button>
                  </div>
                )}

                {fbList.length > 0 && (
                  <div className="feedback-history-list">
                    <span className="settings-section-title">我提交过的需求（{fbList.length}）</span>
                    {fbList.map((item) => {
                      const statusText =
                        item.status === 'done'
                          ? '已上线'
                          : item.status === 'planned'
                            ? '已采纳'
                            : item.status === 'declined'
                              ? '暂不考虑'
                              : '待评估';
                      return (
                        <div key={item.id} className="feedback-history-item">
                          <div className="feedback-history-top">
                            <strong>{item.title}</strong>
                            <span className={`feedback-status-tag ${item.status}`}>{statusText}</span>
                          </div>
                          <small className="sub">
                            {new Date(item.createdAt).toLocaleString('zh-CN')}
                            {item.attachmentName ? ` · 附件：${item.attachmentName}` : ''}
                            {item.githubIssueNumber ? ` · Issue #${item.githubIssueNumber}` : ''}
                          </small>
                          {item.adminReply && (
                            <div className="feedback-admin-reply">作者回复：{item.adminReply}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
