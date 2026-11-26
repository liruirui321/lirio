import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { loadCorpusState, lookupBuiltinWord, saveCorpusState, type Accent } from './corpusService';
import { getAccountState, proxyChat, proxyTranscribe, proxyTts } from './accountService';
import { saveStateBackup } from './stateSync';
import ielts2026Q4Raw from '../data/ielts_speaking_2026_sep_dec.json';

export type ProviderId = 'deepseek' | 'gemini' | 'openai' | 'ollama' | 'local';
export type TtsProviderId = 'edge' | 'openai' | 'macos';
export type AsrProviderId = 'local_whisper' | 'openai';
export type SpeakMode = 'companion' | 'examiner';
export type CompanionPersonaId = 'clara' | 'noah' | 'oliver';
export type CallViewMode = 'chat' | 'phone';
export type IeltsPart = 'warmup' | 'part1' | 'part2' | 'part3';
export type IeltsCategory = 'new' | 'core' | 'retained' | 'overseas';

export interface ProviderProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SpeakConfig {
  activeProvider: ProviderId;
  providers: Record<Exclude<ProviderId, 'local'>, ProviderProfile>;
  accent: Accent;
  silenceMs: number;
  showLiveSubtitles: boolean;
  ttsProvider?: TtsProviderId;
  asrProvider?: AsrProviderId;
  textMode?: 'api' | 'local';
  textApiUrl?: string;
  textApiKey?: string;
  textModel?: string;
  speechMode?: 'local' | 'api';
  speechApiKey?: string;
  speechBaseUrl?: string;
  speechModel?: string;
  speechVoice?: string;
}

export interface UserMemoryProfile {
  aboutMe: string[];
  habits: string[];
  recurringTopics: string[];
  targetPhrases: string[];
  updatedAt: number;
}

export interface SpeakTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface TakeawayItem {
  said: string;
  native: string;
  phrase: string;
  zh: string;
  why: string;
}

export interface IeltsBandBreakdown {
  overall: string;
  fluency: { band: string; note: string };
  lexical: { band: string; note: string };
  grammar: { band: string; note: string };
  pronunciation: { band: string; note: string };
}

export interface QaPolishItem {
  question: string;
  userSaid: string;
  polished: string;
  tip: string;
}

export interface PracticedTopicStat {
  count: number;
  lastAt: number;
  lastBand?: string;
}

export interface SpeakSessionRecord {
  id: string;
  mode: SpeakMode;
  personaId?: CompanionPersonaId;
  topicId: string;
  topicTitle: string;
  timestamp: number;
  turns: SpeakTurn[];
  summary: string;
  takeaways: TakeawayItem[];
  qaPolishes?: QaPolishItem[];
  ieltsScore?: IeltsBandBreakdown;
}

export interface IeltsQuestionItem {
  id: string;
  part: IeltsPart;
  topic: string;
  topicZh?: string;
  prompts: string[];
  promptsZh?: string[];
  linkedId?: string;
  category?: IeltsCategory;
  frequency?: string;
  region?: string;
}

export interface IeltsDeck {
  id: string;
  title: string;
  items: IeltsQuestionItem[];
  createdAt: number;
}

export interface SpeakPersistedState {
  config: SpeakConfig;
  memory: UserMemoryProfile;
  sessions: SpeakSessionRecord[];
  decks: IeltsDeck[];
  activeDeckId: string;
  practicedTopics?: Record<string, PracticedTopicStat>;
  activePersonaId?: CompanionPersonaId;
  callViewMode?: CallViewMode;
}

export interface CompanionPersona {
  id: CompanionPersonaId;
  name: string;
  tag: string;
  accent: Accent;
  edgeVoice: string;
  openaiVoice: string;
  stylePrompt: string;
  openers: Record<string, string>;
  returningOpener: (hint?: string) => string;
}

export const COMPANION_PERSONAS: CompanionPersona[] = [
  {
    id: 'clara',
    name: 'Clara',
    tag: '美式 · 温暖轻松',
    accent: 'us',
    edgeVoice: 'en-US-AvaMultilingualNeural',
    openaiVoice: 'shimmer',
    stylePrompt:
      'You are warm, lively, and genuinely empathetic. React naturally with light conversational touches ("Oh nice,", "Wait, really?", "Totally."), keep your pacing breezy, and make the caller feel completely at ease.',
    openers: {
      daily: "Hey! How's your day treating you so far? Anything fun or weird happen today?",
      academic: "Hey! Tell me what you've been diving into lately—any research or study plans coming up?",
      work: "Hey, good to hear from you! How's work feeling this week—busy or pretty chill?",
    },
    returningOpener: (hint) =>
      hint
        ? `Hey, good to hear from you again! How's ${hint} been going lately?`
        : "Hey! Good to catch up again. What's been on your mind since we last talked?",
  },
  {
    id: 'noah',
    name: 'Noah',
    tag: '美式 · 干练直率',
    accent: 'us',
    edgeVoice: 'en-US-AndrewMultilingualNeural',
    openaiVoice: 'echo',
    stylePrompt:
      'You are sharp, grounded, and curious—like a thoughtful friend in tech or grad school. Keep things punchy and real, gently push back or ask "Wait, why?" when interesting, and skip fluff.',
    openers: {
      daily: "Hey, what's up? Anything interesting catch your attention today?",
      academic: "Hey! What problem are you wrestling with lately in your research or reading?",
      work: "Hey there. How are things moving on your projects right now—smooth sailing or chaos?",
    },
    returningOpener: (hint) =>
      hint
        ? `Hey, welcome back. Still thinking about ${hint}, or onto something new?`
        : "Hey, good to talk again. Pick up where we left off, or start somewhere fresh?",
  },
  {
    id: 'oliver',
    name: 'Oliver',
    tag: '英式 · 温和沉稳',
    accent: 'uk',
    edgeVoice: 'en-GB-RyanNeural',
    openaiVoice: 'fable',
    stylePrompt:
      'You are a calm, articulate British friend with gentle dry humor. Speak at an unhurried, clear pace with natural UK phrasing ("Right,", "Fair enough,", "Mind you,"), keeping turns relaxed and conversational.',
    openers: {
      daily: "Hello there! How's your day shaping up? Done anything nice so far?",
      academic: "Hello! Always curious what you're working through at the moment—anything exciting in your studies?",
      work: "Hello, lovely to chat! How's the week been treating you on the work front?",
    },
    returningOpener: (hint) =>
      hint
        ? `Hello again! How have you been getting on with ${hint} lately?`
        : "Hello again, lovely to catch up! How have things been since our last chat?",
  },
];

export function getCompanionPersona(id?: string): CompanionPersona {
  return COMPANION_PERSONAS.find((p) => p.id === id) || COMPANION_PERSONAS[0];
}

export const PROVIDER_META: { id: ProviderId; label: string; hint: string }[] = [
  { id: 'deepseek', label: 'DeepSeek', hint: '高性价比，中文与中英混说理解极佳' },
  { id: 'gemini', label: 'Gemini', hint: '响应极快，口语表达地道自然' },
  { id: 'openai', label: 'GPT (OpenAI)', hint: '对话细腻，考官模拟稳健' },
  { id: 'ollama', label: '本地 Ollama', hint: '本机大模型服务，免费隐私' },
];

export const SPEAK_TOPICS = [
  {
    id: 'daily',
    title: '日常闲聊',
    opener: "Hey! How's your day going so far? Anything interesting happen today?",
    guide: 'Casual everyday voice call like a warm, curious friend chatting over coffee.',
  },
  {
    id: 'academic',
    title: '科研与留学',
    opener: "Hey! Tell me a bit about what you've been working on recently—any exciting research or plans ahead?",
    guide: 'Friendly academic and graduate life conversation, helping express research ideas clearly and naturally.',
  },
  {
    id: 'work',
    title: '职场与生活',
    opener: "Hey, good to catch up! How have things been going with your projects lately?",
    guide: 'Practical workplace, productivity, and modern life conversation with natural idiomatic English.',
  },
];

const ALL_2026_Q4_ITEMS: IeltsQuestionItem[] = (ielts2026Q4Raw as IeltsQuestionItem[]).map((item) => ({
  ...item,
  prompts: [...item.prompts],
  promptsZh: item.promptsZh ? [...item.promptsZh] : undefined,
}));

export const BUILTIN_IELTS_DECKS: IeltsDeck[] = [
  {
    id: 'builtin_ielts_2026_q4_all',
    title: '2026年9–12月全量题库（670题）',
    createdAt: 4,
    items: ALL_2026_Q4_ITEMS,
  },
  {
    id: 'builtin_ielts_2026_q4_new',
    title: '2026年9–12月 · 当季新题+必考',
    createdAt: 3,
    items: ALL_2026_Q4_ITEMS.filter((q) =>
      q.part === 'part1' ? q.category === 'new' || q.category === 'core' : q.category === 'new',
    ),
  },
  {
    id: 'builtin_ielts_2026_q4_retained',
    title: '2026年9–12月 · 保留题（旧题）',
    createdAt: 2,
    items: ALL_2026_Q4_ITEMS.filter((q) =>
      q.part === 'part1' ? q.category === 'retained' || q.category === 'core' : q.category === 'retained',
    ),
  },
  {
    id: 'builtin_ielts_2026_q4_overseas',
    title: '2026年9–12月 · 海外加考补充',
    createdAt: 1,
    items: ALL_2026_Q4_ITEMS.filter((q) =>
      q.part === 'part1' ? q.category === 'overseas' || q.category === 'core' : q.category === 'overseas',
    ),
  },
];

const BUILTIN_DECK_IDS = new Set([
  'builtin_ielts_sample',
  ...BUILTIN_IELTS_DECKS.map((d) => d.id),
]);

const SPEAK_STATE_KEY = 'aboboo-speak-state-v2';

const DEFAULT_CONFIG: SpeakConfig = {
  activeProvider: 'deepseek',
  providers: {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-2.5-flash' },
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    ollama: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'qwen2.5:7b' },
  },
  accent: 'uk',
  silenceMs: 1800,
  showLiveSubtitles: true,
  ttsProvider: 'edge',
  asrProvider: 'local_whisper',
  textMode: 'api',
  textApiUrl: 'https://api.deepseek.com/v1',
  textApiKey: '',
  textModel: 'deepseek-chat',
  speechMode: 'local',
  speechApiKey: '',
  speechBaseUrl: 'https://api.openai.com/v1',
  speechModel: 'tts-1',
  speechVoice: 'alloy',
};

export const EMPTY_USER_MEMORY: UserMemoryProfile = {
  aboutMe: [],
  habits: [],
  recurringTopics: [],
  targetPhrases: [],
  updatedAt: 0,
};

const DEFAULT_MEMORY: UserMemoryProfile = EMPTY_USER_MEMORY;

const speakListeners = new Set<(state: SpeakPersistedState) => void>();

export function subscribeSpeakState(listener: (state: SpeakPersistedState) => void): () => void {
  speakListeners.add(listener);
  return () => {
    speakListeners.delete(listener);
  };
}

export function loadSpeakState(): SpeakPersistedState {
  try {
    const raw = localStorage.getItem(SPEAK_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const customDecks: IeltsDeck[] = Array.isArray(parsed.decks)
        ? parsed.decks.filter((d: IeltsDeck) => d && d.id && !BUILTIN_DECK_IDS.has(d.id))
        : [];
      const decks = [...BUILTIN_IELTS_DECKS, ...customDecks];
      const savedActive = String(parsed.activeDeckId || '');
      const activeDeckId =
        savedActive && savedActive !== 'builtin_ielts_sample' && decks.some((d) => d.id === savedActive)
          ? savedActive
          : BUILTIN_IELTS_DECKS[0].id;
      const sessions: SpeakSessionRecord[] = Array.isArray(parsed.sessions)
        ? parsed.sessions.map((s: any) => ({ ...s, mode: s?.mode === 'examiner' ? 'examiner' : 'companion' }))
        : [];
      const practicedTopics: Record<string, PracticedTopicStat> =
        parsed.practicedTopics && typeof parsed.practicedTopics === 'object' ? parsed.practicedTopics : {};
      const rawCfg = parsed.config || {};
      const providers = {
        deepseek: { ...DEFAULT_CONFIG.providers.deepseek, ...(rawCfg.providers?.deepseek || {}) },
        gemini: { ...DEFAULT_CONFIG.providers.gemini, ...(rawCfg.providers?.gemini || {}) },
        openai: { ...DEFAULT_CONFIG.providers.openai, ...(rawCfg.providers?.openai || {}) },
        ollama: { ...DEFAULT_CONFIG.providers.ollama, ...(rawCfg.providers?.ollama || {}) },
      };
      const legacyPid = rawCfg.activeProvider as ProviderId | undefined;
      const legacyProf = legacyPid && legacyPid !== 'local' ? providers[legacyPid] : providers.deepseek;
      const textMode: 'api' | 'local' = 'api';
      const speechMode: 'local' | 'api' =
        rawCfg.speechMode === 'api' || (!rawCfg.speechMode && rawCfg.ttsProvider === 'openai') ? 'api' : 'local';

      const activePersonaId: CompanionPersonaId = COMPANION_PERSONAS.some((p) => p.id === parsed.activePersonaId)
        ? parsed.activePersonaId
        : 'clara';
      const callViewMode: CallViewMode = parsed.callViewMode === 'phone' ? 'phone' : 'chat';

      return {
        config: {
          ...DEFAULT_CONFIG,
          ...rawCfg,
          providers,
          textMode,
          textApiUrl: rawCfg.textApiUrl ?? legacyProf?.baseUrl ?? DEFAULT_CONFIG.textApiUrl,
          textApiKey: rawCfg.textApiKey ?? legacyProf?.apiKey ?? '',
          textModel: rawCfg.textModel ?? legacyProf?.model ?? DEFAULT_CONFIG.textModel,
          speechMode,
          speechModel: rawCfg.speechModel || DEFAULT_CONFIG.speechModel,
        },
        memory: { ...DEFAULT_MEMORY, ...(parsed.memory || {}) },
        sessions,
        decks,
        activeDeckId,
        practicedTopics,
        activePersonaId,
        callViewMode,
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    config: { ...DEFAULT_CONFIG },
    memory: { ...DEFAULT_MEMORY },
    sessions: [],
    decks: [...BUILTIN_IELTS_DECKS],
    activeDeckId: BUILTIN_IELTS_DECKS[0].id,
    practicedTopics: {},
    activePersonaId: 'clara',
    callViewMode: 'chat',
  };
}

export function saveSpeakState(state: SpeakPersistedState) {
  try {
    const raw = JSON.stringify(state);
    localStorage.setItem(SPEAK_STATE_KEY, raw);
    saveStateBackup('speak_state_v2', raw);
    speakListeners.forEach((fn) => {
      try {
        fn(state);
      } catch {}
    });
  } catch {
    // ignore quota errors
  }
}

export function recordPracticedTopics(
  prevMap: Record<string, PracticedTopicStat> | undefined,
  topicIds: string[],
  lastBand?: string,
): Record<string, PracticedTopicStat> {
  const next: Record<string, PracticedTopicStat> = { ...(prevMap || {}) };
  const now = Date.now();
  for (const rawId of topicIds) {
    const id = rawId.trim();
    if (!id) continue;
    const old = next[id];
    next[id] = {
      count: (old?.count || 0) + 1,
      lastAt: now,
      lastBand: lastBand || old?.lastBand,
    };
  }
  return next;
}

// ---------- IELTS Question Bank File Upload & Smart Parser ----------

export async function pickAndReadQuestionFile(): Promise<{ title: string; content: string } | null> {
  const selected = await open({
    multiple: false,
    filters: [
      { name: '雅思题单文本', extensions: ['txt', 'md', 'csv', 'json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!selected || typeof selected !== 'string') return null;
  const bytes = await readFile(selected);
  const content = new TextDecoder('utf-8').decode(bytes);
  const title = selected.split('/').pop()?.replace(/\.[^.]+$/, '') || '自定义雅思题单';
  return { title, content };
}

export function parseIeltsQuestionBank(rawText: string): IeltsQuestionItem[] {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      const arr = Array.isArray(json) ? json : Array.isArray(json.items) ? json.items : [];
      const mapped: IeltsQuestionItem[] = arr
        .filter((x: any) => x && (x.topic || x.prompts))
        .map((x: any, idx: number) => {
          const partRaw = String(x.part || 'part1').toLowerCase();
          const part: IeltsPart = partRaw.includes('2') ? 'part2' : partRaw.includes('3') ? 'part3' : 'part1';
          const prompts = Array.isArray(x.prompts)
            ? x.prompts.map((p: any) => String(p).trim()).filter(Boolean)
            : typeof x.prompts === 'string'
              ? [x.prompts.trim()]
              : [String(x.topic || '').trim()];
          return {
            id: `q-json-${idx + 1}-${Date.now().toString(36)}`,
            part,
            topic: String(x.topic || `Topic ${idx + 1}`).trim(),
            prompts,
          };
        });
      if (mapped.length) return mapped;
    } catch {
      // fall through to line-based parser
    }
  }

  const lines = rawText.split(/\r?\n/).map((l) => l.trim());
  const items: IeltsQuestionItem[] = [];
  let currentPart: IeltsPart = 'part1';
  let currentItem: IeltsQuestionItem | null = null;

  const flush = () => {
    if (currentItem && (currentItem.prompts.length > 0 || currentItem.topic)) {
      if (!currentItem.prompts.length) currentItem.prompts.push(currentItem.topic);
      items.push(currentItem);
    }
    currentItem = null;
  };

  for (const raw of lines) {
    if (!raw) continue;
    const clean = raw.replace(/^[-*•\d.)\s]+/, '').trim();
    if (!clean) continue;

    if (/^#*\s*part\s*1\b/i.test(raw) || /^第一部分/.test(clean)) {
      flush();
      currentPart = 'part1';
      continue;
    }
    if (/^#*\s*part\s*2\b/i.test(raw) || /^第二部分|^题卡|^cue\s*card/i.test(clean)) {
      flush();
      currentPart = 'part2';
      continue;
    }
    if (/^#*\s*part\s*3\b/i.test(raw) || /^第三部分/.test(clean)) {
      flush();
      currentPart = 'part3';
      continue;
    }

    if (/^you should say/i.test(clean)) continue;

    const isHeading =
      /^#{1,4}\s+/.test(raw) ||
      /^describe\s+(a|an|the|someone|something)\b/i.test(clean) ||
      /^topic\s*[:：]/i.test(clean) ||
      (!clean.endsWith('?') && !clean.endsWith('？') && clean.length < 48 && !currentItem);

    if (isHeading) {
      flush();
      const topic = clean.replace(/^#+\s*/, '').replace(/^topic\s*[:：]\s*/i, '').trim();
      if (/^describe\s+/i.test(topic)) currentPart = 'part2';
      currentItem = {
        id: `q-${items.length + 1}-${Date.now().toString(36)}`,
        part: currentPart,
        topic,
        prompts: [],
      };
    } else {
      if (!currentItem) {
        currentItem = {
          id: `q-${items.length + 1}-${Date.now().toString(36)}`,
          part: currentPart,
          topic: currentPart === 'part1' ? 'Part 1 Questions' : currentPart === 'part2' ? clean : 'Part 3 Discussion',
          prompts: [],
        };
      }
      currentItem.prompts.push(clean);
    }
  }
  flush();

  if (!items.length) {
    const qs = lines.filter((l) => l.length > 4);
    if (qs.length) {
      items.push({
        id: `q-plain-${Date.now().toString(36)}`,
        part: 'part1',
        topic: '自定义口语题单',
        prompts: qs,
      });
    }
  }
  return items;
}

// ---------- WAV Encoding + Live Call VAD Recorder ----------

function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buffer);
}

async function resampleToWav16k(chunks: Float32Array[], inputRate: number): Promise<Uint8Array> {
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  if (totalLen === 0) return new Uint8Array();
  const merged = new Float32Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    merged.set(c, pos);
    pos += c.length;
  }
  const targetRate = 16000;
  const outLen = Math.max(1, Math.ceil((merged.length / inputRate) * targetRate));
  const offline = new OfflineAudioContext(1, outLen, targetRate);
  const buf = offline.createBuffer(1, merged.length, inputRate);
  buf.getChannelData(0).set(merged);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  const data = new Float32Array(rendered.getChannelData(0));
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0.008 && peak < 0.7) {
    const gain = Math.min(6, 0.7 / peak);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.max(-1, Math.min(1, data[i] * gain));
    }
  }
  return encodePcm16Wav(data, targetRate);
}

export class VadVoiceRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private inputRate = 48000;
  private heardSpeech = false;
  private speechStartedAt = 0;
  private lastVoiceAt = 0;
  private finished = false;
  private muted = false;

  setMuted(m: boolean) {
    this.muted = m;
  }

  async start(opts: {
    silenceMs: number;
    onLevel: (level: number) => void;
    onSpeechDetected?: () => void;
    onSpeechEnd: (wav16k: Uint8Array) => void;
  }): Promise<void> {
    this.chunks = [];
    this.preRoll = [];
    this.heardSpeech = false;
    this.finished = false;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new AudioContext();
    this.inputRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);

    const speechThreshold = 0.014;
    const minSpeechMs = 450;

    this.processor.onaudioprocess = (ev) => {
      if (this.finished) return;
      if (this.muted) {
        opts.onLevel(0);
        return;
      }
      const ch = ev.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / ch.length);
      const norm = Math.min(1, rms * 8);
      opts.onLevel(norm);

      const copy = new Float32Array(ch);
      const now = Date.now();

      if (!this.heardSpeech) {
        this.preRoll.push(copy);
        if (this.preRoll.length > 4) this.preRoll.shift();
        if (rms >= speechThreshold) {
          this.heardSpeech = true;
          this.speechStartedAt = now;
          this.lastVoiceAt = now;
          this.chunks.push(...this.preRoll);
          this.preRoll = [];
          opts.onSpeechDetected?.();
        }
      } else {
        this.chunks.push(copy);
        if (rms >= speechThreshold * 0.75) {
          this.lastVoiceAt = now;
        } else if (now - this.speechStartedAt >= minSpeechMs && now - this.lastVoiceAt >= opts.silenceMs) {
          this.finishAndEmit(opts.onSpeechEnd);
        }
      }
    };

    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);
  }

  private async finishAndEmit(cb: (wav16k: Uint8Array) => void) {
    if (this.finished) return;
    this.finished = true;
    const captured = this.chunks;
    const rate = this.inputRate;
    await this.cleanup();
    const wav = await resampleToWav16k(captured, rate);
    cb(wav);
  }

  async forceFinish(): Promise<Uint8Array> {
    if (this.finished) return new Uint8Array();
    this.finished = true;
    const captured = this.heardSpeech ? this.chunks : [...this.preRoll, ...this.chunks];
    const rate = this.inputRate;
    await this.cleanup();
    return resampleToWav16k(captured, rate);
  }

  async cancel(): Promise<void> {
    this.finished = true;
    await this.cleanup();
  }

  private async cleanup() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
    }
    if (this.silentGain) {
      this.silentGain.disconnect();
    }
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) {
      try { await this.ctx.close(); } catch {}
    }
    this.processor = null;
    this.silentGain = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.chunks = [];
    this.preRoll = [];
  }
}

export async function transcribeVoice(wavBytes: Uint8Array): Promise<string> {
  const acct = getAccountState();
  if (acct.aiMode === 'pro_balance' && acct.proCloudSpeech && acct.token) {
    try {
      return await proxyTranscribe(wavBytes, '云端语音识别');
    } catch (cloudErr) {
      console.warn('[ASR] pro cloud transcription failed, falling back to local:', cloudErr);
    }
  }
  try {
    return await invoke<string>('speak_transcribe', {
      wavBytes: Array.from(wavBytes),
    });
  } catch (localErr) {
    if (acct.token) {
      return await proxyTranscribe(wavBytes, '云端语音识别');
    }
    throw localErr;
  }
}

interface TtsResult {
  bytes: number[];
  mime: string;
  source: string;
}

export async function synthesizeSpeech(
  text: string,
  accent: Accent,
  voiceOverride?: { accent?: Accent; edgeVoice?: string; openaiVoice?: string },
): Promise<string> {
  const { config } = loadSpeakState();
  const effectiveAccent = voiceOverride?.accent || accent;
  const acct = getAccountState();

  const invokeFreeTts = async (): Promise<string> => {
    const res = await invoke<TtsResult>('speak_tts', {
      text,
      accent: effectiveAccent,
      provider: config.ttsProvider === 'macos' ? 'macos' : 'edge',
      apiKey: null,
      baseUrl: 'https://api.openai.com/v1',
      model: config.speechModel || 'tts-1',
      voice: voiceOverride?.edgeVoice || null,
    });
    const blob = new Blob([new Uint8Array(res.bytes)], { type: res.mime || 'audio/mpeg' });
    return URL.createObjectURL(blob);
  };

  if (acct.aiMode === 'pro_balance') {
    const cloudVoice = voiceOverride?.edgeVoice || voiceOverride?.openaiVoice || config.speechVoice;
    if (acct.proCloudSpeech) {
      try {
        return await proxyTts(text, effectiveAccent, cloudVoice, '云端语音合成');
      } catch (err) {
        console.warn('[TTS] pro cloud speech failed, falling back to free local/Edge TTS:', err);
      }
    }
    try {
      return await invokeFreeTts();
    } catch (localErr) {
      if (acct.token) {
        return await proxyTts(text, effectiveAccent, cloudVoice, '云端语音合成');
      }
      throw localErr;
    }
  }

  const apiKey = (config.speechApiKey || '').trim();
  const baseUrl = (config.speechBaseUrl || '').trim() || 'https://api.openai.com/v1';
  if (config.speechMode === 'api' && apiKey.length > 0) {
    try {
      const res = await invoke<TtsResult>('speak_tts', {
        text,
        accent: effectiveAccent,
        provider: 'custom',
        apiKey,
        baseUrl,
        model: config.speechModel || 'tts-1',
        voice: voiceOverride?.openaiVoice || config.speechVoice || 'alloy',
      });
      const blob = new Blob([new Uint8Array(res.bytes)], { type: res.mime || 'audio/mpeg' });
      return URL.createObjectURL(blob);
    } catch (err) {
      console.warn('[TTS] custom speech API failed, falling back to free local/Edge TTS:', err);
    }
  }

  return invokeFreeTts();
}

// ---------- Prompts: Soyas Companion & Certified IELTS Examiner ----------

export interface SpeakWordMistakeSummary {
  w: string;
  t: string;
  count: number;
  bookTitle: string;
}

export function getTopWordMistakesForSpeak(limit = 8): SpeakWordMistakeSummary[] {
  const { mistakes } = loadCorpusState();
  return Object.values(mistakes)
    .sort((a, b) => b.count - a.count || b.lastWrongAt - a.lastWrongAt)
    .slice(0, limit)
    .map((m) => ({ w: m.w, t: m.t, count: m.count, bookTitle: m.bookTitle }));
}

export interface ShadowingResult {
  accuracy: number;
  spoken: string;
  missingWords: string[];
  matchedCount: number;
  totalCount: number;
}

export function scoreShadowing(target: string, spoken: string): ShadowingResult {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const targetWords = clean(target);
  const spokenWords = clean(spoken);
  if (!targetWords.length) {
    return { accuracy: 0, spoken: spoken.trim(), missingWords: [], matchedCount: 0, totalCount: 0 };
  }
  const spokenBag = new Map<string, number>();
  for (const w of spokenWords) spokenBag.set(w, (spokenBag.get(w) || 0) + 1);
  let matched = 0;
  const missingWords: string[] = [];
  for (const tw of targetWords) {
    const left = spokenBag.get(tw) || 0;
    if (left > 0) {
      matched++;
      spokenBag.set(tw, left - 1);
    } else if (!missingWords.includes(tw)) {
      missingWords.push(tw);
    }
  }
  const accuracy = Math.round((matched / targetWords.length) * 100);
  return {
    accuracy,
    spoken: spoken.trim(),
    missingWords,
    matchedCount: matched,
    totalCount: targetWords.length,
  };
}

function sampleArray<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function findLinkedPart3(
  deck: IeltsDeck | undefined,
  part2Item: IeltsQuestionItem | undefined,
): IeltsQuestionItem | undefined {
  if (!deck || !part2Item) return undefined;
  if (part2Item.linkedId) {
    const exact = deck.items.find((q) => q.id === part2Item.linkedId && q.part === 'part3');
    if (exact) return exact;
  }
  if (part2Item.topicZh) {
    const byZh = deck.items.find((q) => q.part === 'part3' && q.topicZh === part2Item.topicZh);
    if (byZh) return byZh;
  }
  const normalizedP2 = part2Item.topic.replace(/^Describe\s+/i, '').trim().toLowerCase();
  const byEn = deck.items.find(
    (q) => q.part === 'part3' && q.topic.trim().toLowerCase() === normalizedP2,
  );
  if (byEn) return byEn;
  const reverse = deck.items.find((q) => q.part === 'part3' && q.linkedId === part2Item.id);
  return reverse;
}

export function findLinkedPart2(
  deck: IeltsDeck | undefined,
  part3Item: IeltsQuestionItem | undefined,
): IeltsQuestionItem | undefined {
  if (!deck || !part3Item) return undefined;
  if (part3Item.linkedId) {
    const exact = deck.items.find((q) => q.id === part3Item.linkedId && q.part === 'part2');
    if (exact) return exact;
  }
  if (part3Item.topicZh) {
    const byZh = deck.items.find((q) => q.part === 'part2' && q.topicZh === part3Item.topicZh);
    if (byZh) return byZh;
  }
  return deck.items.find((q) => q.part === 'part2' && q.linkedId === part3Item.id);
}

function trimPart1ForExam(item: IeltsQuestionItem): IeltsQuestionItem {
  if (item.prompts.length <= 5) return item;
  const indexed = item.prompts.slice(1).map((p, idx) => ({
    p,
    zh: item.promptsZh?.[idx + 1],
  }));
  for (let i = indexed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }
  const picked = indexed.slice(0, 4);
  return {
    ...item,
    prompts: [item.prompts[0], ...picked.map((x) => x.p)],
    promptsZh: item.promptsZh ? [item.promptsZh[0], ...picked.map((x) => x.zh || '')] : undefined,
  };
}

function samplePreferringUnpracticed(
  pool: IeltsQuestionItem[],
  excludeId: string | undefined,
  practicedTopics?: Record<string, PracticedTopicStat>,
): IeltsQuestionItem {
  const filtered = excludeId && pool.length > 1 ? pool.filter((q) => q.id !== excludeId) : pool;
  if (!practicedTopics) return sampleArray(filtered);
  const unpracticed = filtered.filter((q) => !practicedTopics[q.id]?.count);
  if (unpracticed.length > 0) return sampleArray(unpracticed);
  // All practiced: sample from the lowest count tier
  const minCount = Math.min(...filtered.map((q) => practicedTopics[q.id]?.count || 0));
  const least = filtered.filter((q) => (practicedTopics[q.id]?.count || 0) === minCount);
  return sampleArray(least.length ? least : filtered);
}

export function formatIeltsPartLabel(part: IeltsPart): string {
  switch (part) {
    case 'warmup':
      return 'Warm-up';
    case 'part1':
      return 'Part 1';
    case 'part2':
      return 'Part 2';
    case 'part3':
      return 'Part 3';
  }
}

/**
 * Compulsory official IELTS opening warm-up (ID check + work/study + hometown/accommodation)
 * prepended before the rotating Part 1-3 topics in full mock mode.
 */
export function buildIeltsWarmupItem(): IeltsQuestionItem {
  return {
    id: '__ielts_warmup__',
    part: 'warmup',
    category: 'core',
    topic: 'Opening Warm-up (Name, Work/Study, Hometown)',
    topicZh: '考前热身（姓名·工作/学业·家乡/住处）',
    prompts: [
      'Could you tell me your full name, please, and what shall I call you?',
      'Do you work or are you a student?',
      'What kind of work do you do / what are you studying, and why did you choose it?',
      'Where do you live / where is your hometown, and what do you like most about living there?',
    ],
    promptsZh: [
      '请告诉我你的全名，我该怎么称呼你？',
      '你目前在工作还是在读书？',
      '你具体做什么工作 / 学什么专业，为什么选择它？',
      '你现在住在哪里 / 你的家乡是哪里，你最喜欢那里的什么？',
    ],
  };
}

export function buildFullMockQueue(
  deck?: IeltsDeck,
  opts?: {
    excludePart1Id?: string;
    excludePart2Id?: string;
    pinnedPart1?: IeltsQuestionItem;
    pinnedPart2?: IeltsQuestionItem;
    practicedTopics?: Record<string, PracticedTopicStat>;
  },
): IeltsQuestionItem[] {
  if (!deck?.items.length) return [];
  const p1Pool = deck.items.filter((q) => q.part === 'part1');
  const rotatingP1Pool = p1Pool.filter(
    (q) => q.category !== 'core' && !/work|study|studies|hometown|accommodation|live/i.test(q.topic),
  );
  const p1CandidatePool = rotatingP1Pool.length > 0 ? rotatingP1Pool : p1Pool;
  const p2Pool = deck.items.filter((q) => q.part === 'part2');
  const p3Pool = deck.items.filter((q) => q.part === 'part3');

  let p1: IeltsQuestionItem | undefined = opts?.pinnedPart1;
  if (!p1 && p1CandidatePool.length) {
    p1 = trimPart1ForExam(
      samplePreferringUnpracticed(p1CandidatePool, opts?.excludePart1Id, opts?.practicedTopics),
    );
  } else if (p1) {
    p1 = trimPart1ForExam(p1);
  }

  let p2: IeltsQuestionItem | undefined = opts?.pinnedPart2;
  if (!p2 && p2Pool.length) {
    p2 = samplePreferringUnpracticed(p2Pool, opts?.excludePart2Id, opts?.practicedTopics);
  }

  let p3: IeltsQuestionItem | undefined = findLinkedPart3(deck, p2);
  if (!p3 && p3Pool.length) {
    const p2Idx = p2 ? p2Pool.findIndex((q) => q.id === p2!.id) : -1;
    p3 = p2Idx >= 0 && p3Pool[p2Idx] ? p3Pool[p2Idx] : sampleArray(p3Pool);
  }

  const ordered = [p1, p2, p3].filter((q): q is IeltsQuestionItem => Boolean(q));
  if (ordered.length > 0) return [buildIeltsWarmupItem(), ...ordered];
  return deck.items.slice(0, 3);
}

function formatMemoryForPrompt(memory: UserMemoryProfile): string {
  const lines: string[] = [];
  if (memory.aboutMe.length) lines.push(`- User background & goals: ${memory.aboutMe.join('; ')}`);
  if (memory.habits.length) lines.push(`- Speaking habits & friction points: ${memory.habits.join('; ')}`);
  if (memory.recurringTopics.length) lines.push(`- Recent topics: ${memory.recurringTopics.join('; ')}`);
  if (memory.targetPhrases.length) lines.push(`- Phrases they are practicing: ${memory.targetPhrases.slice(0, 12).join(', ')}`);
  const wordMistakes = getTopWordMistakesForSpeak(8);
  if (wordMistakes.length) {
    lines.push(
      `- Vocabulary words the user recently struggled to spell or catch in listening (weave 1–2 naturally into conversation without quizzing them): ${wordMistakes.map((m) => m.w).join(', ')}`,
    );
  }
  if (!lines.length) return '';
  return `\nLong-term memory about this user (use naturally like a friend who remembers them—never recite it mechanically):\n${lines.join('\n')}`;
}

export function buildCompanionOpener(
  persona: CompanionPersona,
  topicId: string,
  memory: UserMemoryProfile,
  opts?: { incognito?: boolean; lastSession?: SpeakSessionRecord },
): string {
  const fallbackTopic = SPEAK_TOPICS.find((t) => t.id === topicId) || SPEAK_TOPICS[0];
  if (opts?.incognito) {
    return persona.openers[topicId] || fallbackTopic.opener;
  }

  if (topicId === 'daily') {
    const candidates = [
      memory.recurringTopics[0],
      memory.targetPhrases[0],
      opts?.lastSession?.topicTitle,
    ];
    const cleanEnglishHint = candidates
      .map((c) => String(c || '').trim())
      .find((c) => c.length >= 2 && c.length <= 48 && !/[\u4e00-\u9fff]/.test(c));
    if (cleanEnglishHint) {
      return persona.returningOpener(cleanEnglishHint);
    }
    if (memory.aboutMe.length + memory.recurringTopics.length > 0 || opts?.lastSession) {
      return persona.returningOpener();
    }
  }

  return persona.openers[topicId] || fallbackTopic.opener;
}

function buildCompanionSystemPrompt(
  topicGuide: string,
  memory: UserMemoryProfile,
  persona?: CompanionPersona,
): string {
  const identity = persona
    ? `Your name is ${persona.name}. ${persona.stylePrompt}`
    : 'You are a warm, natural bilingual speaking companion on a live voice call inside Lirio.';
  return [
    `${identity} You are on a live phone call inside Lirio.`,
    `Context: ${topicGuide}`,
    formatMemoryForPrompt(memory),
    'Rules:',
    '1. Speak like a real friend on a voice call—NOT a teacher, textbook, or customer support bot.',
    '2. Start or respond with natural spoken reactions when fitting ("Oh nice,", "Right,", "Honestly,", "Wait—") and keep every spoken turn tight (1 to 2 crisp, natural sentences plus a light follow-up).',
    '3. The user may code-switch (mix Chinese words/phrases into English when stuck). NEVER interrupt, scold, or lecture about grammar.',
    '4. Understand their Chinese+English meaning seamlessly, react genuinely, and naturally weave the idiomatic English phrasing into your reply.',
    '5. Output plain spoken English only (no markdown, no bullets, no emojis, no stage directions).',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ExaminerReplyOptions {
  hasNextPart?: boolean;
  linkedPart2Topic?: string;
  part2UserExcerpt?: string;
}

function buildExaminerSystemPrompt(
  questionItem: IeltsQuestionItem,
  candidateAnswersInPart: number,
  opts: ExaminerReplyOptions = {},
): string {
  const totalQs = questionItem.prompts.length;
  const promptList = questionItem.prompts.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const endMarker = opts.hasNextPart ? '[NEXT_PART]' : '[END_TEST]';

  const partRule =
    questionItem.part === 'warmup'
      ? [
          'Phase: IELTS Speaking Official Opening Warm-up (ID Check + Core Introductory Questions before Part 1).',
          `Question #1 (asking full name and what to call the candidate) was already asked in your opener. Candidate answers so far in Warm-up: ${candidateAnswersInPart}. Total compulsory checkpoints: ${totalQs}.`,
          'Follow the authentic IELTS examiner opening sequence strictly in 1 concise turn per checkpoint:',
          '- After their name (candidateAnswersInPart === 1): address them naturally by the name they gave (e.g., "Thank you, [Name]. Now, do you work or are you a student?").',
          '- After they say work or student (candidateAnswersInPart === 2): ask ONE natural tailored follow-up matching what they actually said — if working, ask about their job/company/why they chose it; if studying, ask about their major/university/why they chose it.',
          '- After that follow-up (candidateAnswersInPart === 3): transition smoothly to hometown/accommodation ("Thank you. And where are you from, or where do you live at the moment? What do you like most about living there?").',
          'If an answer is ultra-short (under 5 words) and unclear, you may probe briefly once before moving on; never repeat a question already answered.',
          `Once all ${totalQs} warm-up checkpoints have been answered (candidateAnswersInPart >= ${totalQs}), thank them neutrally and transition directly toward Part 1 everyday topics by saying "Thank you. Now let's move on to some other everyday topics." and append the exact token ${endMarker} at the very end of your response.`,
        ].join('\n')
      : questionItem.part === 'part1'
      ? [
          'Phase: IELTS Speaking Part 1 (Interview).',
          `Question #1 was already asked in your opener. Candidate answers so far in Part 1: ${candidateAnswersInPart}. Total questions on sheet: ${totalQs}.`,
          'Ask questions #2 through #' + totalQs + ' on the Official Question Sheet STRICTLY IN ORDER, one question per turn. NEVER invent unrelated topics.',
          'If the latest candidate answer is ultra-short (under 8 words), you may probe briefly ONCE ("Why?" or "Could you tell me a little more?") before moving to the next question.',
          'Otherwise acknowledge neutrally ("Thank you.", "I see.", "Right.") and ask the next unasked question verbatim or naturally verbatim.',
          `Once all ${totalQs} questions on the sheet have been asked and answered (or candidateAnswersInPart >= ${totalQs}), politely close Part 1 by saying "Thank you, that brings us to the end of Part 1." and append the exact token ${endMarker} at the very end of your response.`,
        ].join('\n')
      : questionItem.part === 'part2'
        ? [
            'Phase: IELTS Speaking Part 2 (Individual Long Turn — Cue Card).',
            `Candidate turns so far in Part 2: ${candidateAnswersInPart}.`,
            candidateAnswersInPart <= 1
              ? 'The candidate just finished their 1–2 minute monologue. Thank them briefly ("Thank you.") and ask ONE concise rounding-off follow-up question directly tied to what they just said. Do NOT include any stage-end token yet.'
              : `The candidate has answered your rounding-off question. Thank them politely ("Thank you. That concludes Part 2.") and append the exact token ${endMarker} at the very end of your response.`,
          ].join('\n')
        : [
            'Phase: IELTS Speaking Part 3 (Two-Way Analytical Discussion — linked directly to the Part 2 Cue Card).',
            opts.linkedPart2Topic ? `Linked Part 2 Topic: ${opts.linkedPart2Topic}` : '',
            opts.part2UserExcerpt ? `Summary of what the candidate said in Part 2: ${opts.part2UserExcerpt}` : '',
            `Question #1 was already asked in your opener. Candidate answers so far in Part 3: ${candidateAnswersInPart}. Total questions on sheet: ${totalQs}.`,
            'Ask questions #2 through #' + totalQs + ' on the Official Question Sheet STRICTLY IN ORDER, one question per turn.',
            'Before asking each next question, briefly react to or deepen their point naturally (or ask one brief analytical follow-up if their point is superficial).',
            `Once all ${totalQs} questions on the sheet have been discussed (candidateAnswersInPart >= ${totalQs}), close formally by saying "Thank you very much. That is the end of the speaking test." and append the exact token [END_TEST] at the very end of your response.`,
          ]
            .filter(Boolean)
            .join('\n');

  return [
    'You are a certified, professional IELTS Speaking Examiner conducting an authentic official speaking test.',
    partRule,
    `Topic: ${questionItem.topic}`,
    `Official Question Sheet:\n${promptList}`,
    'Strict Examiner Protocol:',
    '1. Maintain a calm, polite, neutral examiner demeanor. Do NOT give teaching feedback, band scores, or grammar corrections during the test.',
    '2. Keep every examiner utterance crisp, natural, and brief (1–2 sentences max). Never ask two unrelated questions in one turn.',
    `3. Output plain spoken English only (no markdown, no numbering, no emojis, no parenthetical actions). Only use ${endMarker} at the very end when finishing this Part as instructed.`,
  ].join('\n');
}

async function callCustomLlm(
  config: SpeakConfig,
  messages: { role: string; content: string }[],
  temperature = 0.7,
): Promise<string> {
  const baseUrl = (config.textApiUrl || '').trim();
  const apiKey = (config.textApiKey || '').trim();
  const model = (config.textModel || '').trim() || 'deepseek-chat';
  if (!baseUrl) {
    throw new Error('请先在「设置 → AI → 自配置」填写文本模型的 URL。');
  }
  const isLocalEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(baseUrl);
  if (!isLocalEndpoint && !apiKey) {
    throw new Error('请先在「设置 → AI → 自配置」填写 API Key，或启用「官方 API」。');
  }
  return invoke<string>('speak_chat_remote', {
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
  });
}

async function callActiveLlm(
  config: SpeakConfig,
  messages: { role: string; content: string }[],
  temperature = 0.7,
  feature = 'AI 对话',
): Promise<string> {
  const acct = getAccountState();
  if (acct.aiMode === 'pro_balance') {
    return proxyChat({ messages, temperature, feature });
  }
  return callCustomLlm(config, messages, temperature);
}

export async function testProviderConnection(config: SpeakConfig): Promise<string> {
  return callCustomLlm(
    config,
    [
      { role: 'system', content: 'Reply with OK in one word.' },
      { role: 'user', content: 'ping' },
    ],
    0.1,
  );
}

export async function generateCompanionReply(
  config: SpeakConfig,
  topicId: string,
  turns: SpeakTurn[],
  memory: UserMemoryProfile,
  customTopicGuide?: string,
  persona?: CompanionPersona,
): Promise<string> {
  const topic = SPEAK_TOPICS.find((t) => t.id === topicId) || SPEAK_TOPICS[0];
  const guide = customTopicGuide?.trim() ? customTopicGuide : topic.guide;
  const system = buildCompanionSystemPrompt(guide, memory, persona);
  const messages = [
    { role: 'system', content: system },
    ...turns.slice(-16).map((t) => ({ role: t.role, content: t.text })),
  ];
  return callActiveLlm(config, messages, 0.75, '口语陪练');
}

export interface ExaminerReplyResult {
  text: string;
  action: 'continue' | 'next_part' | 'end_test';
}

export async function generateExaminerReply(
  config: SpeakConfig,
  questionItem: IeltsQuestionItem,
  stageTurns: SpeakTurn[],
  opts: ExaminerReplyOptions = {},
): Promise<ExaminerReplyResult> {
  const candidateAnswersInPart = stageTurns.filter((t) => t.role === 'user').length;
  const system = buildExaminerSystemPrompt(questionItem, candidateAnswersInPart, opts);
  const messages = [
    { role: 'system', content: system },
    ...stageTurns.slice(-18).map((t) => ({ role: t.role, content: t.text })),
  ];
  const raw = await callActiveLlm(config, messages, 0.45, '雅思考官');
  let action: 'continue' | 'next_part' | 'end_test' = 'continue';
  if (/\[END_TEST\]/i.test(raw)) {
    action = 'end_test';
  } else if (/\[NEXT_PART\]/i.test(raw)) {
    action = opts.hasNextPart ? 'next_part' : 'end_test';
  }
  const text = raw
    .replace(/\s*\[(NEXT_PART|END_TEST)\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, action };
}

export function buildExaminerOpener(
  item: IeltsQuestionItem,
  linkedPart2?: IeltsQuestionItem,
): string {
  if (item.part === 'warmup') {
    return 'Good afternoon. Welcome to the IELTS speaking test. First of all, could you tell me your full name, please, and what shall I call you?';
  }
  if (item.part === 'part1') {
    const q1 = item.prompts[0] || `Let's talk about ${item.topic}.`;
    return `Now let's talk about ${item.topic}. ${q1}`;
  }
  if (item.part === 'part2') {
    return `Now I'm going to give you a topic and I'd like you to talk about it for one to two minutes. Before you talk, you'll have one minute to think about what you're going to say. Here is your topic: ${item.topic}. You can make some notes if you wish.`;
  }
  const baseTopic = (linkedPart2?.topic || item.topic).replace(/^Describe\s+/i, '').trim();
  const subject = baseTopic
    ? baseTopic[0] === 'I' && (!baseTopic[1] || baseTopic[1] === ' ' || baseTopic[1] === "'")
      ? baseTopic
      : baseTopic[0].toLowerCase() + baseTopic.slice(1)
    : item.topic;
  const q1 = item.prompts[0] || `Let's discuss some broader questions related to ${subject}.`;
  return `We've been talking about ${subject}, and I'd like to discuss with you some more general questions related to this. ${q1}`;
}

export interface MemoryPatch {
  aboutMe?: string[];
  habits?: string[];
  recurringTopics?: string[];
  targetPhrases?: string[];
}

export function mergeMemory(prev: UserMemoryProfile, patch: MemoryPatch): UserMemoryProfile {
  const dedupe = (a: string[], b: string[] | undefined, max: number) => {
    const out = [...a];
    for (const item of b || []) {
      const clean = String(item || '').trim();
      if (!clean) continue;
      if (!out.some((x) => x.toLowerCase() === clean.toLowerCase())) {
        out.unshift(clean);
      }
    }
    return out.slice(0, max);
  };
  return {
    aboutMe: dedupe(prev.aboutMe, patch.aboutMe, 15),
    habits: dedupe(prev.habits, patch.habits, 15),
    recurringTopics: dedupe(prev.recurringTopics, patch.recurringTopics, 12),
    targetPhrases: dedupe(prev.targetPhrases, patch.targetPhrases, 30),
    updatedAt: Date.now(),
  };
}

export async function generateSessionTakeaways(
  config: SpeakConfig,
  mode: SpeakMode,
  turns: SpeakTurn[],
  existingMemory: UserMemoryProfile,
): Promise<{
  summary: string;
  takeaways: TakeawayItem[];
  qaPolishes: QaPolishItem[];
  memoryPatch: MemoryPatch;
  ieltsScore?: IeltsBandBreakdown;
}> {
  const userTurns = turns.filter((t) => t.role === 'user');
  if (!userTurns.length) {
    return { summary: '本次通话尚未有发言记录。', takeaways: [], qaPolishes: [], memoryPatch: {} };
  }

  const transcript = turns
    .map((t) => `${t.role === 'user' ? 'Candidate' : mode === 'examiner' ? 'Examiner' : 'Partner'}: ${t.text}`)
    .join('\n');

  const system =
    mode === 'examiner'
      ? [
          'You are a Senior Certified IELTS Speaking Examiner evaluating a mock speaking test transcript.',
          'Assess strictly against the 4 official IELTS Speaking Band Descriptors: Fluency & Coherence, Lexical Resource, Grammatical Range & Accuracy, and Pronunciation/Delivery.',
          'Also produce BOTH:',
          '1) "qaPolishes": for EVERY question asked by the Examiner that the Candidate answered, provide a polished Band 7.5–8.5 spoken answer ("polished") that keeps the Candidate\'s own core idea, plus a concise Chinese tip ("tip", <=25 chars).',
          '2) "takeaways": 3 to 5 reusable idiomatic expressions/upgrades grounded in what the Candidate said, plus durable memory notes.',
          'Return ONLY valid JSON with this exact schema (no markdown fences):',
          '{"summary":"用2句专业温和的中文总结本次模考表现与最核心提分点","ieltsScore":{"overall":"6.5","fluency":{"band":"6.5","note":"简短中文点评"},"lexical":{"band":"6.5","note":"简短中文点评"},"grammar":{"band":"6.5","note":"简短中文点评"},"pronunciation":{"band":"6.5","note":"基于表达节奏与句式自然度的中文提示"}},"qaPolishes":[{"question":"考官原问","userSaid":"考生原答要点","polished":"保留考生观点但更地道流利的7.5-8.5分完整口语示范回答","tip":"一句话中文点拨"}],"takeaways":[{"said":"考生原话","native":"7.5+分更地道自然的表达","phrase":"核心高分短语/搭配","zh":"中文意思","why":"一句话说明提分逻辑"}],"memory":{"aboutMe":["新了解到的背景或目标"],"habits":["暴露出的高频口语习惯或失分点"],"recurringTopics":["本次考察话题"],"targetPhrases":["核心高分短语"]}}',
        ].join('\n')
      : [
          'You are a warm, perceptive personal bilingual English coach reviewing a voice call.',
          'Focus on places where the user code-switched into Chinese, hesitated, or used Chinglish / stiff phrasing.',
          'Provide "qaPolishes" for each main Partner prompt the user answered (preserving their personal meaning in natural native English), plus "takeaways" and personal memory.',
          existingMemory.habits.length ? `Known habits so far: ${existingMemory.habits.join('; ')}` : '',
          'Return ONLY valid JSON with this exact schema (no markdown fences):',
          '{"summary":"用2句温和简洁的中文总结本次对话亮点与流利度表现","qaPolishes":[{"question":"对方的问题","userSaid":"用户原回答","polished":"更地道自然的母语者整句改写（保留原意）","tip":"一句话中文点拨"}],"takeaways":[{"said":"用户原话","native":"母语者更地道的整句说法","phrase":"值得记忆的核心短语","zh":"核心短语中文意思","why":"一句话中文点拨"}],"memory":{"aboutMe":["新了解到的用户背景/目标"],"habits":["观察到的用户表达习惯或卡壳模式"],"recurringTopics":["本次聊到的核心话题"],"targetPhrases":["核心英文短语"]}}',
        ]
          .filter(Boolean)
          .join('\n');

  const raw = await callActiveLlm(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: transcript },
    ],
    0.3,
    '课后复盘',
  );

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const takeaways: TakeawayItem[] = Array.isArray(parsed.takeaways)
      ? parsed.takeaways
          .filter((x: any) => x && typeof x.native === 'string')
          .map((x: any) => ({
            said: String(x.said || ''),
            native: String(x.native || ''),
            phrase: String(x.phrase || x.native || ''),
            zh: String(x.zh || ''),
            why: String(x.why || ''),
          }))
      : [];
    const qaPolishes: QaPolishItem[] = Array.isArray(parsed.qaPolishes)
      ? parsed.qaPolishes
          .filter((x: any) => x && typeof x.polished === 'string')
          .map((x: any) => ({
            question: String(x.question || ''),
            userSaid: String(x.userSaid || ''),
            polished: String(x.polished || ''),
            tip: String(x.tip || ''),
          }))
      : [];
    const mem = parsed.memory || {};
    const memoryPatch: MemoryPatch = {
      aboutMe: Array.isArray(mem.aboutMe) ? mem.aboutMe : [],
      habits: Array.isArray(mem.habits) ? mem.habits : [],
      recurringTopics: Array.isArray(mem.recurringTopics) ? mem.recurringTopics : [],
      targetPhrases: Array.isArray(mem.targetPhrases)
        ? mem.targetPhrases
        : takeaways.map((t) => t.phrase).filter(Boolean),
    };
    const ieltsScore: IeltsBandBreakdown | undefined = parsed.ieltsScore
      ? {
          overall: String(parsed.ieltsScore.overall || '6.5'),
          fluency: {
            band: String(parsed.ieltsScore.fluency?.band || '6.5'),
            note: String(parsed.ieltsScore.fluency?.note || ''),
          },
          lexical: {
            band: String(parsed.ieltsScore.lexical?.band || '6.5'),
            note: String(parsed.ieltsScore.lexical?.note || ''),
          },
          grammar: {
            band: String(parsed.ieltsScore.grammar?.band || '6.5'),
            note: String(parsed.ieltsScore.grammar?.note || ''),
          },
          pronunciation: {
            band: String(parsed.ieltsScore.pronunciation?.band || '6.5'),
            note: String(parsed.ieltsScore.pronunciation?.note || ''),
          },
        }
      : undefined;

    return {
      summary: String(parsed.summary || '本次通话已完成复盘。'),
      takeaways,
      qaPolishes,
      memoryPatch,
      ieltsScore,
    };
  } catch {
    return {
      summary: raw.slice(0, 240) || '本次通话已完成复盘。',
      takeaways: [],
      qaPolishes: [],
      memoryPatch: {},
    };
  }
}

export function addPhraseToWordModule(phrase: string, zh: string): boolean {
  const clean = phrase.trim();
  if (!clean) return false;
  const state = loadCorpusState();
  const bookId = 'custom_speak_takeaways';
  const existing = state.customBooks[bookId];
  const words = existing ? [...existing.words] : [];
  if (words.some((w) => w.w.toLowerCase() === clean.toLowerCase())) {
    return false;
  }
  words.unshift({ w: clean, t: zh.trim() });
  state.customBooks[bookId] = {
    meta: {
      id: bookId,
      title: '口语地道表达库',
      desc: '从「对话」复盘一键收藏的地道表达',
      count: words.length,
      custom: true,
    },
    words,
  };
  saveCorpusState(state);
  return true;
}

export interface ListeningDiagnosis {
  headline: string;
  patterns: string[];
  nextActions: string[];
}

export async function generateListeningDiagnosis(
  config: SpeakConfig,
  payload: {
    totalSentences: number;
    avgScore: number;
    topContentMistakes: Array<{ word: string; count: number; confusions: string[] }>;
    topWeakWords: Array<{ word: string; missed: number; seen: number }>;
    sampleErrors: Array<{ expected: string; answer: string }>;
  },
): Promise<ListeningDiagnosis> {
  const system = [
    '你是一位极简、敏锐的英语精听教练。根据学习者真实的听写错误统计，直接指出真正拖累听力的核心问题，并给出马上可执行的练习建议。',
    '要求：使用简体中文；只输出严格合法的 JSON，格式为：',
    '{"headline":"一句话核心结论（不超过28字）","patterns":["模式1","模式2"],"nextActions":["行动1","行动2"]}',
    '要求：patterns 最多 3 条（结合具体错词或连读弱读规律，不写空话）；nextActions 最多 3 条（具体可落地，不写套话）。',
  ].join('\n');
  const raw = await callActiveLlm(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    0.35,
    '听力诊断',
  );
  try {
    const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : cleaned);
    const patterns = Array.isArray(parsed.patterns)
      ? parsed.patterns.map((x: unknown) => String(x || '').trim()).filter(Boolean).slice(0, 3)
      : [];
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.map((x: unknown) => String(x || '').trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      headline: String(parsed.headline || '已定位高频漏听与混淆点。').trim(),
      patterns,
      nextActions,
    };
  } catch {
    return {
      headline: raw.replace(/\s+/g, ' ').trim().slice(0, 80) || '已完成听力错误模式扫描。',
      patterns: [],
      nextActions: [],
    };
  }
}

export interface SelectionTranslation {
  text: string;
  phonetic?: string;
  meaning: string;
  note?: string;
}

const translationCache = new Map<string, SelectionTranslation>();

export async function translateSelection(
  rawText: string,
  contextSentence?: string,
): Promise<SelectionTranslation> {
  const cleanText = rawText
    .trim()
    .replace(/^[\s"'“”‘’.,!?;:()[\]]+|[\s"'“”‘’.,!?;:()[\]]+$/g, '')
    .trim();
  const display = cleanText || rawText.trim();
  const ctxKey = `${display.toLowerCase()}::${(contextSentence || '').slice(0, 80).toLowerCase()}`;
  const cached = translationCache.get(ctxKey);
  if (cached) return cached;

  if (/^[A-Za-z][A-Za-z'-]*$/.test(display)) {
    const entry = await lookupBuiltinWord(display);
    if (entry && entry.t) {
      const hit: SelectionTranslation = {
        text: entry.w,
        phonetic: entry.uk ? `/${entry.uk}/` : entry.us ? `/${entry.us}/` : undefined,
        meaning: entry.t,
      };
      translationCache.set(ctxKey, hit);
      return hit;
    }
  }

  const { config } = loadSpeakState();
  const system = [
    '你是一位精准简洁的英汉双语词典与语境翻译助手。',
    '根据用户划选的英文词句（及可选上下文原句），只输出严格合法的 JSON，不要有多余说明：',
    '{"phonetic":"/音标/（仅单个英文单词填写，短语或句子留空字符串）","meaning":"简洁准确的简体中文释义（如单词请带词性缩写如 n. / v. / adj.）","note":"可选的一句地道用法/语境点拨（没有就留空字符串）"}',
  ].join('\n');
  const userMsg = contextSentence
    ? `划选内容：${display}\n所在语境：${contextSentence}`
    : `划选内容：${display}`;
  const raw = await callActiveLlm(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ],
    0.2,
    '划词翻译',
  );
  try {
    const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : stripped);
    const res: SelectionTranslation = {
      text: display,
      phonetic: parsed.phonetic ? String(parsed.phonetic).trim() : undefined,
      meaning: String(parsed.meaning || stripped).trim(),
      note: parsed.note ? String(parsed.note).trim() : undefined,
    };
    translationCache.set(ctxKey, res);
    return res;
  } catch {
    const res: SelectionTranslation = {
      text: display,
      meaning: raw.trim() || '暂无释义',
    };
    translationCache.set(ctxKey, res);
    return res;
  }
}

export interface ProofreadSentenceInput {
  id: string;
  text: string;
  translation?: string;
}

export interface ProofreadOptions {
  fixText: boolean;
  addTranslation: boolean;
  materialTitle?: string;
  onProgress?: (done: number, total: number, batchIdx: number, totalBatches: number) => void;
  signal?: { cancelled: boolean };
}

export interface ProofreadResult {
  updates: Map<string, { text?: string; translation?: string }>;
  changedCount: number;
  translatedCount: number;
}

export async function proofreadDictationSentences(
  items: ProofreadSentenceInput[],
  opts: ProofreadOptions,
): Promise<ProofreadResult> {
  if (!items.length || (!opts.fixText && !opts.addTranslation)) {
    return { updates: new Map(), changedCount: 0, translatedCount: 0 };
  }
  const { config } = loadSpeakState();
  const BATCH_SIZE = 18;
  const totalBatches = Math.ceil(items.length / BATCH_SIZE);
  const updates = new Map<string, { text?: string; translation?: string }>();
  let changedCount = 0;
  let translatedCount = 0;

  const system = [
    'You are an English listening transcript proofreader and bilingual translator (字幕精校).',
    'Given a JSON array of numbered ASR transcript lines [{"i":1,"t":"..."}] (and optional material title), output ONLY valid JSON: {"items":[{"i":1,"t":"...","zh":"..."}]} with NO markdown fences or extra text.',
    'Strict rules:',
    '1. Keep exact 1-to-1 sentence correspondence using the same "i". Never merge, split, drop, or reorder sentences.',
    opts.fixText
      ? '2. For "t": fix obvious ASR speech-to-text errors, homophones, proper nouns, capitalization, and punctuation while staying strictly faithful to what was spoken (do NOT paraphrase).'
      : '2. For "t": keep the input string verbatim unchanged.',
    opts.addTranslation
      ? '3. For "zh": provide natural, concise Simplified Chinese translation.'
      : '3. For "zh": leave as empty string "".',
  ].join('\n');

  for (let b = 0; b < totalBatches; b++) {
    if (opts.signal?.cancelled) {
      throw new Error('AI 精校已取消');
    }
    const startIdx = b * BATCH_SIZE;
    const chunk = items.slice(startIdx, startIdx + BATCH_SIZE);
    opts.onProgress?.(startIdx, items.length, b + 1, totalBatches);

    const payload = chunk.map((item, idx) => ({
      i: idx + 1,
      t: item.text,
    }));
    const userPrompt = opts.materialTitle
      ? `Material: ${opts.materialTitle}\nLines:\n${JSON.stringify(payload)}`
      : `Lines:\n${JSON.stringify(payload)}`;

    const raw = await callActiveLlm(
      config,
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      0.15,
      '字幕 AI 精校',
    );

    if (opts.signal?.cancelled) {
      throw new Error('AI 精校已取消');
    }

    const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
    const objMatch = stripped.match(/\{[\s\S]*\}/);
    const arrMatch = stripped.match(/\[[\s\S]*\]/);
    let rows: Array<{ i?: unknown; t?: unknown; zh?: unknown }> | null = null;
    try {
      if (objMatch) {
        const parsed = JSON.parse(objMatch[0]);
        if (Array.isArray(parsed?.items)) rows = parsed.items;
      } else if (arrMatch) {
        const parsed = JSON.parse(arrMatch[0]);
        if (Array.isArray(parsed)) rows = parsed;
      }
    } catch {
      rows = null;
    }

    if (!rows || !Array.isArray(rows)) {
      throw new Error(`第 ${b + 1} 批 AI 精校返回格式异常，请重试`);
    }

    for (const row of rows) {
      const idx = Number(row?.i) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= chunk.length) continue;
      const orig = chunk[idx];
      const patch: { text?: string; translation?: string } = {};

      if (opts.fixText && typeof row.t === 'string') {
        const cleanT = row.t.trim();
        const maxLen = Math.max(orig.text.length * 1.9 + 50, 80);
        if (cleanT && cleanT.length <= maxLen) {
          patch.text = cleanT;
          if (cleanT !== orig.text.trim()) {
            changedCount++;
          }
        }
      }

      if (opts.addTranslation && typeof row.zh === 'string') {
        const cleanZh = row.zh.trim();
        if (cleanZh) {
          patch.translation = cleanZh;
          translatedCount++;
        }
      }

      if (patch.text !== undefined || patch.translation !== undefined) {
        updates.set(orig.id, patch);
      }
    }
  }

  return { updates, changedCount, translatedCount };
}
