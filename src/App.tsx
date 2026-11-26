import { useState, useEffect, useMemo, useCallback } from 'react';
import './theme.css';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { audioEngine } from './services/audioEngine';
import { projectService } from './services/projectService';
import { simplifyMaterialTitle } from './services/materialTitle';
import { getActiveCorpusDraftSummary, loadCorpusState } from './services/corpusService';
import { loadSpeakState } from './services/speakService';
import {
  checkForAppUpdate,
  dismissUpdateToast,
  downloadAndInstallUpdate,
  getUpdateState,
  initAppVersion,
  relaunchAfterUpdate,
  subscribeUpdateState,
  type UpdateState,
} from './services/updaterService';
import {
  evaluateLocalAccess,
  formatSmartYuan,
  formatYuan,
  getAccountState,
  getDeviceIdentity,
  refreshAccountMe,
  subscribeAccount,
  subscribeLastCharge,
  type AccountState,
  type LastChargeEvent,
} from './services/accountService';
import { hydrateStateFromDisk } from './services/stateSync';
import {
  importAudioFilesToLibrary,
  type ImportProgress,
  type ImportTierChoice,
} from './services/importAgent';
import { useProjectStore } from './stores/projectStore';
import { usePlayerStore } from './stores/playerStore';
import { Timeline } from './components/Timeline/Timeline';
import { Favorites } from './components/Dictation/Favorites';
import { Dictation } from './components/Dictation/Dictation';
import { MaterialLibrary } from './components/Library/MaterialLibrary';
import { history } from './services/submissions';
import { SubmissionAnalysis } from './components/Analysis/SubmissionAnalysis';
import { CorpusDictation } from './components/Corpus/CorpusDictation';
import { CustomSelect } from './components/Corpus/CustomSelect';
import { SpeakCompanion } from './components/Speak/SpeakCompanion';
import { GlobalSettingsModal, type GlobalSettingsTab } from './components/Settings/GlobalSettingsModal';
import { LicenseGateModal } from './components/LicenseGate/LicenseGateModal';
import { Transport } from './components/Player/Transport';
import { GlobalTooltip } from './components/GlobalTooltip';
import { SelectionTools } from './components/SelectionTools';
import {
  IconBack,
  IconBookmark,
  IconChart,
  IconChat,
  IconClose,
  IconCorpus,
  IconFolderAudio,
  IconHeadphones,
  IconLibrary,
  IconLirioMark,
  IconMoon,
  IconSettings,
  IconSun,
  IconUser,
  IconWave,
} from './components/Icons';

type HubSection = 'home' | 'listening' | 'words' | 'speak';
type ListeningMode = 'library' | 'audio' | 'dictation' | 'favorites' | 'analysis';

export default function App() {
  const { project, setProject, setBlobUrl, addRecordingBlob } = useProjectStore();
  const { setDuration, setCurrentTime } = usePlayerStore();
  const [settingsTab, setSettingsTab] = useState<GlobalSettingsTab>('ai');
  const [accountState, setAccountState] = useState<AccountState>(() => getAccountState());
  const [recentCharge, setRecentCharge] = useState<LastChargeEvent | null>(null);
  const access = useMemo(() => evaluateLocalAccess(accountState), [accountState]);

  const [hub, setHub] = useState<HubSection>('home');
  const [listeningMode, setListeningMode] = useState<ListeningMode>('library');
  const [autoPlayDictation, setAutoPlayDictation] = useState(false);
  const [speakContext, setSpeakContext] = useState<{ title: string; excerpt: string } | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importLanguage, setImportLanguage] = useState('en');
  const [importTier, setImportTier] = useState<ImportTierChoice>('auto');
  const [importAiPolish, setImportAiPolish] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState('');
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(() => getUpdateState());
  const [stateTick, setStateTick] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('aboboo-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {}
    return 'light';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('aboboo-theme', theme); } catch {}
  }, [theme]);

  useEffect(() => {
    getDeviceIdentity();
    hydrateStateFromDisk()
      .then((restored) => {
        if (restored) {
          setAccountState(getAccountState());
          setStateTick((t) => t + 1);
        }
        return refreshAccountMe().catch(() => null);
      })
      .catch(() => {});
    const unsubAcct = subscribeAccount((next) => setAccountState(next));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubCharge = subscribeLastCharge((evt) => {
      setRecentCharge(evt);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRecentCharge(null), 4500);
    });
    const onOnline = () => {
      void refreshAccountMe().catch(() => {});
    };
    window.addEventListener('online', onOnline);
    return () => {
      unsubAcct();
      unsubCharge();
      window.removeEventListener('online', onOnline);
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    void initAppVersion();
    const unsub = subscribeUpdateState((next) => setUpdateState(next));
    const timer = setTimeout(() => {
      void checkForAppUpdate({ silent: true });
    }, 3500);
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, []);

  const [asrBusy, setAsrBusy] = useState(false);
  useEffect(() => {
    if (!project) return;
    const key = 'aboboo-favorites:' + project.originalAudioPath + ':' + project.duration.toFixed(2);
    if (project.favorites === undefined) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (Array.isArray(saved)) useProjectStore.getState().updateProject({ favorites: saved });
      } catch {}
    }
  }, [project?.id]);
  useEffect(() => {
    if (!project?.favorites) return;
    try {
      localStorage.setItem('aboboo-favorites:' + project.originalAudioPath + ':' + project.duration.toFixed(2), JSON.stringify(project.favorites));
    } catch {}
  }, [project?.favorites]);

  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (project?.libraryId) {
      invoke('library_save_progress', {
        id: project.libraryId,
        progress: { dictation: project.dictation, favorites: project.favorites, dictationBackups: project.dictationBackups },
      }).catch((e) => setError('材料库进度保存失败：' + String(e)));
    }
  }, [project?.dictation, project?.favorites, project?.dictationBackups, project?.libraryId]);
  useEffect(() => {
    history(project).catch((e) => setError('旧提交记录收集失败：' + String(e)));
  }, [project?.id]);

  const stopListeningAudio = () => {
    audioEngine.stop();
    usePlayerStore.getState().setIsPlaying(false);
  };

  const openLocalAudioPath = async (selected: string, customTitle?: string) => {
    setError('');
    setLoading('正在检查音频…');
    let url: string | null = null;
    try {
      await invoke('inspect_audio_file', { path: selected });
      setLoading('正在读取音频…');
      const bytes = await readFile(selected);
      const ext = selected.split('.').pop()?.toLowerCase() ?? '';
      const mime = ({ mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', ogg: 'audio/ogg' } as Record<string, string>)[ext] || 'application/octet-stream';
      const blob = new Blob([bytes], { type: mime });
      url = URL.createObjectURL(blob);
      const arrayBuffer = await blob.arrayBuffer();

      const newProject = projectService.createProject(
        customTitle || selected.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Project',
        selected,
        0,
      );

      setLoading('正在解码音频，较长录音可能需要一些时间…');
      let duration: number;
      try {
        duration = await audioEngine.loadAudio(newProject.tracks[0].id, arrayBuffer);
      } catch {
        throw new Error('无法解码此音频。请转换为 MP3 / WAV 后重试。');
      }
      newProject.tracks[0].duration = duration;
      newProject.duration = duration;

      stopListeningAudio();
      useProjectStore.getState().clear();
      audioEngine.retainBuffers(newProject.tracks.map((t) => t.id));
      setProject(newProject);
      setListeningMode('dictation');
      setBlobUrl(newProject.tracks[0].id, url);
      addRecordingBlob(newProject.tracks[0].id, blob);
      url = null;
      setDuration(duration);
      setCurrentTime(0);
    } finally {
      if (url) URL.revokeObjectURL(url);
      setLoading('');
    }
  };

  const loadResult = async (result: NonNullable<Awaited<ReturnType<typeof projectService.loadProject>>>) => {
    const { project: loaded, blobUrls } = result;
    stopListeningAudio();
    useProjectStore.getState().clear();
    for (const [id, blob] of result.recordingBlobs) addRecordingBlob(id, blob);
    for (const track of loaded.tracks) {
      const url = blobUrls.get(track.id);
      if (url) {
        const res = await fetch(url);
        const ab = await res.arrayBuffer();
        await audioEngine.loadAudio(track.id, ab);
      }
    }
    audioEngine.retainBuffers(loaded.tracks.map((t) => t.id));
    setProject(loaded);
    useProjectStore.getState().setBlobUrls(blobUrls);
    setDuration(loaded.duration);
    setCurrentTime(0);
  };

  const openMaterial = async (id: string, targetIndex?: number) => {
    setLoading('正在打开材料…');
    setError('');
    try {
      const parsedResult = projectService.parse(await invoke<string>('library_open', { id }));
      if (
        parsedResult.project.dictation &&
        typeof targetIndex === 'number' &&
        targetIndex >= 0 &&
        targetIndex < parsedResult.project.dictation.sentences.length
      ) {
        parsedResult.project.dictation.index = targetIndex;
      }
      await loadResult(parsedResult);
      setListeningMode('dictation');
    } finally {
      setLoading('');
    }
  };

  const handleEnterListening = async (autoPlay = true) => {
    stopListeningAudio();
    const currentProject = useProjectStore.getState().project;
    if (
      currentProject &&
      ((currentProject.dictation?.sentences.length ?? 0) > 0 || currentProject.tracks.length > 0)
    ) {
      setAutoPlayDictation(autoPlay);
      setListeningMode('dictation');
      setHub('listening');
      return;
    }
    try {
      const raw = localStorage.getItem('aboboo-last-listening');
      const parsed = raw
        ? (JSON.parse(raw) as { libraryId?: string; index?: number } | null)
        : null;
      if (parsed?.libraryId) {
        setAutoPlayDictation(autoPlay);
        setListeningMode('dictation');
        setHub('listening');
        await openMaterial(parsed.libraryId, parsed.index);
        return;
      }
    } catch {
      setAutoPlayDictation(false);
    }
    setAutoPlayDictation(false);
    setListeningMode('library');
    setHub('listening');
  };

  const handleImportLocalAudioPaths = useCallback(
    async (
      paths: string[],
      tierOverride: ImportTierChoice = importTier,
      languageOverride: string = importLanguage,
    ) => {
      if (!paths.length) return;
      stopListeningAudio();
      setImportError('');
      setShowImportModal(true);
      setImportBusy(true);
      setAsrBusy(true);
      setImportProgress({
        fileIndex: 1,
        totalFiles: paths.length,
        fileName: paths[0].split(/[/\\]/).pop() || '',
        stage: '准备处理…',
      });
      try {
        const res = await importAudioFilesToLibrary({
          paths,
          language: languageOverride,
          tier: tierOverride,
          aiPolish: {
            enabled: importAiPolish,
            fixText: true,
            addTranslation: true,
          },
          onProgress: (p) => setImportProgress(p),
        });
        setLibraryRefreshKey((k) => k + 1);
        setShowImportModal(false);
        setImportProgress(null);
        if (res.lastLibraryId) {
          await openMaterial(res.lastLibraryId);
        }
        if (res.warnings?.length) {
          setError(res.warnings.join('；'));
        }
      } catch (e) {
        setImportError('导入失败：' + String(e));
      } finally {
        setImportBusy(false);
        setAsrBusy(false);
      }
    },
    [importLanguage, importTier, importAiPolish],
  );

  const handleBatchImportAudio = async () => {
    setImportError('');
    const picked = await open({
      filters: [
        { name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'aif', 'aiff', 'mp4'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      multiple: true,
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
    if (!paths.length) return;
    await handleImportLocalAudioPaths(paths);
  };

  const handleJumpToSentence = useCallback(
    async (projectId: string, sentenceId: string, start: number) => {
      setError('');
      stopListeningAudio();
      let targetProject = useProjectStore.getState().project;
      if (!targetProject || (targetProject.id !== projectId && targetProject.libraryId !== projectId)) {
        setLoading('正在打开原句所在材料…');
        try {
          await loadResult(projectService.parse(await invoke<string>('library_open', { id: projectId })));
          targetProject = useProjectStore.getState().project;
        } catch (e) {
          setError('无法打开对应材料：' + String(e));
          setLoading('');
          return;
        } finally {
          setLoading('');
        }
      }
      const sents = targetProject?.dictation?.sentences || [];
      if (sents.length > 0 && targetProject?.dictation) {
        let idx = sents.findIndex((s) => s.id === sentenceId);
        if (idx < 0) {
          let bestIdx = 0;
          let bestDist = Infinity;
          sents.forEach((s, i) => {
            const d = Math.abs(s.start - start);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          });
          idx = bestIdx;
        }
        useProjectStore.getState().updateProject({
          dictation: { ...targetProject.dictation, index: idx },
        });
      }
      setHub('listening');
      setListeningMode('dictation');
    },
    [],
  );

  const isRec = usePlayerStore((s) => s.isRecording);

  // Global keyboard shortcuts: Cmd/Ctrl + 1 / 2 / 3 to switch modules
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (asrBusy || !!loading || isRec) return;
      if (e.key === '1') {
        e.preventDefault();
        stopListeningAudio();
        setHub('listening');
      } else if (e.key === '2') {
        e.preventDefault();
        stopListeningAudio();
        setHub('words');
      } else if (e.key === '3') {
        e.preventDefault();
        stopListeningAudio();
        setHub('speak');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [asrBusy, loading, isRec]);

  interface HomeCardProgress {
    label: string;
    value: string;
    pct: number;
  }

  const homeCards = useMemo<{
    listening: HomeCardProgress;
    words: HomeCardProgress;
    speak: HomeCardProgress;
  }>(() => {
    const empty: HomeCardProgress = { label: '暂未开始', value: '0%', pct: 0 };
    if (hub !== 'home') {
      return { listening: empty, words: empty, speak: empty };
    }

    let listening: HomeCardProgress = { label: '暂未开始', value: '—', pct: 0 };
    try {
      const raw = localStorage.getItem('aboboo-last-listening');
      if (raw) {
        const parsed = JSON.parse(raw) as { title?: string; index?: number; total?: number };
        if (parsed?.title) {
          const cur = (parsed.index ?? 0) + 1;
          const total = typeof parsed.total === 'number' && parsed.total > 0 ? parsed.total : 0;
          const pct = total > 0 ? Math.min(100, Math.max(4, Math.round((cur / total) * 100))) : 0;
          listening = {
            label: parsed.title,
            value: total > 0 ? `${cur}/${total}` : `第 ${cur} 句`,
            pct,
          };
        }
      }
    } catch {}

    let words: HomeCardProgress = { label: '准备就绪', value: '0/30', pct: 0 };
    try {
      const cs = loadCorpusState();
      const mistakeCount = Object.keys(cs.mistakes || {}).length;
      const draft = getActiveCorpusDraftSummary(cs);
      if (draft) {
        const pct = Math.min(
          100,
          Math.max(draft.doneCount > 0 ? 5 : 0, Math.round((draft.doneCount / Math.max(1, draft.total)) * 100)),
        );
        words = {
          label: mistakeCount > 0 ? `${draft.sectionTitle} · ${mistakeCount} 错词` : draft.sectionTitle,
          value: `${draft.doneCount}/${draft.total}`,
          pct,
        };
      } else if (mistakeCount > 0) {
        words = {
          label: '错词待清',
          value: `${mistakeCount} 词`,
          pct: 0,
        };
      }
    } catch {}

    let speak: HomeCardProgress = { label: '暂未开聊', value: '0 次', pct: 0 };
    try {
      const ss = loadSpeakState();
      const sessionCount = ss.sessions?.length || 0;
      const memCount =
        (ss.memory?.aboutMe?.length || 0) +
        (ss.memory?.habits?.length || 0) +
        (ss.memory?.recurringTopics?.length || 0) +
        (ss.memory?.targetPhrases?.length || 0);
      const practicedCount = Object.keys(ss.practicedTopics || {}).length;
      const totalTopics = ss.decks?.[0]?.items?.length || 165;
      if (practicedCount > 0) {
        speak = {
          label: `${sessionCount} 次复盘 · ${memCount} 记忆`,
          value: `${practicedCount}/${totalTopics} 题`,
          pct: Math.min(100, Math.max(5, Math.round((practicedCount / Math.max(1, totalTopics)) * 100))),
        };
      } else if (sessionCount > 0 || memCount > 0) {
        speak = {
          label: `${sessionCount} 次对话`,
          value: `${memCount} 记忆`,
          pct: Math.min(100, Math.max(8, sessionCount * 15 + memCount * 2)),
        };
      }
    } catch {}

    return { listening, words, speak };
  }, [hub, stateTick]);

  return (
    <div className="app-shell">
      <GlobalTooltip />
      <SelectionTools />
      {/* Breathable Borderless Top Navigation */}
      <div className="app-toolbar">
        {hub === 'home' ? (
          <span className="app-brand">
            <IconLirioMark size={24} />
            <span>Lirio</span>
          </span>
        ) : (
          <>
            <button
              className="icon-btn"
              title="返回首页"
              aria-label="返回首页"
              disabled={asrBusy || !!loading || isRec}
              onClick={() => {
                stopListeningAudio();
                setHub('home');
              }}
            >
              <IconBack size={17} />
            </button>
            <div className="seg-pill" role="tablist" aria-label="模块快速切换">
              {(
                [
                  ['listening', '听力', 'Cmd+1'],
                  ['words', '单词', 'Cmd+2'],
                  ['speak', '对话', 'Cmd+3'],
                ] as const
              ).map(([key, label, shortcut]) => (
                <button
                  key={key}
                  type="button"
                  className={hub === key ? 'active' : ''}
                  disabled={asrBusy || !!loading || isRec}
                  title={`${label} (${shortcut})`}
                  onClick={() => {
                    stopListeningAudio();
                    setHub(key);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Listening-only minimal icons */}
        {hub === 'listening' && (
          <>
            <span className="toolbar-divider" />
            <button
              className={`icon-btn${listeningMode === 'library' ? ' active' : ''}`}
              title="阶梯材料库"
              aria-label="材料库"
              disabled={asrBusy || !!loading || isRec}
              onClick={() => {
                stopListeningAudio();
                setListeningMode('library');
              }}
            >
              <IconLibrary size={17} />
            </button>
            <button
              className={`icon-btn${listeningMode === 'analysis' ? ' active' : ''}`}
              title="听力复盘"
              aria-label="听力复盘"
              disabled={asrBusy || !!loading}
              onClick={() => {
                stopListeningAudio();
                setListeningMode('analysis');
              }}
            >
              <IconChart size={17} />
            </button>
            <button
              className={`icon-btn${showImportModal ? ' active' : ''}`}
              title="导入音频（自动识别分句并入库）"
              aria-label="导入音频并自动入库"
              disabled={asrBusy || !!loading || isRec}
              onClick={() => {
                setImportError('');
                setShowImportModal(true);
              }}
            >
              <IconFolderAudio size={17} />
            </button>
            {project && (
              <>
                <span className="toolbar-divider" />
                <button
                  className={`icon-btn${listeningMode === 'dictation' || listeningMode === 'audio' ? ' active' : ''}`}
                  title={listeningMode === 'dictation' ? '切换音频跟读' : '切换逐句听写'}
                  aria-label="听写与音频切换"
                  disabled={asrBusy || isRec}
                  onClick={() => {
                    stopListeningAudio();
                    setListeningMode(listeningMode === 'dictation' ? 'audio' : 'dictation');
                  }}
                >
                  <IconWave size={17} />
                </button>
                <button
                  className={`icon-btn${listeningMode === 'favorites' ? ' active' : ''}`}
                  title={`收藏词卡 (${project.favorites?.length || 0})`}
                  aria-label="收藏词卡"
                  disabled={asrBusy || isRec}
                  onClick={() => {
                    stopListeningAudio();
                    setListeningMode('favorites');
                  }}
                >
                  <IconBookmark size={17} />
                </button>
              </>
            )}
          </>
        )}

        <div className="toolbar-spacer" />

        {hub === 'listening' && project && (
          <span className="toolbar-project-name" title={project.name}>
            {simplifyMaterialTitle(project.name).shortTitle}
          </span>
        )}

        {accountState.aiMode === 'pro_balance' && accountState.user ? (
          <button
            type="button"
            className={`account-topbar-pill${accountState.user.balanceUnits < 10000 ? ' low' : ''}`}
            title="个人账号、终身通行证与余额"
            aria-label="个人账号与设置"
            onClick={() => {
              setSettingsTab('ai');
              setSettingsOpen(true);
            }}
          >
            <IconUser size={15} />
            <span>{formatSmartYuan(accountState.user.balanceUnits)}</span>
            {recentCharge && (
              <span className="account-charge-delta" title={recentCharge.feature}>
                -{formatYuan(recentCharge.amountUnits, 4)}
              </span>
            )}
          </button>
        ) : (
          <button
            className={`icon-btn${settingsOpen && settingsTab === 'ai' ? ' active' : ''}`}
            title="账号、终身通行证与 AI 引擎"
            aria-label="账号与 AI 设置"
            onClick={() => {
              setSettingsTab('ai');
              setSettingsOpen(true);
            }}
          >
            <IconUser size={17} />
          </button>
        )}

        {access.allowed && access.mode === 'trial' && (
          <button
            type="button"
            className="trial-topbar-pill"
            title="点击激活 Lirio Pro · 永久版"
            onClick={() => {
              setSettingsTab('ai');
              setSettingsOpen(true);
            }}
          >
            体验剩 {Math.max(1, Math.ceil((access.trialRemainingHours || 1) / 24))} 天 · 升永久版
          </button>
        )}

        <button
          className={`icon-btn${settingsOpen && settingsTab === 'data' ? ' active' : ''}`}
          title="数据路径、备份与系统设置"
          aria-label="用户设置"
          onClick={() => {
            setSettingsTab('data');
            setSettingsOpen(true);
          }}
        >
          <IconSettings size={17} />
        </button>

        <button
          className="icon-btn"
          title={theme === 'light' ? '切换至夜间护眼模式' : '切换至白天暖纸模式'}
          aria-label="切换日夜主题"
          onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        >
          {theme === 'light' ? <IconMoon size={17} /> : <IconSun size={17} />}
        </button>
      </div>

      {loading && <div role="status" className="app-status">{loading}</div>}
      {error && <div role="alert" className="app-error" onClick={() => setError('')}>{error}（点击关闭）</div>}

      {/* HOME: Three Minimal Pillars */}
      {hub === 'home' && (
        <div className="home-launcher">
          <div className="home-header">
            <div className="home-brand-mark">
              <IconLirioMark size={76} className="brand-icon-lg" />
            </div>
            <h1>Lirio</h1>
            <p>精听 · 拼写 · 对话</p>
          </div>
          <div className="home-grid">
            <button type="button" className="home-card" onClick={() => void handleEnterListening(true)}>
              <span className="home-card-icon">
                <IconHeadphones size={26} />
              </span>
              <strong>听力</strong>
              <small>精听材料库、播客与逐句跟读</small>
              <div className="home-card-progress">
                <div className="home-progress-row">
                  <span className="home-progress-label">{homeCards.listening.label}</span>
                  <span className="home-progress-val">{homeCards.listening.value}</span>
                </div>
                <div className="home-progress-track">
                  <i className="home-progress-fill" style={{ width: `${homeCards.listening.pct}%` }} />
                </div>
              </div>
            </button>

            <button type="button" className="home-card" onClick={() => setHub('words')}>
              <span className="home-card-icon">
                <IconCorpus size={26} />
              </span>
              <strong>单词</strong>
              <small>雅思高频词卡听写与错词本</small>
              <div className="home-card-progress">
                <div className="home-progress-row">
                  <span className="home-progress-label">{homeCards.words.label}</span>
                  <span className="home-progress-val">{homeCards.words.value}</span>
                </div>
                <div className="home-progress-track">
                  <i className="home-progress-fill" style={{ width: `${homeCards.words.pct}%` }} />
                </div>
              </div>
            </button>

            <button type="button" className="home-card" onClick={() => setHub('speak')}>
              <span className="home-card-icon">
                <IconChat size={26} />
              </span>
              <strong>对话</strong>
              <small>双语语音伴侣与雅思考官</small>
              <div className="home-card-progress">
                <div className="home-progress-row">
                  <span className="home-progress-label">{homeCards.speak.label}</span>
                  <span className="home-progress-val">{homeCards.speak.value}</span>
                </div>
                <div className="home-progress-track">
                  <i className="home-progress-fill" style={{ width: `${homeCards.speak.pct}%` }} />
                </div>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* MODULE 1: Listening */}
      {hub === 'listening' && (
        <>
          {listeningMode === 'analysis' ? (
            <SubmissionAnalysis onJumpToSentence={handleJumpToSentence} />
          ) : listeningMode === 'library' ? (
            <MaterialLibrary
              onOpen={openMaterial}
              onOpenLocalPath={openLocalAudioPath}
              onImportDownloadedPodcast={(path, _title, tier) =>
                handleImportLocalAudioPaths([path], tier || 'auto', 'en')
              }
              refreshKey={libraryRefreshKey}
            />
          ) : project ? (
            listeningMode === 'dictation' ? (
              <Dictation
                onBusy={setAsrBusy}
                autoPlayOnOpen={autoPlayDictation}
                onAutoPlayConsumed={() => setAutoPlayDictation(false)}
                onOpenAiSettings={() => {
                  setSettingsTab('ai');
                  setSettingsOpen(true);
                }}
                onDiscussInSpeak={(topicTitle, excerpt) => {
                  stopListeningAudio();
                  setSpeakContext({ title: topicTitle, excerpt });
                  setHub('speak');
                }}
              />
            ) : listeningMode === 'favorites' ? (
              <Favorites />
            ) : (
              <Timeline />
            )
          ) : (
            <div className="app-empty-hint">
              点击上方图标打开音频或进入阶梯材料库
            </div>
          )}
          {listeningMode === 'audio' && <Transport />}
        </>
      )}

      {/* MODULE 2: Words */}
      {hub === 'words' && <CorpusDictation />}

      {/* MODULE 3: Speak */}
      {hub === 'speak' && (
        <SpeakCompanion
          externalContext={speakContext}
          onClearExternalContext={() => setSpeakContext(null)}
          onOpenGlobalSettings={() => {
            setSettingsTab('ai');
            setSettingsOpen(true);
          }}
        />
      )}

      <GlobalSettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onThemeChange={setTheme}
      />

      {!access.allowed && <LicenseGateModal access={access} account={accountState} />}

      {/* Automated Audio Import & Segmentation Agent Modal */}
      {showImportModal && (
        <div
          className="import-modal-backdrop"
          onClick={() => {
            if (!importBusy) setShowImportModal(false);
          }}
        >
          <div className="import-modal" onClick={(e) => e.stopPropagation()}>
            <div className="import-modal-head">
              <h2>导入新音频 · 自动入库</h2>
              <button
                type="button"
                className="icon-btn"
                disabled={importBusy}
                aria-label="关闭"
                onClick={() => setShowImportModal(false)}
              >
                <IconClose size={15} />
              </button>
            </div>
            <p className="import-modal-desc">
              选择 1 个或多个本地音频（MP3 / M4A / WAV / MP4），自动完成本机识别、意群分句、静音裁剪并存入 SSD 材料库。
            </p>
            <div className="import-modal-grid">
              <label>
                识别语言
                <CustomSelect
                  value={importLanguage}
                  disabled={importBusy}
                  options={[
                    { value: 'en', label: '英语' },
                    { value: 'zh', label: '中文' },
                    { value: 'auto', label: '自动' },
                  ]}
                  minWidth={150}
                  onChange={(v) => setImportLanguage(v)}
                />
              </label>
              <label>
                放入阶梯
                <CustomSelect
                  value={importTier}
                  disabled={importBusy}
                  options={[
                    { value: 'auto', label: '自动归类' },
                    { value: 'L1', label: 'L1 初学者（A1–A2）' },
                    { value: 'L2', label: 'L2 高中生（A2–B1）' },
                    { value: 'L3', label: 'L3 大学生（B1–B2）' },
                    { value: 'L4', label: 'L4 高阶进阶（C1–C2）' },
                  ]}
                  minWidth={150}
                  onChange={(v) => setImportTier(v as ImportTierChoice)}
                />
              </label>
            </div>

            <label className="import-ai-opt">
              <input
                type="checkbox"
                checked={importAiPolish}
                disabled={importBusy}
                onChange={(e) => setImportAiPolish(e.target.checked)}
              />
              <div>
                <strong>导入后 AI 精校字幕 + 生成中文译文（可选）</strong>
                <small>
                  默认离线免费识别；导入后也可随时按需 AI 精校。
                </small>
              </div>
            </label>

            {importError && (
              <div className="app-error" style={{ borderRadius: 10 }} onClick={() => setImportError('')}>
                {importError}
              </div>
            )}

            {importBusy && importProgress && (
              <div className="import-progress-box">
                <strong>
                  正在处理 {importProgress.fileIndex}/{importProgress.totalFiles}：{importProgress.fileName}
                </strong>
                <small>{importProgress.stage}</small>
              </div>
            )}

            <div className="import-modal-actions">
              {importBusy ? (
                <button
                  type="button"
                  onClick={() => {
                    void invoke('cancel_transcription');
                  }}
                >
                  取消处理
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => setShowImportModal(false)}>
                    关闭
                  </button>
                  <button type="button" className="primary" onClick={() => void handleBatchImportAudio()}>
                    选择音频并自动处理
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {!updateState.dismissed &&
        (updateState.status === 'available' ||
          updateState.status === 'downloading' ||
          updateState.status === 'ready') && (
          <div className="update-toast" role="status">
            {updateState.status === 'available' ? (
              <>
                <span className="update-toast-label">新版本 v{updateState.availableVersion}</span>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void downloadAndInstallUpdate()}
                >
                  更新
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="忽略更新"
                  onClick={dismissUpdateToast}
                >
                  <IconClose size={14} />
                </button>
              </>
            ) : updateState.status === 'downloading' ? (
              <>
                <span className="update-toast-label">下载中 {updateState.progressPct ?? 0}%</span>
                <div className="update-toast-progress">
                  <i style={{ width: `${updateState.progressPct ?? 0}%` }} />
                </div>
              </>
            ) : (
              <>
                <span className="update-toast-label">
                  v{updateState.availableVersion} 已就绪
                </span>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void relaunchAfterUpdate()}
                >
                  立即重启
                </button>
              </>
            )}
          </div>
        )}
    </div>
  );
}
