import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  IconCheck,
  IconClose,
  IconEye,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconReplay,
  IconSettings,
  IconTrash,
  IconVolume,
} from '../Icons';
import { CustomSelect, type SelectOption } from './CustomSelect';
import { handleDictationKeySound } from '../../services/typingSound';
import {
  type Accent,
  type CardWordState,
  type CorpusBookMeta,
  type CorpusPersistedState,
  type CorpusWord,
  type GradeResult,
  type MistakeEntry,
  type SectionDraft,
  estimateIeltsBand,
  exportMistakesAudio,
  exportMistakesCsv,
  getBookCompletedCount,
  getBuiltinManifest,
  getSmartNextSection,
  getWordAudio,
  gradeWord,
  loadBookWords,
  loadCorpusState,
  parseCustomWordList,
  preloadWordAudio,
  saveCorpusState,
  sectionProgressKey,
} from '../../services/corpusService';

type SubView = 'practice' | 'walkman' | 'mistakes' | 'history' | 'import';

const emptyCardState = (): CardWordState => ({ status: 'idle', hadMistake: false, lastResult: null });

function findNextUnfinishedIndex(states: CardWordState[], fromIdx: number): number {
  for (let i = fromIdx + 1; i < states.length; i++) {
    if (states[i]?.status !== 'passed' && states[i]?.status !== 'revealed') return i;
  }
  for (let i = 0; i <= fromIdx && i < states.length; i++) {
    if (states[i]?.status !== 'passed' && states[i]?.status !== 'revealed') return i;
  }
  return -1;
}

function findLatestDraftSection(
  bookId: string,
  totalSections: number,
  sectionSize: number,
  drafts: Record<string, SectionDraft>,
): number | null {
  let bestIdx: number | null = null;
  let bestTs = -1;
  for (let i = 0; i < totalSections; i++) {
    const d = drafts[sectionProgressKey(bookId, sectionSize, i)];
    if (!d) continue;
    const hasProgress =
      d.cardStates.some((s) => s.status !== 'idle') || d.inputs.some((v) => v.trim().length > 0);
    if (hasProgress && (d.updatedAt || 0) > bestTs) {
      bestTs = d.updatedAt || 0;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function getMistakeRetentionBadge(lastWrongAt: number): { label: string; isToday: boolean } {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  if (!lastWrongAt || lastWrongAt >= todayMs) {
    return { label: '今日新错', isToday: true };
  }
  const wrongDay = new Date(lastWrongAt);
  wrongDay.setHours(0, 0, 0, 0);
  const days = Math.max(1, Math.round((todayMs - wrongDay.getTime()) / 86400000));
  return { label: `已滞留 ${days} 天`, isToday: false };
}

const RATES = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const SECTION_SIZES = [20, 30, 50, 100];
const ACCENTS: { id: Accent; label: string }[] = [
  { id: 'uk', label: '英音 UK' },
  { id: 'us', label: '美音 US' },
  { id: 'au', label: '澳音 AU' },
  { id: 'in', label: '印音 IN' },
];

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export interface CorpusLaunchRequest {
  mode: 'mistakes-drill' | 'mistakes-view';
  nonce: number;
}

interface CorpusDictationProps {
  launchRequest?: CorpusLaunchRequest | null;
  onConsumeLaunch?: () => void;
  onMistakesChanged?: () => void;
}

export function CorpusDictation({
  launchRequest,
  onConsumeLaunch,
  onMistakesChanged,
}: CorpusDictationProps = {}) {
  const [persisted, setPersisted] = useState<CorpusPersistedState>(() => loadCorpusState());
  const builtinManifest = useMemo(() => getBuiltinManifest(), []);
  const allBooks: CorpusBookMeta[] = useMemo(() => {
    const custom = Object.values(persisted.customBooks).map((b) => b.meta);
    return [...builtinManifest, ...custom];
  }, [builtinManifest, persisted.customBooks]);

  const [subView, setSubView] = useState<SubView>('practice');
  const [showSettings, setShowSettings] = useState<boolean>(false);

  const [bookId, setBookId] = useState<string>(() => {
    const saved = persisted.prefs.bookId;
    if (saved && (builtinManifest.some((b) => b.id === saved) || persisted.customBooks[saved])) {
      return saved;
    }
    return builtinManifest[0]?.id || 'listening_highfreq';
  });
  const [bookWords, setBookWords] = useState<CorpusWord[]>([]);
  const [sectionSize, setSectionSize] = useState<number>(() => persisted.prefs.sectionSize || 30);
  const [sectionIndex, setSectionIndex] = useState<number>(0);

  const [drillWords, setDrillWords] = useState<CorpusWord[]>([]);
  const [drillLabel, setDrillLabel] = useState<string>('');
  const [isMistakeDrill, setIsMistakeDrill] = useState<boolean>(false);

  // Settings (tucked cleanly into popover)
  const [accent, setAccent] = useState<Accent>(() => persisted.prefs.accent || 'uk');
  const [rate, setRate] = useState<number>(() => persisted.prefs.rate || 1.0);
  const [shuffled, setShuffled] = useState<boolean>(() => persisted.prefs.shuffled ?? true);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(false);
  const [autoPauseSec, setAutoPauseSec] = useState<number>(2.5);
  const [showHint, setShowHint] = useState<boolean>(false);
  const [layoutMode, setLayoutMode] = useState<'card' | 'list'>('card');

  // Practice state
  const [inputs, setInputs] = useState<string[]>([]);
  const [cardStates, setCardStates] = useState<CardWordState[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [cardFocused, setCardFocused] = useState<boolean>(false);
  const [cardCaret, setCardCaret] = useState<number>(0);
  const [submitted, setSubmitted] = useState<boolean>(false);
  const [results, setResults] = useState<GradeResult[]>([]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [exporting, setExporting] = useState<string>('');

  // Walkman state
  const [walkmanPlaying, setWalkmanPlaying] = useState<boolean>(false);
  const [walkmanIdx, setWalkmanIdx] = useState<number>(0);
  const [walkmanReveal, setWalkmanReveal] = useState<boolean>(true);
  const [walkmanGapSec, setWalkmanGapSec] = useState<number>(1.8);

  // Mistakes & custom import
  const [mistakeBookFilter, setMistakeBookFilter] = useState<string>('all');
  const [mistakeBatchSize, setMistakeBatchSize] = useState<number>(
    () => persisted.prefs.mistakeBatchSize ?? 30,
  );
  const [importTitle, setImportTitle] = useState<string>('');
  const [importText, setImportText] = useState<string>('');

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const cardInputRef = useRef<HTMLInputElement | null>(null);
  const playSeqRef = useRef<number>(0);
  const autoTimerRef = useRef<number | null>(null);
  const loadedSectionKeyRef = useRef<string>('');

  const updatePersisted = useCallback(
    (updater: (prev: CorpusPersistedState) => CorpusPersistedState) => {
      setPersisted((prev) => {
        const next = updater(prev);
        saveCorpusState(next);
        return next;
      });
    },
    [],
  );

  const mistakeCount = Object.keys(persisted.mistakes || {}).length;
  const historyCount = persisted.history?.length || 0;
  useEffect(() => {
    onMistakesChanged?.();
  }, [mistakeCount, historyCount, onMistakesChanged]);

  const stopAudio = useCallback(() => {
    playSeqRef.current++;
    if (autoTimerRef.current !== null) {
      window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => stopAudio();
  }, [stopAudio]);

  useEffect(() => {
    setCardCaret((inputs[activeIdx] || '').length);
  }, [activeIdx]);

  useEffect(() => {
    updatePersisted((prev) => {
      const p = prev.prefs || {};
      if (
        p.bookId === bookId &&
        p.sectionSize === sectionSize &&
        p.accent === accent &&
        p.rate === rate &&
        p.shuffled === shuffled
      ) {
        return prev;
      }
      return { ...prev, prefs: { bookId, sectionSize, accent, rate, shuffled } };
    });
  }, [bookId, sectionSize, accent, rate, shuffled, updatePersisted]);

  useEffect(() => {
    let cancelled = false;
    loadBookWords(bookId, persisted)
      .then((words) => {
        if (cancelled) return;
        const latestState = loadCorpusState();
        setBookWords(words);
        const sections = Math.max(1, Math.ceil(words.length / sectionSize));
        const draftIdx = findLatestDraftSection(bookId, sections, sectionSize, latestState.sectionDrafts);
        if (draftIdx !== null) {
          setSectionIndex(draftIdx);
        } else {
          const smart = getSmartNextSection(bookId, sections, sectionSize, latestState.sectionProgress);
          setSectionIndex(smart.index);
        }
        setIsMistakeDrill(false);
      })
      .catch((e) => {
        if (!cancelled) setStatusMsg('加载词库失败：' + String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, persisted.customBooks]);

  const totalSections = Math.max(1, Math.ceil(bookWords.length / sectionSize));

  useEffect(() => {
    if (isMistakeDrill || !bookWords.length) return;
    const safeIdx = Math.min(sectionIndex, Math.max(0, Math.ceil(bookWords.length / sectionSize) - 1));
    const start = safeIdx * sectionSize;
    const slice = bookWords.slice(start, start + sectionSize);
    const pKey = sectionProgressKey(bookId, sectionSize, safeIdx);
    const draft = loadCorpusState().sectionDrafts[pKey];
    const sliceMap = new Map(slice.map((w) => [w.w, w]));

    const validDraft =
      draft &&
      draft.wordOrder.length === slice.length &&
      draft.inputs.length === slice.length &&
      draft.cardStates.length === slice.length &&
      draft.wordOrder.every((w) => sliceMap.has(w)) &&
      (draft.cardStates.some((s) => s.status !== 'idle') || draft.inputs.some((v) => v.trim().length > 0));

    stopAudio();
    setDrillLabel(`Section ${safeIdx + 1}（${start + 1}–${start + slice.length}）`);
    setSubmitted(false);
    setResults([]);
    setWalkmanIdx(0);
    setWalkmanPlaying(false);

    if (validDraft) {
      const restoredWords = draft.wordOrder.map((w) => sliceMap.get(w)!);
      const savedIdx = draft.activeIdx;
      const savedCard = draft.cardStates[savedIdx];
      const startIdx =
        savedIdx >= 0 &&
        savedIdx < restoredWords.length &&
        savedCard?.status !== 'passed' &&
        savedCard?.status !== 'revealed'
          ? savedIdx
          : Math.max(0, findNextUnfinishedIndex(draft.cardStates, -1));
      const doneCount = draft.cardStates.filter(
        (s) => s.status === 'passed' || s.status === 'revealed',
      ).length;
      setDrillWords(restoredWords);
      setInputs([...draft.inputs]);
      setCardStates([...draft.cardStates]);
      setActiveIdx(startIdx);
      loadedSectionKeyRef.current = pKey;
      preloadWordAudio(restoredWords, startIdx, accent, 4);
      if (doneCount > 0) {
        setStatusMsg(`已恢复进度（已完成 ${doneCount}/${restoredWords.length} 词），继续第 ${startIdx + 1} 词`);
      }
    } else {
      const list = shuffled ? shuffle(slice) : slice;
      setDrillWords(list);
      setInputs(new Array(list.length).fill(''));
      setCardStates(Array.from({ length: list.length }, emptyCardState));
      setActiveIdx(0);
      loadedSectionKeyRef.current = pKey;
      preloadWordAudio(list, 0, accent, 4);
    }
  }, [bookId, bookWords, sectionIndex, sectionSize, isMistakeDrill, stopAudio]);

  // Continuously save unfinished draft so switching tabs or restarting resumes from the exact word
  useEffect(() => {
    if (
      submitted ||
      !drillWords.length ||
      inputs.length !== drillWords.length ||
      cardStates.length !== drillWords.length
    ) {
      return;
    }
    const pKey = isMistakeDrill
      ? '__mistakes__'
      : sectionProgressKey(
          bookId,
          sectionSize,
          Math.min(sectionIndex, Math.max(0, Math.ceil(bookWords.length / sectionSize) - 1)),
        );
    if (loadedSectionKeyRef.current !== pKey) return;
    const hasProgress =
      inputs.some((v) => v.trim().length > 0) || cardStates.some((s) => s.status !== 'idle');
    if (!hasProgress) return;

    const nextDraft: SectionDraft = {
      wordOrder: drillWords.map((w) => w.w),
      inputs,
      cardStates,
      activeIdx,
      updatedAt: Date.now(),
    };
    updatePersisted((prev) => ({
      ...prev,
      sectionDrafts: {
        ...prev.sectionDrafts,
        [pKey]: nextDraft,
      },
    }));
  }, [
    bookId,
    bookWords.length,
    sectionIndex,
    sectionSize,
    isMistakeDrill,
    submitted,
    drillWords,
    inputs,
    cardStates,
    activeIdx,
    updatePersisted,
  ]);

  useEffect(() => {
    if (drillWords.length) {
      preloadWordAudio(drillWords, activeIdx, accent, 3);
    }
  }, [drillWords, activeIdx, accent]);

  const playWordAt = useCallback(
    async (wordText: string, onDone?: () => void) => {
      stopAudio();
      const seq = playSeqRef.current;
      setStatusMsg('');
      try {
        const { url } = await getWordAudio(wordText, accent);
        if (seq !== playSeqRef.current) return;
        const audio = audioRef.current || new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.playbackRate = rate;
        audio.onended = () => {
          if (seq !== playSeqRef.current) return;
          setIsPlaying(false);
          onDone?.();
        };
        audio.onerror = () => {
          if (seq !== playSeqRef.current) return;
          setIsPlaying(false);
          setStatusMsg(`音频播放失败：${wordText}`);
        };
        setIsPlaying(true);
        await audio.play();
      } catch (e) {
        if (seq !== playSeqRef.current) return;
        setIsPlaying(false);
        setStatusMsg(`获取发音失败（${wordText}）：${String(e)}`);
      }
    },
    [accent, rate, stopAudio],
  );

  const focusAndPlay = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= drillWords.length) return;
      setActiveIdx(idx);
      setTimeout(() => {
        const el = layoutMode === 'card' ? cardInputRef.current : inputRefs.current[idx];
        if (el) {
          el.focus();
          if (layoutMode === 'list') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, 0);
      const word = drillWords[idx]?.w;
      if (!word) return;
      playWordAt(word, () => {
        if (autoAdvance && !submitted && idx + 1 < drillWords.length) {
          autoTimerRef.current = window.setTimeout(() => {
            focusAndPlay(idx + 1);
          }, autoPauseSec * 1000);
        }
      });
    },
    [drillWords, playWordAt, autoAdvance, autoPauseSec, submitted, layoutMode],
  );

  const togglePlayCurrent = useCallback(() => {
    if (isPlaying) {
      stopAudio();
    } else if (drillWords[activeIdx]) {
      playWordAt(drillWords[activeIdx].w);
    }
  }, [isPlaying, stopAudio, drillWords, activeIdx, playWordAt]);

  useEffect(() => {
    if (subView !== 'practice') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        togglePlayCurrent();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        if (drillWords[activeIdx]) playWordAt(drillWords[activeIdx].w);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [subView, togglePlayCurrent, drillWords, activeIdx, playWordAt]);

  useEffect(() => {
    if (subView !== 'walkman' || !walkmanPlaying || !drillWords.length) return;
    const word = drillWords[walkmanIdx]?.w;
    if (!word) return;
    preloadWordAudio(drillWords, walkmanIdx + 1, accent, 3);
    playWordAt(word, () => {
      autoTimerRef.current = window.setTimeout(() => {
        setWalkmanIdx((prev) => (prev + 1) % drillWords.length);
      }, walkmanGapSec * 1000);
    });
    return () => {
      if (autoTimerRef.current !== null) {
        window.clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [subView, walkmanPlaying, walkmanIdx, drillWords, accent, walkmanGapSec, playWordAt]);

  const currentBookMeta = allBooks.find((b) => b.id === bookId);

  const handleSubmit = useCallback(
    (overrideCardStates?: CardWordState[]) => {
      if (!drillWords.length) return;
      stopAudio();
      const statesToUse = overrideCardStates || cardStates;
      const graded = drillWords.map((item, idx) => {
        const base = gradeWord(inputs[idx] || '', item.w);
        const st = statesToUse[idx];
        if (st && st.hadMistake) {
          return {
            ...base,
            correct: false,
            diff: st.lastResult && !st.lastResult.correct ? st.lastResult.diff : base.diff,
          };
        }
        return base;
      });
      setResults(graded);
      setSubmitted(true);

      const correctCount = graded.filter((r) => r.correct).length;
      const accuracy = Math.round((correctCount / drillWords.length) * 1000) / 10;
      const wrongWords: string[] = [];

      updatePersisted((prev) => {
        const nextMistakes = { ...prev.mistakes };
        graded.forEach((res, idx) => {
          const w = drillWords[idx];
          const key = w.w.toLowerCase();
          if (!res.correct) {
            wrongWords.push(w.w);
            const existing = nextMistakes[key];
            nextMistakes[key] = {
              w: w.w,
              t: w.t,
              uk: w.uk,
              us: w.us,
              bookId: existing?.bookId || bookId,
              bookTitle: existing?.bookTitle || currentBookMeta?.title || bookId,
              count: (existing?.count || 0) + 1,
              lastWrongAt: Date.now(),
            };
          } else if (isMistakeDrill) {
            delete nextMistakes[key];
          }
        });

        const record = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          bookId: isMistakeDrill ? 'mistakes' : bookId,
          bookTitle: isMistakeDrill ? '错词专练' : (currentBookMeta?.title || bookId),
          sectionLabel: drillLabel,
          total: drillWords.length,
          correct: correctCount,
          accuracy,
          wrongWords,
          timestamp: Date.now(),
        };

        const nextProgress = { ...prev.sectionProgress };
        const nextDrafts = { ...prev.sectionDrafts };
        if (isMistakeDrill) {
          delete nextDrafts['__mistakes__'];
        } else {
          const pKey = sectionProgressKey(bookId, sectionSize, sectionIndex);
          const oldP = nextProgress[pKey];
          nextProgress[pKey] = {
            attempts: (oldP?.attempts || 0) + 1,
            lastAccuracy: accuracy,
            bestAccuracy: Math.max(oldP?.bestAccuracy || 0, accuracy),
            lastStudiedAt: Date.now(),
          };
          delete nextDrafts[pKey];
        }

        return {
          ...prev,
          mistakes: nextMistakes,
          history: [record, ...prev.history].slice(0, 200),
          sectionProgress: nextProgress,
          sectionDrafts: nextDrafts,
        };
      });
    },
    [drillWords, inputs, cardStates, stopAudio, updatePersisted, bookId, sectionSize, sectionIndex, currentBookMeta, isMistakeDrill, drillLabel],
  );

  const handleCardCheckOrNext = useCallback(() => {
    const item = drillWords[activeIdx];
    if (!item || submitted) return;
    const cur = cardStates[activeIdx] || emptyCardState();

    if (cur.status === 'passed' || cur.status === 'revealed') {
      const nextIdx = findNextUnfinishedIndex(cardStates, activeIdx);
      if (nextIdx >= 0) focusAndPlay(nextIdx);
      else handleSubmit();
      return;
    }

    const res = gradeWord(inputs[activeIdx] || '', item.w);
    if (res.correct) {
      const nextStates = [...cardStates];
      nextStates[activeIdx] = { status: 'passed', hadMistake: cur.hadMistake, lastResult: res };
      setCardStates(nextStates);
      if (isMistakeDrill && !cur.hadMistake) {
        const key = item.w.toLowerCase();
        updatePersisted((prev) => {
          if (!prev.mistakes[key]) return prev;
          const nextMistakes = { ...prev.mistakes };
          delete nextMistakes[key];
          return { ...prev, mistakes: nextMistakes };
        });
      }
      const nextIdx = findNextUnfinishedIndex(nextStates, activeIdx);
      if (autoTimerRef.current !== null) window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = window.setTimeout(() => {
        if (nextIdx >= 0) focusAndPlay(nextIdx);
        else handleSubmit(nextStates);
      }, 450);
    } else {
      const typed = inputs[activeIdx] || '';
      const nextStates = [...cardStates];
      nextStates[activeIdx] = { status: 'wrong', hadMistake: true, lastResult: res, lastAttempt: typed };
      setCardStates(nextStates);
      setInputs((prev) => {
        const next = [...prev];
        next[activeIdx] = '';
        return next;
      });
      setCardCaret(0);
      playWordAt(item.w);
      setTimeout(() => cardInputRef.current?.focus(), 0);
    }
  }, [drillWords, activeIdx, submitted, cardStates, inputs, focusAndPlay, handleSubmit, playWordAt, isMistakeDrill, updatePersisted]);

  const handleRevealAnswer = useCallback(() => {
    const item = drillWords[activeIdx];
    if (!item || submitted) return;
    const res = gradeWord(inputs[activeIdx] || '', item.w);
    setCardStates((prev) => {
      const next = [...prev];
      next[activeIdx] = { status: 'revealed', hadMistake: true, lastResult: res };
      return next;
    });
    playWordAt(item.w);
    setTimeout(() => cardInputRef.current?.focus(), 0);
  }, [drillWords, activeIdx, submitted, inputs, playWordAt]);

  const startMistakeDrill = useCallback(
    (wordsList: CorpusWord[], label: string, resumeDraft = false) => {
      if (!wordsList.length) return;
      stopAudio();
      const draft = resumeDraft ? loadCorpusState().sectionDrafts['__mistakes__'] : undefined;
      const wordMap = new Map(wordsList.map((w) => [w.w.toLowerCase(), w]));
      const canResume =
        draft &&
        draft.wordOrder.length > 0 &&
        draft.wordOrder.length === draft.inputs.length &&
        draft.wordOrder.length === draft.cardStates.length &&
        draft.wordOrder.some((w) => wordMap.has(w.toLowerCase()));

      setIsMistakeDrill(true);
      setDrillLabel(label);
      setSubmitted(false);
      setResults([]);
      loadedSectionKeyRef.current = '__mistakes__';

      if (canResume && draft) {
        const restoredWords = draft.wordOrder.map(
          (w) => wordMap.get(w.toLowerCase()) || { w, t: '' },
        );
        const startIdx =
          draft.activeIdx >= 0 &&
          draft.activeIdx < restoredWords.length &&
          draft.cardStates[draft.activeIdx]?.status !== 'passed' &&
          draft.cardStates[draft.activeIdx]?.status !== 'revealed'
            ? draft.activeIdx
            : Math.max(0, findNextUnfinishedIndex(draft.cardStates, -1));
        setDrillWords(restoredWords);
        setInputs([...draft.inputs]);
        setCardStates([...draft.cardStates]);
        setActiveIdx(startIdx);
        setSubView('practice');
        preloadWordAudio(restoredWords, startIdx, accent, 4);
        const doneCount = draft.cardStates.filter(
          (s) => s.status === 'passed' || s.status === 'revealed',
        ).length;
        setStatusMsg(`已恢复错词专练进度（${doneCount}/${restoredWords.length} 词）`);
        return;
      }

      const list = shuffled ? shuffle(wordsList) : [...wordsList];
      setDrillWords(list);
      setInputs(new Array(list.length).fill(''));
      setCardStates(Array.from({ length: list.length }, emptyCardState));
      setActiveIdx(0);
      setSubView('practice');
      preloadWordAudio(list, 0, accent, 4);
    },
    [shuffled, stopAudio, accent],
  );

  const handleRestartSection = () => {
    stopAudio();
    const pKey = isMistakeDrill
      ? '__mistakes__'
      : sectionProgressKey(
          bookId,
          sectionSize,
          Math.min(sectionIndex, Math.max(0, Math.ceil(bookWords.length / sectionSize) - 1)),
        );
    updatePersisted((prev) => {
      if (!prev.sectionDrafts[pKey]) return prev;
      const nextDrafts = { ...prev.sectionDrafts };
      delete nextDrafts[pKey];
      return { ...prev, sectionDrafts: nextDrafts };
    });
    const list = shuffled ? shuffle(drillWords) : [...drillWords];
    setDrillWords(list);
    setInputs(new Array(list.length).fill(''));
    setCardStates(Array.from({ length: list.length }, emptyCardState));
    setSubmitted(false);
    setResults([]);
    setActiveIdx(0);
  };

  const handleNextSection = () => {
    setIsMistakeDrill(false);
    setSectionIndex((prev) => Math.min(totalSections - 1, prev + 1));
  };

  const handleExportMistakesCsv = async (entries: MistakeEntry[], filename: string) => {
    try {
      setExporting('正在导出 Excel (CSV)…');
      const ok = await exportMistakesCsv(entries, filename);
      if (ok) setStatusMsg(`已导出 ${entries.length} 个错词`);
    } catch (e) {
      setStatusMsg('导出失败：' + String(e));
    } finally {
      setExporting('');
    }
  };

  const handleExportMistakesAudio = async (entries: MistakeEntry[], filename: string) => {
    try {
      setExporting(`正在合成错词音频（0/${entries.length}）…`);
      const ok = await exportMistakesAudio(
        entries.map((e) => e.w),
        accent,
        1.2,
        filename,
        (done, total) => setExporting(`正在合成错词音频（${done}/${total}）…`),
      );
      if (ok) setStatusMsg(`已导出 ${entries.length} 个错词合并音频`);
    } catch (e) {
      setStatusMsg('导出音频失败：' + String(e));
    } finally {
      setExporting('');
    }
  };

  const handleImportCustom = () => {
    const words = parseCustomWordList(importText);
    if (!words.length) {
      setStatusMsg('未解析出有效英文单词，请检查格式。');
      return;
    }
    const id = `custom_${Date.now()}`;
    const title = importTitle.trim() || `自定义词库 (${words.length}词)`;
    const meta: CorpusBookMeta = { id, title, desc: '用户自定义词库', count: words.length, custom: true };
    updatePersisted((prev) => ({
      ...prev,
      customBooks: { ...prev.customBooks, [id]: { meta, words } },
    }));
    setBookId(id);
    setIsMistakeDrill(false);
    setImportTitle('');
    setImportText('');
    setSubView('practice');
    setStatusMsg(`已导入「${title}」（${words.length} 词）`);
  };

  const allMistakesList = useMemo(
    () => Object.values(persisted.mistakes).sort((a, b) => b.count - a.count || b.lastWrongAt - a.lastWrongAt),
    [persisted.mistakes],
  );
  const filteredMistakes = useMemo(
    () => (mistakeBookFilter === 'all' ? allMistakesList : allMistakesList.filter((m) => m.bookId === mistakeBookFilter)),
    [allMistakesList, mistakeBookFilter],
  );
  const applyMistakeBatch = useCallback(
    (list: MistakeEntry[]): MistakeEntry[] =>
      mistakeBatchSize > 0 && list.length > mistakeBatchSize
        ? list.slice(0, mistakeBatchSize)
        : list,
    [mistakeBatchSize],
  );

  const clearQueueMistakes = useMemo(
    () => [...filteredMistakes].sort((a, b) => a.lastWrongAt - b.lastWrongAt || b.count - a.count),
    [filteredMistakes],
  );
  const batchedFilteredMistakes = useMemo(
    () => applyMistakeBatch(filteredMistakes),
    [applyMistakeBatch, filteredMistakes],
  );
  const batchedClearMistakes = useMemo(
    () => applyMistakeBatch(clearQueueMistakes),
    [applyMistakeBatch, clearQueueMistakes],
  );

  const launchNonceRef = useRef<number>(0);
  useEffect(() => {
    if (!launchRequest || launchRequest.nonce === launchNonceRef.current) return;
    launchNonceRef.current = launchRequest.nonce;
    if (launchRequest.mode === 'mistakes-drill') {
      const allSorted = Object.values(loadCorpusState().mistakes || {}).sort(
        (a, b) => a.lastWrongAt - b.lastWrongAt || b.count - a.count,
      );
      if (allSorted.length > 0) {
        const batch = applyMistakeBatch(allSorted);
        const label =
          batch.length < allSorted.length
            ? `每日巩固 (${batch.length}/${allSorted.length}词)`
            : `每日巩固 (${batch.length}词)`;
        startMistakeDrill(
          batch.map((m) => ({ w: m.w, t: m.t, uk: m.uk, us: m.us })),
          label,
        );
      } else {
        setSubView('mistakes');
      }
    } else if (launchRequest.mode === 'mistakes-view') {
      setSubView('mistakes');
    }
    onConsumeLaunch?.();
  }, [launchRequest, applyMistakeBatch, startMistakeDrill, onConsumeLaunch]);
  const mistakeBooksInList = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of allMistakesList) map.set(m.bookId, m.bookTitle);
    return Array.from(map.entries());
  }, [allMistakesList]);

  const currentWrongEntries: MistakeEntry[] = useMemo(() => {
    if (!submitted) return [];
    return drillWords
      .map((w, idx) => ({ w, res: results[idx] }))
      .filter((x) => x.res && !x.res.correct)
      .map(({ w }) => ({
        w: w.w,
        t: w.t,
        uk: w.uk,
        us: w.us,
        bookId,
        bookTitle: currentBookMeta?.title || bookId,
        count: persisted.mistakes[w.w.toLowerCase()]?.count || 1,
        lastWrongAt: Date.now(),
      }));
  }, [submitted, drillWords, results, bookId, currentBookMeta, persisted.mistakes]);

  const correctCount = submitted ? results.filter((r) => r.correct).length : 0;
  const accuracyPct = submitted && drillWords.length ? Math.round((correctCount / drillWords.length) * 1000) / 10 : 0;

  const bookOptions: SelectOption[] = useMemo(
    () =>
      allBooks.map((b) => {
        const secs = Math.max(1, Math.ceil(b.count / sectionSize));
        const done = getBookCompletedCount(b.id, secs, sectionSize, persisted.sectionProgress);
        return {
          value: b.id,
          label: b.title,
          meta: done > 0 ? `${done}/${secs}节` : `${b.count}词`,
          status: done === secs ? 'done' : done > 0 ? 'warn' : 'idle',
        };
      }),
    [allBooks, sectionSize, persisted.sectionProgress],
  );

  const sectionOptions: SelectOption[] = useMemo(
    () =>
      Array.from({ length: totalSections }, (_, i) => {
        const s = i * sectionSize + 1;
        const e = Math.min(bookWords.length, (i + 1) * sectionSize);
        const pKey = sectionProgressKey(bookId, sectionSize, i);
        const draft = persisted.sectionDrafts[pKey];
        const doneInDraft = draft
          ? draft.cardStates.filter((cs) => cs.status === 'passed' || cs.status === 'revealed').length
          : 0;
        const hasAnyDraftInput = draft ? draft.inputs.some((v) => v.trim().length > 0) : false;
        const inProgress = doneInDraft > 0 || hasAnyDraftInput;
        const prog = persisted.sectionProgress[pKey];
        const studied = prog && prog.attempts > 0;
        return {
          value: String(i),
          label: `Section ${i + 1} (${s}-${e})`,
          meta: inProgress
            ? `进行中 ${doneInDraft}/${draft!.wordOrder.length}`
            : studied
              ? `${prog.bestAccuracy}%`
              : '未练',
          status: inProgress ? 'warn' : !studied ? 'idle' : prog.bestAccuracy >= 90 ? 'done' : 'warn',
        };
      }),
    [totalSections, sectionSize, bookWords.length, persisted.sectionProgress, persisted.sectionDrafts, bookId],
  );

  const sectionSizeOptions: SelectOption[] = useMemo(
    () => SECTION_SIZES.map((sz) => ({ value: String(sz), label: `${sz} 词/节` })),
    [],
  );
  const accentOptions: SelectOption[] = useMemo(
    () => ACCENTS.map((a) => ({ value: a.id, label: a.label })),
    [],
  );
  const rateOptions: SelectOption[] = useMemo(
    () => RATES.map((r) => ({ value: String(r), label: `${r.toFixed(2).replace(/\.00$/, '.0')}x` })),
    [],
  );

  return (
    <div
      className="corpus-workspace"
      onDoubleClick={(e) => {
        if (subView === 'practice' && (e.target as HTMLElement).tagName !== 'INPUT') {
          togglePlayCurrent();
        }
      }}
    >
      {/* Ultra-Clean Single-Row Bar */}
      <div className="corpus-topbar">
        <div className="corpus-selectors">
          <CustomSelect
            value={bookId}
            options={bookOptions}
            minWidth={165}
            menuWidth={260}
            title="选择词库"
            onChange={(val) => {
              setIsMistakeDrill(false);
              setBookId(val);
            }}
          />
          <CustomSelect
            value={String(sectionIndex)}
            options={sectionOptions}
            disabled={isMistakeDrill}
            minWidth={148}
            menuWidth={220}
            title="选择小节"
            onChange={(val) => {
              setIsMistakeDrill(false);
              setSectionIndex(Number(val));
            }}
          />
        </div>

        <div className="seg-pill" role="tablist">
          <button
            type="button"
            className={subView === 'practice' ? 'active' : ''}
            onClick={() => { stopAudio(); setWalkmanPlaying(false); setSubView('practice'); }}
          >
            听写
          </button>
          <button
            type="button"
            className={subView === 'walkman' ? 'active' : ''}
            onClick={() => { stopAudio(); setSubView('walkman'); }}
          >
            随身听
          </button>
          <button
            type="button"
            className={subView === 'mistakes' ? 'active' : ''}
            onClick={() => { stopAudio(); setWalkmanPlaying(false); setSubView('mistakes'); }}
          >
            错词 ({allMistakesList.length})
          </button>
        </div>

        <div className="corpus-top-right">
          {subView === 'practice' && !submitted && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => handleSubmit()}
              disabled={!drillWords.length}
              title="提前结算本节"
              aria-label="提前结算"
            >
              <IconCheck size={16} />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn${showSettings ? ' active' : ''}`}
            title="听写设置与历史"
            aria-label="设置"
            onClick={() => setShowSettings((s) => !s)}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </div>

      {/* Clean Popover Drawer for Settings, History & Import */}
      {showSettings && (
        <div className="corpus-popover">
          <div className="corpus-popover-head">
            <strong>听写设置</strong>
            <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="关闭">
              <IconClose size={14} />
            </button>
          </div>
          <div className="corpus-popover-grid">
            <label>
              口音
              <CustomSelect value={accent} options={accentOptions} minWidth={95} onChange={(v) => setAccent(v as Accent)} />
            </label>
            <label>
              倍速
              <CustomSelect value={String(rate)} options={rateOptions} minWidth={80} onChange={(v) => setRate(Number(v))} />
            </label>
            <label>
              每节词数
              <CustomSelect
                value={String(sectionSize)}
                options={sectionSizeOptions}
                minWidth={95}
                onChange={(val) => {
                  const nextSize = Number(val);
                  setIsMistakeDrill(false);
                  setSectionSize(nextSize);
                  const secs = Math.max(1, Math.ceil(bookWords.length / nextSize));
                  const latestState = loadCorpusState();
                  const draftIdx = findLatestDraftSection(bookId, secs, nextSize, latestState.sectionDrafts);
                  if (draftIdx !== null) {
                    setSectionIndex(draftIdx);
                  } else {
                    const smart = getSmartNextSection(bookId, secs, nextSize, latestState.sectionProgress);
                    setSectionIndex(smart.index);
                  }
                }}
              />
            </label>
            <label>
              视图
              <CustomSelect
                value={layoutMode}
                options={[
                  { value: 'card', label: '居中词卡' },
                  { value: 'list', label: '批量列表' },
                ]}
                minWidth={95}
                onChange={(v) => setLayoutMode(v as 'card' | 'list')}
              />
            </label>
          </div>
          <div className="corpus-popover-checks">
            <label>
              <input
                type="checkbox"
                checked={shuffled}
                onChange={(e) => {
                  const nextShuffled = e.target.checked;
                  setShuffled(nextShuffled);
                  if (!isMistakeDrill && !submitted && bookWords.length > 0) {
                    const hasProgress =
                      inputs.some((v) => v.trim().length > 0) ||
                      cardStates.some((s) => s.status !== 'idle');
                    if (!hasProgress) {
                      const safeIdx = Math.min(
                        sectionIndex,
                        Math.max(0, Math.ceil(bookWords.length / sectionSize) - 1),
                      );
                      const start = safeIdx * sectionSize;
                      const slice = bookWords.slice(start, start + sectionSize);
                      const list = nextShuffled ? shuffle(slice) : slice;
                      setDrillWords(list);
                      setInputs(new Array(list.length).fill(''));
                      setCardStates(Array.from({ length: list.length }, emptyCardState));
                      setActiveIdx(0);
                    }
                  }
                }}
              />{' '}
              乱序
            </label>
            <label><input type="checkbox" checked={showHint} onChange={(e) => setShowHint(e.target.checked)} /> 释义提示</label>
            <label><input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} /> 自动连播</label>
            {autoAdvance && (
              <CustomSelect
                value={String(autoPauseSec)}
                options={[
                  { value: '1.5', label: '1.5s' },
                  { value: '2.5', label: '2.5s' },
                  { value: '3.5', label: '3.5s' },
                ]}
                minWidth={72}
                onChange={(v) => setAutoPauseSec(Number(v))}
              />
            )}
          </div>
          <div className="corpus-popover-links">
            <button onClick={() => { setShowSettings(false); setSubView('history'); }}>
              正确率历史 ({persisted.history.length})
            </button>
            <button onClick={() => { setShowSettings(false); setSubView('import'); }}>
              导入自定义词单
            </button>
          </div>
        </div>
      )}

      {(statusMsg || exporting) && (
        <div className="corpus-banner" onClick={() => setStatusMsg('')}>
          {exporting || statusMsg}
        </div>
      )}

      {/* VIEW 1: Practice */}
      {subView === 'practice' && (
        <div className="corpus-main">
          {submitted && (
            <div className="corpus-summary">
              <div className="corpus-score-big">
                <span>正确率</span>
                <strong>{accuracyPct}%</strong>
                <small>
                  {correctCount}/{drillWords.length} · 拼写估分参考 {estimateIeltsBand(accuracyPct)}
                </small>
              </div>
              <div className="corpus-summary-actions">
                {currentWrongEntries.length > 0 && (
                  <>
                    <button
                      className="primary"
                      onClick={() =>
                        startMistakeDrill(
                          currentWrongEntries.map((e) => ({ w: e.w, t: e.t, uk: e.uk, us: e.us })),
                          `本次错词 (${currentWrongEntries.length}词)`,
                        )
                      }
                    >
                      重练错词 ({currentWrongEntries.length})
                    </button>
                    <button
                      disabled={!!exporting}
                      onClick={() => handleExportMistakesCsv(currentWrongEntries, `ielts-mistakes-${Date.now()}.csv`)}
                    >
                      导出 Excel
                    </button>
                    <button
                      disabled={!!exporting}
                      onClick={() => handleExportMistakesAudio(currentWrongEntries, `ielts-mistakes-${Date.now()}.wav`)}
                    >
                      导出音频
                    </button>
                  </>
                )}
                {!isMistakeDrill && sectionIndex + 1 < totalSections && (
                  <button onClick={handleNextSection}>下一小节</button>
                )}
                <button onClick={handleRestartSection}>再刷一遍</button>
              </div>
            </div>
          )}

          {layoutMode === 'card' ? (
            <div className="corpus-stage">
              {drillWords[activeIdx] ? (() => {
                const item = drillWords[activeIdx];
                const st = cardStates[activeIdx] || emptyCardState();
                const res = submitted ? results[activeIdx] : st.lastResult;
                const isPassed = !submitted && st.status === 'passed';
                const isWrong = !submitted && st.status === 'wrong';
                const isRevealed = !submitted && st.status === 'revealed';
                const canAdvance = submitted || isPassed || isRevealed;
                const progressPct = drillWords.length ? ((activeIdx + 1) / drillWords.length) * 100 : 0;
                const cardCls = submitted
                  ? res?.correct ? 'correct' : 'wrong'
                  : isPassed ? 'correct' : (isWrong || isRevealed) ? 'wrong' : '';
                return (
                  <div className={`corpus-card ${cardCls}`}>
                    <div className="corpus-card-progress">
                      <div className="corpus-card-bar">
                        <i style={{ width: `${progressPct}%` }} />
                      </div>
                      <span>
                        {String(activeIdx + 1).padStart(2, '0')} / {String(drillWords.length).padStart(2, '0')}
                      </span>
                    </div>

                    <button
                      type="button"
                      className={`corpus-card-play ${isPlaying ? 'playing' : ''}`}
                      onClick={() => playWordAt(item.w)}
                      title="播放 / 重播发音 (Tab)"
                      aria-label="播放发音"
                    >
                      {isPlaying ? <IconPause size={22} /> : <IconVolume size={22} />}
                    </button>

                    <div className="corpus-card-hint">
                      {showHint && !submitted && !isPassed && !isRevealed && item.t
                        ? item.t
                        : !submitted && st.status === 'idle'
                          ? 'Enter 验证 · Esc 显示答案 · Tab 重播'
                          : isWrong
                            ? `拼写有误（${item.w.length} 字符），修改后按 Enter 重试`
                            : isRevealed
                              ? '按 Enter 进入下一词'
                              : isPassed && isMistakeDrill && !st.hadMistake
                                ? '已移出错词本'
                                : ''}
                    </div>

                    {(() => {
                      const rawTyped = inputs[activeIdx] || '';
                      const targetChars = Array.from(item.w);
                      const showTargetTiles = isRevealed || (submitted && !res?.correct);
                      const typedChars = Array.from(rawTyped);
                      const totalSlots = showTargetTiles
                        ? targetChars.length
                        : Math.max(targetChars.length, typedChars.length);
                      const sizeCls = totalSlots >= 17 ? 'xs' : totalSlots >= 13 ? 'sm' : '';
                      const targetKinds: Array<'ok' | 'missed'> = [];
                      if (showTargetTiles && res?.diff?.length) {
                        for (const d of res.diff) {
                          if (d.kind !== 'extra') {
                            targetKinds.push(d.kind === 'ok' ? 'ok' : 'missed');
                          }
                        }
                      }
                      const activeSlot =
                        totalSlots > 0 ? Math.min(cardCaret, totalSlots - 1) : 0;

                      const segments: Array<
                        | { type: 'word'; indices: number[] }
                        | { type: 'space'; idx: number }
                      > = [];
                      let curWord: number[] = [];
                      for (let i = 0; i < totalSlots; i++) {
                        if (targetChars[i] === ' ') {
                          if (curWord.length) {
                            segments.push({ type: 'word', indices: curWord });
                            curWord = [];
                          }
                          segments.push({ type: 'space', idx: i });
                        } else {
                          curWord.push(i);
                        }
                      }
                      if (curWord.length) {
                        segments.push({ type: 'word', indices: curWord });
                      }

                      const renderSlot = (i: number) => {
                        const targetCh = targetChars[i];
                        const typedCh = typedChars[i] ?? '';
                        const isCursor =
                          cardFocused &&
                          !submitted &&
                          !isPassed &&
                          !isRevealed &&
                          i === activeSlot;

                        if (targetCh === ' ') {
                          const cls = [
                            'corpus-letter-space',
                            showTargetTiles
                              ? 'complete'
                              : isPassed || (submitted && res?.correct)
                                ? 'complete'
                                : typedCh === ' '
                                  ? 'filled'
                                  : isWrong && typedCh === ''
                                    ? 'wrong'
                                    : '',
                            isCursor ? 'active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ');
                          return (
                            <span key={i} className={cls}>
                              {!showTargetTiles && typedCh && typedCh !== ' ' ? typedCh : ''}
                            </span>
                          );
                        }

                        if (showTargetTiles) {
                          const okMatch =
                            targetKinds[i] === 'ok' ||
                            (!targetKinds.length &&
                              (st.lastAttempt || rawTyped).trim().toLowerCase().charAt(i) ===
                                (targetCh || '').toLowerCase());
                          const cls = [
                            'corpus-letter-tile',
                            okMatch ? 'complete' : 'missed',
                          ].join(' ');
                          return (
                            <span key={i} className={cls}>
                              {targetCh}
                            </span>
                          );
                        }

                        const cls = [
                          'corpus-letter-tile',
                          isPassed || (submitted && res?.correct)
                            ? 'complete'
                            : i >= targetChars.length
                              ? 'extra'
                              : typedCh !== ''
                                ? 'filled'
                                : isWrong
                                  ? 'wrong'
                                  : '',
                          isCursor ? 'active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ');

                        return (
                          <span key={i} className={cls}>
                            {typedCh}
                          </span>
                        );
                      };

                      return (
                        <div
                          className="corpus-letter-stage"
                          onMouseDown={() => cardInputRef.current?.focus()}
                        >
                          <div className={`corpus-letter-row ${sizeCls}`} aria-hidden="true">
                            {segments.map((seg, si) =>
                              seg.type === 'space' ? (
                                renderSlot(seg.idx)
                              ) : (
                                <span key={`w-${si}`} className="corpus-letter-word">
                                  {seg.indices.map(renderSlot)}
                                </span>
                              ),
                            )}
                          </div>
                          <input
                            ref={cardInputRef}
                            className="corpus-letter-hidden-input"
                            type="text"
                            spellCheck={false}
                            autoComplete="off"
                            autoCapitalize="off"
                            disabled={submitted}
                            readOnly={isRevealed}
                            aria-label="在此逐字母拼写"
                            value={rawTyped}
                            onFocus={(e) => {
                              setCardFocused(true);
                              setCardCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                            }}
                            onBlur={() => setCardFocused(false)}
                            onSelect={(e) => {
                              setCardCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                            }}
                            onKeyUp={(e) => {
                              setCardCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                            }}
                            onChange={(e) => {
                              const val = e.target.value;
                              const caret = e.currentTarget.selectionStart ?? val.length;
                              setCardCaret(caret);
                              setInputs((prev) => {
                                const next = [...prev];
                                next[activeIdx] = val;
                                return next;
                              });
                              if (st.status === 'wrong') {
                                setCardStates((prev) => {
                                  const next = [...prev];
                                  next[activeIdx] = { ...prev[activeIdx], status: 'idle' };
                                  return next;
                                });
                              }
                            }}
                            onKeyDown={(e) => {
                              if (!submitted && !isRevealed) handleDictationKeySound(e);
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (e.shiftKey) {
                                  if (activeIdx > 0) focusAndPlay(activeIdx - 1);
                                } else {
                                  handleCardCheckOrNext();
                                }
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                if (!submitted && !isPassed && !isRevealed) handleRevealAnswer();
                              } else if (e.key === 'Tab' && !e.shiftKey) {
                                e.preventDefault();
                                playWordAt(item.w);
                              }
                            }}
                          />
                        </div>
                      );
                    })()}

                    {(isWrong || isPassed || isRevealed || submitted) && res && (
                      <div className="corpus-card-result">
                        {isWrong && !submitted && !isRevealed && !isPassed ? (
                          <div className="card-res-wrong">
                            {res.diff.length > 0 && (
                              <div className="fb-diff card-diff" title="绿色对位、红色多写、下划线漏写或错位">
                                {res.diff.map((d, di) => (
                                  <span key={di} className={`diff-ch ${d.kind}`}>
                                    {d.kind === 'missing' ? '＿' : d.ch === ' ' ? '␣' : d.ch}
                                  </span>
                                ))}
                              </div>
                            )}
                            {st.lastAttempt && (
                              <small className="card-res-meta">上次输入：{st.lastAttempt}</small>
                            )}
                          </div>
                        ) : isPassed || (submitted && res.correct) ? (
                          <>
                            {item.t && <div className="card-res-trans">{item.t}</div>}
                            {res.ukUsVariant && <small className="card-res-meta">英美拼写兼容</small>}
                          </>
                        ) : (
                          <>
                            <div className="card-res-wrong">
                              {res.diff.length > 0 && (
                                <div className="fb-diff card-diff">
                                  {res.diff.map((d, di) => (
                                    <span key={di} className={`diff-ch ${d.kind}`}>
                                      {d.ch === ' ' ? '␣' : d.ch}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <strong className="fb-expected">{item.w}</strong>
                            </div>
                            {(item.uk || item.us) && (
                              <div className="card-res-meta">
                                {item.uk && <span>UK /{item.uk}/</span>}
                                {item.us && <span>US /{item.us}/</span>}
                              </div>
                            )}
                            {item.t && <div className="card-res-trans">{item.t}</div>}
                          </>
                        )}
                      </div>
                    )}

                    <div className="corpus-card-nav">
                      <button
                        className="icon-btn"
                        disabled={activeIdx <= 0}
                        onClick={() => focusAndPlay(activeIdx - 1)}
                        title="上一词 (Shift+Enter)"
                        aria-label="上一词"
                      >
                        <IconPrev size={16} />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={() => playWordAt(item.w)}
                        title="重播发音 (Tab)"
                        aria-label="重播"
                      >
                        <IconReplay size={16} />
                      </button>
                      {!submitted && !isPassed && !isRevealed && (
                        <button
                          className="icon-btn"
                          onClick={handleRevealAnswer}
                          title="显示答案 (Esc)"
                          aria-label="显示答案"
                        >
                          <IconEye size={16} />
                        </button>
                      )}
                      {!submitted ? (
                        <button
                          className="icon-btn primary"
                          onClick={handleCardCheckOrNext}
                          title={canAdvance ? '下一词 (Enter)' : '验证拼写 (Enter)'}
                          aria-label={canAdvance ? '下一词' : '验证拼写'}
                        >
                          {canAdvance ? <IconNext size={16} /> : <IconCheck size={16} />}
                        </button>
                      ) : activeIdx + 1 < drillWords.length ? (
                        <button className="icon-btn primary" onClick={() => focusAndPlay(activeIdx + 1)} title="下一词" aria-label="下一词">
                          <IconNext size={16} />
                        </button>
                      ) : (
                        <button className="icon-btn primary" onClick={handleRestartSection} title="再刷一遍" aria-label="再刷一遍">
                          <IconReplay size={16} />
                        </button>
                      )}
                    </div>

                    <div className="corpus-dots" aria-label="词汇进度导航">
                      {drillWords.map((w, i) => {
                        const r = submitted ? results[i] : null;
                        const cst = cardStates[i];
                        const filled = (inputs[i] || '').trim().length > 0;
                        const stateCls = r
                          ? r.correct
                            ? 'ok'
                            : cst?.status === 'passed'
                              ? 'warn'
                              : 'err'
                          : cst?.status === 'passed'
                            ? cst.hadMistake
                              ? 'warn'
                              : 'ok'
                            : cst?.status === 'wrong' || cst?.status === 'revealed'
                              ? 'err'
                              : filled
                                ? 'filled'
                                : '';
                        const dotTitle =
                          stateCls === 'ok'
                            ? `第 ${i + 1} 词 · 一次拼对`
                            : stateCls === 'warn'
                              ? `第 ${i + 1} 词 · 已改对（将收进错词本）`
                              : stateCls === 'err'
                                ? `第 ${i + 1} 词 · 拼写有误`
                                : `第 ${i + 1} 词`;
                        const cls = ['corpus-dot', i === activeIdx ? 'active' : '', stateCls].filter(Boolean).join(' ');
                        return (
                          <button
                            key={`${w.w}-${i}`}
                            type="button"
                            className={cls}
                            title={dotTitle}
                            onClick={() => focusAndPlay(i)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })() : (
                <div className="corpus-empty">正在加载词库…</div>
              )}
            </div>
          ) : (
            <div className="corpus-grid">
              {drillWords.map((item, idx) => {
                const res = submitted ? results[idx] : null;
                const isActive = idx === activeIdx;
                return (
                  <div
                    key={`${item.w}-${idx}`}
                    className={`corpus-row ${isActive ? 'active' : ''} ${res ? (res.correct ? 'correct' : 'wrong') : ''}`}
                    onClick={() => {
                      setActiveIdx(idx);
                      if (submitted) playWordAt(item.w);
                    }}
                  >
                    <span className="corpus-idx">{String(idx + 1).padStart(2, '0')}</span>
                    <button
                      className="icon-btn corpus-speak"
                      type="button"
                      title="播放发音"
                      aria-label="播放发音"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveIdx(idx);
                        playWordAt(item.w);
                      }}
                    >
                      <IconVolume size={14} />
                    </button>

                    <div className="corpus-input-wrap">
                      <input
                        ref={(el) => { inputRefs.current[idx] = el; }}
                        type="text"
                        spellCheck={false}
                        autoComplete="off"
                        autoCapitalize="off"
                        disabled={submitted}
                        value={inputs[idx] || ''}
                        placeholder={showHint && item.t ? item.t : '听音拼写…'}
                        onFocus={() => {
                          if (activeIdx !== idx) {
                            setActiveIdx(idx);
                            if (!submitted) playWordAt(item.w);
                          }
                        }}
                        onChange={(e) => {
                          const val = e.target.value;
                          setInputs((prev) => {
                            const next = [...prev];
                            next[idx] = val;
                            return next;
                          });
                        }}
                        onKeyDown={(e) => {
                          if (!submitted) handleDictationKeySound(e);
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (e.shiftKey) {
                              if (idx > 0) focusAndPlay(idx - 1);
                            } else if (idx + 1 < drillWords.length) {
                              focusAndPlay(idx + 1);
                            } else {
                              handleSubmit();
                            }
                          } else if (e.key === 'Tab' && !e.shiftKey) {
                            e.preventDefault();
                            playWordAt(item.w);
                          }
                        }}
                      />

                      {res && (
                        <div className="corpus-feedback">
                          {res.correct ? (
                            <span className="fb-ok">
                              {item.t || item.w}
                              {res.ukUsVariant && <em>（英美拼写兼容）</em>}
                            </span>
                          ) : (
                            <div className="fb-wrong">
                              <span className="fb-diff">
                                {res.diff.map((d, di) => (
                                  <span key={di} className={`diff-ch ${d.kind}`}>
                                    {d.ch === ' ' ? '␣' : d.ch}
                                  </span>
                                ))}
                              </span>
                              <strong className="fb-expected">{item.w}</strong>
                              {item.t && <small>{item.t}</small>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* VIEW 2: Walkman */}
      {subView === 'walkman' && (
        <div className="corpus-walkman">
          <div className="walkman-card">
            <div className="walkman-meta">
              {currentBookMeta?.title} · {walkmanIdx + 1} / {drillWords.length}
            </div>
            <div className="walkman-word">
              {walkmanReveal ? drillWords[walkmanIdx]?.w || '—' : '盲听中…'}
            </div>
            {walkmanReveal && drillWords[walkmanIdx] && (
              <>
                <div className="walkman-phone">
                  {drillWords[walkmanIdx].uk ? `UK /${drillWords[walkmanIdx].uk}/` : ''}{' '}
                  {drillWords[walkmanIdx].us ? `US /${drillWords[walkmanIdx].us}/` : ''}
                </div>
                <div className="walkman-trans">{drillWords[walkmanIdx].t}</div>
              </>
            )}
            <div className="walkman-actions">
              <button className="icon-btn" title="上一词" aria-label="上一词" onClick={() => setWalkmanIdx((i) => (i - 1 + drillWords.length) % drillWords.length)}><IconPrev size={16} /></button>
              <button
                className="icon-btn primary"
                title={walkmanPlaying ? '暂停' : '开始随身听'}
                aria-label="播放控制"
                onClick={() => {
                  if (walkmanPlaying) {
                    stopAudio();
                    setWalkmanPlaying(false);
                  } else {
                    setWalkmanPlaying(true);
                  }
                }}
              >
                {walkmanPlaying ? <IconPause size={16} /> : <IconPlay size={16} />}
              </button>
              <button className="icon-btn" title="下一词" aria-label="下一词" onClick={() => setWalkmanIdx((i) => (i + 1) % drillWords.length)}><IconNext size={16} /></button>
            </div>
            <div className="walkman-opts">
              <label>
                <input type="checkbox" checked={walkmanReveal} onChange={(e) => setWalkmanReveal(e.target.checked)} />
                显示单词
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                间隔
                <CustomSelect
                  value={String(walkmanGapSec)}
                  options={[
                    { value: '1', label: '1.0s' },
                    { value: '1.8', label: '1.8s' },
                    { value: '3', label: '3.0s' },
                  ]}
                  minWidth={68}
                  onChange={(val) => setWalkmanGapSec(Number(val))}
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 3: Mistakes Book */}
      {subView === 'mistakes' && (
        <div className="corpus-panel">
          <div className="corpus-controls">
            <strong>错词本（{allMistakesList.length}）</strong>
            <CustomSelect
              value={mistakeBookFilter}
              options={[
                { value: 'all', label: '全部词库', meta: `${allMistakesList.length}词` },
                ...mistakeBooksInList.map(([id, title]) => ({ value: id, label: title })),
              ]}
              minWidth={150}
              menuWidth={220}
              onChange={(val) => setMistakeBookFilter(val)}
            />
            <CustomSelect
              value={String(mistakeBatchSize)}
              options={[
                { value: '20', label: '每批 20 词' },
                { value: '30', label: '每批 30 词' },
                { value: '50', label: '每批 50 词' },
                { value: '0', label: '全部错词' },
              ]}
              minWidth={118}
              onChange={(val) => {
                const n = Number(val);
                setMistakeBatchSize(n);
                updatePersisted((prev) => ({
                  ...prev,
                  prefs: { ...prev.prefs, mistakeBatchSize: n },
                }));
              }}
            />
            <button
              className="primary"
              disabled={!batchedFilteredMistakes.length}
              onClick={() =>
                startMistakeDrill(
                  batchedFilteredMistakes.map((m) => ({ w: m.w, t: m.t, uk: m.uk, us: m.us })),
                  batchedFilteredMistakes.length < filteredMistakes.length
                    ? `错词专练 (${batchedFilteredMistakes.length}/${filteredMistakes.length}词)`
                    : `合并错词 (${batchedFilteredMistakes.length}词)`,
                )
              }
            >
              错词专练 (
              {batchedFilteredMistakes.length < filteredMistakes.length
                ? `${batchedFilteredMistakes.length}/${filteredMistakes.length}`
                : batchedFilteredMistakes.length}
              )
            </button>
            {(() => {
              const md = persisted.sectionDrafts['__mistakes__'];
              const mdDone = md
                ? md.cardStates.filter((s) => s.status === 'passed' || s.status === 'revealed').length
                : 0;
              const hasMd =
                md &&
                md.wordOrder.length > 0 &&
                (mdDone > 0 || md.inputs.some((v) => v.trim().length > 0));
              if (!hasMd || !allMistakesList.length) return null;
              return (
                <button
                  onClick={() =>
                    startMistakeDrill(
                      allMistakesList.map((m) => ({ w: m.w, t: m.t, uk: m.uk, us: m.us })),
                      `继续错词专练`,
                      true,
                    )
                  }
                >
                  继续上次错词 ({mdDone}/{md.wordOrder.length})
                </button>
              );
            })()}
            <button
              disabled={!batchedClearMistakes.length}
              title="按滞留时长优先清空错词（一次拼对即移出）"
              onClick={() =>
                startMistakeDrill(
                  batchedClearMistakes.map((m) => ({ w: m.w, t: m.t, uk: m.uk, us: m.us })),
                  batchedClearMistakes.length < clearQueueMistakes.length
                    ? `今日待清空 (${batchedClearMistakes.length}/${clearQueueMistakes.length}词)`
                    : `今日待清空 (${batchedClearMistakes.length}词)`,
                )
              }
            >
              今日待清空 (
              {batchedClearMistakes.length < clearQueueMistakes.length
                ? `${batchedClearMistakes.length}/${clearQueueMistakes.length}`
                : batchedClearMistakes.length}
              )
            </button>
            <button
              disabled={!filteredMistakes.length || !!exporting}
              onClick={() => handleExportMistakesCsv(filteredMistakes, 'ielts-mistakes-all.csv')}
            >
              导出 Excel
            </button>
            <button
              disabled={!filteredMistakes.length || !!exporting}
              onClick={() => handleExportMistakesAudio(filteredMistakes, 'ielts-mistakes-all.wav')}
            >
              导出音频
            </button>
          </div>

          {!filteredMistakes.length ? (
            <div className="corpus-empty">还没有错词记录。拼错的词会自动收录在这里，错词专练一次拼对即自动移出。</div>
          ) : (
            <table className="corpus-table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}></th>
                  <th>单词</th>
                  <th>释义</th>
                  <th>来源词库</th>
                  <th style={{ width: 96 }}>状态</th>
                  <th style={{ width: 70 }}>错次</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredMistakes.map((m) => {
                  const age = getMistakeRetentionBadge(m.lastWrongAt);
                  return (
                  <tr key={m.w.toLowerCase()}>
                    <td>
                      <button className="icon-btn corpus-speak" title="播放发音" aria-label="播放发音" onClick={() => playWordAt(m.w)}>
                        <IconVolume size={14} />
                      </button>
                    </td>
                    <td>
                      <strong>{m.w}</strong>
                      {m.uk && <small style={{ marginLeft: 6, color: 'var(--muted)' }}>/{m.uk}/</small>}
                    </td>
                    <td>{m.t}</td>
                    <td>{m.bookTitle}</td>
                    <td>
                      <span className={`mistake-age-tag${age.isToday ? ' today' : ''}`}>{age.label}</span>
                    </td>
                    <td>{m.count}</td>
                    <td>
                      <button
                        className="icon-btn"
                        title="移出"
                        aria-label="移出"
                        onClick={() =>
                          updatePersisted((prev) => {
                            const next = { ...prev.mistakes };
                            delete next[m.w.toLowerCase()];
                            return { ...prev, mistakes: next };
                          })
                        }
                      >
                        <IconTrash size={14} />
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* VIEW 4: History */}
      {subView === 'history' && (
        <div className="corpus-panel">
          <div className="corpus-controls">
            <strong>正确率历史（{persisted.history.length}）</strong>
            <button onClick={() => setSubView('practice')}>返回听写</button>
          </div>
          {!persisted.history.length ? (
            <div className="corpus-empty">暂无提交记录。</div>
          ) : (
            <table className="corpus-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>词库</th>
                  <th>小节</th>
                  <th>正确 / 总数</th>
                  <th>正确率</th>
                  <th>估分参考</th>
                </tr>
              </thead>
              <tbody>
                {persisted.history.map((h) => (
                  <tr key={h.id}>
                    <td>{new Date(h.timestamp).toLocaleString()}</td>
                    <td>{h.bookTitle}</td>
                    <td>{h.sectionLabel}</td>
                    <td>{h.correct} / {h.total}</td>
                    <td>
                      <strong style={{ color: h.accuracy >= 90 ? 'var(--accent-bright)' : h.accuracy >= 75 ? 'var(--amber)' : 'var(--danger)' }}>
                        {h.accuracy}%
                      </strong>
                    </td>
                    <td>{estimateIeltsBand(h.accuracy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* VIEW 5: Import */}
      {subView === 'import' && (
        <div className="corpus-panel corpus-import">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>导入自定义词单</h3>
            <button onClick={() => setSubView('practice')}>返回听写</button>
          </div>
          <p className="corpus-tip">每行一个单词或短语，可用逗号分隔中文释义（如 <code>accommodation, 住宿</code>）。</p>
          <input
            type="text"
            placeholder="词库名称"
            value={importTitle}
            onChange={(e) => setImportTitle(e.target.value)}
          />
          <textarea
            rows={10}
            placeholder={'accommodation, 住宿\nmaintenance, 维护\nquestionnaire, 问卷'}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div>
            <button className="primary" onClick={handleImportCustom}>
              导入并开始听写
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
