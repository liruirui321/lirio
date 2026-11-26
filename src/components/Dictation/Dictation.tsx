import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { mkdir, writeFile, readTextFile } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { audioEngine } from '../../services/audioEngine';
import { useProjectStore } from '../../stores/projectStore';
import {
  grade,
  sentences,
  srt,
  parseSrt,
  resegmentSentences,
  mergeTwoSentences,
  splitSentenceAt,
} from '../../services/dictation';
import { FUNCTION_WORDS, record } from '../../services/submissions';
import { addMistakeToWordBook, loadCorpusState } from '../../services/corpusService';
import { simplifyMaterialTitle } from '../../services/materialTitle';
import { formatPoints, getAccountState, subscribeAccount, type AccountState } from '../../services/accountService';
import { loadSpeakState, proofreadDictationSentences } from '../../services/speakService';
import { handleDictationKeySound } from '../../services/typingSound';
import type { Sentence } from '../../types/project';
import { CustomSelect } from '../Corpus/CustomSelect';
import { StudyWaveform } from './StudyWaveform';
import {
  IconBookmark,
  IconBulb,
  IconCheck,
  IconClose,
  IconEye,
  IconListView,
  IconNext,
  IconPause,
  IconPrev,
  IconReplay,
  IconSettings,
  IconVolume,
} from '../Icons';

const stamp = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const gradedAnswer = (s: Sentence) => (s.submittedAnswer !== undefined ? s.submittedAnswer : s.answer);

export function Dictation({
  onBusy,
  onDiscussInSpeak,
  onOpenAiSettings,
  autoPlayOnOpen,
  onAutoPlayConsumed,
}: {
  onBusy: (busy: boolean) => void;
  onDiscussInSpeak?: (topicTitle: string, excerpt: string) => void;
  onOpenAiSettings?: () => void;
  autoPlayOnOpen?: boolean;
  onAutoPlayConsumed?: () => void;
}) {
  const { project, updateProject } = useProjectStore();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [language, setLanguage] = useState('en');
  const [playing, setPlaying] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [rate, setRate] = useState(1);
  const [wrongOnly, setWrongOnly] = useState(false);
  const [inputStyle, setInputStyle] = useState<'sentence' | 'word'>(() => {
    try {
      return localStorage.getItem('aboboo-dict-input-style') === 'word' ? 'word' : 'sentence';
    } catch {
      return 'sentence';
    }
  });
  const [hint, setHint] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAiPolish, setShowAiPolish] = useState(false);
  const [aiPolishing, setAiPolishing] = useState(false);
  const [polishFixText, setPolishFixText] = useState(true);
  const [polishAddZh, setPolishAddZh] = useState(true);
  const [showTranslation, setShowTranslation] = useState(() => {
    try {
      return localStorage.getItem('aboboo-dict-show-zh') !== '0';
    } catch {
      return true;
    }
  });
  const [accountState, setAccountState] = useState<AccountState>(() => getAccountState());
  const [showComplete, setShowComplete] = useState(false);
  const [addedMistakes, setAddedMistakes] = useState<Record<string, boolean>>({});
  const [reference, setReference] = useState('');
  const [editTranslation, setEditTranslation] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const submitting = useRef(false);
  const aiCancelRef = useRef({ cancelled: false });
  const commandGesture = useRef<{ used: boolean } | null>(null);
  const autoPlaySentence = useRef<string | null>(null);
  const [position, setPosition] = useState(0);
  const starting = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const slotRefs = useRef<Array<HTMLInputElement | null>>([]);

  const items = project?.dictation?.sentences || [];
  const index = project?.dictation?.index || 0;
  const sentence = items[index];
  const original = project?.tracks.find((t) => t.type === 'original');
  const trimmed = useMemo(
    () => (sentence && original ? audioEngine.trimSilence(original.id, sentence.start, sentence.end) : null),
    [original?.id, sentence?.id, sentence?.start, sentence?.end],
  );
  const segStart = trimmed?.start ?? sentence?.start ?? 0;
  const segEnd = trimmed?.end ?? sentence?.end ?? 0;
  const key = project ? 'aboboo-dictation:' + project.originalAudioPath + ':' + project.duration.toFixed(2) : '';

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [sentence?.answer, sentence?.id, inputStyle]);
  const failure = (e: unknown) => setError(String(e));
  const stop = () => {
    audioEngine.pause();
    setPosition(audioEngine.getCurrentTime());
    setPlaying(false);
  };

  useEffect(() => {
    if (!project) return;
    if (!project.dictation) {
      try {
        const stored = JSON.parse(localStorage.getItem(key) || 'null');
        if (stored && Array.isArray(stored.sentences) && stored.sentences.length) {
          updateProject({ dictation: stored });
        }
      } catch {
        // ignore corrupt local cache
      }
    }
    return () => {
      audioEngine.pause();
    };
  }, [project?.id]);

  useEffect(() => {
    if (project?.dictation) {
      try {
        localStorage.setItem(key, JSON.stringify(project.dictation));
      } catch {
        setError('本机进度缓存空间不足。');
      }
    }
  }, [project?.dictation]);

  useEffect(() => {
    onBusy(busy || aiPolishing);
    return () => onBusy(false);
  }, [busy, aiPolishing, onBusy]);

  useEffect(() => subscribeAccount(setAccountState), []);

  useEffect(() => {
    setShowComplete(false);
  }, [project?.id]);

  useEffect(() => {
    if (!project?.name) return;
    try {
      const { shortTitle: cleanTitle } = simplifyMaterialTitle(project.name);
      localStorage.setItem(
        'aboboo-last-listening',
        JSON.stringify({
          libraryId: project.libraryId || '',
          title: cleanTitle || project.name,
          index,
          total: items.length,
          updatedAt: Date.now(),
        }),
      );
    } catch {
      // ignore storage failure
    }
  }, [project?.name, project?.libraryId, index, items.length]);

  useEffect(() => {
    starting.current = false;
    setPlaying(false);
    setHint(false);
    setEditing(false);
    setPosition(segStart);
    let cancelled = false;
    const shouldAutoOpen = Boolean(autoPlayOnOpen) && Boolean(sentence) && Boolean(original);
    const autoplay = autoPlaySentence.current === sentence?.id || shouldAutoOpen;
    if (autoPlaySentence.current === sentence?.id) {
      autoPlaySentence.current = null;
    }
    if (shouldAutoOpen) {
      onAutoPlayConsumed?.();
    }
    if (autoplay && sentence && original) {
      setError('');
      starting.current = true;
      audioEngine
        .playRange(original.id, segStart, segEnd, rate)
        .then((started) => {
          if (!cancelled && started) {
            setPlaying(true);
            (inputRef.current ?? slotRefs.current[0])?.focus();
          }
        })
        .catch((e) => {
          if (!cancelled) failure(e);
        })
        .finally(() => {
          if (!cancelled) starting.current = false;
        });
    }
    return () => {
      cancelled = true;
    };
  }, [sentence?.id, autoPlayOnOpen]);

  useEffect(() => {
    if (!playing || !sentence || !original) return;
    const timer = setInterval(() => {
      setPosition(audioEngine.getCurrentTime());
      if (!audioEngine.isPlaying() && !starting.current) {
        if (repeat) {
          starting.current = true;
          audioEngine
            .playRange(original.id, segStart, segEnd, rate)
            .catch(failure)
            .finally(() => {
              starting.current = false;
            });
        } else {
          setPlaying(false);
        }
      }
    }, 80);
    return () => clearInterval(timer);
  }, [playing, repeat, sentence?.id, segStart, segEnd, rate]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        if (!e.repeat && !commandGesture.current) {
          commandGesture.current = { used: busy || editing || !sentence || e.altKey || e.ctrlKey || e.shiftKey || e.isComposing };
        }
        return;
      }
      if (commandGesture.current) commandGesture.current.used = true;
      if (e.defaultPrevented || e.repeat || e.isComposing || busy || editing || !sentence || !original) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role=separator]')) return;
      const typing = !!target?.closest('input,textarea,select,[contenteditable="true"]');
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        next(1);
        inputRef.current?.focus();
      } else if (!e.metaKey && !e.ctrlKey && !e.shiftKey && ((!e.altKey && !typing && e.code === 'Space') || (e.altKey && e.code === 'KeyP'))) {
        e.preventDefault();
        togglePlayback().catch(failure);
      } else if (!e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'Tab' && (!typing || target === inputRef.current)) {
        e.preventDefault();
        play().catch(failure);
      } else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'ArrowRight') {
        e.preventDefault();
        next(1);
        inputRef.current?.focus();
      } else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'ArrowLeft') {
        e.preventDefault();
        next(-1);
        inputRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape' && !showDrawer && !showSettings && !showAiPolish) {
        e.preventDefault();
        update({ revealed: !sentence.revealed, assisted: sentence.assisted || !sentence.revealed });
      }
    };
    const release = (e: KeyboardEvent) => {
      if (e.key !== 'Meta') return;
      const gesture = commandGesture.current;
      commandGesture.current = null;
      if (!gesture || gesture.used || e.isComposing || busy || editing || !sentence || !original) return;
      if (document.activeElement?.closest('[role=separator]')) return;
      e.preventDefault();
      next(1);
      inputRef.current?.focus();
    };
    const modifier = (event: Event) => {
      const { command, other } = (event as CustomEvent<{ command: boolean; other: boolean }>).detail;
      if (command) {
        handle(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, shiftKey: other }));
        if (other && commandGesture.current) commandGesture.current.used = true;
      } else {
        release(new KeyboardEvent('keyup', { key: 'Meta' }));
      }
    };
    window.addEventListener('aboboo-command-modifier', modifier);
    const cancel = () => {
      commandGesture.current = null;
    };
    const pointer = () => {
      if (commandGesture.current) commandGesture.current.used = true;
    };
    window.addEventListener('keydown', handle);
    window.addEventListener('keyup', release);
    window.addEventListener('blur', cancel);
    window.addEventListener('pointerdown', pointer);
    return () => {
      window.removeEventListener('aboboo-command-modifier', modifier);
      window.removeEventListener('keydown', handle);
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pointerdown', pointer);
    };
  });

  const { shortTitle, badge } = useMemo(
    () => simplifyMaterialTitle(project?.name || ''),
    [project?.name],
  );

  // Sliding dot window when items.length > 40 so long Part 1 scripts stay clean
  const dotWindow = useMemo(() => {
    if (items.length <= 40) return { start: 0, end: items.length };
    const half = 12;
    let s = Math.max(0, index - half);
    let e = Math.min(items.length, s + half * 2 + 1);
    if (e - s < half * 2 + 1) s = Math.max(0, e - (half * 2 + 1));
    return { start: s, end: e };
  }, [items.length, index]);

  if (!project || !original) return null;

  const update = (changes: Partial<Sentence>) => {
    if (!sentence) return;
    updateProject({
      dictation: {
        ...project.dictation!,
        sentences: items.map((s, i) => (i === index ? { ...s, ...changes } : s)),
      },
    });
  };

  const choose = (i: number, autoplay = false) => {
    stop();
    autoPlaySentence.current = autoplay ? items[i]?.id ?? null : null;
    updateProject({ dictation: { ...project.dictation!, index: i } });
  };

  const visible = items.map((s, i) => ({ s, i })).filter(({ s }) => !wrongOnly || (s.submitted && grade(s.text, gradedAnswer(s)).hasErrors));
  const wrongIndices = items
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.submitted && grade(s.text, gradedAnswer(s)).hasErrors)
    .map(({ i }) => i);
  const next = (direction: number) => {
    const at = visible.findIndex((v) => v.i === index);
    const item = visible[at + direction];
    if (item) choose(item.i, direction > 0);
  };

  const play = async () => {
    if (!sentence) return;
    stop();
    setError('');
    await audioEngine.playRange(original.id, segStart, segEnd, rate);
    setPosition(segStart);
    setPlaying(true);
    (inputRef.current ?? slotRefs.current[0])?.focus();
  };

  const togglePlayback = async () => {
    if (!sentence) return;
    if (audioEngine.isPlaying()) {
      stop();
      return;
    }
    const at = audioEngine.getCurrentTime();
    const offset = at >= segStart && at < segEnd - 0.05 ? at : segStart;
    await audioEngine.playRange(original.id, offset, segEnd, rate);
    setPlaying(true);
    (inputRef.current ?? slotRefs.current[0])?.focus();
  };

  const playSlow = async () => {
    if (!sentence) return;
    stop();
    setError('');
    await audioEngine.playRange(original.id, segStart, segEnd, 0.75);
    setPosition(segStart);
    setPlaying(true);
    (inputRef.current ?? slotRefs.current[0])?.focus();
  };

  const resegmentCurrent = () => {
    if (!project.dictation || !items.length) return;
    stop();
    const nextList = resegmentSentences(
      items,
      project.dictation.words,
      project.duration,
      (a, b) => audioEngine.trimSilence(original.id, a, b),
    );
    if (!nextList.length) return;
    updateProject({
      dictationBackups: [...(project.dictationBackups || []), project.dictation].slice(-3),
      dictation: {
        ...project.dictation,
        sentences: nextList,
        index: Math.min(index, nextList.length - 1),
        segmentationVersion: 3,
      },
    });
    setWrongOnly(false);
    setShowSettings(false);
    setStatus(`已智能重排分句：${items.length} 句 → ${nextList.length} 句`);
  };

  const mergeNextSentence = () => {
    if (!project.dictation || index >= items.length - 1) return;
    stop();
    const merged = mergeTwoSentences(items[index], items[index + 1]);
    const nextList = [...items.slice(0, index), merged, ...items.slice(index + 2)];
    updateProject({
      dictationBackups: [...(project.dictationBackups || []), project.dictation].slice(-3),
      dictation: {
        ...project.dictation,
        sentences: nextList,
        index,
      },
    });
    setEditing(false);
    setShowSettings(false);
    setStatus(`已与第 ${index + 2} 句合并`);
  };

  const splitCurrentSentence = () => {
    if (!project.dictation || !sentence) return;
    const pair = splitSentenceAt(
      sentence,
      position,
      project.dictation.words,
      (a, b) => audioEngine.trimSilence(original.id, a, b),
    );
    if (!pair) {
      setError('当前句词数过少，无法继续拆分');
      return;
    }
    stop();
    const nextList = [...items.slice(0, index), pair[0], pair[1], ...items.slice(index + 1)];
    updateProject({
      dictationBackups: [...(project.dictationBackups || []), project.dictation].slice(-3),
      dictation: {
        ...project.dictation,
        sentences: nextList,
        index,
      },
    });
    setEditing(false);
    setShowSettings(false);
    setStatus(`已将第 ${index + 1} 句拆分为两句`);
  };

  const restorePreviousDictation = () => {
    const backups = project.dictationBackups || [];
    if (!backups.length) return;
    stop();
    const prev = backups[backups.length - 1];
    updateProject({
      dictation: {
        ...prev,
        index: Math.min(index, Math.max(0, prev.sentences.length - 1)),
      },
      dictationBackups: backups.slice(0, -1),
    });
    setWrongOnly(false);
    setShowAiPolish(false);
    setShowSettings(false);
    setStatus('已还原精校前的字幕版本');
  };

  const runAiPolish = async (scope: 'current' | 'all') => {
    if (!project.dictation || !items.length || aiPolishing || busy) return;
    if (!polishFixText && !polishAddZh) {
      setError('请至少勾选「修正英文文本」或「生成中文译文」中的一项。');
      return;
    }
    const targets = scope === 'current' ? (sentence ? [sentence] : []) : items;
    if (!targets.length) return;

    stop();
    setError('');
    setShowAiPolish(false);
    setShowSettings(false);
    setAiPolishing(true);
    aiCancelRef.current = { cancelled: false };
    setStatus(scope === 'current' ? '正在 AI 精校当前句…' : `正在 AI 精校全篇（共 ${targets.length} 句）…`);

    try {
      const res = await proofreadDictationSentences(
        targets.map((s) => ({ id: s.id, text: s.text, translation: s.translation })),
        {
          fixText: polishFixText,
          addTranslation: polishAddZh,
          materialTitle: shortTitle || project.name,
          signal: aiCancelRef.current,
          onProgress: (done, total, bIdx, bTotal) => {
            setStatus(
              scope === 'current'
                ? '正在 AI 精校当前句…'
                : `正在 AI 精校字幕（第 ${bIdx}/${bTotal} 批，${done}/${total} 句）…`,
            );
          },
        },
      );

      if (aiCancelRef.current.cancelled) {
        setStatus('已取消 AI 精校（原字幕未改动）');
        return;
      }

      const currentProj = useProjectStore.getState().project;
      if (!currentProj?.dictation || currentProj.id !== project.id) return;

      const currentItems = currentProj.dictation.sentences;
      const nextSentences = currentItems.map((s) => {
        const patch = res.updates.get(s.id);
        if (!patch) return s;
        return {
          ...s,
          text: patch.text !== undefined ? patch.text : s.text,
          translation: patch.translation !== undefined ? patch.translation : s.translation,
        };
      });

      const baseSource = (currentProj.dictation.source || '本机离线识别').replace(/ · AI 精校$/, '');
      updateProject({
        dictationBackups: [...(currentProj.dictationBackups || []), currentProj.dictation].slice(-3),
        dictation: {
          ...currentProj.dictation,
          sentences: nextSentences,
          aiPolished: true,
          source: `${baseSource} · AI 精校`,
        },
      });

      if (polishAddZh && !showTranslation) {
        setShowTranslation(true);
        try {
          localStorage.setItem('aboboo-dict-show-zh', '1');
        } catch {}
      }

      if (scope === 'current') {
        setStatus(
          `第 ${index + 1} 句 AI 精校完成（修正 ${res.changedCount} 处 · 译文 ${res.translatedCount} 句）`,
        );
      } else {
        setStatus(
          `全篇 AI 精校完成：共优化 ${res.changedCount} 句文本，生成 ${res.translatedCount} 句中文译文（已备份原版，可随时还原）`,
        );
      }
    } catch (e) {
      const msg = String(e);
      if (aiCancelRef.current.cancelled || msg.includes('已取消')) {
        setStatus('已取消 AI 精校（原字幕未改动）');
      } else {
        setError('AI 精校失败：' + msg);
        setStatus('');
      }
    } finally {
      setAiPolishing(false);
    }
  };

  const favoriteSentence = () => {
    if (!sentence) return;
    const favorites = project.favorites || [];
    if (favorites.some((f) => f.kind === 'sentence' && f.text.toLowerCase() === sentence.text.toLowerCase() && f.start === segStart)) {
      setStatus('该句已在收藏词卡中');
      return;
    }
    updateProject({
      favorites: [
        ...favorites,
        {
          id: crypto.randomUUID(),
          kind: 'sentence',
          text: sentence.text,
          context: sentence.text,
          start: segStart,
          end: segEnd,
          note: '',
          mastered: false,
          reviews: 0,
        },
      ],
    });
    setStatus('已收藏本句到「收藏词卡」');
  };

  const submit = async () => {
    if (!sentence || submitting.current) return;
    const prevResult = sentence.submitted ? grade(sentence.text, gradedAnswer(sentence)) : null;
    if (sentence.submitted && prevResult && !prevResult.correct && !sentence.answer.trim()) {
      (inputRef.current ?? slotRefs.current[0])?.focus();
      return;
    }
    submitting.current = true;
    setError('');
    const captured = sentence;
    const projectId = project.id;
    try {
      await record(project, captured, !!captured.assisted || captured.revealed || hint);
      const graded = grade(captured.text, captured.answer);
      const current = useProjectStore.getState().project;
      let clearedForRetry = false;
      if (current?.id === projectId && current.dictation) {
        const nextSentences = current.dictation.sentences.map((s) => {
          if (s.id !== captured.id) return s;
          const unchanged = s.answer === captured.answer && s.text === captured.text;
          const attempts = Math.max(s.attempts, captured.attempts + 1);
          if (!unchanged) {
            return { ...s, submitted: false, attempts };
          }
          if (!graded.correct) {
            clearedForRetry = true;
            return { ...s, answer: '', submittedAnswer: captured.answer, submitted: true, attempts };
          }
          return { ...s, submittedAnswer: captured.answer, submitted: true, attempts };
        });
        updateProject({
          dictation: {
            ...current.dictation,
            sentences: nextSentences,
          },
        });
        if (clearedForRetry) {
          setTimeout(() => (inputRef.current ?? slotRefs.current[0])?.focus(), 0);
        }
        if (nextSentences.length > 0 && nextSentences.every((s) => s.submitted)) {
          setShowComplete(true);
        }
      }
      setStatus('');
    } catch (e) {
      setError('提交未保存，请重试：' + String(e));
    } finally {
      submitting.current = false;
    }
  };

  const transcribe = async () => {
    setBusy(true);
    setError('');
    setShowSettings(false);
    stop();
    setStatus('正在准备音频…');
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<string>('transcription-progress', (e) => setStatus(e.payload));
      const bytes = await audioEngine.exportWav(original.id);
      const id = crypto.randomUUID();
      const dir = await appCacheDir();
      await mkdir(dir, { recursive: true });
      await writeFile(await join(dir, `asr-input-${id}.wav`), bytes);
      setStatus('正在本机提取字幕…');
      const result = await invoke<{ segments: Array<{ start: number; end: number; text: string }>; words?: Array<{ start: number; end: number; text: string }>; source: string }>('transcribe_audio', { id, language });
      const list = sentences(result.segments, project.duration, result.words);
      if (!list.length) throw Error('没有可用的语音片段。');
      const restored = list.map((s) => {
        const old = items.find((o) => o.text.toLowerCase() === s.text.toLowerCase());
        return old
          ? {
              ...s,
              translation: old.translation,
              answer: old.answer,
              submittedAnswer: old.submittedAnswer,
              submitted: old.submitted,
              revealed: old.revealed,
              attempts: old.attempts,
            }
          : s;
      });
      updateProject({
        dictationBackups: project.dictation ? [...(project.dictationBackups || []), project.dictation].slice(-3) : project.dictationBackups,
        dictation: { sentences: restored, index: 0, source: result.source, aiPolished: false, words: result.words, segmentationVersion: 3 },
      });
      setWrongOnly(false);
      setStatus(`已生成 ${list.length} 个单句`);
    } catch (e) {
      failure(e);
    } finally {
      unlisten?.();
      setBusy(false);
    }
  };

  const importSubs = async () => {
    const path = await open({ filters: [{ name: 'SRT 字幕', extensions: ['srt'] }], multiple: false });
    if (typeof path !== 'string') return;
    const list = parseSrt(await readTextFile(path), project.duration);
    if (!list.length) throw Error('字幕无有效时间轴。');
    updateProject({ dictation: { sentences: list, index: 0, source: '导入字幕' } });
    setShowSettings(false);
  };

  const exportSubs = async () => {
    const path = await save({ defaultPath: project.name + '.srt', filters: [{ name: '字幕', extensions: ['srt'] }] });
    if (path) await writeFile(path, new TextEncoder().encode(srt(items)));
  };

  const result = sentence?.submitted ? grade(sentence.text, gradedAnswer(sentence)) : null;
  const done = items.filter((s) => s.submitted).length;
  const cursor = visible.findIndex((v) => v.i === index);
  const detailPlay = (t: number) => {
    if (!sentence) return;
    stop();
    audioEngine
      .playRange(original.id, Math.max(segStart, t), segEnd, rate)
      .then(() => setPlaying(true))
      .catch(failure);
  };

  const progressPct = items.length ? ((index + 1) / items.length) * 100 : 0;
  const cardCls = result ? (result.correct ? 'correct' : 'wrong') : '';

  return (
    <section className="dict-workspace" aria-label="单句精听">
      {/* Minimal Single-Row Top Bar */}
      <div className="dict-topbar">
        <div className="dict-title-group" title={project.name}>
          {badge && <span className="material-badge">{badge}</span>}
          <strong>{shortTitle}</strong>
          {items.length > 0 && (
            <span className="dict-done-count">
              {done}/{items.length}
            </span>
          )}
        </div>

        <div className="dict-top-actions">
          {wrongIndices.length > 0 && (
            <button
              type="button"
              className={`dict-slow-btn${wrongOnly ? ' active' : ''}`}
              title={wrongOnly ? '恢复显示全部句子' : '只看并重练错句'}
              onClick={() => {
                const nextWrongOnly = !wrongOnly;
                setWrongOnly(nextWrongOnly);
                if (nextWrongOnly && !wrongIndices.includes(index)) {
                  choose(wrongIndices[0], false);
                }
              }}
            >
              {wrongOnly ? `错句中 (${wrongIndices.length})` : `只看错句 (${wrongIndices.length})`}
            </button>
          )}
          {items.length > 0 && done === items.length && (
            <button
              type="button"
              className={`dict-slow-btn${showComplete ? ' active' : ''}`}
              title="查看本篇精听总结与下一步"
              onClick={() => setShowComplete((c) => !c)}
            >
              {showComplete ? '返回单句' : '本篇复盘'}
            </button>
          )}
          {items.length > 0 && (
            <button
              type="button"
              className={`dict-slow-btn dict-ai-btn${showAiPolish || project.dictation?.aiPolished ? ' active' : ''}`}
              disabled={busy}
              title="AI 精校字幕与中文译文"
              onClick={() => {
                setShowDrawer(false);
                setShowSettings(false);
                setShowAiPolish((v) => !v);
              }}
            >
              {aiPolishing ? '精校中…' : project.dictation?.aiPolished ? 'AI 已精校 ✓' : 'AI 精校'}
            </button>
          )}
          {items.length > 0 && (
            <button
              type="button"
              className={`icon-btn${showDrawer ? ' active' : ''}`}
              title="全篇句子目录"
              aria-label="句子目录"
              onClick={() => {
                setShowSettings(false);
                setShowAiPolish(false);
                setShowDrawer((d) => !d);
              }}
            >
              <IconListView size={16} />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn${showSettings ? ' active' : ''}`}
            title="精听设置与字幕工具"
            aria-label="精听设置"
            onClick={() => {
              setShowDrawer(false);
              setShowAiPolish(false);
              setShowSettings((s) => !s);
            }}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </div>

      {/* Status / Error Banners */}
      {(status || error) && (
        <div
          className={error ? 'app-error' : 'corpus-banner'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
          onClick={() => {
            if (aiPolishing) return;
            setStatus('');
            setError('');
          }}
        >
          <span>{error || status}</span>
          {aiPolishing && (
            <button
              type="button"
              className="dict-slow-btn"
              onClick={(e) => {
                e.stopPropagation();
                aiCancelRef.current.cancelled = true;
                setStatus('正在取消 AI 精校…');
              }}
            >
              取消精校
            </button>
          )}
        </div>
      )}

      {/* AI Polish & Bilingual Subtitle Popover */}
      {showAiPolish && items.length > 0 && (() => {
        const speakCfg = loadSpeakState().config;
        const usingOfficial = accountState.aiMode === 'pro_balance';
        const channelLabel = usingOfficial
          ? `Lirio 云端服务 · 剩余 ${formatPoints(accountState.user?.balanceUnits ?? 0)}`
          : `自填 API Key · ${speakCfg.textModel || 'deepseek-chat'}`;
        const hasBackups = (project.dictationBackups?.length ?? 0) > 0;
        const translatedInDoc = items.filter((s) => Boolean(s.translation?.trim())).length;

        return (
          <div className="corpus-popover dict-ai-popover">
            <div className="corpus-popover-head">
              <strong>字幕校对模式（本地 / AI 精校）</strong>
              <button className="icon-btn" onClick={() => setShowAiPolish(false)} aria-label="关闭">
                <IconClose size={14} />
              </button>
            </div>
            <div className="dict-ai-meta">
              <span className={`dict-ai-mode-pill${project.dictation?.aiPolished ? ' polished' : ''}`}>
                {project.dictation?.aiPolished ? 'AI 已精校' : '离线字幕'}
              </span>
              <span className="dict-ai-source" title={project.dictation?.source || ''}>
                {project.dictation?.source || '本机识别'}
                {translatedInDoc > 0 ? ` · 含译文 ${translatedInDoc}/${items.length}` : ''}
              </span>
            </div>
            <div className="dict-ai-channel">
              <span>当前通道：{channelLabel}</span>
              {onOpenAiSettings && (
                <button
                  type="button"
                  className="link-inline-btn"
                  onClick={() => {
                    setShowAiPolish(false);
                    onOpenAiSettings();
                  }}
                >
                  切换 AI 设置
                </button>
              )}
            </div>
            <p className="dict-ai-note">
              可按需修正识别错误并补全中文译文，精校前自动备份，随时可还原。
            </p>
            <div className="corpus-popover-checks dict-ai-checks">
              <label>
                <input
                  type="checkbox"
                  checked={polishFixText}
                  disabled={aiPolishing}
                  onChange={(e) => setPolishFixText(e.target.checked)}
                />
                修正拼写、专有名词、大小写与标点
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={polishAddZh}
                  disabled={aiPolishing}
                  onChange={(e) => setPolishAddZh(e.target.checked)}
                />
                同步生成中文参考译文
              </label>
            </div>
            <div className="dict-ai-actions">
              <button
                type="button"
                disabled={busy || aiPolishing || !sentence}
                onClick={() => void runAiPolish('current')}
              >
                精校当前句
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || aiPolishing}
                onClick={() => void runAiPolish('all')}
              >
                {aiPolishing ? '精校中…' : `全篇 AI 精校（${items.length} 句）`}
              </button>
              {aiPolishing && (
                <button
                  type="button"
                  onClick={() => {
                    aiCancelRef.current.cancelled = true;
                  }}
                >
                  取消精校
                </button>
              )}
              {hasBackups && !aiPolishing && (
                <button type="button" onClick={restorePreviousDictation}>
                  还原上一版字幕
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Settings Popover */}
      {showSettings && (
        <div className="corpus-popover">
          <div className="corpus-popover-head">
            <strong>精听设置</strong>
            <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="关闭">
              <IconClose size={14} />
            </button>
          </div>
          <div className="corpus-popover-grid">
            <label>
              倍速
              <CustomSelect
                value={String(rate)}
                options={[0.5, 0.75, 1, 1.25, 1.5].map((r) => ({ value: String(r), label: `${r}x` }))}
                minWidth={95}
                onChange={(v) => {
                  stop();
                  setRate(Number(v));
                }}
              />
            </label>
            <label>
              识别语言
              <CustomSelect
                value={language}
                disabled={busy}
                options={[
                  { value: 'en', label: '英语' },
                  { value: 'zh', label: '中文' },
                  { value: 'auto', label: '自动' },
                ]}
                minWidth={95}
                onChange={(v) => setLanguage(v)}
              />
            </label>
            <label>
              输入形式
              <CustomSelect
                value={inputStyle}
                options={[
                  { value: 'sentence', label: '整句输入' },
                  { value: 'word', label: '逐词填空' },
                ]}
                minWidth={95}
                onChange={(v) => {
                  const nextStyle = v === 'word' ? 'word' : 'sentence';
                  setInputStyle(nextStyle);
                  try {
                    localStorage.setItem('aboboo-dict-input-style', nextStyle);
                  } catch {}
                }}
              />
            </label>
          </div>
          <div className="corpus-popover-checks">
            <label><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> 单句循环</label>
            <label><input type="checkbox" checked={wrongOnly} onChange={(e) => setWrongOnly(e.target.checked)} /> 只看错句</label>
            <label>
              <input
                type="checkbox"
                checked={showTranslation}
                onChange={(e) => {
                  const nextVal = e.target.checked;
                  setShowTranslation(nextVal);
                  try {
                    localStorage.setItem('aboboo-dict-show-zh', nextVal ? '1' : '0');
                  } catch {}
                }}
              />
              显示中文译文
            </label>
          </div>
          <div className="corpus-popover-links">
            <button disabled={busy || aiPolishing} onClick={() => void transcribe()}>
              {items.length ? '本地重提字幕' : '自动提取字幕'}
            </button>
            {items.length > 0 && (
              <button
                disabled={busy || aiPolishing}
                onClick={() => {
                  setShowSettings(false);
                  setShowAiPolish(true);
                }}
              >
                AI 精校字幕
              </button>
            )}
            {(project.dictationBackups?.length ?? 0) > 0 && (
              <button disabled={busy || aiPolishing} onClick={restorePreviousDictation}>
                还原上一版
              </button>
            )}
            {busy && <button onClick={() => invoke('cancel_transcription').catch(failure)}>取消</button>}
            {items.length > 0 && (
              <button disabled={busy || aiPolishing} title="免重识别，1秒内按意群切长句、合并碎句" onClick={resegmentCurrent}>
                智能重排分句
              </button>
            )}
            <button disabled={busy || aiPolishing} onClick={() => importSubs().catch(failure)}>导入 SRT</button>
            {items.length > 0 && <button onClick={() => exportSubs().catch(failure)}>导出 SRT</button>}
            {sentence && (
              <>
                <button disabled={index >= items.length - 1} title="把当前句与下一句合为一体" onClick={mergeNextSentence}>
                  与下句合并
                </button>
                <button title="从当前波形指针或句中停顿处拆成两句" onClick={splitCurrentSentence}>
                  拆成两句
                </button>
                <button
                  onClick={() => {
                    stop();
                    setShowSettings(false);
                    setEditing((e) => !e);
                    setReference(sentence.text);
                    setEditTranslation(sentence.translation || '');
                    setStart(sentence.start.toFixed(2));
                    setEnd(sentence.end.toFixed(2));
                  }}
                >
                  校正本句
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Sentence Directory Drawer */}
      {showDrawer && items.length > 0 && (
        <div className="dict-drawer">
          <div className="corpus-popover-head">
            <strong>全篇目录（{visible.length} 句）</strong>
            <button className="icon-btn" onClick={() => setShowDrawer(false)} aria-label="关闭">
              <IconClose size={14} />
            </button>
          </div>
          <div className="dict-drawer-list">
            {visible.map(({ s, i }) => {
              const r = s.submitted ? grade(s.text, gradedAnswer(s)) : null;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`dict-drawer-row${i === index ? ' active' : ''}`}
                  onClick={() => {
                    choose(i, true);
                    setShowDrawer(false);
                  }}
                >
                  <span className="dict-drawer-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="dict-drawer-text">{s.answer || s.submittedAnswer || s.text || '待听写'}</span>
                  <span className={`dict-drawer-score${r ? (r.correct ? ' ok' : ' err') : ''}`}>
                    {r ? `${r.score}%` : stamp(s.start)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Completion Card OR Empty State OR Centered Single-Sentence Card */}
      {showComplete && items.length > 0 ? (() => {
        const gradedList = items.map((s) => grade(s.text, gradedAnswer(s)));
        const avgScore = Math.round(
          gradedList.reduce((sum, g) => sum + g.score, 0) / Math.max(1, gradedList.length),
        );
        const perfectCount = gradedList.filter((g) => g.correct).length;
        const mistakeMap = new Map<string, number>();
        for (const g of gradedList) {
          for (const e of g.edits) {
            const w = e.expected?.toLowerCase();
            if (w && (e.kind === 'wrong' || e.kind === 'missing') && w.length >= 2 && !FUNCTION_WORDS.has(w)) {
              mistakeMap.set(w, (mistakeMap.get(w) || 0) + 1);
            }
          }
        }
        const uniqueMistakes = [...mistakeMap.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
        const existingMistakes = loadCorpusState().mistakes;
        const unsavedCount = uniqueMistakes.filter((w) => !existingMistakes[w] && !addedMistakes[w]).length;
        const excerpt = items
          .slice(0, 6)
          .map((s) => s.text.trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 600);

        return (
          <div className="dict-stage">
            <div className="dict-complete-card">
              <div>
                <span className="tier-badge small">精听完成</span>
                <h2 style={{ marginTop: 8 }}>{shortTitle}</h2>
              </div>

              <div className="dict-complete-stats">
                <div className="dict-complete-stat">
                  <span>平均正确率</span>
                  <strong>{avgScore}%</strong>
                </div>
                <div className="dict-complete-stat">
                  <span>全对句数</span>
                  <strong>
                    {perfectCount} / {items.length}
                  </strong>
                </div>
                <div className="dict-complete-stat">
                  <span>实词错词</span>
                  <strong>{uniqueMistakes.length} 词</strong>
                </div>
              </div>

              {uniqueMistakes.length > 0 && (
                <div className="dict-diff-tokens">
                  {uniqueMistakes.slice(0, 18).map((w) => {
                    const added = !!addedMistakes[w] || !!existingMistakes[w];
                    return (
                      <button
                        key={w}
                        type="button"
                        className={`dict-mistake-chip wrong${added ? ' added' : ''}`}
                        title={added ? '已在单词错词本' : '加入单词错词本'}
                        onClick={() => {
                          addMistakeToWordBook(w, shortTitle);
                          setAddedMistakes((prev) => ({ ...prev, [w]: true }));
                        }}
                      >
                        {w}
                        {added ? ' ✓' : ' +'}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="dict-complete-actions">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setShowComplete(false)}>
                    返回逐句查看
                  </button>
                  {wrongIndices.length > 0 && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setWrongOnly(true);
                        setShowComplete(false);
                        choose(wrongIndices[0], false);
                      }}
                    >
                      只重练本篇错句 ({wrongIndices.length} 句)
                    </button>
                  )}
                  {uniqueMistakes.length > 0 && (
                    <button
                      type="button"
                      disabled={unsavedCount === 0}
                      onClick={() => {
                        const mark: Record<string, boolean> = {};
                        for (const w of uniqueMistakes) {
                          addMistakeToWordBook(w, shortTitle);
                          mark[w] = true;
                        }
                        setAddedMistakes((prev) => ({ ...prev, ...mark }));
                        setStatus(`已将 ${uniqueMistakes.length} 个实词收进「单词 → 错词本」`);
                      }}
                    >
                      {unsavedCount > 0 ? `全部收进错词本 (${unsavedCount})` : '已全部收进错词本'}
                    </button>
                  )}
                </div>
                {onDiscussInSpeak && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onDiscussInSpeak(shortTitle, excerpt)}
                  >
                    去「对话」聊聊这篇
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })() : !items.length ? (
        <div className="dictation-empty">
          <h2>准备开始单句精听</h2>
          <p>提取音频字幕后，即可像刷单词一样逐句卡片精听。</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18 }}>
            <button className="primary" disabled={busy} onClick={() => void transcribe()}>
              {busy ? '正在识别字幕…' : '自动提取字幕'}
            </button>
            <button disabled={busy} onClick={() => importSubs().catch(failure)}>
              导入 SRT
            </button>
          </div>
        </div>
      ) : sentence ? (
        <div className="dict-stage">
          <div className={`dict-card ${cardCls}`}>
            {/* Card Header: Progress + Timestamp */}
            <div className="corpus-card-progress">
              <div className="corpus-card-bar">
                <i style={{ width: `${progressPct}%` }} />
              </div>
              <span>
                {String(index + 1).padStart(2, '0')} / {String(items.length).padStart(2, '0')} · {stamp(segStart)}
              </span>
            </div>

            {/* Single-Sentence Compact Waveform */}
            <div className="dict-wave-mini">
              <StudyWaveform id={original.id} start={segStart} end={segEnd} position={position} onSeek={detailPlay} detail />
            </div>

            {/* Centered Play Button */}
            <button
              type="button"
              className={`corpus-card-play ${playing ? 'playing' : ''}`}
              onClick={() => togglePlayback().catch(failure)}
              title="播放 / 暂停 (Tab 重播 · Option+P 播/停)"
              aria-label={playing ? '暂停本句' : '播放本句'}
            >
              {playing ? <IconPause size={22} /> : <IconVolume size={22} />}
            </button>

            {/* Hint / Status Line */}
            <div className="corpus-card-hint">
              {hint
                ? sentence.text
                    .split(/\s+/)
                    .map((w) => w[0] + '＿'.repeat(Math.max(1, w.length - 1)))
                    .join(' ')
                : inputStyle === 'word' && sentence.text.trim()
                  ? 'Space/Enter 跳下一空 · Backspace 返回 · Tab 重播 · Esc 看答案'
                  : 'Enter 提交批改 · Shift+Enter 换行 · Tab 重播 · Esc 看答案'}
            </div>

            {/* Clean Borderless Dictation Input: Sentence Textarea OR Word-Fill Slots */}
            {inputStyle === 'word' && sentence.text.trim() ? (() => {
              const targetWords = sentence.text.trim().split(/\s+/).filter(Boolean);
              const rawParts = sentence.answer.split(' ');
              const slots = targetWords.map((_, i) => rawParts[i] ?? '');
              return (
                <div className="word-fill-wrap">
                  {targetWords.map((tw, idx) => {
                    const cleanLen = tw.replace(/[^a-zA-Z0-9'-]/g, '').length;
                    return (
                      <input
                        key={idx}
                        ref={(el) => {
                          slotRefs.current[idx] = el;
                        }}
                        type="text"
                        className="word-fill-slot"
                        style={{ width: `${Math.min(18, Math.max(4, cleanLen + 1))}ch` }}
                        aria-label={`第 ${idx + 1} 个词`}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoComplete="off"
                        value={slots[idx]}
                        onChange={(e) => {
                          const rawVal = e.target.value;
                          const nextSlots = [...slots];
                          const pastedWords = rawVal.trim().split(/\s+/).filter(Boolean);
                          if (rawVal.includes(' ') && pastedWords.length > 1) {
                            for (let k = 0; k < pastedWords.length && idx + k < nextSlots.length; k++) {
                              nextSlots[idx + k] = pastedWords[k];
                            }
                            const targetFocus = Math.min(nextSlots.length - 1, idx + pastedWords.length - 1);
                            slotRefs.current[targetFocus]?.focus();
                          } else {
                            nextSlots[idx] = rawVal.replace(/\s+/g, '');
                          }
                          update({ answer: nextSlots.join(' '), submitted: false });
                        }}
                        onKeyDown={(e) => {
                          handleDictationKeySound(e);
                          if (e.key === ' ') {
                            e.preventDefault();
                            if (idx < slots.length - 1) {
                              slotRefs.current[idx + 1]?.focus();
                            }
                          } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                            e.preventDefault();
                            if (sentence.submitted && result?.correct && cursor < visible.length - 1) {
                              next(1);
                            } else if (idx < slots.length - 1 && !sentence.submitted) {
                              slotRefs.current[idx + 1]?.focus();
                            } else {
                              submit();
                            }
                          } else if (e.key === 'Backspace' && !slots[idx] && idx > 0) {
                            e.preventDefault();
                            slotRefs.current[idx - 1]?.focus();
                          } else if ((e.metaKey || e.ctrlKey) && e.code === 'Space') {
                            e.preventDefault();
                            play().catch(failure);
                          }
                        }}
                      />
                    );
                  })}
                </div>
              );
            })() : (
              <textarea
                ref={inputRef}
                className="dict-textarea"
                rows={1}
                aria-label="听写输入"
                spellCheck={false}
                placeholder="在这里输入你听到的这一句…"
                value={sentence.answer}
                onChange={(e) => update({ answer: e.target.value, submitted: false })}
                onKeyDown={(e) => {
                  handleDictationKeySound(e);
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault();
                    if (sentence.submitted && result?.correct && cursor < visible.length - 1) {
                      next(1);
                    } else {
                      submit();
                    }
                  } else if ((e.metaKey || e.ctrlKey) && e.code === 'Space') {
                    e.preventDefault();
                    play().catch(failure);
                  }
                }}
              />
            )}

            {/* Immediate Word-Level Diff & Clickable Mistakes -> Word Book */}
            {(sentence.revealed || sentence.submitted) && (
              <div className="dict-diff-wrap">
                {result ? (
                  <div className="dict-diff-tokens">
                    {result.edits.map((e, i) => {
                      if (e.kind === 'correct') {
                        return <span key={i} className="edit-token correct">{e.actual}</span>;
                      }
                      if (e.kind === 'wrong' || e.kind === 'missing') {
                        const targetWord = e.expected || '';
                        const added = !!addedMistakes[targetWord.toLowerCase()];
                        return (
                          <button
                            key={i}
                            type="button"
                            className={`dict-mistake-chip ${e.kind}${added ? ' added' : ''}`}
                            title={added ? '已加入「单词」错词本' : '点击加入「单词」错词本'}
                            onClick={() => {
                              if (!targetWord) return;
                              addMistakeToWordBook(targetWord, shortTitle);
                              setAddedMistakes((prev) => ({ ...prev, [targetWord.toLowerCase()]: true }));
                              setStatus(`已将「${targetWord}」加入「单词 → 错词本」`);
                            }}
                          >
                            {e.kind === 'missing' ? `漏:${targetWord}` : `${e.actual}→${targetWord}`}
                            {added ? ' ✓' : ' +'}
                          </button>
                        );
                      }
                      if (e.kind === 'extra') {
                        return <span key={i} className="edit-token extra">{e.actual}</span>;
                      }
                      return <span key={i} className="edit-token placeholder">{e.expected}</span>;
                    })}
                  </div>
                ) : null}
                <div className="dict-ref-sentence">
                  <span>{sentence.text}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title="收藏本句到「收藏词卡」"
                    aria-label="收藏本句"
                    onClick={favoriteSentence}
                  >
                    <IconBookmark size={14} />
                  </button>
                </div>
                {showTranslation && sentence.translation && (
                  <div className="dict-ref-translation">{sentence.translation}</div>
                )}
              </div>
            )}

            {/* Inline Reference Editor (when toggled from settings) */}
            {editing && (
              <div className="reference-editor" style={{ width: '100%' }}>
                <textarea aria-label="校正文本" value={reference} onChange={(e) => setReference(e.target.value)} />
                <input
                  type="text"
                  className="reference-translation-input"
                  aria-label="中文参考译文"
                  placeholder="中文参考译文（可选）"
                  value={editTranslation}
                  onChange={(e) => setEditTranslation(e.target.value)}
                />
                <label>起点 <input type="number" step="0.01" value={start} onChange={(e) => setStart(e.target.value)} /></label>
                <label>终点 <input type="number" step="0.01" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
                <button type="button" disabled={index >= items.length - 1} onClick={mergeNextSentence}>
                  合并下句
                </button>
                <button type="button" onClick={splitCurrentSentence}>
                  从当前位置拆分
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    const a = Number(start);
                    const b = Number(end);
                    if (!reference.trim() || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > project.duration) {
                      setError('文本不能为空且时间需在音频范围内');
                      return;
                    }
                    update({
                      text: reference.trim(),
                      translation: editTranslation.trim() || undefined,
                      start: a,
                      end: b,
                      submitted: false,
                      submittedAnswer: undefined,
                    });
                    setEditing(false);
                    setError('');
                  }}
                >
                  保存
                </button>
              </div>
            )}

            {/* Minimal Icon Navigation Bar */}
            <div className="corpus-card-nav">
              <button
                className="icon-btn"
                disabled={cursor <= 0}
                onClick={() => next(-1)}
                title="上一句 (Option+←)"
                aria-label="上一句"
              >
                <IconPrev size={16} />
              </button>
              <button
                className="icon-btn"
                onClick={() => play().catch(failure)}
                title="从头重播本句 (Tab)"
                aria-label="重播"
              >
                <IconReplay size={16} />
              </button>
              <button
                type="button"
                className="dict-slow-btn"
                onClick={() => void playSlow().catch(failure)}
                title="0.75× 慢速重听一遍（不改默认倍速）"
                aria-label="慢速重听一遍"
              >
                0.75×
              </button>
              <button
                className={`icon-btn${hint ? ' active' : ''}`}
                onClick={() => {
                  if (!hint) update({ assisted: true });
                  setHint((h) => !h);
                }}
                title="首字母提示"
                aria-label="首字母提示"
              >
                <IconBulb size={16} />
              </button>
              <button
                className={`icon-btn${sentence.revealed ? ' active' : ''}`}
                onClick={() => update({ revealed: !sentence.revealed, assisted: sentence.assisted || !sentence.revealed })}
                title="显示 / 隐藏答案 (Esc)"
                aria-label="显示答案"
              >
                <IconEye size={16} />
              </button>
              <button
                className="icon-btn primary"
                onClick={() => {
                  if (sentence.submitted && result?.correct && cursor < visible.length - 1) {
                    next(1);
                  } else {
                    submit();
                  }
                }}
                title={sentence.submitted && result?.correct ? '下一句 (Command)' : '提交批改 (Enter)'}
                aria-label="提交或下一句"
              >
                {sentence.submitted && result?.correct ? <IconNext size={16} /> : <IconCheck size={16} />}
              </button>
              {sentence.submitted && !result?.correct && cursor < visible.length - 1 && (
                <button
                  className="icon-btn"
                  onClick={() => next(1)}
                  title="跳过到下一句 (Command)"
                  aria-label="下一句"
                >
                  <IconNext size={16} />
                </button>
              )}
            </div>

            {/* Clean Sliding-Window Progress Dots */}
            <div className="corpus-dots" aria-label="句子进度">
              {items.slice(dotWindow.start, dotWindow.end).map((s, offset) => {
                const realIdx = dotWindow.start + offset;
                const r = s.submitted ? grade(s.text, gradedAnswer(s)) : null;
                const filled = s.answer.trim().length > 0;
                const stateCls = r ? (r.correct ? 'ok' : 'err') : filled ? 'filled' : '';
                const cls = ['corpus-dot', realIdx === index ? 'active' : '', stateCls].filter(Boolean).join(' ');
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={cls}
                    title={`第 ${realIdx + 1} 句`}
                    onClick={() => choose(realIdx, true)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
