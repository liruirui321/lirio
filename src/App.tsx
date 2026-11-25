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
  formatYuan,
  getAccountState,
  refreshAccountMe,
  subscribeAccount,
  type AccountState,
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
  IconWave,
} from './components/Icons';

type HubSection = 'home' | 'listening' | 'words' | 'speak';
type ListeningMode = 'library' | 'audio' | 'dictation' | 'favorites' | 'analysis';

export default function App() {
  const { project, setProject, setBlobUrl, addRecordingBlob } = useProjectStore();
  const { setDuration, setCurrentTime } = usePlayerStore();

  const [hub, setHub] = useState<HubSection>('home');
  const [listeningMode, setListeningMode] = useState<ListeningMode>('library');
  const [speakContext, setSpeakContext] = useState<{ title: string; excerpt: string } | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importLanguage, setImportLanguage] = useState('en');
  const [importTier, setImportTier] = useState<ImportTierChoice>('auto');
  const [importBusy, setImportBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState('');
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<GlobalSettingsTab>('account');
  const [accountState, setAccountState] = useState<AccountState>(() => getAccountState());
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
    hydrateStateFromDisk()
      .then((restored) => {
        if (restored) {
          setAccountState(getAccountState());
          setStateTick((t) => t + 1);
        }
        return refreshAccountMe().catch(() => null);
      })
      .catch(() => {});
    return subscribeAccount((next) => setAccountState(next));
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

  const openMaterial = async (id: string) => {
    setLoading('正在打开材料…');
    setError('');
    try {
      await loadResult(projectService.parse(await invoke<string>('library_open', { id })));
      setListeningMode('dictation');
    } finally {
      setLoading('');
    }
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
          onProgress: (p) => setImportProgress(p),
        });
        setLibraryRefreshKey((k) => k + 1);
        setShowImportModal(false);
        setImportProgress(null);
        if (res.lastLibraryId) {
          await openMaterial(res.lastLibraryId);
        }
      } catch (e) {
        setImportError('导入失败：' + String(e));
      } finally {
        setImportBusy(false);
        setAsrBusy(false);
      }
    },
    [importLanguage, importTier],
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

  const homeHints = useMemo(() => {
    if (hub !== 'home') {
      return { listening: '', words: '', speak: '' };
    }
    let listeningHint = '阶梯精听库、拓展播客与逐句跟读';
    try {
      const raw = localStorage.getItem('aboboo-last-listening');
      if (raw) {
        const parsed = JSON.parse(raw) as { title?: string; index?: number; total?: number };
        if (parsed?.title) {
          const total = typeof parsed.total === 'number' && parsed.total > 0 ? `/${parsed.total}` : '';
          listeningHint = `上次：${parsed.title} · 第 ${(parsed.index ?? 0) + 1}${total} 句`;
        }
      }
    } catch {}

    let wordsHint = '暂无错词 · 词卡听写保持手感';
    try {
      const cs = loadCorpusState();
      const mistakeCount = Object.keys(cs.mistakes || {}).length;
      const draft = getActiveCorpusDraftSummary(cs);
      if (draft) {
        wordsHint = `进行中 ${draft.sectionTitle} · ${draft.doneCount}/${draft.total}${mistakeCount > 0 ? ` · ${mistakeCount} 错词` : ''}`;
      } else if (mistakeCount > 0) {
        wordsHint = `错词本 ${mistakeCount} 词待清空`;
      }
    } catch {}

    let speakHint = '随时开启双语陪练或雅思模考';
    try {
      const ss = loadSpeakState();
      const sessionCount = ss.sessions?.length || 0;
      const memCount =
        (ss.memory?.aboutMe?.length || 0) +
        (ss.memory?.habits?.length || 0) +
        (ss.memory?.recurringTopics?.length || 0) +
        (ss.memory?.targetPhrases?.length || 0);
      if (sessionCount > 0) {
        speakHint = `${sessionCount} 次对话复盘 · ${memCount} 条记忆`;
      } else if (memCount > 0) {
        speakHint = `已沉淀 ${memCount} 条私人记忆`;
      }
    } catch {}

    return { listening: listeningHint, words: wordsHint, speak: speakHint };
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

        <button
          type="button"
          className={`account-topbar-pill${
            accountState.user && accountState.aiMode === 'pro_balance' && accountState.user.balanceUnits < 10000
              ? ' low'
              : ''
          }`}
          title="账户、余额与 AI 计费模式设置"
          onClick={() => {
            setSettingsTab('account');
            setSettingsOpen(true);
          }}
        >
          {accountState.user
            ? accountState.aiMode === 'pro_balance'
              ? `Pro · ${formatYuan(accountState.user.balanceUnits, 2)}`
              : '自有 Key'
            : '登录 / Pro'}
        </button>

        <button
          className={`icon-btn${settingsOpen ? ' active' : ''}`}
          title="用户设置（账户、AI 引擎、语音与数据备份）"
          aria-label="用户设置"
          onClick={() => {
            setSettingsTab('ai');
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
            <button type="button" className="home-card" onClick={() => setHub('listening')}>
              <span className="home-card-icon">
                <IconHeadphones size={26} />
              </span>
              <strong>听力</strong>
              <small>阶梯精听库、拓展播客与逐句跟读</small>
              <span className="home-card-meta">{homeHints.listening}</span>
            </button>

            <button type="button" className="home-card" onClick={() => setHub('words')}>
              <span className="home-card-icon">
                <IconCorpus size={26} />
              </span>
              <strong>单词</strong>
              <small>雅思高频词卡听写、乱序闯关与错词本</small>
              <span className="home-card-meta">{homeHints.words}</span>
            </button>

            <button type="button" className="home-card" onClick={() => setHub('speak')}>
              <span className="home-card-icon">
                <IconChat size={26} />
              </span>
              <strong>对话</strong>
              <small>双语语音伴侣与雅思考官题单模考</small>
              <span className="home-card-meta">{homeHints.speak}</span>
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
                    { value: 'L1', label: 'L1 基础生活' },
                    { value: 'L2', label: 'L2 进阶叙事' },
                    { value: 'L3', label: 'L3 高阶研讨' },
                    { value: 'L4', label: 'L4 专业讲座' },
                  ]}
                  minWidth={150}
                  onChange={(v) => setImportTier(v as ImportTierChoice)}
                />
              </label>
            </div>

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
    </div>
  );
}
