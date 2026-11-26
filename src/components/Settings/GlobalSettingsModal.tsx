import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { open as openExternalUrl } from '@tauri-apps/plugin-shell';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import type { Accent } from '../../services/corpusService';
import {
  fetchCommunityConfig,
  fetchMyFeedbacks,
  getAccountState,
  loginAccount,
  logoutAccount,
  pullCloudSyncSnapshot,
  refreshAccountMe,
  registerAccount,
  submitFeedback,
  subscribeAccount,
  updateAccountState,
  validateAccountId,
  validatePassword,
  type AccountState,
  type CommunityConfig,
  type FeedbackCategory,
  type FeedbackItem,
} from '../../services/accountService';
import {
  applySyncedStateJson,
  exportAllStateJson,
  flushAllStateToDisk,
  forceReloadStateFromDisk,
  formatBytes,
  getLastCloudSyncAt,
  getStorageInfo,
  importAllStateJson,
  openStorageDir,
  resetStorageDir,
  restoreStateFromCloudIfLocalEmpty,
  setLastCloudSyncAt,
  setStorageDir,
  syncStateToCloudNow,
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
import { IconClose, IconEye, IconUpload } from '../Icons';

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
  const [syncBusy, setSyncBusy] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(() => getLastCloudSyncAt());
  const [communityCfg, setCommunityCfg] = useState<CommunityConfig | null>(null);
  const [copiedQq, setCopiedQq] = useState(false);

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
    setLastSyncAt(getLastCloudSyncAt());
    if (acct.token) {
      refreshAccountMe().catch(() => {});
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
    if (!isOpen || tab !== 'feedback') return;
    fetchCommunityConfig()
      .then((cfg) => setCommunityCfg(cfg))
      .catch(() => {});
    if (!account.token) return;
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
    setStatusMsg(mode === 'pro_balance' ? '已启用云端服务' : '已启用自配置');
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
      if (authMode === 'register') {
        await registerAccount({ email: email.trim(), password, name: nickname.trim() });
      } else {
        await loginAccount({ email: email.trim(), password });
      }
      setPassword('');
      const restored = await restoreStateFromCloudIfLocalEmpty();
      setLastSyncAt(getLastCloudSyncAt());
      if (restored) {
        setStatusMsg('已登录并从云端恢复学习记录，正在刷新…');
        setTimeout(() => window.location.reload(), 650);
      } else {
        await syncStateToCloudNow();
        setLastSyncAt(getLastCloudSyncAt());
        setStatusMsg(authMode === 'register' ? '已注册并开启云端同步' : '已登录');
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const handlePushCloudSync = async () => {
    setSyncBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const snap = await syncStateToCloudNow();
      if (!snap) throw new Error('云端同步失败，请检查网络连接。');
      setLastSyncAt(snap.updatedAt);
      setStatusMsg(`已同步到云端（${formatBytes(snap.byteSize)}）`);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setSyncBusy(false);
    }
  };

  const handlePullCloudSync = async () => {
    setSyncBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const snap = await pullCloudSyncSnapshot();
      if (!snap?.payload) {
        setStatusMsg('云端暂无备份记录');
        return;
      }
      const restored = applySyncedStateJson(snap.payload);
      setLastCloudSyncAt(snap.updatedAt);
      setLastSyncAt(snap.updatedAt);
      if (restored > 0) {
        setStatusMsg('已从云端恢复本地记录，即将刷新…');
        setTimeout(() => window.location.reload(), 650);
      } else {
        setStatusMsg('云端备份为空');
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setSyncBusy(false);
    }
  };

  const openUrlSafe = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
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
                账号
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
                社区
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
                <span>云端服务</span>
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
                <span>当前生效：{account.aiMode === 'pro_balance' ? '云端服务' : '自配置'}</span>
                {aiViewMode === 'pro_balance' ? (
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={!account.user}
                    onClick={() => handleActivateAiMode('pro_balance')}
                  >
                    {account.user ? '启用云端服务' : '登录后可启用'}
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
                    登录后可云端同步学习记录；不登录也可直接使用本地功能
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
                        </div>
                        <small>{account.user.email}</small>
                      </div>
                      <button type="button" onClick={logoutAccount}>
                        退出
                      </button>
                    </div>
                  </div>

                  <div className="sync-status-card">
                    <div className="sync-status-head">
                      <strong>本地与云端双同步</strong>
                      <small>
                        {lastSyncAt
                          ? `上次云端备份：${new Date(lastSyncAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                          : '本地已实时保存 · 尚未备份到云端'}
                      </small>
                    </div>
                    <div className="sync-status-actions">
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={syncBusy}
                        onClick={() => void handlePushCloudSync()}
                      >
                        {syncBusy ? '同步中…' : '立即同步到云端'}
                      </button>
                      <button
                        type="button"
                        className="ghost-pill-btn"
                        disabled={syncBusy}
                        onClick={() => void handlePullCloudSync()}
                      >
                        从云端恢复
                      </button>
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
                      title="开启后使用云端语音，响应更快；关闭后使用本地语音，速度会慢一些"
                    >
                      <input
                        type="checkbox"
                        checked={account.proCloudSpeech}
                        onChange={(e) => updateAccountState({ proCloudSpeech: e.target.checked })}
                      />
                      云端语音（更快）
                    </label>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: -4, lineHeight: 1.5 }}>
                    云端模式响应更快；关闭后使用本地语音与转写（速度会慢一些）。
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
                  <span className="settings-section-title">说明</span>
                  <small>数据存储与语音模式</small>
                </div>
                <button type="button" onClick={() => setShowGuide((v) => !v)}>
                  {showGuide ? '收起' : '查看'}
                </button>
              </div>
            </div>

            {showGuide && (
              <div className="settings-guide-card">
                <div className="guide-block">
                  <strong>本地优先与云端双同步</strong>
                  <p>
                    精听进度、单词记录、错词本与收藏均优先保存在本地；登录账号后会自动同步到云端，更换设备或重装后可随时恢复。
                  </p>
                </div>
                <div className="guide-block">
                  <strong>本地与云端语音</strong>
                  <p>
                    日常学习功能均可本地运行；开启云端模式响应更快，关闭后使用本地语音与转写（速度会慢一些）。
                  </p>
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
            <div className="community-modal-card">
              <div className="community-modal-info">
                <strong>{communityCfg?.qqGroupName || 'Lirio 学习交流群'}</strong>
                <p>{communityCfg?.communityNote || '交流英语学习方法、分享精听素材与改进建议。'}</p>
                <div className="community-modal-actions">
                  <span className="community-modal-code">
                    {communityCfg?.qqGroupNumber ? `QQ 群号：${communityCfg.qqGroupNumber}` : 'QQ 群号待补充'}
                  </span>
                  {communityCfg?.qqGroupNumber && (
                    <button
                      type="button"
                      className="ghost-pill-btn"
                      onClick={() => {
                        void navigator.clipboard.writeText(communityCfg.qqGroupNumber);
                        setCopiedQq(true);
                        setTimeout(() => setCopiedQq(false), 1600);
                      }}
                    >
                      {copiedQq ? '已复制' : '复制群号'}
                    </button>
                  )}
                  {communityCfg?.qqGroupLink && (
                    <button
                      type="button"
                      className="ghost-pill-btn"
                      onClick={() => void openUrlSafe(communityCfg.qqGroupLink)}
                    >
                      加入 QQ 群 ↗
                    </button>
                  )}
                </div>
              </div>
              <div className="community-modal-qr">
                {communityCfg?.qqGroupQr ? (
                  <img src={communityCfg.qqGroupQr} alt="QQ 群二维码" />
                ) : (
                  <span>群二维码待配置</span>
                )}
              </div>
            </div>

            {!account.token ? (
              <div className="account-auth-box">
                <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--muted)' }}>
                  登录后可在应用内直接提交功能建议与问题反馈
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
