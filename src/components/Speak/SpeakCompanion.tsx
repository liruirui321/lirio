import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import {
  IconBookmark,
  IconCheck,
  IconClipboard,
  IconClose,
  IconKeyboard,
  IconMic,
  IconPause,
  IconPlus,
  IconSend,
  IconSettings,
  IconShuffle,
  IconStop,
  IconTrash,
  IconUpload,
  IconVolume,
} from '../Icons';
import {
  PROVIDER_META,
  SPEAK_TOPICS,
  VadVoiceRecorder,
  addPhraseToWordModule,
  buildExaminerOpener,
  buildFullMockQueue,
  findLinkedPart3,
  generateCompanionReply,
  generateExaminerReply,
  generateSessionTakeaways,
  getTopWordMistakesForSpeak,
  loadSpeakState,
  mergeMemory,
  parseIeltsQuestionBank,
  pickAndReadQuestionFile,
  recordPracticedTopics,
  saveSpeakState,
  scoreShadowing,
  subscribeSpeakState,
  synthesizeSpeech,
  transcribeVoice,
  type IeltsDeck,
  type IeltsPart,
  type IeltsQuestionItem,
  type ShadowingResult,
  type SpeakConfig,
  type SpeakMode,
  type SpeakPersistedState,
  type SpeakSessionRecord,
  type SpeakTurn,
  type UserMemoryProfile,
} from '../../services/speakService';

type SpeakSubView = 'call' | 'review' | 'library' | 'history';
type CallPhase = 'idle' | 'ai_speaking' | 'part2_prep' | 'listening' | 'transcribing' | 'thinking';

export interface SpeakExternalContext {
  title: string;
  excerpt: string;
}

export function SpeakCompanion({
  externalContext = null,
  onClearExternalContext,
  onOpenGlobalSettings,
}: {
  externalContext?: SpeakExternalContext | null;
  onClearExternalContext?: () => void;
  onOpenGlobalSettings?: () => void;
}) {
  const [persisted, setPersisted] = useState<SpeakPersistedState>(() => loadSpeakState());
  const config = persisted.config;
  const memory = persisted.memory;
  const decks = persisted.decks;
  const activeDeck: IeltsDeck = useMemo(
    () => decks.find((d) => d.id === persisted.activeDeckId) || decks[0],
    [decks, persisted.activeDeckId],
  );

  const [subView, setSubView] = useState<SpeakSubView>('call');
  const [libraryTab, setLibraryTab] = useState<'decks' | 'memory'>('decks');
  const [speakMode, setSpeakMode] = useState<SpeakMode>('companion');
  const [topicId, setTopicId] = useState<string>(SPEAK_TOPICS[0].id);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>(() => activeDeck?.items[0]?.id || '');

  // Live voice call state
  const [callActive, setCallActive] = useState<boolean>(false);
  const [callPhase, setCallPhase] = useState<CallPhase>('idle');
  const [muted, setMuted] = useState<boolean>(false);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [heardVoice, setHeardVoice] = useState<boolean>(false);
  const [turns, setTurns] = useState<SpeakTurn[]>([]);
  const [showKeyboard, setShowKeyboard] = useState<boolean>(false);
  const [draftText, setDraftText] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [reviewing, setReviewing] = useState<boolean>(false);
  const [activeReview, setActiveReview] = useState<SpeakSessionRecord | null>(null);
  const [savedPhrases, setSavedPhrases] = useState<Record<string, boolean>>({});
  const [showTranscript, setShowTranscript] = useState<boolean>(false);

  // Part 2 Cue Card timers (60s prep, 120s talk)
  const [part2PrepLeft, setPart2PrepLeft] = useState<number>(60);
  const [part2TalkSec, setPart2TalkSec] = useState<number>(0);
  const [part2MonologueDone, setPart2MonologueDone] = useState<boolean>(false);

  // Full 3-part mock queue, pre-drawn combo & Takeaway shadowing state
  const [drawnSet, setDrawnSet] = useState<IeltsQuestionItem[]>(() =>
    buildFullMockQueue(activeDeck, { practicedTopics: persisted.practicedTopics }),
  );
  const [examLaunchMode, setExamLaunchMode] = useState<'full_mock' | 'single'>('full_mock');
  const [deckPartFilter, setDeckPartFilter] = useState<'all' | IeltsPart>('all');
  const [deckFreqFilter, setDeckFreqFilter] = useState<'all' | '超高频' | '高频'>('all');
  const [deckUnpracticedOnly, setDeckUnpracticedOnly] = useState<boolean>(false);
  const [deckSearch, setDeckSearch] = useState<string>('');
  const [mockQueue, setMockQueue] = useState<IeltsQuestionItem[]>([]);
  const [mockStep, setMockStep] = useState<number>(0);
  const [shadowingIdx, setShadowingIdx] = useState<number | null>(null);
  const [shadowingBusy, setShadowingBusy] = useState<boolean>(false);
  const [shadowResults, setShadowResults] = useState<Record<number, ShadowingResult>>({});

  // Deck upload & paste form
  const [pasteTitle, setPasteTitle] = useState<string>('');
  const [pasteRaw, setPasteRaw] = useState<string>('');
  const [showPasteBox, setShowPasteBox] = useState<boolean>(false);

  // Manual memory note input
  const [newMemoryNote, setNewMemoryNote] = useState<string>('');
  const [newMemoryField, setNewMemoryField] = useState<'aboutMe' | 'habits'>('aboutMe');

  const activeQuestion: IeltsQuestionItem = useMemo(
    () => activeDeck?.items.find((q) => q.id === selectedQuestionId) || activeDeck?.items[0],
    [activeDeck, selectedQuestionId],
  );

  useEffect(() => {
    return subscribeSpeakState((next) => setPersisted(next));
  }, []);

  // Keep selectedQuestionId & pre-drawn combo synced when deck changes
  const prevDeckIdRef = useRef<string>(activeDeck?.id || '');
  useEffect(() => {
    if (!activeDeck) return;
    if (prevDeckIdRef.current !== activeDeck.id && !callActiveRef.current) {
      prevDeckIdRef.current = activeDeck.id;
      const fresh = buildFullMockQueue(activeDeck, { practicedTopics: persisted.practicedTopics });
      setDrawnSet(fresh);
      setExamLaunchMode('full_mock');
      if (fresh[0]) {
        setSelectedQuestionId(fresh[0].id);
        return;
      }
    }
    if (!activeDeck.items.some((q) => q.id === selectedQuestionId)) {
      setSelectedQuestionId(activeDeck.items[0]?.id || '');
    }
  }, [activeDeck, selectedQuestionId, persisted.practicedTopics]);

  const callActiveRef = useRef<boolean>(false);
  const turnsRef = useRef<SpeakTurn[]>([]);
  const configRef = useRef<SpeakConfig>(config);
  const memoryRef = useRef<UserMemoryProfile>(memory);
  const speakModeRef = useRef<SpeakMode>(speakMode);
  const topicIdRef = useRef<string>(topicId);
  const questionRef = useRef<IeltsQuestionItem | undefined>(activeQuestion);
  const part2DoneRef = useRef<boolean>(part2MonologueDone);
  const mutedRef = useRef<boolean>(muted);
  const recorderRef = useRef<VadVoiceRecorder | null>(null);
  const shadowRecorderRef = useRef<VadVoiceRecorder | null>(null);
  const mockQueueRef = useRef<IeltsQuestionItem[]>([]);
  const mockStepRef = useRef<number>(0);
  const stageStartTurnIdxRef = useRef<number>(0);
  const part2MonologueRef = useRef<string>('');
  const handleNextMockStageRef = useRef<() => Promise<void>>(async () => {});
  const handleHangUpRef = useRef<() => Promise<void>>(async () => {});
  const externalContextRef = useRef<SpeakExternalContext | null>(externalContext);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playSeqRef = useRef<number>(0);
  const playResolveRef = useRef<(() => void) | null>(null);

  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { memoryRef.current = memory; }, [memory]);
  useEffect(() => { speakModeRef.current = speakMode; }, [speakMode]);
  useEffect(() => { topicIdRef.current = topicId; }, [topicId]);
  useEffect(() => { questionRef.current = activeQuestion; }, [activeQuestion]);
  useEffect(() => { part2DoneRef.current = part2MonologueDone; }, [part2MonologueDone]);
  useEffect(() => { mockQueueRef.current = mockQueue; }, [mockQueue]);
  useEffect(() => {
    externalContextRef.current = externalContext;
    if (externalContext && !callActiveRef.current) {
      setSpeakMode('companion');
      setSubView('call');
    }
  }, [externalContext]);
  useEffect(() => {
    mutedRef.current = muted;
    recorderRef.current?.setMuted(muted);
  }, [muted]);

  const updatePersisted = useCallback((updater: (prev: SpeakPersistedState) => SpeakPersistedState) => {
    setPersisted((prev) => {
      const next = updater(prev);
      saveSpeakState(next);
      return next;
    });
  }, []);

  // Silent auto-detect DeepSeek API key from local dsh credentials
  useEffect(() => {
    if (!persisted.config.providers.deepseek.apiKey) {
      invoke<string | null>('speak_auto_detect_deepseek')
        .then((key) => {
          if (key) {
            updatePersisted((prev) => ({
              ...prev,
              config: {
                ...prev.config,
                providers: {
                  ...prev.config.providers,
                  deepseek: { ...prev.config.providers.deepseek, apiKey: key },
                },
              },
            }));
          }
        })
        .catch(() => {});
    }
  }, []);

  const stopAudio = useCallback(() => {
    playSeqRef.current++;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    const pendingResolve = playResolveRef.current;
    playResolveRef.current = null;
    pendingResolve?.();
  }, []);

  const stopRecorder = useCallback(async () => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    setMicLevel(0);
    setHeardVoice(false);
    if (rec) await rec.cancel();
  }, []);

  const stopShadowRecorder = useCallback(async () => {
    const rec = shadowRecorderRef.current;
    shadowRecorderRef.current = null;
    setShadowingIdx(null);
    if (rec) await rec.cancel();
  }, []);

  useEffect(() => {
    return () => {
      callActiveRef.current = false;
      stopAudio();
      recorderRef.current?.cancel();
      shadowRecorderRef.current?.cancel();
    };
  }, [stopAudio]);

  useEffect(() => {
    if (subView !== 'review') {
      void stopShadowRecorder();
    }
  }, [subView, stopShadowRecorder]);

  // Pipelined sentence-by-sentence TTS for minimal first-byte latency
  const playTtsAndWait = useCallback(
    async (text: string): Promise<void> => {
      stopAudio();
      const seq = playSeqRef.current;
      const sentences = text
        .split(/(?<=[.!?。！？])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const chunks = sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
      if (!chunks.length) return;

      const accent = configRef.current.accent;
      let nextPromise: Promise<string> | null = synthesizeSpeech(chunks[0], accent);

      for (let i = 0; i < chunks.length; i++) {
        if (seq !== playSeqRef.current) return;
        const currentPromise = nextPromise!;
        nextPromise = i + 1 < chunks.length ? synthesizeSpeech(chunks[i + 1], accent) : null;

        let url: string;
        try {
          url = await currentPromise;
        } catch {
          continue;
        }
        if (seq !== playSeqRef.current) {
          URL.revokeObjectURL(url);
          return;
        }

        await new Promise<void>((resolve) => {
          const audio = new Audio(url);
          audio.volume = 1;
          audioRef.current = audio;
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            if (playResolveRef.current === done) playResolveRef.current = null;
            if (audioRef.current === audio) {
              audio.onended = null;
              audio.onerror = null;
              audioRef.current = null;
            }
            URL.revokeObjectURL(url);
            resolve();
          };
          playResolveRef.current = done;
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        });
      }
    },
    [stopAudio],
  );

  const beginListeningTurn = useCallback(async () => {
    if (!callActiveRef.current) return;
    await stopRecorder();
    setCallPhase('listening');
    setHeardVoice(false);
    setMicLevel(0);

    const isPart2Monologue =
      speakModeRef.current === 'examiner' &&
      questionRef.current?.part === 'part2' &&
      !part2DoneRef.current;

    const silenceMs = isPart2Monologue ? 4500 : configRef.current.silenceMs || 1800;

    const rec = new VadVoiceRecorder();
    rec.setMuted(mutedRef.current);
    recorderRef.current = rec;
    try {
      await rec.start({
        silenceMs,
        onLevel: (lvl) => setMicLevel(lvl),
        onSpeechDetected: () => setHeardVoice(true),
        onSpeechEnd: async (wav) => {
          if (!callActiveRef.current) return;
          recorderRef.current = null;
          setMicLevel(0);
          setHeardVoice(false);
          if (wav.length < 400) {
            beginListeningTurn();
            return;
          }
          setCallPhase('transcribing');
          try {
            const text = await transcribeVoice(wav);
            if (!callActiveRef.current) return;
            await processUserTurnInCall(text);
          } catch (e) {
            if (!callActiveRef.current) return;
            setStatusMsg(String(e));
            beginListeningTurn();
          }
        },
      });
    } catch (e) {
      setStatusMsg('无法访问麦克风，请检查系统权限：' + String(e));
      callActiveRef.current = false;
      setCallActive(false);
      setCallPhase('idle');
    }
  }, [stopRecorder]);

  const processUserTurnInCall = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) {
        if (callActiveRef.current) beginListeningTurn();
        return;
      }
      setStatusMsg('');
      const userTurn: SpeakTurn = {
        id: `u-${Date.now()}`,
        role: 'user',
        text: clean,
        timestamp: Date.now(),
      };
      const nextTurns = [...turnsRef.current, userTurn];
      turnsRef.current = nextTurns;
      setTurns(nextTurns);

      if (
        speakModeRef.current === 'examiner' &&
        questionRef.current?.part === 'part2' &&
        !part2DoneRef.current
      ) {
        part2MonologueRef.current = clean.slice(0, 600);
        part2DoneRef.current = true;
        setPart2MonologueDone(true);
      }

      setCallPhase('thinking');

      try {
        const extCtx = externalContextRef.current;
        const customGuide =
          speakModeRef.current === 'companion' && extCtx
            ? `The user just finished intensive listening on "${extCtx.title}". Transcript excerpt:\n${extCtx.excerpt}\nHave a warm, natural 2–3 minute spoken chat about ideas from this listening passage and encourage them to try reusing phrases they heard.`
            : undefined;
        const stageTurns = nextTurns.slice(stageStartTurnIdxRef.current);
        const hasNextPart =
          mockQueueRef.current.length > 0 && mockStepRef.current + 1 < mockQueueRef.current.length;
        const linkedPart2Topic = mockQueueRef.current.find((q) => q.part === 'part2')?.topic;
        const examinerRes =
          speakModeRef.current === 'examiner' && questionRef.current
            ? await generateExaminerReply(configRef.current, questionRef.current, stageTurns, {
                hasNextPart,
                linkedPart2Topic,
                part2UserExcerpt: part2MonologueRef.current || undefined,
              })
            : null;
        const reply = examinerRes
          ? examinerRes.text
          : await generateCompanionReply(
              configRef.current,
              topicIdRef.current,
              nextTurns,
              memoryRef.current,
              customGuide,
            );
        if (!callActiveRef.current) return;
        const aiTurn: SpeakTurn = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: reply,
          timestamp: Date.now(),
        };
        const afterAi = [...turnsRef.current, aiTurn];
        turnsRef.current = afterAi;
        setTurns(afterAi);

        setCallPhase('ai_speaking');
        await playTtsAndWait(reply);
        if (!callActiveRef.current) return;
        if (examinerRes?.action === 'next_part' && mockStepRef.current + 1 < mockQueueRef.current.length) {
          await handleNextMockStageRef.current();
        } else if (examinerRes?.action === 'end_test') {
          await handleHangUpRef.current();
        } else {
          beginListeningTurn();
        }
      } catch (e) {
        setStatusMsg(String(e));
        if (callActiveRef.current) {
          beginListeningTurn();
        } else {
          setCallPhase('idle');
        }
      }
    },
    [playTtsAndWait, beginListeningTurn],
  );

  // Part 2 60s prep countdown -> auto enter speaking listening mode
  useEffect(() => {
    if (!callActive || callPhase !== 'part2_prep') return;
    const timer = window.setInterval(() => {
      setPart2PrepLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          playTtsAndWait('Your one minute preparation time is up. Please begin speaking now.').then(() => {
            if (callActiveRef.current) beginListeningTurn();
          });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callActive, callPhase, playTtsAndWait, beginListeningTurn]);

  // Part 2 120s monologue elapsed timer (hard stop at 2:00 like official IELTS)
  useEffect(() => {
    const inPart2Talk =
      callActive &&
      callPhase === 'listening' &&
      speakMode === 'examiner' &&
      activeQuestion?.part === 'part2' &&
      !part2MonologueDone;
    if (!inPart2Talk) return;

    const timer = window.setInterval(() => {
      setPart2TalkSec((prev) => {
        const next = prev + 1;
        if (next >= 120 && recorderRef.current) {
          window.clearInterval(timer);
          const rec = recorderRef.current;
          recorderRef.current = null;
          setCallPhase('transcribing');
          rec.forceFinish().then(async (wav) => {
            if (!callActiveRef.current) return;
            if (wav.length >= 400) {
              try {
                const text = await transcribeVoice(wav);
                if (callActiveRef.current) await processUserTurnInCall(text);
              } catch (e) {
                setStatusMsg(String(e));
              }
            }
          });
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callActive, callPhase, speakMode, activeQuestion, part2MonologueDone, processUserTurnInCall]);

  // Start call (Companion or IELTS Examiner)
  const handleStartCall = useCallback(
    async (overrideMode?: SpeakMode, overrideQuestion?: IeltsQuestionItem, isMockContinuation?: boolean) => {
      const modeToUse = overrideMode || speakModeRef.current;
      const qToUse = overrideQuestion || questionRef.current;
      if (!isMockContinuation) {
        setMockQueue([]);
        mockQueueRef.current = [];
        setMockStep(0);
        mockStepRef.current = 0;
      }
      stageStartTurnIdxRef.current = 0;
      part2MonologueRef.current = '';
      setStatusMsg('');
      setPart2PrepLeft(60);
      setPart2TalkSec(0);
      setPart2MonologueDone(false);
      part2DoneRef.current = false;

      let opener = '';
      if (modeToUse === 'examiner' && qToUse) {
        const linkedP2 =
          qToUse.part === 'part3' ? mockQueueRef.current.find((q) => q.part === 'part2') : undefined;
        opener = buildExaminerOpener(qToUse, linkedP2);
      } else if (externalContextRef.current) {
        opener = `Hey! You just finished listening to ${externalContextRef.current.title}. What stood out to you the most?`;
      } else {
        const topic = SPEAK_TOPICS.find((t) => t.id === topicIdRef.current) || SPEAK_TOPICS[0];
        opener = topic.opener;
      }

      const openerTurn: SpeakTurn = {
        id: `opener-${Date.now()}`,
        role: 'assistant',
        text: opener,
        timestamp: Date.now(),
      };
      turnsRef.current = [openerTurn];
      setTurns([openerTurn]);
      setActiveReview(null);
      setShadowResults({});
      callActiveRef.current = true;
      setCallActive(true);
      setSubView('call');

      setCallPhase('ai_speaking');
      try {
        await playTtsAndWait(opener);
      } catch (e) {
        setStatusMsg('语音播报失败：' + String(e));
      }
      if (!callActiveRef.current) return;

      if (modeToUse === 'examiner' && qToUse?.part === 'part2') {
        setCallPhase('part2_prep');
      } else {
        beginListeningTurn();
      }
    },
    [playTtsAndWait, beginListeningTurn],
  );

  const handleStartFullMock = useCallback(
    (deck?: IeltsDeck, customQueue?: IeltsQuestionItem[]) => {
      const targetDeck = deck || activeDeck;
      let queue: IeltsQuestionItem[];
      if (customQueue && customQueue.length > 0) {
        queue = customQueue;
      } else if (
        !deck &&
        drawnSet.length >= 2 &&
        targetDeck?.items.length &&
        drawnSet.every((x) => targetDeck.items.some((it) => it.id === x.id))
      ) {
        queue = drawnSet;
      } else {
        queue = buildFullMockQueue(targetDeck, { practicedTopics: persisted.practicedTopics });
        if (queue.length && (!deck || deck.id === activeDeck?.id)) {
          setDrawnSet(queue);
        }
      }
      if (!queue.length) {
        setStatusMsg('当前题单暂无题目，请先导入题单。');
        return;
      }
      setSpeakMode('examiner');
      speakModeRef.current = 'examiner';
      setMockQueue(queue);
      mockQueueRef.current = queue;
      setMockStep(0);
      mockStepRef.current = 0;
      setSelectedQuestionId(queue[0].id);
      questionRef.current = queue[0];
      void handleStartCall('examiner', queue[0], true);
    },
    [activeDeck, drawnSet, handleStartCall],
  );

  const handleNextMockStage = useCallback(async () => {
    const nextIdx = mockStepRef.current + 1;
    const nextQ = mockQueueRef.current[nextIdx];
    if (!nextQ) return;
    stopAudio();
    await stopRecorder();
    if (!callActiveRef.current) return;

    setMockStep(nextIdx);
    mockStepRef.current = nextIdx;
    setSelectedQuestionId(nextQ.id);
    questionRef.current = nextQ;
    setPart2PrepLeft(60);
    setPart2TalkSec(0);
    setPart2MonologueDone(false);
    part2DoneRef.current = false;
    stageStartTurnIdxRef.current = turnsRef.current.length;

    const linkedP2 =
      nextQ.part === 'part3' ? mockQueueRef.current.find((q) => q.part === 'part2') : undefined;
    const opener = buildExaminerOpener(nextQ, linkedP2);
    const openerTurn: SpeakTurn = {
      id: `opener-${Date.now()}`,
      role: 'assistant',
      text: opener,
      timestamp: Date.now(),
    };
    const nextTurns = [...turnsRef.current, openerTurn];
    turnsRef.current = nextTurns;
    setTurns(nextTurns);

    setCallPhase('ai_speaking');
    try {
      await playTtsAndWait(opener);
    } catch (e) {
      setStatusMsg('语音播报失败：' + String(e));
    }
    if (!callActiveRef.current) return;

    if (nextQ.part === 'part2') {
      setCallPhase('part2_prep');
    } else {
      beginListeningTurn();
    }
  }, [stopAudio, stopRecorder, playTtsAndWait, beginListeningTurn]);

  useEffect(() => {
    handleNextMockStageRef.current = handleNextMockStage;
  }, [handleNextMockStage]);

  const handleToggleShadowing = useCallback(
    async (idx: number, targetText: string) => {
      if (shadowingBusy) return;
      if (shadowingIdx === idx && shadowRecorderRef.current) {
        const rec = shadowRecorderRef.current;
        shadowRecorderRef.current = null;
        setShadowingIdx(null);
        setShadowingBusy(true);
        try {
          const wav = await rec.forceFinish();
          if (wav.length >= 400) {
            const spoken = await transcribeVoice(wav);
            const scored = scoreShadowing(targetText, spoken);
            setShadowResults((prev) => ({ ...prev, [idx]: scored }));
          }
        } catch (e) {
          setStatusMsg('跟读识别失败：' + String(e));
        } finally {
          setShadowingBusy(false);
        }
        return;
      }

      await stopShadowRecorder();
      stopAudio();
      const rec = new VadVoiceRecorder();
      shadowRecorderRef.current = rec;
      setShadowingIdx(idx);
      try {
        await rec.start({
          silenceMs: 1800,
          onLevel: () => {},
          onSpeechEnd: async (wav) => {
            if (shadowRecorderRef.current === rec) {
              shadowRecorderRef.current = null;
            }
            setShadowingIdx(null);
            if (wav.length < 400) return;
            setShadowingBusy(true);
            try {
              const spoken = await transcribeVoice(wav);
              const scored = scoreShadowing(targetText, spoken);
              setShadowResults((prev) => ({ ...prev, [idx]: scored }));
            } catch (e) {
              setStatusMsg('跟读识别失败：' + String(e));
            } finally {
              setShadowingBusy(false);
            }
          },
        });
      } catch (e) {
        shadowRecorderRef.current = null;
        setShadowingIdx(null);
        setStatusMsg('麦克风启动失败：' + String(e));
      }
    },
    [shadowingIdx, shadowingBusy, stopShadowRecorder, stopAudio],
  );

  const handleSkipPart2Prep = useCallback(() => {
    if (callPhase !== 'part2_prep') return;
    stopAudio();
    beginListeningTurn();
  }, [callPhase, stopAudio, beginListeningTurn]);

  const handleOrbTap = useCallback(async () => {
    if (!callActiveRef.current) {
      if (speakModeRef.current === 'examiner') {
        if (examLaunchMode === 'full_mock' && drawnSet.length > 1) {
          handleStartFullMock(activeDeck, drawnSet);
          return;
        }
        if (examLaunchMode === 'single' && activeQuestion?.part === 'part2') {
          const linkedP3 = findLinkedPart3(activeDeck, activeQuestion);
          if (linkedP3) {
            handleStartFullMock(activeDeck, [activeQuestion, linkedP3]);
            return;
          }
        }
      }
      handleStartCall();
      return;
    }
    if (callPhase === 'part2_prep') {
      handleSkipPart2Prep();
      return;
    }
    if (callPhase === 'ai_speaking') {
      stopAudio();
      beginListeningTurn();
    } else if (callPhase === 'listening' && recorderRef.current) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      setMicLevel(0);
      setHeardVoice(false);
      setCallPhase('transcribing');
      try {
        const wav = await rec.forceFinish();
        if (!callActiveRef.current) return;
        if (wav.length < 400) {
          beginListeningTurn();
          return;
        }
        const text = await transcribeVoice(wav);
        if (!callActiveRef.current) return;
        await processUserTurnInCall(text);
      } catch (e) {
        setStatusMsg(String(e));
        if (callActiveRef.current) beginListeningTurn();
      }
    }
  }, [callPhase, examLaunchMode, drawnSet, activeDeck, activeQuestion, handleStartFullMock, handleStartCall, handleSkipPart2Prep, stopAudio, beginListeningTurn, processUserTurnInCall]);

  const handleHangUp = useCallback(async () => {
    const mockPartsLabel =
      mockQueueRef.current.length > 1
        ? mockQueueRef.current.map((q) => q.part.toUpperCase()).join(' · ')
        : '';
    const sessionTopicIds =
      mockQueueRef.current.length > 0
        ? mockQueueRef.current.map((q) => q.id)
        : speakModeRef.current === 'examiner' && questionRef.current
          ? [questionRef.current.id]
          : [];
    setMockQueue([]);
    mockQueueRef.current = [];
    setMockStep(0);
    mockStepRef.current = 0;
    callActiveRef.current = false;
    setCallActive(false);
    setCallPhase('idle');
    stopAudio();
    await stopRecorder();

    const currentTurns = turnsRef.current;
    const userCount = currentTurns.filter((t) => t.role === 'user').length;
    if (!userCount) return;

    setReviewing(true);
    const modeNow = speakModeRef.current;
    setStatusMsg(
      modeNow === 'examiner'
        ? '模考结束，考官正在生成 4 维度 Band 评分与逐题润色示范…'
        : '通话结束，正在提炼逐题地道改写并更新私人记忆档案…',
    );
    try {
      const { summary, takeaways, qaPolishes, memoryPatch, ieltsScore } = await generateSessionTakeaways(
        configRef.current,
        modeNow,
        currentTurns,
        memoryRef.current,
      );
      const topicTitle = mockPartsLabel
        ? `全真模考 (${mockPartsLabel})`
        : modeNow === 'examiner' && questionRef.current
          ? `${questionRef.current.part.toUpperCase()} · ${questionRef.current.topic}`
          : (SPEAK_TOPICS.find((t) => t.id === topicIdRef.current) || SPEAK_TOPICS[0]).title;

      const record: SpeakSessionRecord = {
        id: `sp-${Date.now()}`,
        mode: modeNow,
        topicId: modeNow === 'examiner' ? questionRef.current?.id || 'ielts' : topicIdRef.current,
        topicTitle,
        timestamp: Date.now(),
        turns: currentTurns,
        summary,
        takeaways,
        qaPolishes,
        ieltsScore,
      };
      updatePersisted((prev) => ({
        ...prev,
        memory: mergeMemory(prev.memory, memoryPatch),
        sessions: [record, ...prev.sessions].slice(0, 60),
        practicedTopics:
          sessionTopicIds.length > 0
            ? recordPracticedTopics(prev.practicedTopics, sessionTopicIds, ieltsScore?.overall)
            : prev.practicedTopics,
      }));
      setShowTranscript(false);
      setActiveReview(record);
      setStatusMsg('');
      setSubView('review');
    } catch (e) {
      setStatusMsg('复盘生成失败：' + String(e));
    } finally {
      setReviewing(false);
    }
  }, [stopAudio, stopRecorder, updatePersisted]);

  useEffect(() => {
    handleHangUpRef.current = handleHangUp;
  }, [handleHangUp]);

  const handleManualTextSend = useCallback(async () => {
    const clean = draftText.trim();
    if (!clean) return;
    setDraftText('');
    if (!callActiveRef.current) {
      callActiveRef.current = true;
      setCallActive(true);
    }
    stopAudio();
    await stopRecorder();
    await processUserTurnInCall(clean);
  }, [draftText, stopAudio, stopRecorder, processUserTurnInCall]);

  const handleUploadDeck = async () => {
    try {
      const file = await pickAndReadQuestionFile();
      if (!file) return;
      const items = parseIeltsQuestionBank(file.content);
      if (!items.length) {
        setStatusMsg('未能从文件中解析出题目，请检查格式。');
        return;
      }
      const newDeck: IeltsDeck = {
        id: `deck-${Date.now()}`,
        title: file.title,
        items,
        createdAt: Date.now(),
      };
      updatePersisted((prev) => ({
        ...prev,
        decks: [newDeck, ...prev.decks],
        activeDeckId: newDeck.id,
      }));
      setSelectedQuestionId(items[0].id);
      setSpeakMode('examiner');
      setStatusMsg(`已导入题单「${newDeck.title}」（共 ${items.length} 组题）`);
    } catch (e) {
      setStatusMsg('读取题单失败：' + String(e));
    }
  };

  const handleSavePastedDeck = () => {
    const items = parseIeltsQuestionBank(pasteRaw);
    if (!items.length) {
      setStatusMsg('未能识别有效题目，请按行粘贴 Part 1/2/3 问题。');
      return;
    }
    const newDeck: IeltsDeck = {
      id: `deck-${Date.now()}`,
      title: pasteTitle.trim() || `自定义题单 (${items.length}组)`,
      items,
      createdAt: Date.now(),
    };
    updatePersisted((prev) => ({
      ...prev,
      decks: [newDeck, ...prev.decks],
      activeDeckId: newDeck.id,
    }));
    setSelectedQuestionId(items[0].id);
    setSpeakMode('examiner');
    setPasteTitle('');
    setPasteRaw('');
    setShowPasteBox(false);
    setStatusMsg(`已保存题单「${newDeck.title}」（共 ${items.length} 组题）`);
  };

  const handleDrawRandomMockSet = () => {
    if (!activeDeck?.items.length) return;
    const prevP1 = drawnSet.find((q) => q.part === 'part1');
    const prevP2 = drawnSet.find((q) => q.part === 'part2');
    const nextSet = buildFullMockQueue(activeDeck, {
      excludePart1Id: prevP1?.id,
      excludePart2Id: prevP2?.id,
      practicedTopics: persisted.practicedTopics,
    });
    setDrawnSet(nextSet);
    setExamLaunchMode('full_mock');
    if (nextSet[0]) {
      setSelectedQuestionId(nextSet[0].id);
    }
  };

  const topicOptions: SelectOption[] = useMemo(
    () => SPEAK_TOPICS.map((t) => ({ value: t.id, label: t.title })),
    [],
  );

  const deckOptions: SelectOption[] = useMemo(
    () => decks.map((d) => ({ value: d.id, label: d.title, meta: `${d.items.length}组` })),
    [decks],
  );

  const questionOptions: SelectOption[] = useMemo(
    () =>
      (activeDeck?.items || []).map((q) => ({
        value: q.id,
        label: q.topicZh ? `${q.topic}（${q.topicZh}）` : q.topic,
        meta: q.part.toUpperCase(),
      })),
    [activeDeck],
  );

  const lastAiTurn = useMemo(
    () => [...turns].reverse().find((t) => t.role === 'assistant') || null,
    [turns],
  );
  const lastUserTurn = useMemo(
    () => [...turns].reverse().find((t) => t.role === 'user') || null,
    [turns],
  );

  const memoryCount =
    memory.aboutMe.length +
    memory.habits.length +
    memory.recurringTopics.length +
    memory.targetPhrases.length;

  const activeProviderLabel =
    PROVIDER_META.find((p) => p.id === config.activeProvider)?.label || config.activeProvider;

  const phaseLabel =
    callPhase === 'ai_speaking'
      ? speakMode === 'examiner'
        ? '考官提问中…'
        : '正在说话…'
      : callPhase === 'part2_prep'
        ? `Cue Card 准备中 · ${part2PrepLeft}s（点光球提前开讲）`
        : callPhase === 'listening'
          ? muted
            ? '麦克风已静音'
            : speakMode === 'examiner' && activeQuestion?.part === 'part2' && !part2MonologueDone
              ? `Part 2 作答中 · ${Math.floor(part2TalkSec / 60)}:${String(part2TalkSec % 60).padStart(2, '0')} / 2:00`
              : heardVoice
                ? '正在聆听…'
                : speakMode === 'examiner'
                  ? '请作答…'
                  : '请开口，卡壳可中英混说'
          : callPhase === 'transcribing'
            ? '正在识别…'
            : callPhase === 'thinking'
              ? '思考中…'
              : speakMode === 'examiner'
                ? '点击光球，开始雅思口语模考'
                : '点击光球，拨通双语语音通话';

  const orbScale = callPhase === 'listening' ? 1 + micLevel * 0.25 : 1;

  return (
    <div className="speak-workspace">
      {/* Minimal Single-Row Floating Header */}
      <div className="speak-topbar">
        <div className="seg-pill" role="tablist" aria-label="对话模式">
          <button
            type="button"
            className={speakMode === 'companion' ? 'active' : ''}
            disabled={callActive}
            onClick={() => {
              setSpeakMode('companion');
              setSubView('call');
            }}
          >
            双语闲聊
          </button>
          <button
            type="button"
            className={speakMode === 'examiner' ? 'active' : ''}
            disabled={callActive}
            onClick={() => {
              setSpeakMode('examiner');
              setSubView('call');
            }}
          >
            雅思考官
          </button>
        </div>

        {subView === 'call' && (
          <div className="speak-context-pills">
            {speakMode === 'companion' ? (
              <>
                <CustomSelect
                  value={topicId}
                  options={topicOptions}
                  disabled={callActive}
                  minWidth={104}
                  onChange={(v) => setTopicId(v)}
                />
                {externalContext && (
                  <span className="speak-context-chip" title={`围绕「${externalContext.title}」展开对话`}>
                    <span>刚听完：{externalContext.title}</span>
                    {!callActive && onClearExternalContext && (
                      <button
                        type="button"
                        aria-label="清除听力上下文"
                        onClick={onClearExternalContext}
                      >
                        <IconClose size={12} />
                      </button>
                    )}
                  </span>
                )}
              </>
            ) : (
              <>
                <CustomSelect
                  value={activeDeck?.id || ''}
                  options={deckOptions}
                  disabled={callActive}
                  minWidth={150}
                  menuWidth={260}
                  onChange={(v) => updatePersisted((prev) => ({ ...prev, activeDeckId: v }))}
                />
                <CustomSelect
                  value={activeQuestion?.id || ''}
                  options={questionOptions}
                  disabled={callActive}
                  minWidth={165}
                  menuWidth={300}
                  onChange={(v) => {
                    setSelectedQuestionId(v);
                    setExamLaunchMode('single');
                  }}
                />
                <button
                  type="button"
                  className="icon-btn"
                  disabled={callActive}
                  title="随机抽一套（Part 1 + Part 2 & 3 联动）"
                  aria-label="随机抽题"
                  onClick={handleDrawRandomMockSet}
                >
                  <IconShuffle size={15} />
                </button>
                <button
                  type="button"
                  className="mock-start-btn"
                  disabled={callActive || !activeDeck?.items.length}
                  title="按当前抽取组合开启 Part 1 → Part 2 → Part 3 全真连考"
                  onClick={() => handleStartFullMock(activeDeck, drawnSet)}
                >
                  全真连考
                </button>
              </>
            )}
          </div>
        )}

        <div className="speak-top-actions">
          <button
            type="button"
            className={`icon-btn${subView === 'library' ? ' active' : ''}`}
            title="雅思题单与个人记忆"
            aria-label="题单与记忆"
            disabled={callActive}
            onClick={() => setSubView((v) => (v === 'library' ? 'call' : 'library'))}
          >
            <IconClipboard size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn${subView === 'history' || subView === 'review' ? ' active' : ''}`}
            title="复盘与模考记录"
            aria-label="复盘记录"
            disabled={callActive}
            onClick={() => setSubView((v) => (v === 'history' ? 'call' : 'history'))}
          >
            <IconBookmark size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={`全局 AI 与语音设置（${activeProviderLabel}）`}
            aria-label="设置"
            disabled={callActive}
            onClick={() => onOpenGlobalSettings?.()}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </div>

      {(statusMsg || reviewing) && (
        <div className="corpus-banner" onClick={() => setStatusMsg('')}>
          {statusMsg || '正在复盘…'}
        </div>
      )}

      {/* VIEW 1: Minimalist Fluid Orb Call Stage */}
      {subView === 'call' && (
        <div className="speak-call-stage">
          {/* Pre-Exam Random Drawn Combo Ticket (Part 1 + Linked Part 2 & 3) */}
          {!callActive && speakMode === 'examiner' && examLaunchMode === 'full_mock' && drawnSet.length > 0 && (
            <div className="exam-ticket-card">
              <div className="exam-ticket-head">
                <span className="exam-ticket-title">
                  本场抽题组合（点击光球或「全真连考」逐部分开考）
                </span>
                <button
                  type="button"
                  className="exam-ticket-refresh"
                  onClick={handleDrawRandomMockSet}
                  title="重新随机抽取 Part 1 与联动 Part 2/3"
                >
                  <IconShuffle size={12} />
                  <span>随机换一套</span>
                </button>
              </div>
              <div className="exam-ticket-rows">
                {drawnSet.map((q) => (
                  <div key={q.id} className="exam-ticket-row">
                    <span className={q.part === 'part3' ? 'exam-part-tag linked' : 'exam-part-tag'}>
                      {q.part === 'part3' ? 'PART 3 · 联动' : q.part.toUpperCase()}
                    </span>
                    <span className="exam-ticket-topic" title={q.topic}>
                      {q.topic}
                      {q.topicZh && <small>（{q.topicZh}）</small>}
                    </span>
                    <span className="exam-ticket-meta">
                      {q.part === 'part2' ? '1–2 min 陈述' : `${q.prompts.length} 问`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Part 2 Cue Card Floating Glass Card (Only in Examiner Part 2) */}
          {speakMode === 'examiner' && activeQuestion?.part === 'part2' && (callActive || examLaunchMode === 'single') && (
            <div className="cue-card-float">
              <div className="cue-card-badge">PART 2 · CUE CARD</div>
              <h3>{activeQuestion.topic}</h3>
              <ul>
                {activeQuestion.prompts.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Centered Fluid Organic Orb */}
          <div className="fluid-orb-stage">
            <button
              type="button"
              className={`fluid-orb-wrap ${callPhase}`}
              style={{ transform: `scale(${orbScale.toFixed(3)})` }}
              disabled={reviewing || callPhase === 'transcribing' || callPhase === 'thinking'}
              onClick={handleOrbTap}
              title={phaseLabel}
              aria-label={phaseLabel}
            >
              <span className="fluid-orb-halo" />
              <span className="fluid-orb" />
            </button>

            <div className="speak-orb-status">{phaseLabel}</div>
            {callActive && speakMode === 'examiner' && mockQueue.length > 1 && (
              <div className="exam-stage-steps" aria-label="模考进度">
                {mockQueue.map((q, idx) => (
                  <span
                    key={q.id}
                    className={`exam-stage-step${idx === mockStep ? ' active' : idx < mockStep ? ' done' : ''}`}
                  >
                    {q.part.toUpperCase()}
                    {q.topicZh ? ` · ${q.topicZh}` : ''}
                  </span>
                ))}
              </div>
            )}
            {callActive && speakMode === 'examiner' && mockStep + 1 < mockQueue.length && (
              <button
                type="button"
                className="mock-next-pill"
                disabled={reviewing}
                onClick={() => void handleNextMockStage()}
              >
                提前进入下一部分 ({mockQueue[mockStep + 1].part.toUpperCase()})
              </button>
            )}
            {!callActive && (
              <div className="speak-orb-engine">
                {activeProviderLabel}
                {speakMode === 'companion' && memoryCount > 0 ? ` · ${memoryCount} 条记忆` : ''}
                {speakMode === 'examiner'
                  ? examLaunchMode === 'full_mock' && drawnSet.length > 1
                    ? ` · 全真连考 (${drawnSet.map((q) => q.part.toUpperCase()).join(' → ')})`
                    : activeQuestion
                      ? ` · ${activeQuestion.part.toUpperCase()}${activeQuestion.part === 'part2' && findLinkedPart3(activeDeck, activeQuestion) ? ' + 联动 PART 3' : ''}`
                      : ''
                  : ''}
              </div>
            )}
          </div>

          {/* Cinematic Dissolving Captions (Last Turn Only, No Chat Boxes) */}
          {config.showLiveSubtitles && (lastAiTurn || lastUserTurn) && (
            <div className="cinematic-captions">
              {lastAiTurn && <p className="cap-ai">{lastAiTurn.text}</p>}
              {lastUserTurn && <p className="cap-user">{lastUserTurn.text}</p>}
            </div>
          )}

          {/* Expandable Quiet Text Fallback */}
          {showKeyboard && (
            <div className="speak-text-row">
              <div className="speak-text-fallback">
                <input
                  type="text"
                  autoFocus
                  value={draftText}
                  disabled={reviewing || callPhase === 'transcribing' || callPhase === 'thinking'}
                  placeholder="输入文本回答（支持中英混说，Enter 发送）…"
                  onChange={(e) => setDraftText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleManualTextSend();
                    }
                  }}
                />
                <button
                  className="icon-btn primary"
                  disabled={!draftText.trim() || reviewing}
                  title="发送"
                  aria-label="发送"
                  onClick={handleManualTextSend}
                >
                  <IconSend size={15} />
                </button>
              </div>
            </div>
          )}

          {/* Minimal Floating Bottom Dock (Only 3 Circular Icons during Call) */}
          <div className="speak-bottom-dock">
            {callActive && (
              <button
                type="button"
                className={`dock-circle${muted ? ' active' : ''}`}
                title={muted ? '取消静音' : '静音'}
                aria-label="静音"
                onClick={() => setMuted((m) => !m)}
              >
                {muted ? <IconPause size={17} /> : <IconMic size={17} />}
              </button>
            )}

            <button
              type="button"
              className={`dock-circle${showKeyboard ? ' active' : ''}`}
              title="切换键盘输入"
              aria-label="键盘输入"
              onClick={() => setShowKeyboard((k) => !k)}
            >
              <IconKeyboard size={17} />
            </button>

            {callActive && (
              <button
                type="button"
                className="dock-circle danger"
                title="结束通话并生成复盘"
                aria-label="挂断"
                onClick={handleHangUp}
              >
                <IconStop size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* VIEW 2: Post-Call Review (Official IELTS 4-Band Card + Takeaways) */}
      {subView === 'review' && activeReview && (
        <div className="corpus-panel speak-review">
          <div className="speak-review-head">
            <div>
              <h2>{activeReview.topicTitle}</h2>
              <p>{activeReview.summary}</p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setSubView('call')}>返回</button>
              <button
                className="primary"
                onClick={() => {
                  setSubView('call');
                  handleStartCall(activeReview.mode);
                }}
              >
                再来一次
              </button>
            </div>
          </div>

          {activeReview.ieltsScore && (
            <div className="ielts-score-card">
              <div className="ielts-overall">
                <span>PRELIMINARY BAND</span>
                <strong>{activeReview.ieltsScore.overall}</strong>
              </div>
              <div className="ielts-criteria-grid">
                {(
                  [
                    ['Fluency & Coherence', activeReview.ieltsScore.fluency],
                    ['Lexical Resource', activeReview.ieltsScore.lexical],
                    ['Grammatical Range', activeReview.ieltsScore.grammar],
                    ['Pronunciation & Flow', activeReview.ieltsScore.pronunciation],
                  ] as const
                ).map(([label, item]) => (
                  <div key={label} className="ielts-criterion">
                    <div className="ielts-criterion-top">
                      <span>{label}</span>
                      <strong>{item.band}</strong>
                    </div>
                    <small>{item.note}</small>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeReview.qaPolishes && activeReview.qaPolishes.length > 0 && (
            <div className="qa-polish-section">
              <div className="speak-subhead" style={{ marginBottom: 8 }}>
                <h3>逐题润色示范（{activeReview.qaPolishes.length} 题 · 保留你的原意升档）</h3>
              </div>
              <div className="qa-polish-grid">
                {activeReview.qaPolishes.map((qp, idx) => (
                  <div key={idx} className="qa-polish-card">
                    <div className="qa-polish-q">
                      <span className="tier-badge small">Q{idx + 1}</span>
                      <strong>{qp.question}</strong>
                      <button
                        type="button"
                        className="icon-btn"
                        title="试听润色示范"
                        aria-label="试听润色示范"
                        onClick={() => playTtsAndWait(qp.polished)}
                      >
                        <IconVolume size={14} />
                      </button>
                    </div>
                    {qp.userSaid && <p className="qa-polish-user">原答：{qp.userSaid}</p>}
                    <p className="qa-polish-best">{qp.polished}</p>
                    {qp.tip && <small className="qa-polish-tip">{qp.tip}</small>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeReview.takeaways.length === 0 ? (
            <div className="corpus-empty">本次未提炼出需要升级的表达。</div>
          ) : (
            <div className="takeaway-list">
              {activeReview.takeaways.map((tk, idx) => {
                const added = !!savedPhrases[tk.phrase];
                const isShadowing = shadowingIdx === idx;
                const shadowRes = shadowResults[idx];
                return (
                  <div key={idx} className="takeaway-card">
                    <div className="takeaway-row">
                      <span className="takeaway-tag muted">你当时说</span>
                      <p className="takeaway-said">{tk.said}</p>
                    </div>
                    <div className="takeaway-row">
                      <span className="takeaway-tag accent">更地道</span>
                      <p className="takeaway-native">{tk.native}</p>
                      <button
                        className="icon-btn"
                        title="试听发音"
                        aria-label="试听"
                        onClick={() => playTtsAndWait(tk.native)}
                      >
                        <IconVolume size={14} />
                      </button>
                      <button
                        className={`icon-btn${isShadowing ? ' active' : ''}`}
                        disabled={shadowingBusy && !isShadowing}
                        title={isShadowing ? '停止跟读打分' : '开口跟读复述打分'}
                        aria-label={isShadowing ? '停止跟读' : '跟读'}
                        onClick={() => void handleToggleShadowing(idx, tk.native)}
                      >
                        {isShadowing ? <IconStop size={14} /> : <IconMic size={14} />}
                      </button>
                    </div>
                    {shadowRes && (
                      <div className="shadowing-feedback">
                        <strong>跟读准确度 {shadowRes.accuracy}%</strong>
                        {shadowRes.spoken && <small>识别：{shadowRes.spoken}</small>}
                        {shadowRes.missingWords.length > 0 && (
                          <span className="shadowing-missing">漏读：{shadowRes.missingWords.join(', ')}</span>
                        )}
                      </div>
                    )}
                    <div className="takeaway-foot">
                      <div className="takeaway-phrase">
                        <strong>{tk.phrase}</strong>
                        {tk.zh && <span>{tk.zh}</span>}
                        {tk.why && <small>{tk.why}</small>}
                      </div>
                      <button
                        className={`icon-btn${added ? ' active' : ''}`}
                        title={added ? '已加入「单词」模块' : '加入「单词」模块听写'}
                        aria-label="加入单词库"
                        onClick={() => {
                          addPhraseToWordModule(tk.phrase, tk.zh || tk.why);
                          setSavedPhrases((prev) => ({ ...prev, [tk.phrase]: true }));
                          setStatusMsg(`已将「${tk.phrase}」加入「单词 → 口语地道表达库」`);
                        }}
                      >
                        {added ? <IconCheck size={15} /> : <IconPlus size={15} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeReview.turns && activeReview.turns.length > 0 && (
            <div className="qa-transcript-wrap">
              <button
                type="button"
                className="qa-transcript-toggle"
                onClick={() => setShowTranscript((v) => !v)}
              >
                {showTranscript
                  ? `收起本场完整对话原文 (${activeReview.turns.length} 轮)`
                  : `展开本场完整对话原文 (${activeReview.turns.length} 轮 · 支持划词翻译收录)`}
              </button>
              {showTranscript && (
                <div className="qa-transcript-list">
                  {activeReview.turns.map((t) => (
                    <div key={t.id} className={`qa-turn-row ${t.role}`}>
                      <span className="qa-turn-role">
                        {t.role === 'user' ? '你' : activeReview.mode === 'examiner' ? '考官' : '语伴'}
                      </span>
                      <p>{t.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* VIEW 3: IELTS Question Decks & Personal Memory */}
      {subView === 'library' && (
        <div className="corpus-panel speak-memory">
          <div className="speak-subhead">
            <div className="seg-pill">
              <button
                type="button"
                className={libraryTab === 'decks' ? 'active' : ''}
                onClick={() => setLibraryTab('decks')}
              >
                雅思题单 ({decks.length})
              </button>
              <button
                type="button"
                className={libraryTab === 'memory' ? 'active' : ''}
                onClick={() => setLibraryTab('memory')}
              >
                我的记忆 ({memoryCount})
              </button>
            </div>
            <button className="icon-btn" title="返回通话" aria-label="返回" onClick={() => setSubView('call')}>
              <IconClose size={15} />
            </button>
          </div>

          {libraryTab === 'decks' && (
            <>
              <div className="deck-actions-bar">
                <CustomSelect
                  value={activeDeck?.id || ''}
                  options={deckOptions}
                  minWidth={200}
                  menuWidth={280}
                  onChange={(v) => updatePersisted((prev) => ({ ...prev, activeDeckId: v }))}
                />
                <button type="button" className="primary" onClick={handleUploadDeck}>
                  <IconUpload size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  上传本地题单
                </button>
                <button type="button" onClick={() => setShowPasteBox((s) => !s)}>
                  {showPasteBox ? '收起粘贴框' : '粘贴文本导入'}
                </button>
                <button
                  type="button"
                  disabled={!activeDeck?.items.length}
                  onClick={() => {
                    const fresh = buildFullMockQueue(activeDeck, {
                      practicedTopics: persisted.practicedTopics,
                    });
                    handleStartFullMock(activeDeck, fresh);
                  }}
                >
                  随机全真连考
                </button>
              </div>

              <div className="deck-filter-bar">
                <div className="seg-pill" role="tablist" aria-label="按题型筛选">
                  {(
                    [
                      ['all', '全部'],
                      ['part1', 'Part 1'],
                      ['part2', 'Part 2'],
                      ['part3', 'Part 3'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={deckPartFilter === val ? 'active' : ''}
                      onClick={() => setDeckPartFilter(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="seg-pill" role="tablist" aria-label="按考频筛选">
                  {(
                    [
                      ['all', '全频次'],
                      ['超高频', '超高频'],
                      ['高频', '高频'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={deckFreqFilter === val ? 'active' : ''}
                      onClick={() => setDeckFreqFilter(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="deck-unpracticed-check">
                  <input
                    type="checkbox"
                    checked={deckUnpracticedOnly}
                    onChange={(e) => setDeckUnpracticedOnly(e.target.checked)}
                  />
                  仅看未练
                </label>
                <input
                  type="text"
                  className="deck-search-input"
                  value={deckSearch}
                  placeholder="搜索中英文话题或题目关键词…"
                  onChange={(e) => setDeckSearch(e.target.value)}
                />
              </div>

              {showPasteBox && (
                <div className="deck-paste-box">
                  <input
                    type="text"
                    placeholder="题单名称（例如：2026年9月口语新题）"
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                  />
                  <textarea
                    rows={8}
                    placeholder={'支持直接粘贴 Part 1 / Part 2 / Part 3 题单，例如：\nPart 1\n## Hometown\nWhere is your hometown?\nWhat do you like most about it?\n\nPart 2\nDescribe a book you enjoyed reading\n- What it was about\n- Why you read it'}
                    value={pasteRaw}
                    onChange={(e) => setPasteRaw(e.target.value)}
                  />
                  <button type="button" className="primary" onClick={handleSavePastedDeck}>
                    解析并保存题单
                  </button>
                </div>
              )}

              <div className="deck-items-list">
                {(activeDeck?.items || [])
                  .filter((item) => {
                    if (deckPartFilter !== 'all' && item.part !== deckPartFilter) return false;
                    if (deckFreqFilter !== 'all' && item.frequency !== deckFreqFilter) return false;
                    if (deckUnpracticedOnly && (persisted.practicedTopics?.[item.id]?.count || 0) > 0) {
                      return false;
                    }
                    const q = deckSearch.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      item.topic.toLowerCase().includes(q) ||
                      (item.topicZh || '').toLowerCase().includes(q) ||
                      item.prompts.some((p) => p.toLowerCase().includes(q)) ||
                      (item.promptsZh || []).some((p) => p.toLowerCase().includes(q))
                    );
                  })
                  .map((item) => {
                    const catLabel =
                      item.category === 'new'
                        ? '当季新题'
                        : item.category === 'core'
                          ? '必考题'
                          : item.category === 'overseas'
                            ? '海外加考'
                            : item.category === 'retained'
                              ? '保留题'
                              : '';
                    const linkedP3 = item.part === 'part2' ? findLinkedPart3(activeDeck, item) : undefined;
                    const practiceStat = persisted.practicedTopics?.[item.id];
                    return (
                      <div key={item.id} className="deck-item-card">
                        <div className="deck-item-head">
                          <span className="tier-badge small">{item.part.toUpperCase()}</span>
                          <div className="deck-item-title-col">
                            <strong>{item.topic}</strong>
                            {item.topicZh && <span className="deck-item-zh">{item.topicZh}</span>}
                          </div>
                          {practiceStat && practiceStat.count > 0 && (
                            <span className="deck-meta-tag practiced">已练 {practiceStat.count} 次</span>
                          )}
                          {catLabel && (
                            <span className={`deck-meta-tag ${item.category || ''}`}>{catLabel}</span>
                          )}
                          {item.frequency && <span className="deck-meta-tag">{item.frequency}</span>}
                          <button
                            type="button"
                            className="primary"
                            title={linkedP3 ? '开始 Part 2 + 联动 Part 3 连考' : '开始本话题模考'}
                            onClick={() => {
                              setSpeakMode('examiner');
                              if (item.part === 'part2' && linkedP3) {
                                handleStartFullMock(activeDeck, [item, linkedP3]);
                              } else {
                                setExamLaunchMode('single');
                                setSelectedQuestionId(item.id);
                                handleStartCall('examiner', item);
                              }
                            }}
                          >
                            {linkedP3 ? 'Part 2+3 连考' : '开考'}
                          </button>
                        </div>
                        <ul className="deck-item-prompts">
                          {item.prompts.map((p, idx) => (
                            <li key={idx}>
                              <span>{p}</span>
                              {item.promptsZh?.[idx] && (
                                <span className="deck-prompt-zh">{item.promptsZh[idx]}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
              </div>
            </>
          )}

          {libraryTab === 'memory' && (
            <>
              <div className="memory-add-bar">
                <CustomSelect
                  value={newMemoryField}
                  options={[
                    { value: 'aboutMe', label: '关于我 / 目标' },
                    { value: 'habits', label: '表达习惯 / 卡壳点' },
                  ]}
                  minWidth={150}
                  onChange={(v) => setNewMemoryField(v as 'aboutMe' | 'habits')}
                />
                <input
                  type="text"
                  value={newMemoryNote}
                  placeholder="补充一条记忆（如：正在准备博士申请 / 容易漏掉过去式）…"
                  onChange={(e) => setNewMemoryNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newMemoryNote.trim()) {
                      updatePersisted((prev) => ({
                        ...prev,
                        memory: mergeMemory(prev.memory, { [newMemoryField]: [newMemoryNote.trim()] }),
                      }));
                      setNewMemoryNote('');
                    }
                  }}
                />
                <button
                  className="icon-btn primary"
                  disabled={!newMemoryNote.trim()}
                  title="添加"
                  aria-label="添加记忆"
                  onClick={() => {
                    if (!newMemoryNote.trim()) return;
                    updatePersisted((prev) => ({
                      ...prev,
                      memory: mergeMemory(prev.memory, { [newMemoryField]: [newMemoryNote.trim()] }),
                    }));
                    setNewMemoryNote('');
                  }}
                >
                  <IconPlus size={15} />
                </button>
              </div>

              <div className="memory-grid">
                {(
                  [
                    ['aboutMe', '关于我与目标', memory.aboutMe],
                    ['habits', '表达习惯与高频卡壳点', memory.habits],
                    ['recurringTopics', '近期话题', memory.recurringTopics],
                    ['targetPhrases', '待巩固表达', memory.targetPhrases],
                  ] as const
                ).map(([field, title, list]) => (
                  <div key={field} className="memory-section">
                    <h4>
                      <span>{title}</span>
                      <small>{list.length}</small>
                    </h4>
                    {list.length === 0 ? (
                      <div className="memory-empty">聊完一通电话后会自动沉淀在这里。</div>
                    ) : (
                      <div className="memory-tags">
                        {list.map((item) => (
                          <span key={item} className="memory-tag">
                            <span>{item}</span>
                            <button
                              type="button"
                              onClick={() =>
                                updatePersisted((prev) => ({
                                  ...prev,
                                  memory: {
                                    ...prev.memory,
                                    [field]: prev.memory[field].filter((x) => x !== item),
                                  },
                                }))
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {(() => {
                  const wordMistakes = getTopWordMistakesForSpeak(8);
                  return (
                    <div className="memory-section memory-section-wide">
                      <h4>
                        <span>单词本高频易错词（只读同步 · 对话时自然带练）</span>
                        <small>{wordMistakes.length}</small>
                      </h4>
                      {wordMistakes.length === 0 ? (
                        <div className="memory-empty">单词听写中拼错的词会自动同步到这里，陪练会在闲聊时自然带你用起来。</div>
                      ) : (
                        <div className="memory-tags">
                          {wordMistakes.map((m) => (
                            <span
                              key={m.w}
                              className="memory-tag readonly"
                              title={m.t ? `${m.t}（错 ${m.count} 次）` : `错 ${m.count} 次`}
                            >
                              <span>{m.w}</span>
                              <small className="memory-tag-count">×{m.count}</small>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      )}

      {/* VIEW 4: Session History */}
      {subView === 'history' && (
        <div className="corpus-panel speak-memory">
          <div className="speak-subhead">
            <h3>通话与模考记录</h3>
            <button className="icon-btn" title="返回" aria-label="返回" onClick={() => setSubView('call')}>
              <IconClose size={15} />
            </button>
          </div>
          {!persisted.sessions.length ? (
            <div className="corpus-empty">还没有记录。结束一通对话或模考后会自动沉淀在这里。</div>
          ) : (
            <div className="speak-history-list">
              {persisted.sessions.map((s) => (
                <div key={s.id} className="speak-history-row">
                  <div
                    className="speak-history-main"
                    onClick={() => {
                      setActiveReview(s);
                      setSubView('review');
                    }}
                  >
                    <strong>
                      {s.mode === 'examiner' && s.ieltsScore ? `[Band ${s.ieltsScore.overall}] ` : ''}
                      {s.topicTitle} · {s.takeaways.length} 条表达
                    </strong>
                    <p>{s.summary}</p>
                    <small>{new Date(s.timestamp).toLocaleString()}</small>
                  </div>
                  <button
                    className="icon-btn"
                    title="删除"
                    aria-label="删除"
                    onClick={() =>
                      updatePersisted((prev) => ({
                        ...prev,
                        sessions: prev.sessions.filter((x) => x.id !== s.id),
                      }))
                    }
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
