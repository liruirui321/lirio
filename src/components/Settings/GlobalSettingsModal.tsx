import { useEffect, useRef, useState } from 'react';
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
  validateAccountId,
  validatePassword,
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
import { IconClose, IconEye, IconReplay, IconUpload } from '../Icons';

export type GlobalSettingsTab = 'ai' | 'data' | 'feedback';

const FEEDBACK_CAT_META: Record<
  FeedbackCategory,
  {
    label: string;
    titleLabel: string;
    titlePlaceholder: string;
    contentLabel: string;
    contentPlaceholder: string;
    modules?: string[];
    showSourceUrl?: boolean;
    uploadTitle?: string;
  }
> = {
  feature: {
    label: '功能优化',
    titleLabel: '建议标题',
    titlePlaceholder: '希望新增或优化什么功能？',
    contentLabel: '详细说明',
    contentPlaceholder: '简述使用场景与期待效果…',
    modules: ['听力', '单词', '对话', '其他'],
  },
  vocab: {
    label: '词本投稿',
    titleLabel: '词本名称',
    titlePlaceholder: '例如：雅思环保高频词表（200 词）',
    contentLabel: '词表内容',
    contentPlaceholder: '直接粘贴单词列表，或点击左下角上传图标导入 .txt / .csv / .md…',
    uploadTitle: '上传词本 (.txt / .csv / .md，≤512KB)',
  },
  listening: {
    label: '听力建议',
    titleLabel: '材料 / 播客名称',
    titlePlaceholder: '例如：BBC 6 Minute English',
    contentLabel: '推荐说明',
    contentPlaceholder: '简单说明推荐理由或适用难度…',
    showSourceUrl: true,
    uploadTitle: '上传字幕或文本材料 (.srt / .lrc / .txt)',
  },
  bug: {
    label: '问题反馈',
    titleLabel: '问题简述',
    titlePlaceholder: '例如：单词听写无法播放发音',
    contentLabel: '复现说明',
    contentPlaceholder: '怎么触发的？出现了什么报错或异常表现…',
    modules: ['听力', '单词', '对话', '账号/其他'],
    uploadTitle: '上传日志或文本附件 (≤512KB)',
  },
};

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
  const [aiViewMode, setAiViewMode] = useState<'pro_balance' | 'byok'>(() => getAccountState().aiMode);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
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
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
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
  const [fbModule, setFbModule] = useState<string>('听力');
  const [fbSourceUrl, setFbSourceUrl] = useState<string>('');
  const [fbTitle, setFbTitle] = useState('');
  const [fbContent, setFbContent] = useState('');
  const [fbAttachmentName, setFbAttachmentName] = useState('');
  const [fbAttachmentContent, setFbAttachmentContent] = useState('');
  const [fbAttachmentSize, setFbAttachmentSize] = useState(0);
  const [fbBusy, setFbBusy] = useState(false);
  const [fbList, setFbList] = useState<FeedbackItem[]>([]);
  const fbFileInputRef = useRef<HTMLInputElement | null>(null);

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
    setAiViewMode(acct.aiMode);
    setStatusMsg('');
    setErrorMsg('');
    setTestResult(null);
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

  const handleViewAiMode = (mode: 'pro_balance' | 'byok') => {
    setStatusMsg('');
    setErrorMsg('');
    setTestResult(null);
    setAiViewMode(mode);
  };

  const handleActivateAiMode = (mode: 'pro_balance' | 'byok') => {
    setErrorMsg('');
    updateAccountState({ aiMode: mode });
    setStatusMsg(mode === 'pro_balance' ? '已启用官方 API' : '已启用自配置 API');
  };

  const handleAuthSubmit = async () => {
    const acctErr = validateAccountId(email);
    if (acctErr) {
      setErrorMsg(acctErr);
      return;
    }
    const pwdErr = validatePassword(password);
    if (pwdErr) {
      setErrorMsg(pwdErr);
      return;
    }
    if (authMode === 'register' && nickname.trim().length > 24) {
      setErrorMsg('昵称最多 24 个字符。');
      return;
    }
    setAuthBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res =
        authMode === 'register'
          ? await registerAccount({ email: email.trim(), password, name: nickname.trim() })
          : await loginAccount({ email: email.trim(), password });
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
    setStatusMsg('');
    setTestResult(null);
    try {
      await testProviderConnection(config);
      setTestResult({ ok: true, msg: '连接正常 ✓' });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
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

  const fbCatMeta = FEEDBACK_CAT_META[fbCategory];

  const handlePickFeedbackFile = async () => {
    setErrorMsg('');
    const hasTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!hasTauri) {
      fbFileInputRef.current?.click();
      return;
    }
    try {
      const picked = await open({
        multiple: false,
        title: fbCatMeta.uploadTitle || '选择文本附件（≤512KB）',
        filters: [{ name: '文本文件', extensions: ['txt', 'csv', 'md', 'json', 'srt', 'lrc'] }],
      });
      if (typeof picked !== 'string' || !picked) return;
      const content = await readTextFile(picked);
      const byteSize = new TextEncoder().encode(content).length;
      if (byteSize > 512 * 1024) {
        setErrorMsg('附件不能超过 512 KB');
        return;
      }
      const fname = picked.split(/[/\\]/).pop() || 'attachment.txt';
      setFbAttachmentName(fname);
      setFbAttachmentContent(content);
      setFbAttachmentSize(byteSize);
    } catch {
      fbFileInputRef.current?.click();
    }
  };

  const handleWebFeedbackFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErrorMsg('');
    if (!/\.(txt|csv|md|json|srt|lrc)$/i.test(file.name)) {
      setErrorMsg('仅支持 .txt / .csv / .md / .json / .srt / .lrc 文本文件');
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
    try {
      const prefixes: string[] = [];
      if (fbCatMeta.modules?.length && fbModule) {
        prefixes.push(`[模块：${fbModule}]`);
      }
      if (fbCatMeta.showSourceUrl && fbSourceUrl.trim()) {
        prefixes.push(`[来源链接：${fbSourceUrl.trim()}]`);
      }
      const finalContent = prefixes.length
        ? `${prefixes.join('\n')}\n${fbContent.trim()}`
        : fbContent.trim();

      const res = await submitFeedback({
        category: fbCategory,
        title: fbTitle,
        content: finalContent,
        attachmentName: fbCatMeta.uploadTitle && fbAttachmentName ? fbAttachmentName : undefined,
        attachmentContent: fbCatMeta.uploadTitle && fbAttachmentName ? fbAttachmentContent : undefined,
        appVersion: updateState.currentVersion,
      });
      setFbList((prev) => [res.feedback, ...prev]);
      setFbTitle('');
      setFbContent('');
      setFbSourceUrl('');
      setFbAttachmentName('');
      setFbAttachmentContent('');
      setFbAttachmentSize(0);
      setStatusMsg('已收到反馈，感谢你的建议');
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
                反馈
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
                className={aiViewMode === 'pro_balance' ? 'active' : ''}
                onClick={() => handleViewAiMode('pro_balance')}
              >
                <span>官方 API</span>
                {account.aiMode === 'pro_balance' && (
                  <span className="ai-active-dot" title="当前生效通道" aria-label="当前生效" />
                )}
              </button>
              <button
                type="button"
                className={aiViewMode === 'byok' ? 'active' : ''}
                onClick={() => handleViewAiMode('byok')}
              >
                <span>自配置</span>
                {account.aiMode === 'byok' && (
                  <span className="ai-active-dot" title="当前生效通道" aria-label="当前生效" />
                )}
              </button>
            </div>

            {aiViewMode !== account.aiMode && (
              <div className="ai-channel-switch-bar">
                <span>当前生效：{account.aiMode === 'pro_balance' ? '官方 API' : '自配置'}</span>
                {aiViewMode === 'pro_balance' ? (
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={!account.user}
                    onClick={() => handleActivateAiMode('pro_balance')}
                  >
                    {account.user ? '启用官方 API' : '登录后可启用'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => handleActivateAiMode('byok')}
                  >
                    启用自配置
                  </button>
                )}
              </div>
            )}

            {aiViewMode === 'pro_balance' ? (
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
                        注册
                      </button>
                    </div>
                  </div>

                  <div className="settings-two-col">
                    <div className="speak-field">
                      <label>账号</label>
                      <input
                        type="text"
                        value={email}
                        placeholder="4–32 位字母/数字/下划线"
                        minLength={4}
                        maxLength={32}
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                    <div className="speak-field">
                      <label>密码</label>
                      <input
                        type="password"
                        value={password}
                        placeholder="6–32 位，不含空格"
                        minLength={6}
                        maxLength={32}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && email.trim().length >= 4 && password.length >= 6) void handleAuthSubmit();
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
                        placeholder="选填"
                        maxLength={24}
                        onChange={(e) => setNickname(e.target.value)}
                      />
                    </div>
                  )}

                    <div className="import-modal-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={authBusy || email.trim().length < 4 || password.length < 6}
                      onClick={() => void handleAuthSubmit()}
                    >
                      {authBusy ? '请稍候…' : authMode === 'register' ? '注册' : '登录'}
                    </button>
                  </div>
                  <div className="settings-rate-tip" style={{ textAlign: 'center' }}>
                    新用户赠 ¥0.5 · 按量扣费 · 本地免费
                  </div>
                  <button
                    type="button"
                    className="link-inline-btn"
                    onClick={() => void openUrlSafe(getStoreWebsiteUrl())}
                  >
                    了解 Lirio Pro · 永久版 ↗
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
                      <div
                        className="account-balance-stats"
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}
                      >
                        {account.user.tier === 'pro' && (
                          <button
                            type="button"
                            className="ghost-pill-btn"
                            onClick={() => void handleToggleBuyPanel()}
                          >
                            {showBuyPanel ? '收起' : '充值'}
                          </button>
                        )}
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
                        <span>{account.proCloudSpeech ? '¥0.06 / 千字 · CosyVoice2' : '本地免费'}</span>
                      </div>
                    </div>

                    {(account.user.tier !== 'pro' || showBuyPanel) && (
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
                            placeholder={
                              account.user.tier === 'pro'
                                ? '输入加油包兑换码'
                                : '输入卡密兑换码（LIRIO-XXXX-XXXX-XXXX）'
                            }
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
                      </div>
                    )}

                    {account.user.tier !== 'pro' && (
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
                    )}

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
                                {(storeConfig?.presets || [])
                                  .filter((p) => (account.user?.tier === 'pro' ? !p.upgradeToPro : true))
                                  .map((p) => {
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
                      title="使用硅基流动 CosyVoice2 极速播音（约 0.5 秒出声，¥0.06/千字），关闭则使用免费本地语音"
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
                    <button type="button" className="primary" onClick={onClose}>
                      完成
                    </button>
                  </div>
                </>
              )
            ) : (
              <>
                <div className="settings-row-between">
                  <span className="settings-section-title">文本模型 API</span>
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
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 84px', gap: 6, width: '100%' }}>
                            <input
                              type="text"
                              value={config.speechModel || ''}
                              placeholder="tts-1"
                              style={{ minWidth: 0, width: '100%' }}
                              onChange={(e) => updateConfig({ speechModel: e.target.value })}
                            />
                            <input
                              type="text"
                              value={config.speechVoice || ''}
                              placeholder="alloy"
                              style={{ minWidth: 0, width: '100%' }}
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

                <div className="import-modal-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <button type="button" disabled={testingConn} onClick={() => void handleTestConn()}>
                      {testingConn ? '测试中…' : '测试连接'}
                    </button>
                    {testResult && (
                      <span
                        title={testResult.msg}
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: testResult.ok ? 'var(--accent-bright)' : 'var(--danger)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {testResult.msg}
                      </span>
                    )}
                  </div>
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
                    : '浏览器暂存'}
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
                      <span>切换时同步迁移当前数据</span>
                    </label>
                  </>
                )}
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
                  <strong>免费本地功能</strong>
                  <p>
                    导入音频、自动断句、默认朗读、单词听写与错词本均本地运行，免费不限次。
                  </p>
                </div>
                <div className="guide-block">
                  <strong>费用参考（¥10 约可用 80–270 场）</strong>
                  <ul>
                    <li>雅思模考 + 复盘：约 ¥0.04–¥0.12 / 场</li>
                    <li>双语陪练 + 复盘：约 ¥0.03–¥0.10 / 次</li>
                    <li>听力诊断 / 字幕精校：约 ¥0.005–¥0.01 / 次</li>
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
            {!account.token ? (
              <div className="account-auth-box">
                <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--muted)' }}>
                  请先在「AI」页登录账号后提交反馈
                </p>
                <button type="button" className="primary-btn" onClick={() => setTab('ai')}>
                  前往登录
                </button>
              </div>
            ) : (
              <>
                <form className="provider-form" onSubmit={(e) => void handleSubmitFeedback(e)}>
                  <div className="feedback-cat-pills" role="tablist" aria-label="反馈类型">
                    {(['feature', 'vocab', 'listening', 'bug'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={fbCategory === k ? 'active' : ''}
                        onClick={() => {
                          setFbCategory(k);
                          const mods = FEEDBACK_CAT_META[k].modules;
                          if (mods?.length && !mods.includes(fbModule)) {
                            setFbModule(mods[0]);
                          }
                        }}
                      >
                        {FEEDBACK_CAT_META[k].label}
                      </button>
                    ))}
                  </div>

                  {fbCatMeta.modules && (
                    <div className="feedback-sub-pills" aria-label="涉及模块">
                      {fbCatMeta.modules.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={fbModule === m ? 'active' : ''}
                          onClick={() => setFbModule(m)}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  )}

                  {fbCatMeta.showSourceUrl && (
                    <div className="speak-field">
                      <label>公开链接（选填）</label>
                      <input
                        type="text"
                        value={fbSourceUrl}
                        placeholder="播客 RSS 或公开链接"
                        onChange={(e) => setFbSourceUrl(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="speak-field">
                    <label>{fbCatMeta.titleLabel}</label>
                    <input
                      type="text"
                      value={fbTitle}
                      placeholder={fbCatMeta.titlePlaceholder}
                      required
                      onChange={(e) => setFbTitle(e.target.value)}
                    />
                  </div>

                  <div className="speak-field">
                    <label>{fbCatMeta.contentLabel}</label>
                    <textarea
                      rows={4}
                      value={fbContent}
                      placeholder={fbCatMeta.contentPlaceholder}
                      required
                      onChange={(e) => setFbContent(e.target.value)}
                    />
                  </div>

                  <input
                    ref={fbFileInputRef}
                    type="file"
                    accept=".txt,.csv,.md,.json,.srt,.lrc"
                    style={{ display: 'none' }}
                    onChange={(e) => void handleWebFeedbackFile(e)}
                  />

                  <div className="feedback-footer-bar">
                    <div className="feedback-footer-left">
                      {fbCatMeta.uploadTitle && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={fbCatMeta.uploadTitle}
                          aria-label={fbCatMeta.uploadTitle}
                          onClick={() => void handlePickFeedbackFile()}
                        >
                          <IconUpload size={15} />
                        </button>
                      )}
                      {fbCatMeta.uploadTitle && fbAttachmentName && (
                        <span className="feedback-file-chip" title={`${fbAttachmentName} (${formatBytes(fbAttachmentSize)})`}>
                          <span>{fbAttachmentName}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            title="移除附件"
                            aria-label="移除附件"
                            onClick={() => {
                              setFbAttachmentName('');
                              setFbAttachmentContent('');
                              setFbAttachmentSize(0);
                            }}
                          >
                            <IconClose size={12} />
                          </button>
                        </span>
                      )}
                    </div>
                    <button
                      type="submit"
                      className="primary-btn"
                      disabled={fbBusy || fbTitle.trim().length < 2 || fbContent.trim().length < 4}
                    >
                      {fbBusy ? '提交中…' : '提交'}
                    </button>
                  </div>
                </form>

                {fbList.length > 0 && (
                  <div className="feedback-history-list">
                    <span className="settings-section-title">反馈记录（{fbList.length}）</span>
                    {fbList.map((item) => {
                      const statusText =
                        item.status === 'done'
                          ? '已上线'
                          : item.status === 'planned'
                            ? '已采纳'
                            : item.status === 'declined'
                              ? '暂不考虑'
                              : '待评估';
                      const catLabel = FEEDBACK_CAT_META[item.category]?.label || item.category;
                      return (
                        <div key={item.id} className="feedback-history-item">
                          <div className="feedback-history-top">
                            <strong>{item.title}</strong>
                            <span className={`feedback-status-tag ${item.status}`}>{statusText}</span>
                          </div>
                          <small className="sub">
                            {catLabel} · {new Date(item.createdAt).toLocaleString('zh-CN')}
                            {item.attachmentName ? ` · 附件：${item.attachmentName}` : ''}
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
