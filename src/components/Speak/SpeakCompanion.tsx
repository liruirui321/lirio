import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import {
  IconBookmark,
  IconChat,
  IconCheck,
  IconClipboard,
  IconClose,
  IconIncognito,
  IconKeyboard,
  IconMic,
  IconPause,
  IconPhone,
  IconPlay,
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
  COMPANION_PERSONAS,
  EMPTY_USER_MEMORY,
  SPEAK_TOPICS,
  VadVoiceRecorder,
  addPhraseToWordModule,
  buildCompanionOpener,
  buildExaminerOpener,
  buildFullMockQueue,
  findLinkedPart3,
  formatIeltsPartLabel,
  generateCompanionReply,
  generateExaminerReply,
  generateSessionTakeaways,
  getCompanionPersona,
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
  type CallViewMode,
  type CompanionPersona,
  type CompanionPersonaId,
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
type CallPhase = 'idle' | 'ai_speaking' | 'part2_prep' | 'listening' | 'transcribing' | 'thinking' | 'paused';

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
  const [incognito, setIncognito] = useState<boolean>(false);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>(() => activeDeck?.items[0]?.id || '');

  const activePersonaId: CompanionPersonaId = persisted.activePersonaId || 'clara';
  const activePersona = useMemo(() => getCompanionPersona(activePersonaId), [activePersonaId]);
  const callViewMode: CallViewMode = persisted.callViewMode === 'phone' ? 'phone' : 'chat';
  const latestCompanionSession = useMemo(
    () => persisted.sessions.find((s) => s.mode === 'companion' && Array.isArray(s.turns) && s.turns.length > 0) || null,
    [persisted.sessions],
  );

  // Live voice call state
  const [callActive, setCallActive] = useState<boolean>(false);
  const [callPaused, setCallPaused] = useState<boolean>(false);
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
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (subView === 'call') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [turns.length, callPhase, subView]);
  const memoryRef = useRef<UserMemoryProfile>(memory);
  const speakModeRef = useRef<SpeakMode>(speakMode);
  const topicIdRef = useRef<string>(topicId);
  const personaRef = useRef<CompanionPersona>(activePersona);
  const incognitoRef = useRef<boolean>(incognito);
  const activeSessionIdRef = useRef<string | null>(null);
  const latestCompanionSessionRef = useRef<SpeakSessionRecord | null>(latestCompanionSession);
  const questionRef = useRef<IeltsQuestionItem | undefined>(activeQuestion);
  const part2DoneRef = useRef<boolean>(part2MonologueDone);
  const mutedRef = useRef<boolean>(muted);
  const callPausedRef = useRef<boolean>(callPaused);
  const recorderRef = useRef<VadVoiceRecorder | null>(null);
  const shadowRecorderRef = useRef<VadVoiceRecorder | null>(null);
  const mockQueueRef = useRef<IeltsQuestionItem[]>([]);
  const mockStepRef = useRef<number>(0);
  const stageStartTurnIdxRef = useRef<number>(0);
  const part2MonologueRef = useRef<string>('');
  const handleNextMockStageRef = useRef<() => Promise<void>>(async () => {});
  const handleHangUpRef = useRef<() => Promise<void>>(async () => {});
  const handleOrbTapRef = useRef<() => void>(() => {});
  const externalContextRef = useRef<SpeakExternalContext | null>(externalContext);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackGainRef = useRef<GainNode | null>(null);
  const playbackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playSeqRef = useRef<number>(0);
  const playResolveRef = useRef<(() => void) | null>(null);

  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { memoryRef.current = memory; }, [memory]);
  useEffect(() => { speakModeRef.current = speakMode; }, [speakMode]);
  useEffect(() => { topicIdRef.current = topicId; }, [topicId]);
  useEffect(() => { personaRef.current = activePersona; }, [activePersona]);
  useEffect(() => { incognitoRef.current = incognito; }, [incognito]);
  useEffect(() => { latestCompanionSessionRef.current = latestCompanionSession; }, [latestCompanionSession]);
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
    if (!persisted.config.textApiKey && (persisted.config.textApiUrl || '').includes('deepseek')) {
      invoke<string | null>('speak_auto_detect_deepseek')
        .then((key) => {
          if (key) {
            updatePersisted((prev) => ({
              ...prev,
              config: {
                ...prev.config,
                textApiKey: key,
              },
            }));
          }
        })
        .catch(() => {});
    }
  }, []);

  const stopAudio = useCallback(() => {
    playSeqRef.current++;
    if (playbackSourceRef.current) {
      try {
        playbackSourceRef.current.onended = null;
        playbackSourceRef.current.stop();
        playbackSourceRef.current.disconnect();
      } catch {}
      playbackSourceRef.current = null;
    }
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
      callPausedRef.current = false;
      stopAudio();
      if (playbackCtxRef.current) {
        try {
          void playbackCtxRef.current.close();
        } catch {}
        playbackCtxRef.current = null;
        playbackGainRef.current = null;
      }
      recorderRef.current?.cancel();
      shadowRecorderRef.current?.cancel();
    };
  }, [stopAudio]);

  const getPlaybackOutput = useCallback((): { ctx: AudioContext; gain: GainNode } | null => {
    if (typeof window === 'undefined') return null;
    try {
      if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        gain.gain.value = 1.55;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -10;
        comp.knee.value = 12;
        comp.ratio.value = 6;
        comp.attack.value = 0.003;
        comp.release.value = 0.15;
        gain.connect(comp);
        comp.connect(ctx.destination);
        playbackCtxRef.current = ctx;
        playbackGainRef.current = gain;
      }
      if (playbackCtxRef.current.state === 'suspended') {
        void playbackCtxRef.current.resume().catch(() => {});
      }
      return { ctx: playbackCtxRef.current, gain: playbackGainRef.current! };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (subView !== 'review') {
      void stopShadowRecorder();
    }
  }, [subView, stopShadowRecorder]);

  // Pipelined sentence-by-sentence TTS for minimal first-byte latency; returns false if interrupted
  const playTtsAndWait = useCallback(
    async (text: string, opts?: { usePersonaVoice?: boolean }): Promise<boolean> => {
      stopAudio();
      const seq = playSeqRef.current;
      const sentences = text
        .split(/(?<=[.!?。！？])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      let chunks = sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
      if (!chunks.length) return true;
      // Split a long leading sentence at the first clause boundary so TTS speaks sooner
      if (chunks[0].length > 85) {
        const match = chunks[0].slice(35).match(/^(.*?[—;，,])\s+(.+)$/);
        if (match) {
          const head = (chunks[0].slice(0, 35) + match[1]).trim();
          const tail = match[2].trim();
          if (head && tail) chunks = [head, tail, ...chunks.slice(1)];
        }
      }

      const accent = configRef.current.accent;
      const voiceOverride =
        speakModeRef.current === 'companion' && opts?.usePersonaVoice !== false
          ? {
              accent: personaRef.current.accent,
              edgeVoice: personaRef.current.edgeVoice,
              openaiVoice: personaRef.current.openaiVoice,
            }
          : undefined;
      let nextPromise: Promise<string> | null = synthesizeSpeech(chunks[0], accent, voiceOverride);

      for (let i = 0; i < chunks.length; i++) {
        if (seq !== playSeqRef.current || callPausedRef.current) return false;
        const currentPromise = nextPromise!;
        nextPromise =
          i + 1 < chunks.length ? synthesizeSpeech(chunks[i + 1], accent, voiceOverride) : null;

        let url: string;
        try {
          url = await currentPromise;
        } catch {
          continue;
        }
        if (seq !== playSeqRef.current || callPausedRef.current) {
          URL.revokeObjectURL(url);
          return false;
        }

        const out = getPlaybackOutput();
        let playedViaWebAudio = false;
        if (out) {
          try {
            const resp = await fetch(url);
            const ab = await resp.arrayBuffer();
            if (seq !== playSeqRef.current || callPausedRef.current) {
              URL.revokeObjectURL(url);
              return false;
            }
            const audioBuf = await out.ctx.decodeAudioData(ab);
            if (seq !== playSeqRef.current || callPausedRef.current) {
              URL.revokeObjectURL(url);
              return false;
            }
            if (out.ctx.state === 'suspended') {
              await out.ctx.resume().catch(() => {});
            }
            playedViaWebAudio = true;
            await new Promise<void>((resolve) => {
              const src = out.ctx.createBufferSource();
              src.buffer = audioBuf;
              src.connect(out.gain);
              playbackSourceRef.current = src;
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                if (playResolveRef.current === done) playResolveRef.current = null;
                if (playbackSourceRef.current === src) {
                  src.onended = null;
                  try {
                    src.disconnect();
                  } catch {}
                  playbackSourceRef.current = null;
                }
                URL.revokeObjectURL(url);
                resolve();
              };
              playResolveRef.current = done;
              src.onended = done;
              src.start(0);
            });
          } catch {
            playedViaWebAudio = false;
          }
        }

        if (!playedViaWebAudio) {
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
        if (seq !== playSeqRef.current || callPausedRef.current) return false;
      }
      return seq === playSeqRef.current && !callPausedRef.current;
    },
    [stopAudio, getPlaybackOutput],
  );

  const beginListeningTurn = useCallback(async () => {
    if (!callActiveRef.current || callPausedRef.current) return;
    await stopRecorder();
    if (!callActiveRef.current || callPausedRef.current) return;
    setCallPhase('listening');
    setHeardVoice(false);
    setMicLevel(0);

    const isPart2Monologue =
      speakModeRef.current === 'examiner' &&
      questionRef.current?.part === 'part2' &&
      !part2DoneRef.current;

    const silenceMs = isPart2Monologue
      ? 4500
      : speakModeRef.current === 'companion'
        ? Math.min(configRef.current.silenceMs || 1200, 1200)
        : configRef.current.silenceMs || 1600;

    const rec = new VadVoiceRecorder();
    rec.setMuted(mutedRef.current);
    recorderRef.current = rec;
    try {
      await rec.start({
        silenceMs,
        onLevel: (lvl) => setMicLevel(lvl),
        onSpeechDetected: () => setHeardVoice(true),
        onSpeechEnd: async (wav) => {
          if (!callActiveRef.current || callPausedRef.current) return;
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
            if (!callActiveRef.current || callPausedRef.current) return;
            await processUserTurnInCall(text);
          } catch (e) {
            if (!callActiveRef.current || callPausedRef.current) return;
            setStatusMsg(String(e));
            beginListeningTurn();
          }
        },
      });
    } catch (e) {
      const msg = String(e);
      setStatusMsg(
        /NotAllowed|PermissionDenied|permission|denied/i.test(msg)
          ? '无法访问麦克风，请前往「设置 → 通用」开启麦克风权限。'
          : '无法访问麦克风，请检查系统权限：' + msg,
      );
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
              incognitoRef.current ? EMPTY_USER_MEMORY : memoryRef.current,
              customGuide,
              personaRef.current,
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
        if (callPausedRef.current) return;

        setCallPhase('ai_speaking');
        const finished = await playTtsAndWait(reply);
        if (!callActiveRef.current || !finished) return;
        if (examinerRes?.action === 'next_part' && mockStepRef.current + 1 < mockQueueRef.current.length) {
          await handleNextMockStageRef.current();
        } else if (examinerRes?.action === 'end_test') {
          await handleHangUpRef.current();
        } else {
          beginListeningTurn();
        }
      } catch (e) {
        setStatusMsg(String(e));
        if (callActiveRef.current && !callPausedRef.current) {
          beginListeningTurn();
        } else if (!callActiveRef.current) {
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
          playTtsAndWait('Your one minute preparation time is up. Please begin speaking now.', {
            usePersonaVoice: false,
          }).then((finished) => {
            if (callActiveRef.current && finished) beginListeningTurn();
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
      activeSessionIdRef.current = null;
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
        opener = buildCompanionOpener(personaRef.current, topicIdRef.current, memoryRef.current, {
          incognito: incognitoRef.current,
          lastSession: latestCompanionSessionRef.current || undefined,
        });
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
      callPausedRef.current = false;
      setCallPaused(false);
      callActiveRef.current = true;
      setCallActive(true);
      setSubView('call');

      setCallPhase('ai_speaking');
      let finished = true;
      try {
        finished = await playTtsAndWait(opener);
      } catch (e) {
        setStatusMsg('语音播报失败：' + String(e));
      }
      if (!callActiveRef.current || !finished) return;

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
        drawnSet.every((x) => x.part === 'warmup' || targetDeck.items.some((it) => it.id === x.id))
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
    let finished = true;
    try {
      finished = await playTtsAndWait(opener);
    } catch (e) {
      setStatusMsg('语音播报失败：' + String(e));
    }
    if (!callActiveRef.current || !finished) return;

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
        const msg = String(e);
        setStatusMsg(
          /NotAllowed|PermissionDenied|permission|denied/i.test(msg)
            ? '无法访问麦克风，请前往「设置 → 通用」开启麦克风权限。'
            : '麦克风启动失败：' + msg,
        );
      }
    },
    [shadowingIdx, shadowingBusy, stopShadowRecorder, stopAudio],
  );

  const handleSkipPart2Prep = useCallback(() => {
    if (callPhase !== 'part2_prep') return;
    stopAudio();
    beginListeningTurn();
  }, [callPhase, stopAudio, beginListeningTurn]);

  const handleTogglePause = useCallback(async () => {
    if (!callActiveRef.current) return;
    if (callPausedRef.current) {
      callPausedRef.current = false;
      setCallPaused(false);
      setStatusMsg('');
      await beginListeningTurn();
    } else {
      callPausedRef.current = true;
      setCallPaused(true);
      setCallPhase('paused');
      stopAudio();
      await stopRecorder();
      setHeardVoice(false);
      setMicLevel(0);
    }
  }, [beginListeningTurn, stopAudio, stopRecorder]);

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
    if (callPausedRef.current) {
      await handleTogglePause();
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
        if (!callActiveRef.current || callPausedRef.current) return;
        if (wav.length < 400) {
          beginListeningTurn();
          return;
        }
        const text = await transcribeVoice(wav);
        if (!callActiveRef.current || callPausedRef.current) return;
        await processUserTurnInCall(text);
      } catch (e) {
        setStatusMsg(String(e));
        if (callActiveRef.current && !callPausedRef.current) beginListeningTurn();
      }
    }
  }, [callPhase, examLaunchMode, drawnSet, activeDeck, activeQuestion, handleStartFullMock, handleStartCall, handleTogglePause, handleSkipPart2Prep, stopAudio, beginListeningTurn, processUserTurnInCall]);

  useEffect(() => {
    handleOrbTapRef.current = () => {
      void handleOrbTap();
    };
  }, [handleOrbTap]);

  // Global Space key shortcut during active call: instant barge-in or turn finish
  useEffect(() => {
    if (subView !== 'call' || !callActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return;
      }
      if (callPhase === 'ai_speaking' || callPhase === 'part2_prep' || callPhase === 'listening') {
        e.preventDefault();
        handleOrbTapRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [subView, callActive, callPhase]);

  const handleResumeSession = useCallback(
    async (session: SpeakSessionRecord) => {
      stopAudio();
      await stopRecorder();
      setMockQueue([]);
      mockQueueRef.current = [];
      setMockStep(0);
      mockStepRef.current = 0;

      setSpeakMode(session.mode);
      speakModeRef.current = session.mode;
      if (session.mode === 'companion') {
        if (SPEAK_TOPICS.some((t) => t.id === session.topicId)) {
          setTopicId(session.topicId);
          topicIdRef.current = session.topicId;
        }
        const restoredPersona = getCompanionPersona(session.personaId);
        personaRef.current = restoredPersona;
        setIncognito(false);
        incognitoRef.current = false;
        updatePersisted((prev) => ({
          ...prev,
          activePersonaId: restoredPersona.id,
          callViewMode: 'chat',
        }));
      } else {
        updatePersisted((prev) => ({ ...prev, callViewMode: 'chat' }));
      }

      const restoredTurns = Array.isArray(session.turns) ? [...session.turns] : [];
      activeSessionIdRef.current = session.id;
      turnsRef.current = restoredTurns;
      setTurns(restoredTurns);
      setActiveReview(null);
      setShadowResults({});
      setStatusMsg('');
      callPausedRef.current = false;
      setCallPaused(false);
      callActiveRef.current = true;
      setCallActive(true);
      setSubView('call');
      await beginListeningTurn();
    },
    [stopAudio, stopRecorder, updatePersisted, beginListeningTurn],
  );

  const handleHangUp = useCallback(async () => {
    const mockPartsLabel =
      mockQueueRef.current.length > 1
        ? mockQueueRef.current.map((q) => formatIeltsPartLabel(q.part)).join(' · ')
        : '';
    const sessionTopicIds =
      mockQueueRef.current.length > 0
        ? mockQueueRef.current.filter((q) => q.part !== 'warmup').map((q) => q.id)
        : speakModeRef.current === 'examiner' && questionRef.current
          ? [questionRef.current.id]
          : [];
    setMockQueue([]);
    mockQueueRef.current = [];
    setMockStep(0);
    mockStepRef.current = 0;
    callPausedRef.current = false;
    setCallPaused(false);
    callActiveRef.current = false;
    setCallActive(false);
    setCallPhase('idle');
    stopAudio();
    await stopRecorder();

    const modeNow = speakModeRef.current;
    if (modeNow === 'companion' && incognitoRef.current) {
      turnsRef.current = [];
      setTurns([]);
      activeSessionIdRef.current = null;
      setStatusMsg('无痕对话已结束（未写入记忆与历史）');
      return;
    }

    const currentTurns = turnsRef.current;
    const userCount = currentTurns.filter((t) => t.role === 'user').length;
    if (!userCount) {
      activeSessionIdRef.current = null;
      return;
    }

    setReviewing(true);
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
          ? `${formatIeltsPartLabel(questionRef.current.part)} · ${questionRef.current.topic}`
          : (SPEAK_TOPICS.find((t) => t.id === topicIdRef.current) || SPEAK_TOPICS[0]).title;

      const resumedId = activeSessionIdRef.current;
      activeSessionIdRef.current = null;
      const record: SpeakSessionRecord = {
        id: resumedId || `sp-${Date.now()}`,
        mode: modeNow,
        personaId: modeNow === 'companion' ? personaRef.current.id : undefined,
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
        sessions: [record, ...prev.sessions.filter((x) => x.id !== record.id)].slice(0, 60),
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
    setStatusMsg('已重新抽题');
  };

  const personaOptions: SelectOption[] = useMemo(
    () => COMPANION_PERSONAS.map((p) => ({ value: p.id, label: p.name, meta: p.tag })),
    [],
  );

  const topicOptions: SelectOption[] = useMemo(
    () => SPEAK_TOPICS.map((t) => ({ value: t.id, label: t.title })),
    [],
  );

  const deckOptions: SelectOption[] = useMemo(
    () => decks.map((d) => ({ value: d.id, label: d.title, meta: `${d.items.length}组` })),
    [decks],
  );

  const memoryCount =
    memory.aboutMe.length +
    memory.habits.length +
    memory.recurringTopics.length +
    memory.targetPhrases.length;

  const phaseLabel =
    callPhase === 'ai_speaking'
      ? speakMode === 'examiner'
        ? '考官提问中 · 点光球或按空格插话'
        : `${activePersona.name} 说话中 · 点光球或按空格插话`
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
              : callPhase === 'paused'
                ? '通话已暂停 · 点继续或光球恢复'
                : speakMode === 'examiner'
                ? '点击光球，开始雅思口语模考'
                : incognito
                  ? `点击光球，与 ${activePersona.name} 无痕通话`
                  : `点击光球，与 ${activePersona.name} 语音通话`;

  const orbScale = callPhase === 'listening' ? 1 + micLevel * 0.25 : 1;
  const showPhoneStage = !callActive && turns.length === 0 ? true : callActive && callViewMode === 'phone';
  const teacherLabel = speakMode === 'examiner' ? '考官' : activePersona.name;

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
                  value={activePersona.id}
                  options={personaOptions}
                  disabled={callActive}
                  minWidth={94}
                  menuWidth={206}
                  onChange={(v) =>
                    updatePersisted((prev) => ({
                      ...prev,
                      activePersonaId: v as CompanionPersonaId,
                    }))
                  }
                />
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
                <button
                  type="button"
                  className="speak-draw-btn"
                  disabled={callActive}
                  title="随机抽一套题"
                  onClick={handleDrawRandomMockSet}
                >
                  <IconShuffle size={13} />
                  <span>抽题</span>
                </button>
              </>
            )}
          </div>
        )}

        <div className="speak-top-actions">
          {speakMode === 'companion' && (
            <button
              type="button"
              className={`icon-btn${incognito ? ' incognito-on' : ''}`}
              title={incognito ? '无痕模式已开启：不读取记忆，结束不写入历史' : '无痕对话（不写入记忆与历史）'}
              aria-label="无痕对话开关"
              aria-pressed={incognito}
              disabled={callActive}
              onClick={() => setIncognito((v) => !v)}
            >
              <IconIncognito size={16} />
            </button>
          )}
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
            title="设置"
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

      {/* VIEW 1: Clean Phone / Idle Orb Stage <-> Left/Right Chat Bubble Stage */}
      {subView === 'call' && showPhoneStage && (
        <div className="speak-call-stage">
          {/* Part 2 Cue Card Floating Glass Card */}
          {speakMode === 'examiner' &&
            activeQuestion?.part === 'part2' &&
            (callActive || examLaunchMode === 'single') && (
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
            {callActive && speakMode === 'companion' && (
              <div className="speak-phone-persona">
                {activePersona.name}
                {incognito ? ' · 无痕' : ''}
              </div>
            )}
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

            {!callActive &&
              turns.length === 0 &&
              speakMode === 'companion' &&
              !incognito &&
              latestCompanionSession && (
                <button
                  type="button"
                  className="speak-resume-chip"
                  title="回到上一次聊天内容继续对话"
                  onClick={() => void handleResumeSession(latestCompanionSession)}
                >
                  <IconChat size={13} />
                  <span>
                    继续上次：
                    {latestCompanionSession.personaId
                      ? `${getCompanionPersona(latestCompanionSession.personaId).name} · `
                      : ''}
                    {latestCompanionSession.topicTitle}
                  </span>
                </button>
              )}
          </div>

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

          {/* Minimal Floating Bottom Dock */}
          <div className="speak-bottom-dock">
            {callActive && (
              <>
                <button
                  type="button"
                  className={`dock-circle${muted ? ' active' : ''}`}
                  title={muted ? '取消静音' : '静音'}
                  aria-label="静音"
                  onClick={() => setMuted((m) => !m)}
                >
                  <IconMic size={16} style={muted ? { opacity: 0.45 } : undefined} />
                </button>
                <button
                  type="button"
                  className={`dock-circle${callPaused ? ' active' : ''}`}
                  title={callPaused ? '继续通话' : '暂停通话'}
                  aria-label={callPaused ? '继续通话' : '暂停通话'}
                  onClick={() => void handleTogglePause()}
                >
                  {callPaused ? <IconPlay size={16} /> : <IconPause size={16} />}
                </button>
              </>
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
              <>
                <button
                  type="button"
                  className="dock-circle"
                  title="切换到聊天气泡模式"
                  aria-label="切换到聊天气泡模式"
                  onClick={() => updatePersisted((prev) => ({ ...prev, callViewMode: 'chat' }))}
                >
                  <IconChat size={16} />
                </button>
                <button
                  type="button"
                  className="dock-circle danger"
                  title={incognito && speakMode === 'companion' ? '结束无痕通话' : '结束通话并生成复盘'}
                  aria-label="挂断"
                  onClick={handleHangUp}
                >
                  <IconStop size={15} />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {subView === 'call' && !showPhoneStage && (
        <div className="speak-call-stage chat-active">
          {speakMode === 'examiner' && activeQuestion?.part === 'part2' && (callActive || examLaunchMode === 'single') && (
            <div className="cue-card-float compact">
              <div className="cue-card-badge">PART 2 · CUE CARD</div>
              <h3>{activeQuestion.topic}</h3>
              <ul>
                {activeQuestion.prompts.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {callActive && speakMode === 'examiner' && mockQueue.length > 1 && (
            <div className="exam-stage-steps" aria-label="模考进度">
              {mockQueue.map((q, idx) => (
                <span
                  key={q.id}
                  className={`exam-stage-step${idx === mockStep ? ' active' : idx < mockStep ? ' done' : ''}`}
                >
                  {formatIeltsPartLabel(q.part)}
                  {q.topicZh ? ` · ${q.topicZh}` : ''}
                </span>
              ))}
              {mockStep + 1 < mockQueue.length && (
                <button
                  type="button"
                  className="mock-next-pill"
                  disabled={reviewing}
                  onClick={() => void handleNextMockStage()}
                >
                  下一部分 ({formatIeltsPartLabel(mockQueue[mockStep + 1].part)})
                </button>
              )}
            </div>
          )}

          <div className="speak-chat-thread" aria-label="对话记录">
            {turns.map((t) =>
              t.role === 'assistant' ? (
                <div key={t.id} className="speak-chat-row ai">
                  <div className="speak-chat-meta">{teacherLabel}</div>
                  <div className="speak-bubble-wrap">
                    <div className="speak-bubble ai">{t.text}</div>
                    <button
                      type="button"
                      className="icon-btn speak-bubble-play"
                      disabled={callActive && !muted}
                      title={callActive && !muted ? '静音或结束后可重播' : '重播这句'}
                      aria-label="重播"
                      onClick={() => void playTtsAndWait(t.text)}
                    >
                      <IconVolume size={13} />
                    </button>
                  </div>
                </div>
              ) : (
                <div key={t.id} className="speak-chat-row user">
                  <div className="speak-chat-meta">我</div>
                  <div className="speak-bubble user">{t.text}</div>
                </div>
              ),
            )}
            {callPhase === 'thinking' && (
              <div className="speak-chat-row ai">
                <div className="speak-chat-meta">{teacherLabel}</div>
                <div className="speak-bubble ai pending">思考中…</div>
              </div>
            )}
            {callPhase === 'transcribing' && (
              <div className="speak-chat-row user">
                <div className="speak-chat-meta">我</div>
                <div className="speak-bubble user pending">识别中…</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

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

          <div className="speak-chat-controls">
            <div className="speak-chat-orb-group">
              <button
                type="button"
                className={`fluid-orb-wrap compact ${callPhase}`}
                style={{ transform: `scale(${orbScale.toFixed(3)})` }}
                disabled={reviewing || callPhase === 'transcribing' || callPhase === 'thinking'}
                onClick={handleOrbTap}
                title={phaseLabel}
                aria-label={phaseLabel}
              >
                <span className="fluid-orb-halo" />
                <span className="fluid-orb" />
              </button>
              <span className="speak-chat-status">{phaseLabel}</span>
            </div>

            <div className="speak-chat-dock">
              {callActive && (
                <>
                  <button
                    type="button"
                    className={`dock-circle sm${muted ? ' active' : ''}`}
                    title={muted ? '取消静音' : '静音'}
                    aria-label="静音"
                    onClick={() => setMuted((m) => !m)}
                  >
                    <IconMic size={15} style={muted ? { opacity: 0.45 } : undefined} />
                  </button>
                  <button
                    type="button"
                    className={`dock-circle sm${callPaused ? ' active' : ''}`}
                    title={callPaused ? '继续通话' : '暂停通话'}
                    aria-label={callPaused ? '继续通话' : '暂停通话'}
                    onClick={() => void handleTogglePause()}
                  >
                    {callPaused ? <IconPlay size={15} /> : <IconPause size={15} />}
                  </button>
                </>
              )}
              <button
                type="button"
                className={`dock-circle sm${showKeyboard ? ' active' : ''}`}
                title="切换键盘输入"
                aria-label="键盘输入"
                onClick={() => setShowKeyboard((k) => !k)}
              >
                <IconKeyboard size={15} />
              </button>
              {callActive ? (
                <>
                  <button
                    type="button"
                    className="dock-circle sm"
                    title="切换到电话模式"
                    aria-label="切换到电话模式"
                    onClick={() => updatePersisted((prev) => ({ ...prev, callViewMode: 'phone' }))}
                  >
                    <IconPhone size={15} />
                  </button>
                  <button
                    type="button"
                    className="dock-circle sm danger"
                    title={incognito && speakMode === 'companion' ? '结束无痕通话' : '结束通话并生成复盘'}
                    aria-label="挂断"
                    onClick={handleHangUp}
                  >
                    <IconStop size={14} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="dock-circle sm"
                  title="开启新对话"
                  aria-label="开启新对话"
                  onClick={() => {
                    activeSessionIdRef.current = null;
                    setTurns([]);
                  }}
                >
                  <IconPlus size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: Post-Call Review (Official IELTS 4-Band Card + Takeaways) */}
      {subView === 'review' && activeReview && (
        <div className="corpus-panel speak-review">
          <div className="speak-review-head">
            <div>
              <h2>
                {activeReview.mode === 'companion' && activeReview.personaId
                  ? `${getCompanionPersona(activeReview.personaId).name} · `
                  : ''}
                {activeReview.topicTitle}
              </h2>
              <p>{activeReview.summary}</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {activeReview.mode === 'companion' && activeReview.turns?.length > 0 && (
                <button
                  type="button"
                  className="icon-btn"
                  title="回到这场对话继续聊"
                  aria-label="继续对话"
                  onClick={() => void handleResumeSession(activeReview)}
                >
                  <IconChat size={16} />
                </button>
              )}
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
                <div className="qa-transcript-list chat-style">
                  {activeReview.turns.map((t) =>
                    t.role === 'user' ? (
                      <div key={t.id} className="speak-chat-row user">
                        <div className="speak-chat-meta">我</div>
                        <div className="speak-bubble user">{t.text}</div>
                      </div>
                    ) : (
                      <div key={t.id} className="speak-chat-row ai">
                        <div className="speak-chat-meta">
                          {activeReview.mode === 'examiner'
                            ? '考官'
                            : getCompanionPersona(activeReview.personaId).name}
                        </div>
                        <div className="speak-bubble ai">{t.text}</div>
                      </div>
                    ),
                  )}
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
                          <span className="tier-badge small">{formatIeltsPartLabel(item.part)}</span>
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
                      {s.mode === 'companion' && s.personaId
                        ? `${getCompanionPersona(s.personaId).name} · `
                        : ''}
                      {s.topicTitle} · {s.takeaways.length} 条表达
                    </strong>
                    <p>{s.summary}</p>
                    <small>{new Date(s.timestamp).toLocaleString()}</small>
                  </div>
                  <div className="speak-history-actions">
                    {s.mode === 'companion' && Array.isArray(s.turns) && s.turns.length > 0 && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="回到上次对话继续聊"
                        aria-label="继续对话"
                        onClick={() => void handleResumeSession(s)}
                      >
                        <IconChat size={14} />
                      </button>
                    )}
                    <button
                      type="button"
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
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
