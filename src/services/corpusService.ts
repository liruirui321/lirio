import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { proxyTts } from './accountService';
import { saveStateBackup } from './stateSync';

export type Accent = 'uk' | 'us' | 'au' | 'in';

export interface CorpusWord {
  w: string;
  t: string;
  uk?: string;
  us?: string;
}

export interface CorpusBookMeta {
  id: string;
  title: string;
  desc: string;
  count: number;
  custom?: boolean;
}

export interface MistakeEntry {
  w: string;
  t: string;
  uk?: string;
  us?: string;
  bookId: string;
  bookTitle: string;
  count: number;
  lastWrongAt: number;
}

export interface CorpusSessionRecord {
  id: string;
  bookId: string;
  bookTitle: string;
  sectionLabel: string;
  total: number;
  correct: number;
  accuracy: number;
  wrongWords: string[];
  timestamp: number;
}

export interface SectionProgress {
  attempts: number;
  lastAccuracy: number;
  bestAccuracy: number;
  lastStudiedAt: number;
}

export interface CardWordState {
  status: 'idle' | 'wrong' | 'revealed' | 'passed';
  hadMistake: boolean;
  lastResult: GradeResult | null;
  lastAttempt?: string;
}

export interface SectionDraft {
  wordOrder: string[];
  inputs: string[];
  cardStates: CardWordState[];
  activeIdx: number;
  updatedAt: number;
}

export interface CorpusPrefs {
  bookId?: string;
  sectionSize?: number;
  accent?: Accent;
  rate?: number;
  shuffled?: boolean;
  mistakeBatchSize?: number;
  mistakeReminderDismissedDate?: string;
}

export interface CorpusPersistedState {
  mistakes: Record<string, MistakeEntry>;
  history: CorpusSessionRecord[];
  customBooks: Record<string, { meta: CorpusBookMeta; words: CorpusWord[] }>;
  sectionProgress: Record<string, SectionProgress>;
  sectionDrafts: Record<string, SectionDraft>;
  prefs: CorpusPrefs;
}

export function sectionProgressKey(bookId: string, sectionSize: number, sectionIndex: number): string {
  return `${bookId}:${sectionSize}:${sectionIndex}`;
}

export function getBookCompletedCount(
  bookId: string,
  totalSections: number,
  sectionSize: number,
  progress: Record<string, SectionProgress>,
): number {
  let done = 0;
  for (let i = 0; i < totalSections; i++) {
    if (progress[sectionProgressKey(bookId, sectionSize, i)]?.attempts > 0) {
      done++;
    }
  }
  return done;
}

export function getSmartNextSection(
  bookId: string,
  totalSections: number,
  sectionSize: number,
  progress: Record<string, SectionProgress>,
): { index: number; reason: 'next_unstudied' | 'lowest_accuracy' } {
  for (let i = 0; i < totalSections; i++) {
    const p = progress[sectionProgressKey(bookId, sectionSize, i)];
    if (!p || p.attempts === 0) {
      return { index: i, reason: 'next_unstudied' };
    }
  }
  // All sections studied: pick the one with the lowest bestAccuracy for targeted review
  let bestIdx = 0;
  let lowestAcc = Infinity;
  for (let i = 0; i < totalSections; i++) {
    const p = progress[sectionProgressKey(bookId, sectionSize, i)];
    const acc = p ? p.bestAccuracy : 0;
    if (acc < lowestAcc) {
      lowestAcc = acc;
      bestIdx = i;
    }
  }
  return { index: bestIdx, reason: 'lowest_accuracy' };
}

const STATE_KEY = 'aboboo-corpus-state-v1';

export function loadCorpusState(): CorpusPersistedState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        mistakes: parsed.mistakes || {},
        history: Array.isArray(parsed.history) ? parsed.history : [],
        customBooks: parsed.customBooks || {},
        sectionProgress: parsed.sectionProgress || {},
        sectionDrafts: parsed.sectionDrafts || {},
        prefs: parsed.prefs || {},
      };
    }
  } catch {
    // ignore storage corruption
  }
  return { mistakes: {}, history: [], customBooks: {}, sectionProgress: {}, sectionDrafts: {}, prefs: {} };
}

export function saveCorpusState(state: CorpusPersistedState) {
  try {
    const raw = JSON.stringify(state);
    localStorage.setItem(STATE_KEY, raw);
    saveStateBackup('corpus_state_v1', raw);
  } catch {
    // ignore quota error
  }
}

export function getLocalDateKey(ts = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface DailyMistakeReminder {
  totalMistakes: number;
  overdueCount: number;
  shouldRemind: boolean;
  today: string;
}

export function getDailyMistakeReminder(
  state: CorpusPersistedState,
  now = Date.now(),
): DailyMistakeReminder {
  const mistakes = Object.values(state.mistakes || {});
  const totalMistakes = mistakes.length;
  const today = getLocalDateKey(now);
  const overdueCount = mistakes.filter((m) => getLocalDateKey(m.lastWrongAt) !== today).length;
  const practicedToday = (state.history || []).some(
    (h) => h.bookId === 'mistakes' && getLocalDateKey(h.timestamp) === today,
  );
  const dismissedToday = state.prefs?.mistakeReminderDismissedDate === today;
  return {
    totalMistakes,
    overdueCount,
    shouldRemind: totalMistakes > 0 && !practicedToday && !dismissedToday,
    today,
  };
}

export function dismissDailyMistakeReminder(now = Date.now()): void {
  const cur = loadCorpusState();
  saveCorpusState({
    ...cur,
    prefs: {
      ...cur.prefs,
      mistakeReminderDismissedDate: getLocalDateKey(now),
    },
  });
}

export function getActiveCorpusDraftSummary(
  state: CorpusPersistedState,
): { sectionTitle: string; doneCount: number; total: number } | null {
  const entries = Object.entries(state.sectionDrafts || {});
  let best: { key: string; draft: SectionDraft } | null = null;
  for (const [key, draft] of entries) {
    if (!draft || !Array.isArray(draft.wordOrder) || !draft.wordOrder.length) continue;
    const hasProgress =
      draft.cardStates.some((s) => s.status !== 'idle') || draft.inputs.some((v) => v.trim().length > 0);
    if (!hasProgress) continue;
    if (!best || (draft.updatedAt || 0) > (best.draft.updatedAt || 0)) {
      best = { key, draft };
    }
  }
  if (!best) return null;
  const doneCount = best.draft.cardStates.filter(
    (s) => s.status === 'passed' || s.status === 'revealed',
  ).length;
  const total = best.draft.wordOrder.length;
  if (best.key === '__mistakes__') {
    return { sectionTitle: '错词专练', doneCount, total };
  }
  const parts = best.key.split(':');
  const secIdx = Number(parts[parts.length - 1]);
  const sectionTitle = Number.isFinite(secIdx) ? `Section ${secIdx + 1}` : '上次小节';
  return { sectionTitle, doneCount, total };
}

// Dynamic Vite glob import for built-in open-source IELTS corpus JSONs.
const builtinModules = import.meta.glob<CorpusWord[]>('../data/corpus/*.json', {
  import: 'default',
});

import manifestData from '../data/corpus/manifest.json';

export function getBuiltinManifest(): CorpusBookMeta[] {
  return manifestData as CorpusBookMeta[];
}

const bookCache = new Map<string, CorpusWord[]>();

export async function loadBookWords(bookId: string, state: CorpusPersistedState): Promise<CorpusWord[]> {
  if (state.customBooks[bookId]) {
    return state.customBooks[bookId].words;
  }
  if (bookCache.has(bookId)) {
    return bookCache.get(bookId)!;
  }
  const key = `../data/corpus/${bookId}.json`;
  const loader = builtinModules[key];
  if (!loader) {
    throw new Error(`未找到词库：${bookId}`);
  }
  const words = await loader();
  bookCache.set(bookId, words);
  return words;
}

let allWordsIndexPromise: Promise<Map<string, CorpusWord>> | null = null;

export async function lookupBuiltinWord(rawWord: string): Promise<CorpusWord | null> {
  const clean = rawWord.trim().replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '').toLowerCase();
  if (!clean) return null;
  if (!allWordsIndexPromise) {
    allWordsIndexPromise = (async () => {
      const idx = new Map<string, CorpusWord>();
      const state = loadCorpusState();
      const manifest = getBuiltinManifest();
      for (const meta of manifest) {
        try {
          const list = await loadBookWords(meta.id, state);
          for (const w of list) {
            const k = w.w.trim().toLowerCase();
            if (k && w.t && !idx.has(k)) idx.set(k, w);
          }
        } catch {
          // skip failed optional book
        }
      }
      return idx;
    })();
  }
  const index = await allWordsIndexPromise;
  return index.get(clean) || null;
}

export function parseCustomWordList(text: string): CorpusWord[] {
  const lines = text.split(/\r?\n/);
  const out: CorpusWord[] = [];
  const seen = new Set<string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Split on tab, comma, or Chinese comma for "word, meaning"
    const m = line.match(/^([A-Za-z][A-Za-z0-9\s\-'.\/]*?)(?:[\t,，]+(.*))?$/);
    if (!m) continue;
    const w = m[1].trim();
    const t = (m[2] || '').trim();
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ w, t });
  }
  return out;
}

// ---------- IELTS Spelling Grading (UK/US compatible, strict plural) ----------

const UK_US_EXACT_PAIRS: [string, string][] = [
  ['travelling', 'traveling'], ['travelled', 'traveled'], ['traveller', 'traveler'],
  ['cancelled', 'canceled'], ['cancelling', 'canceling'],
  ['labelled', 'labeled'], ['labelling', 'labeling'],
  ['modelled', 'modeled'], ['modelling', 'modeling'],
  ['programme', 'program'], ['programmes', 'programs'],
  ['catalogue', 'catalog'], ['catalogues', 'catalogs'],
  ['dialogue', 'dialog'], ['dialogues', 'dialogs'],
  ['licence', 'license'], ['practise', 'practice'],
  ['cheque', 'check'], ['cheques', 'checks'],
  ['defence', 'defense'], ['offence', 'offense'],
  ['centre', 'center'], ['centres', 'centers'],
  ['theatre', 'theater'], ['theatres', 'theaters'],
  ['metre', 'meter'], ['metres', 'meters'],
  ['kilometre', 'kilometer'], ['kilometres', 'kilometers'],
  ['litre', 'liter'], ['litres', 'liters'],
  ['fibre', 'fiber'], ['fibres', 'fibers'],
  ['colour', 'color'], ['colours', 'colors'], ['colourful', 'colorful'],
  ['favour', 'favor'], ['favours', 'favors'], ['favourite', 'favorite'], ['favourites', 'favorites'],
  ['honour', 'honor'], ['honours', 'honors'],
  ['labour', 'labor'], ['neighbour', 'neighbor'], ['neighbours', 'neighbors'], ['neighbourhood', 'neighborhood'],
  ['behaviour', 'behavior'], ['behaviours', 'behaviors'],
  ['flavour', 'flavor'], ['flavours', 'flavors'],
  ['humour', 'humor'], ['rumour', 'rumor'], ['vapour', 'vapor'], ['harbour', 'harbor'],
  ['grey', 'gray'], ['tyre', 'tire'], ['tyres', 'tires'],
  ['aeroplane', 'airplane'], ['aeroplanes', 'airplanes'],
  ['jewellery', 'jewelry'], ['pyjamas', 'pajamas'],
  ['skilful', 'skillful'], ['fulfil', 'fulfill'], ['enrol', 'enroll'], ['enrolment', 'enrollment'],
  ['ageing', 'aging'], ['judgement', 'judgment'], ['acknowledgement', 'acknowledgment'],
  ['storey', 'story'], ['storeys', 'stories'], ['plough', 'plow'], ['mould', 'mold'],
  ['encyclopaedia', 'encyclopedia'], ['paediatric', 'pediatric'], ['anaesthesia', 'anesthesia'],
  ['archaeology', 'archeology'], ['manoeuvre', 'maneuver'], ['omelette', 'omelet'],
];

const UK_US_MAP = new Map<string, string>();
for (const [uk, us] of UK_US_EXACT_PAIRS) {
  UK_US_MAP.set(uk, us);
  UK_US_MAP.set(us, us);
}

function normalizeToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ');
}

function canonicalizeBritishAmerican(word: string): string {
  const parts = word.split(' ').map((part) => {
    if (UK_US_MAP.has(part)) return UK_US_MAP.get(part)!;
    // Generic -ise/-ize, -isation/-ization, -yse/-yze
    if (part.endsWith('isation') && part.length > 8) return part.slice(0, -7) + 'ization';
    if (part.endsWith('isations') && part.length > 9) return part.slice(0, -8) + 'izations';
    if (part.endsWith('ised') && part.length > 5) return part.slice(0, -4) + 'ized';
    if (part.endsWith('ising') && part.length > 6) return part.slice(0, -5) + 'izing';
    if (part.endsWith('ise') && part.length > 5 && !['arise', 'advise', 'revise', 'supervise', 'exercise', 'surprise', 'promise', 'comprise', 'disguise', 'enterprise', 'otherwise', 'precise', 'concise', 'franchise', 'merchandise'].includes(part)) {
      return part.slice(0, -3) + 'ize';
    }
    if (part.endsWith('yse') && part.length > 4) return part.slice(0, -3) + 'yze';
    return part;
  });
  return parts.join(' ');
}

export interface CharDiff {
  ch: string;
  kind: 'ok' | 'wrong' | 'missing' | 'extra';
}

export interface GradeResult {
  correct: boolean;
  ukUsVariant?: boolean;
  expected: string;
  actual: string;
  diff: CharDiff[];
}

export function gradeWord(input: string, target: string): GradeResult {
  const actual = normalizeToken(input);
  const variants = target
    .split(/[/|]/)
    .map((v) => normalizeToken(v))
    .filter(Boolean);

  if (variants.includes(actual)) {
    return { correct: true, expected: target, actual, diff: [] };
  }

  const canonActual = canonicalizeBritishAmerican(actual);
  for (const v of variants) {
    if (canonicalizeBritishAmerican(v) === canonActual) {
      return { correct: true, ukUsVariant: true, expected: target, actual, diff: [] };
    }
    // Also allow hyphen vs space equivalence (e.g. "check-in" vs "check in")
    if (v.replace(/-/g, ' ') === actual.replace(/-/g, ' ')) {
      return { correct: true, expected: target, actual, diff: [] };
    }
  }

  const primary = variants[0] || normalizeToken(target);
  return {
    correct: false,
    expected: target,
    actual,
    diff: buildCharDiff(actual, primary),
  };
}

function buildCharDiff(actual: string, expected: string): CharDiff[] {
  const m = actual.length;
  const n = expected.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = actual[i] === expected[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: CharDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (actual[i] === expected[j]) {
      out.push({ ch: expected[j], kind: 'ok' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ ch: actual[i], kind: 'extra' });
      i++;
    } else {
      out.push({ ch: expected[j], kind: 'missing' });
      j++;
    }
  }
  while (i < m) out.push({ ch: actual[i++], kind: 'extra' });
  while (j < n) out.push({ ch: expected[j++], kind: 'missing' });
  return out;
}

export function estimateIeltsBand(accuracyPct: number): string {
  if (accuracyPct >= 95) return '8.5 - 9.0';
  if (accuracyPct >= 90) return '8.0';
  if (accuracyPct >= 85) return '7.5';
  if (accuracyPct >= 78) return '7.0';
  if (accuracyPct >= 70) return '6.5';
  if (accuracyPct >= 60) return '6.0';
  return '5.5 及以下';
}

// ---------- Audio Fetch + Local Cache + Playback ----------

interface CorpusAudioResult {
  bytes: number[];
  mime: string;
  source: string;
}

const audioUrlCache = new Map<string, { url: string; bytes: Uint8Array; mime: string }>();
const inflightAudio = new Map<string, Promise<{ url: string; bytes: Uint8Array; mime: string }>>();

export async function getWordAudio(word: string, accent: Accent): Promise<{ url: string; bytes: Uint8Array; mime: string }> {
  const key = `${accent}:${word.trim().toLowerCase()}`;
  const cached = audioUrlCache.get(key);
  if (cached) return cached;

  const existing = inflightAudio.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const res = await invoke<CorpusAudioResult>('corpus_fetch_audio', {
        word: word.trim(),
        accent,
      });
      const bytes = new Uint8Array(res.bytes);
      const blob = new Blob([bytes], { type: res.mime || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const entry = { url, bytes, mime: res.mime || 'audio/mpeg' };
      audioUrlCache.set(key, entry);
      return entry;
    } catch (nativeErr) {
      const url = await proxyTts(word.trim(), accent, undefined, '词卡发音').catch(() => {
        throw nativeErr;
      });
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      const bytes = new Uint8Array(buf);
      const entry = { url, bytes, mime: 'audio/mpeg' };
      audioUrlCache.set(key, entry);
      return entry;
    }
  })().finally(() => {
    inflightAudio.delete(key);
  });

  inflightAudio.set(key, promise);
  return promise;
}

export function preloadWordAudio(words: CorpusWord[], startIndex: number, accent: Accent, count = 3) {
  for (let i = startIndex; i < Math.min(words.length, startIndex + count); i++) {
    getWordAudio(words[i].w, accent).catch(() => {});
  }
}

// ---------- Export: Mistakes CSV (Excel) & Combined Mistakes WAV ----------

function csvEscape(val: string): string {
  if (/[",\n\r]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export async function exportMistakesCsv(entries: MistakeEntry[], defaultName = 'ielts-mistakes.csv'): Promise<boolean> {
  if (!entries.length) return false;
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: 'Excel CSV', extensions: ['csv'] }],
  });
  if (!path) return false;

  const header = ['单词', '英式音标', '美式音标', '中文释义', '来源词库', '错误次数'];
  const rows = entries.map((e) => [
    csvEscape(e.w),
    csvEscape(e.uk || ''),
    csvEscape(e.us || ''),
    csvEscape(e.t || ''),
    csvEscape(e.bookTitle || ''),
    String(e.count || 1),
  ].join(','));

  // UTF-8 BOM ensures Excel opens Chinese characters cleanly without garbled text.
  const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n');
  await writeFile(path, new TextEncoder().encode(csv));
  return true;
}

export function encodeWavMono16(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export async function exportMistakesAudio(
  words: string[],
  accent: Accent,
  pauseSec = 1.2,
  defaultName = 'ielts-mistakes-audio.wav',
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  if (!words.length) return false;
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: 'WAV 音频', extensions: ['wav'] }],
  });
  if (!path) return false;

  const targetRate = 22050;
  const ctx = new AudioContext({ sampleRate: targetRate });
  try {
    const chunks: Float32Array[] = [];
    const silence = new Float32Array(Math.floor(targetRate * pauseSec));

    for (let idx = 0; idx < words.length; idx++) {
      onProgress?.(idx + 1, words.length);
      const { bytes } = await getWordAudio(words[idx], accent);
      const ab = bytes.slice().buffer as ArrayBuffer;
      const decoded = await ctx.decodeAudioData(ab);

      // Mix to mono & resample if needed via OfflineAudioContext
      let mono: Float32Array;
      if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
        mono = decoded.getChannelData(0);
      } else {
        const outLen = Math.ceil(decoded.duration * targetRate);
        const offline = new OfflineAudioContext(1, outLen, targetRate);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        mono = rendered.getChannelData(0);
      }
      chunks.push(mono);
      chunks.push(silence);
    }

    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Float32Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.length;
    }

    const wavBytes = encodeWavMono16(merged, targetRate);
    await writeFile(path, wavBytes);
    return true;
  } finally {
    await ctx.close();
  }
}

export function addMistakeToWordBook(word: string, sourceTitle: string, meaning?: string): boolean {
  const clean = word.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'-]+$/g, '');
  if (!clean) return false;
  const state = loadCorpusState();
  const key = clean.toLowerCase();
  const existing = state.mistakes[key];
  state.mistakes[key] = {
    w: existing?.w || clean,
    t: existing?.t || (meaning ? meaning.trim() : ''),
    uk: existing?.uk,
    us: existing?.us,
    bookId: existing?.bookId || 'listening_mistakes',
    bookTitle: existing?.bookTitle || sourceTitle || '听力精听错词',
    count: (existing?.count || 0) + 1,
    lastWrongAt: Date.now(),
  };
  saveCorpusState(state);
  return !existing;
}

export const SAVED_WORDS_BOOK_ID = 'my_saved_words';

export function addSavedWordToCollection(
  word: string,
  meaning?: string,
  phonetic?: string,
): { added: boolean; total: number } {
  const clean = word.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'-]+$/g, '');
  if (!clean) return { added: false, total: 0 };
  const state = loadCorpusState();
  const existingBook = state.customBooks[SAVED_WORDS_BOOK_ID];
  const prevWords = existingBook ? [...existingBook.words] : [];
  const key = clean.toLowerCase();
  const idx = prevWords.findIndex((w) => w.w.toLowerCase() === key);
  const cleanMeaning = meaning ? meaning.trim() : '';
  const cleanPhonetic = phonetic ? phonetic.replace(/^\/+|\/+$/g, '').trim() : '';
  let added = false;

  if (idx >= 0) {
    const old = prevWords[idx];
    prevWords[idx] = {
      ...old,
      t: old.t || cleanMeaning,
      uk: old.uk || cleanPhonetic || undefined,
      us: old.us || cleanPhonetic || undefined,
    };
  } else {
    prevWords.unshift({
      w: clean,
      t: cleanMeaning,
      uk: cleanPhonetic || undefined,
      us: cleanPhonetic || undefined,
    });
    added = true;
  }

  state.customBooks[SAVED_WORDS_BOOK_ID] = {
    meta: {
      id: SAVED_WORDS_BOOK_ID,
      title: '我的收藏',
      desc: '对话与学习中收藏的生词',
      count: prevWords.length,
      custom: true,
    },
    words: prevWords,
  };
  saveCorpusState(state);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('lirio-corpus-updated'));
  }
  return { added, total: prevWords.length };
}
