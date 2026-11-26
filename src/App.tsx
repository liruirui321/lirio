import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import './theme.css';
import './styles/mobile.css';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { audioEngine } from './services/audioEngine';
import { projectService } from './services/projectService';
import { simplifyMaterialTitle } from './services/materialTitle';
import {
  dismissDailyMistakeReminder,
  getActiveCorpusDraftSummary,
  getDailyMistakeReminder,
  loadCorpusState,
  type DailyMistakeReminder,
} from './services/corpusService';
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
  getAccountState,
  getDeviceIdentity,
  refreshAccountMe,
  subscribeAccount,
  type AccountState,
} from './services/accountService';
import { hydrateStateFromDisk, restoreStateFromCloudIfLocalEmpty } from './services/stateSync';
import {
  checkMicPermission,
  hasDismissedFirstRunMicPrompt,
  markFirstRunMicPrompt,
  openSystemMicSettings,
  requestMicPermission,
  type MicPermissionStatus,
} from './services/micPermission';
import {
  commitPreparedImportsToLibrary,
  importAudioFilesToLibrary,
  prepareAudioFilesForImport,
  type ImportProgress,
  type ImportTierChoice,
  type PreparedImportItem,
} from './services/importAgent';
import { useProjectStore } from './stores/projectStore';
import { usePlayerStore } from './stores/playerStore';
import { Timeline } from './components/Timeline/Timeline';
import { Favorites } from './components/Dictation/Favorites';
import { Dictation } from './components/Dictation/Dictation';
import { MaterialLibrary } from './components/Library/MaterialLibrary';
import { history } from './services/submissions';
import { SubmissionAnalysis } from './components/Analysis/SubmissionAnalysis';
import { CorpusDictation, type CorpusLaunchRequest } from './components/Corpus/CorpusDictation';
import { CustomSelect } from './components/Corpus/CustomSelect';
import { SpeakCompanion } from './components/Speak/SpeakCompanion';
import {
  syncNativeSystemBars,
  useIsMobileLayout,
  useKeyboardVisible,
} from './services/platform';
import { MobileBottomNav, MobileTopBar } from './components/Mobile/MobileNav';
import { GlobalSettingsModal, type GlobalSettingsTab } from './components/Settings/GlobalSettingsModal';
import { Transport } from './components/Player/Transport';
import { GlobalTooltip } from './components/GlobalTooltip';
import { SelectionTools } from './components/SelectionTools';
import {
  IconBack,
  IconBookmark,
  IconChart,
  IconChat,
  IconCheck,
  IconClose,
  IconCorpus,
  IconExport,
  IconFolderAudio,
  IconHeadphones,
  IconLibrary,
  IconLirioMark,
  IconMic,
  IconMoon,
  IconNext,
  IconReplay,
  IconSettings,
  IconStop,
  IconSun,
  IconTrash,
  IconUpload,
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

  const [hub, setHub] = useState<HubSection>('home');
  const [listeningMode, setListeningMode] = useState<ListeningMode>('library');
  const [autoPlayDictation, setAutoPlayDictation] = useState(false);
  const [speakContext, setSpeakContext] = useState<{ title: string; excerpt: string } | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importLanguage, setImportLanguage] = useState('en');
  const [importAiPolish, setImportAiPolish] = useState(true);
  const [importBusy, setImportBusy] = useState(false);
  const [importSaving, setImportSaving] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState('');
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [preparedImports, setPreparedImports] = useState<PreparedImportItem[]>([]);
  const importCancelRef = useRef({ cancelled: false });
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(() => getUpdateState());
  const [stateTick, setStateTick] = useState(0);
  const [reminderTick, setReminderTick] = useState(0);
  const [wordsLaunch, setWordsLaunch] = useState<CorpusLaunchRequest | null>(null);
  const [micModalOpen, setMicModalOpen] = useState(false);
  const [micStatus, setMicStatus] = useState<MicPermissionStatus>('prompt');
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState('');
  const [speakCallActive, setSpeakCallActive] = useState(false);
  const isMobile = useIsMobileLayout();
  const kbOpen = useKeyboardVisible();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('aboboo-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {}
    return 'light';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    syncNativeSystemBars(theme);
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
        return restoreStateFromCloudIfLocalEmpty().then((cloudRestored) => {
          if (cloudRestored) setStateTick((t) => t + 1);
          return refreshAccountMe().catch(() => null);
        });
      })
      .catch(() => {});
    const unsubAcct = subscribeAccount((next) => setAccountState(next));
    const onOnline = () => {
      void refreshAccountMe().catch(() => {});
    };
    const onWindowFocus = () => {
      setReminderTick((n) => n + 1);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      unsubAcct();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onWindowFocus);
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

  useEffect(() => {
    const timer = setTimeout(() => {
      if (hasDismissedFirstRunMicPrompt()) return;
      void checkMicPermission().then((status) => {
        setMicStatus(status);
        if (status !== 'granted') {
          setMicModalOpen(true);
        }
      });
    }, 600);
    return () => clearTimeout(timer);
  }, []);

  const mistakeReminder: DailyMistakeReminder = useMemo(
    () => getDailyMistakeReminder(loadCorpusState()),
    [stateTick, reminderTick, hub],
  );
  const handleConsumeWordsLaunch = useCallback(() => setWordsLaunch(null), []);
  const handleMistakesChanged = useCallback(() => setReminderTick((n) => n + 1), []);

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
      const isContentUri = selected.startsWith('content://');
      if (!isContentUri) {
        await invoke('inspect_audio_file', { path: selected });
      }
      setLoading('正在读取音频…');
      const bytes = await readFile(selected);
      let decodedName = selected;
      if (isContentUri) {
        try { decodedName = decodeURIComponent(selected); } catch {}
      }
      const ext = decodedName.split('.').pop()?.toLowerCase() ?? '';
      const mime = ({ mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', ogg: 'audio/ogg' } as Record<string, string>)[ext] || 'application/octet-stream';
      const blob = new Blob([bytes], { type: mime });
      url = URL.createObjectURL(blob);
      const arrayBuffer = await blob.arrayBuffer();

      const newProject = projectService.createProject(
        customTitle || decodedName.split(/[/:\\]/).pop()?.replace(/\.[^.]+$/, '') || 'Project',
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
      tierOverride: ImportTierChoice = 'auto',
      languageOverride: string = importLanguage,
      sourceKind: 'user' | 'podcast' = 'user',
    ) => {
      if (!paths.length) return;
      stopListeningAudio();
      setImportError('');
      setShowImportModal(true);
      setImportBusy(true);
      setAsrBusy(true);
      setImportProgress({
        step: 'decode',
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
          sourceKind,
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
    [importLanguage, importAiPolish],
  );

  const handleBatchImportAudio = async () => {
    setImportError('');
    setImportWarnings([]);
    const picked = await open({
      filters: [
        { name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'aif', 'aiff', 'mp4'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      multiple: true,
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
    if (!paths.length) return;

    stopListeningAudio();
    importCancelRef.current = { cancelled: false };
    setPreparedImports([]);
    setShowImportModal(true);
    setImportBusy(true);
    setAsrBusy(true);
    setImportProgress({
      step: 'decode',
      fileIndex: 1,
      totalFiles: paths.length,
      fileName: paths[0].split(/[/\\]/).pop() || '',
      stage: '正在检查并解码音频…',
    });

    try {
      const { prepared, warnings } = await prepareAudioFilesForImport({
        paths,
        language: importLanguage,
        tier: 'auto',
        sourceKind: 'user',
        aiPolish: {
          enabled: importAiPolish,
          fixText: true,
          addTranslation: true,
        },
        signal: importCancelRef.current,
        onProgress: (p) => setImportProgress(p),
      });
      if (importCancelRef.current.cancelled) {
        setImportProgress(null);
        return;
      }
      setPreparedImports(prepared);
      setImportWarnings(warnings);
      setImportProgress(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (importCancelRef.current.cancelled || /已取消/.test(msg)) {
        setImportError('');
      } else {
        setImportError('导入处理失败：' + msg);
      }
      setImportProgress(null);
    } finally {
      setImportBusy(false);
      setAsrBusy(false);
    }
  };

  const handleConfirmPreparedImports = async () => {
    if (!preparedImports.length || importSaving) return;
    setImportError('');
    setImportSaving(true);
    try {
      const res = await commitPreparedImportsToLibrary(preparedImports, (p) => setImportProgress(p));
      setLibraryRefreshKey((k) => k + 1);
      if (importWarnings.length) {
        setError(importWarnings.join('；'));
      }
      setPreparedImports([]);
      setImportWarnings([]);
      setImportProgress(null);
      setShowImportModal(false);
      if (res.lastLibraryId) {
        await openMaterial(res.lastLibraryId);
      }
    } catch (e) {
      setImportError('写入材料库失败：' + String(e));
    } finally {
      setImportSaving(false);
      setImportProgress(null);
    }
  };

  const handleDiscardPreparedImports = () => {
    if (importBusy || importSaving) return;
    setPreparedImports([]);
    setImportWarnings([]);
    setImportError('');
    setImportProgress(null);
    setShowImportModal(false);
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

  // Android hardware back handler: dismiss modals -> back to library -> back to home -> exit toast
  useEffect(() => {
    window.__lirioHandleAndroidBack = () => {
      if (micModalOpen) {
        setMicModalOpen(false);
        return true;
      }
      if (showImportModal) {
        if (!importBusy && !importSaving) {
          setPreparedImports([]);
          setImportWarnings([]);
          setShowImportModal(false);
        }
        return true;
      }
      if (settingsOpen) {
        setSettingsOpen(false);
        return true;
      }
      if (asrBusy || !!loading || isRec || speakCallActive) {
        return true;
      }
      if (hub === 'listening' && listeningMode !== 'library') {
        stopListeningAudio();
        setListeningMode('library');
        return true;
      }
      if (hub !== 'home') {
        stopListeningAudio();
        setHub('home');
        return true;
      }
      return false;
    };
    return () => {
      if (window.__lirioHandleAndroidBack) {
        delete window.__lirioHandleAndroidBack;
      }
    };
  }, [micModalOpen, showImportModal, importBusy, settingsOpen, asrBusy, loading, isRec, speakCallActive, hub, listeningMode]);

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
      {isMobile ? (
        <MobileTopBar
          hub={hub}
          listeningMode={listeningMode}
          projectName={project ? simplifyMaterialTitle(project.name).shortTitle : undefined}
          favoritesCount={project?.favorites?.length || 0}
          hasProject={Boolean(project)}
          busy={asrBusy || !!loading || isRec}
          userName={accountState.user?.name || null}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          onOpenSettings={(tab) => {
            setSettingsTab(tab);
            setSettingsOpen(true);
          }}
          onBackListeningLibrary={() => {
            stopListeningAudio();
            setListeningMode('library');
          }}
          onSelectListeningMode={(mode) => {
            stopListeningAudio();
            setListeningMode(mode);
          }}
          onOpenImport={() => {
            setImportError('');
            setImportWarnings([]);
            setPreparedImports([]);
            setShowImportModal(true);
          }}
        />
      ) : (
      /* Breathable Borderless Top Navigation */
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

        {accountState.user ? (
          <button
            type="button"
            className="account-topbar-pill"
            title="账号与云同步"
            aria-label="个人账号与设置"
            onClick={() => {
              setSettingsTab('ai');
              setSettingsOpen(true);
            }}
          >
            <IconUser size={15} />
            <span>{accountState.user.name}</span>
          </button>
        ) : (
          <button
            className={`icon-btn${settingsOpen && settingsTab === 'ai' ? ' active' : ''}`}
            title="账号、云同步与设置"
            aria-label="账号与设置"
            onClick={() => {
              setSettingsTab('ai');
              setSettingsOpen(true);
            }}
          >
            <IconUser size={17} />
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
      )}

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
          <button
            type="button"
            className="home-community-pill"
            onClick={() => {
              setSettingsTab('feedback');
              setSettingsOpen(true);
            }}
          >
            <span className="home-community-dot" aria-hidden="true" />
            <span>QQ 交流群 966587892 · 扫码入群与反馈</span>
            <span className="home-community-arrow" aria-hidden="true">›</span>
          </button>
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
                handleImportLocalAudioPaths([path], tier || 'auto', 'en', 'podcast')
              }
              onOpenImport={() => {
                setImportError('');
                setImportWarnings([]);
                setPreparedImports([]);
                setShowImportModal(true);
              }}
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
      {hub === 'words' && (
        <CorpusDictation
          launchRequest={wordsLaunch}
          onConsumeLaunch={handleConsumeWordsLaunch}
          onMistakesChanged={handleMistakesChanged}
        />
      )}

      {/* MODULE 3: Speak */}
      {hub === 'speak' && (
        <SpeakCompanion
          externalContext={speakContext}
          onClearExternalContext={() => setSpeakContext(null)}
          onOpenGlobalSettings={() => {
            setSettingsTab('ai');
            setSettingsOpen(true);
          }}
          onCallActiveChange={setSpeakCallActive}
        />
      )}

      {isMobile && (
        <MobileBottomNav
          hub={hub}
          disabled={asrBusy || !!loading || isRec}
          hidden={kbOpen || speakCallActive || settingsOpen || showImportModal || micModalOpen}
          onSelectHub={(next) => {
            stopListeningAudio();
            if (next === 'listening') {
              void handleEnterListening(true);
            } else {
              setHub(next);
            }
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

      {micModalOpen && (
        <div className="import-modal-backdrop">
          <div
            className="import-modal mic-permission-modal"
            role="dialog"
            aria-modal="true"
            aria-label="开启麦克风权限"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="import-modal-head">
              <h2>开启麦克风权限</h2>
            </div>
            <p className="mic-modal-desc">
              Lirio 的口语对话与跟读练习需要使用麦克风录音，音频仅用于语音识别，不会在后台采集。
            </p>
            {micError && (
              <div className="app-error" style={{ borderRadius: 10 }}>
                {micError}
              </div>
            )}
            <div className="import-modal-actions">
              <button
                type="button"
                className="icon-action-btn"
                disabled={micBusy}
                title="稍后再说"
                aria-label="稍后再说"
                onClick={() => {
                  markFirstRunMicPrompt('later');
                  setMicModalOpen(false);
                }}
              >
                <IconClose size={17} />
              </button>
              {micStatus === 'denied' && (
                <button
                  type="button"
                  className="icon-action-btn"
                  title="打开系统设置"
                  aria-label="打开系统设置"
                  onClick={() => {
                    void openSystemMicSettings().catch((e) => setMicError(String(e)));
                  }}
                >
                  <IconSettings size={17} />
                </button>
              )}
              <button
                type="button"
                className="icon-action-btn primary"
                disabled={micBusy}
                title={micBusy ? '请求中…' : micStatus === 'denied' ? '重试授权' : '立即授权'}
                aria-label={micStatus === 'denied' ? '重试授权' : '立即授权'}
                onClick={async () => {
                  setMicBusy(true);
                  setMicError('');
                  try {
                    const res = await requestMicPermission();
                    setMicStatus(res.status);
                    if (res.ok) {
                      setMicModalOpen(false);
                    } else if (res.error) {
                      setMicError(res.error);
                    }
                  } finally {
                    setMicBusy(false);
                  }
                }}
              >
                <IconMic size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Automated Audio Import, AI Proofreading & Preview Wizard */}
      {showImportModal && (
        <div
          className="import-modal-backdrop"
          onClick={() => {
            if (!importBusy && !importSaving) handleDiscardPreparedImports();
          }}
        >
          <div
            className={`import-modal${preparedImports.length > 0 ? ' wide' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="import-modal-head">
              <h2>
                {preparedImports.length > 0
                  ? '字幕精校预览 · 确认加入我的上传'
                  : '导入音频 · 加入我的上传'}
              </h2>
              <button
                type="button"
                className="icon-btn"
                disabled={importBusy || importSaving}
                aria-label="关闭"
                onClick={handleDiscardPreparedImports}
              >
                <IconClose size={15} />
              </button>
            </div>

            {/* 4-step pipeline status strip when processing or previewing */}
            {(importBusy || importSaving || preparedImports.length > 0) && (() => {
              const curStep = preparedImports.length > 0 && !importSaving
                ? 3
                : importProgress?.step === 'save'
                  ? 3
                  : importProgress?.step === 'polish'
                    ? 2
                    : importProgress?.step === 'transcribe'
                      ? 1
                      : 0;
              return (
                <div className="import-steps-bar" aria-label="导入处理流程">
                  {['1 解码音频', '2 识别分句', '3 AI 精校', '4 预览入库'].map((label, idx) => (
                    <span
                      key={label}
                      className={`import-step-pill${
                        idx < curStep ? ' done' : idx === curStep ? ' active' : ''
                      }`}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              );
            })()}

            {preparedImports.length > 0 ? (
              <>
                {importWarnings.length > 0 && (
                  <div className="corpus-banner" style={{ borderRadius: 10 }}>
                    {importWarnings.join('；')}
                  </div>
                )}
                <div className="import-preview-scroll">
                  {preparedImports.map((item, idx) => {
                    const fmtTime = (sec: number) =>
                      `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
                    const previewSlice = item.previewLines.slice(0, 12);
                    return (
                      <div key={item.project.id} className="import-preview-box">
                        <div className="import-preview-title-row">
                          <label>
                            <span>材料名称</span>
                            <input
                              type="text"
                              value={item.title}
                              disabled={importSaving}
                              onChange={(e) => {
                                const val = e.target.value;
                                setPreparedImports((prev) =>
                                  prev.map((x, j) => (j === idx ? { ...x, title: val } : x)),
                                );
                              }}
                            />
                          </label>
                          <div className="import-preview-stats">
                            <span>共 {item.sentenceCount} 句</span>
                            {item.aiPolished && (
                              <span className="tier-badge small pro">
                                AI 修正 {item.changedCount} 处 · 译文 {item.translatedCount} 句
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="import-preview-list">
                          {previewSlice.map((line, li) => (
                            <div key={line.id} className="import-preview-line">
                              <div className="import-preview-line-meta">
                                <span>
                                  {li + 1}. {fmtTime(line.start)}
                                </span>
                                {line.changed && <span className="import-fixed-tag">已修正</span>}
                              </div>
                              <div className="import-preview-en">{line.text}</div>
                              {line.changed && (
                                <div className="import-preview-raw">原识别：{line.rawText}</div>
                              )}
                              {line.translation && (
                                <div className="import-preview-zh">{line.translation}</div>
                              )}
                            </div>
                          ))}
                          {item.previewLines.length > 12 && (
                            <div className="import-preview-more">
                              其余 {item.previewLines.length - 12} 句已一并就绪，入库后即可逐句听写。
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <p className="import-modal-desc">
                  选择本地音频（MP3 / M4A / WAV / MP4），自动完成音频解码、识别分句并由 AI 精校字幕与中文译文，确认预览后保存到你的「我的上传」独立仓库。
                </p>
                <div className="import-modal-grid single">
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
                </div>

                <label className="import-ai-opt">
                  <input
                    type="checkbox"
                    checked={importAiPolish}
                    disabled={importBusy}
                    onChange={(e) => setImportAiPolish(e.target.checked)}
                  />
                  <div>
                    <strong>AI 精校字幕并生成中文译文</strong>
                    <small>
                      自动修正语音识别中的拼写、专有名词与标点，并生成对照译文；未联网或未登录时自动保留原始识别字幕。
                    </small>
                  </div>
                </label>
              </>
            )}

            {importError && (
              <div className="app-error" style={{ borderRadius: 10 }} onClick={() => setImportError('')}>
                {importError}
              </div>
            )}

            {(importBusy || importSaving) && importProgress && (
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
                  className="icon-action-btn danger"
                  title="取消处理"
                  aria-label="取消处理"
                  onClick={() => {
                    importCancelRef.current.cancelled = true;
                    void invoke('cancel_transcription').catch(() => {});
                  }}
                >
                  <IconStop size={17} />
                </button>
              ) : preparedImports.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="icon-action-btn"
                    disabled={importSaving}
                    title="放弃本次导入"
                    aria-label="放弃"
                    onClick={handleDiscardPreparedImports}
                  >
                    <IconTrash size={17} />
                  </button>
                  <button
                    type="button"
                    className="icon-action-btn primary"
                    disabled={importSaving}
                    title={importSaving ? '正在入库…' : '确认入库并开始听写'}
                    aria-label="确认入库并开始听写"
                    onClick={() => void handleConfirmPreparedImports()}
                  >
                    <IconCheck size={19} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="icon-action-btn"
                    title="关闭"
                    aria-label="关闭"
                    onClick={handleDiscardPreparedImports}
                  >
                    <IconClose size={17} />
                  </button>
                  <button
                    type="button"
                    className="icon-action-btn primary"
                    title="选择本地音频并自动制作精听材料"
                    aria-label="选择音频并自动生成精听材料"
                    onClick={() => void handleBatchImportAudio()}
                  >
                    <IconUpload size={19} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {mistakeReminder.shouldRemind && hub !== 'words' && (
        <div
          className={`mistake-reminder-toast${
            !updateState.dismissed &&
            (updateState.status === 'available' ||
              updateState.status === 'downloading' ||
              updateState.status === 'ready')
              ? ' stacked'
              : ''
          }`}
          role="status"
        >
          <span className="mistake-reminder-dot" aria-hidden="true" />
          <span className="update-toast-label">
            {mistakeReminder.overdueCount > 0
              ? `今日错词待巩固（${mistakeReminder.totalMistakes} 词）`
              : `错词本有 ${mistakeReminder.totalMistakes} 词待巩固`}
          </span>
          <button
            type="button"
            className="icon-btn primary"
            title="去巩固错词"
            aria-label="去巩固"
            onClick={() => {
              setWordsLaunch({ mode: 'mistakes-drill', nonce: Date.now() });
              setHub('words');
            }}
          >
            <IconNext size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="今日不再提醒"
            aria-label="今日不再提醒"
            onClick={() => {
              dismissDailyMistakeReminder();
              setReminderTick((n) => n + 1);
            }}
          >
            <IconClose size={14} />
          </button>
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
                  className="icon-btn primary"
                  title="下载并安装更新"
                  aria-label="更新"
                  onClick={() => void downloadAndInstallUpdate()}
                >
                  <IconExport size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="忽略本次更新"
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
                  className="icon-btn primary"
                  title="立即重启应用新版本"
                  aria-label="立即重启"
                  onClick={() => void relaunchAfterUpdate()}
                >
                  <IconReplay size={15} />
                </button>
              </>
            )}
          </div>
        )}
    </div>
  );
}
