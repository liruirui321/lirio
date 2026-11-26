import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import type { Project } from '../types/project';
import { getAccountState, proxyTranscribe } from './accountService';
import { audioEngine } from './audioEngine';
import { sentences } from './dictation';
import { projectService } from './projectService';
import { proofreadDictationSentences } from './speakService';

export type ImportTierChoice = 'auto' | 'L1' | 'L2' | 'L3' | 'L4';
export type ImportStep = 'decode' | 'transcribe' | 'polish' | 'save' | 'ready';

export interface ImportAiPolishOption {
  enabled: boolean;
  fixText?: boolean;
  addTranslation?: boolean;
}

export interface ImportProgress {
  step: ImportStep;
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  stage: string;
  sentenceCount?: number;
  polishedDone?: number;
  polishedTotal?: number;
}

export interface PreparedImportPreviewLine {
  id: string;
  start: number;
  end: number;
  rawText: string;
  text: string;
  translation?: string;
  changed: boolean;
}

export interface PreparedImportItem {
  project: Project;
  blob: Blob;
  trackId: string;
  title: string;
  duration: number;
  sentenceCount: number;
  changedCount: number;
  translatedCount: number;
  aiPolished: boolean;
  source: string;
  previewLines: PreparedImportPreviewLine[];
}

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  ogg: 'audio/ogg',
};

function detectSpeechSpans16kWav(wavBytes: Uint8Array): Array<[number, number]> {
  if (wavBytes.length < 46) return [];
  const totalSamples = Math.floor((wavBytes.length - 44) / 2);
  if (totalSamples < 6400) return [];
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);

  const rawSpans: Array<[number, number]> = [];
  let first: number | null = null;
  let last = 0;

  // Frame size = 20ms (320 samples @ 16kHz); RMS > 0.001 threshold => power > 1074
  for (let offset = 0; offset < totalSamples; offset += 320) {
    const end = Math.min(offset + 320, totalSamples);
    let powerSum = 0;
    for (let i = offset; i < end; i++) {
      const s = view.getInt16(44 + i * 2, true);
      powerSum += s * s;
    }
    const power = powerSum / Math.max(1, end - offset);
    if (power > 1074) {
      if (first === null) first = offset;
      last = end;
    } else if (first !== null && offset - last >= 24000) {
      // Split on >= 1.5s silence
      rawSpans.push([Math.max(0, first - 4000), Math.min(totalSamples, last + 4000)]);
      first = null;
    }
  }
  if (first !== null) {
    rawSpans.push([Math.max(0, first - 4000), Math.min(totalSamples, last + 4000)]);
  }

  // Cap individual cloud chunks at 25s (400,000 samples) so ASR stays snappy
  const MAX_CHUNK = 16000 * 25;
  const finalSpans: Array<[number, number]> = [];
  for (const [a, b] of rawSpans) {
    if (b - a < 6400) continue;
    for (let cur = a; cur < b; cur += MAX_CHUNK) {
      const sliceEnd = Math.min(b, cur + MAX_CHUNK);
      if (sliceEnd - cur >= 6400) finalSpans.push([cur, sliceEnd]);
    }
  }
  return finalSpans;
}

function sliceWav16k(wavBytes: Uint8Array, startSample: number, endSample: number): Uint8Array {
  const byteStart = 44 + startSample * 2;
  const byteEnd = 44 + endSample * 2;
  const pcmLen = Math.max(0, byteEnd - byteStart);
  const clip = new Uint8Array(44 + pcmLen);
  clip.set(wavBytes.subarray(0, 44), 0);
  const dv = new DataView(clip.buffer);
  dv.setUint32(4, pcmLen + 36, true);
  dv.setUint32(40, pcmLen, true);
  clip.set(wavBytes.subarray(byteStart, byteEnd), 44);
  return clip;
}

async function transcribeViaCloudSpans(
  wavBytes: Uint8Array,
  signal: { cancelled: boolean } | undefined,
  onProgress: (done: number, total: number) => void,
): Promise<{
  segments: Array<{ start: number; end: number; text: string }>;
  source: string;
}> {
  const spans = detectSpeechSpans16kWav(wavBytes);
  if (!spans.length) {
    throw new Error('没有检测到可识别的清晰语音，请检查音频音量。');
  }
  const segments: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < spans.length; i++) {
    if (signal?.cancelled) {
      throw new Error('已取消导入处理。');
    }
    onProgress(i + 1, spans.length);
    const [a, b] = spans[i];
    const clip = sliceWav16k(wavBytes, a, b);
    try {
      const text = await proxyTranscribe(clip, '音频导入云端识别');
      const cleaned = String(text || '').trim();
      if (cleaned) {
        segments.push({ start: a / 16000, end: b / 16000, text: cleaned });
      }
    } catch {
      // Continue remaining chunks if one short clip fails
    }
  }
  return { segments, source: '云端语音识别' };
}

export async function prepareAudioFilesForImport(opts: {
  paths: string[];
  language: string;
  tier: ImportTierChoice;
  sourceKind?: 'user' | 'podcast';
  aiPolish?: ImportAiPolishOption;
  signal?: { cancelled: boolean };
  onProgress: (p: ImportProgress) => void;
}): Promise<{ prepared: PreparedImportItem[]; warnings: string[] }> {
  const { paths, language, tier, sourceKind = 'user', aiPolish, signal, onProgress } = opts;
  const prepared: PreparedImportItem[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < paths.length; i++) {
    if (signal?.cancelled) {
      throw new Error('已取消导入处理。');
    }
    const filePath = paths[i];
    const isContentUri = filePath.startsWith('content://');
    let decodedTail = filePath;
    if (isContentUri) {
      try {
        decodedTail = decodeURIComponent(filePath);
      } catch {}
    }
    const baseWithExt = decodedTail.split(/[/:\\]/).pop() || `Audio-${i + 1}`;
    const rawName = baseWithExt.replace(/\.[^/.]+$/, '');
    const ext = baseWithExt.split('.').pop()?.toLowerCase() || '';
    const hasTierPrefix = /^\[(L[1-4])\]/i.test(rawName);
    const finalTitle =
      sourceKind === 'podcast' && tier !== 'auto' && !hasTierPrefix
        ? `[${tier}] ${rawName}`
        : rawName;

    let currentStage = '正在解码音频…';
    const emit = (
      step: ImportStep,
      stage: string,
      extra?: Partial<Pick<ImportProgress, 'sentenceCount' | 'polishedDone' | 'polishedTotal'>>,
    ) => {
      currentStage = stage;
      onProgress({
        step,
        fileIndex: i + 1,
        totalFiles: paths.length,
        fileName: rawName,
        stage,
        ...extra,
      });
    };

    let unlisten: (() => void) | undefined;
    try {
      emit('decode', '正在检查并解码音频…');
      if (!isContentUri) {
        await invoke('inspect_audio_file', { path: filePath });
      }
      const bytes = await readFile(filePath);
      if (signal?.cancelled) throw new Error('已取消导入处理。');
      const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
      const blob = new Blob([bytes], { type: mime });
      const arrayBuffer = await blob.arrayBuffer();

      const project = projectService.createProject(finalTitle, filePath, 0);
      project.sourceKind = sourceKind;
      const trackId = project.tracks[0].id;
      const duration = await audioEngine.loadAudio(trackId, arrayBuffer);
      project.duration = duration;
      project.tracks[0].duration = duration;

      emit('transcribe', '正在提取 16kHz 语音并自动分句…');
      const wavBytes = await audioEngine.exportWav(trackId);
      if (signal?.cancelled) throw new Error('已取消导入处理。');

      unlisten = await listen<string>('transcription-progress', (ev) => {
        if (ev.payload && ev.payload !== currentStage) {
          emit('transcribe', ev.payload);
        }
      });

      let result: {
        segments: Array<{ start: number; end: number; text: string }>;
        words?: Array<{ start: number; end: number; text: string }>;
        source: string;
      };

      try {
        const asrId = crypto.randomUUID();
        const cacheDir = await appCacheDir();
        await mkdir(cacheDir, { recursive: true });
        await writeFile(await join(cacheDir, `asr-input-${asrId}.wav`), wavBytes);
        result = await invoke('transcribe_audio', { id: asrId, language });
      } catch (localErr) {
        const msg = String(localErr);
        const missingOffline = /离线识别组件缺失|model\.bin|whisper-cli/i.test(msg);
        if (missingOffline && getAccountState().token) {
          result = await transcribeViaCloudSpans(wavBytes, signal, (done, total) => {
            emit('transcribe', `正在云端识别语音片段 ${done}/${total}…`);
          });
        } else {
          throw localErr;
        }
      }

      if (signal?.cancelled) throw new Error('已取消导入处理。');

      const list = sentences(result.segments, duration, result.words);
      if (!list.length) {
        throw new Error(`「${rawName}」未识别出有效英文/语音句子。`);
      }

      const trimmedSentences = list.map((s) => {
        const span = audioEngine.trimSilence(trackId, s.start, s.end);
        return {
          ...s,
          start: span.start,
          end: span.end,
        };
      });

      const rawTexts = new Map(trimmedSentences.map((s) => [s.id, s.text]));
      let finalSentences = trimmedSentences;
      let finalSource = result.source;
      let aiPolished = false;
      let changedCount = 0;
      let translatedCount = 0;

      if (aiPolish?.enabled && trimmedSentences.length > 0) {
        emit('polish', `已切分 ${trimmedSentences.length} 句，正在提交 AI 精校…`, {
          sentenceCount: trimmedSentences.length,
          polishedDone: 0,
          polishedTotal: trimmedSentences.length,
        });
        try {
          const polishRes = await proofreadDictationSentences(
            trimmedSentences.map((s) => ({ id: s.id, text: s.text, translation: s.translation })),
            {
              fixText: aiPolish.fixText ?? true,
              addTranslation: aiPolish.addTranslation ?? true,
              materialTitle: finalTitle,
              signal,
              onProgress: (done, total, bIdx, bTotal) => {
                emit('polish', `正在 AI 精校字幕（第 ${bIdx}/${bTotal} 批，${done}/${total} 句）…`, {
                  sentenceCount: trimmedSentences.length,
                  polishedDone: done,
                  polishedTotal: total,
                });
              },
            },
          );
          finalSentences = trimmedSentences.map((s) => {
            const patch = polishRes.updates.get(s.id);
            if (!patch) return s;
            return {
              ...s,
              text: patch.text !== undefined ? patch.text : s.text,
              translation: patch.translation !== undefined ? patch.translation : s.translation,
            };
          });
          changedCount = polishRes.changedCount;
          translatedCount = polishRes.translatedCount;
          aiPolished = true;
          finalSource = `${result.source} · AI 精校`;
        } catch (aiErr) {
          if (signal?.cancelled) throw aiErr;
          const reason = aiErr instanceof Error ? aiErr.message : String(aiErr);
          warnings.push(`「${rawName}」已完成识别分句，但 AI 精校未完成（保留原始识别字幕）：${reason}`);
        }
      }

      project.dictation = {
        sentences: finalSentences,
        index: 0,
        source: finalSource,
        aiPolished,
        words: result.words,
        segmentationVersion: 3,
      };

      const previewLines: PreparedImportPreviewLine[] = finalSentences.map((s) => {
        const rawText = rawTexts.get(s.id) ?? s.text;
        return {
          id: s.id,
          start: s.start,
          end: s.end,
          rawText,
          text: s.text,
          translation: s.translation,
          changed: s.text.trim() !== rawText.trim(),
        };
      });

      prepared.push({
        project,
        blob,
        trackId,
        title: finalTitle,
        duration,
        sentenceCount: finalSentences.length,
        changedCount,
        translatedCount,
        aiPolished,
        source: finalSource,
        previewLines,
      });
    } finally {
      unlisten?.();
    }
  }

  return { prepared, warnings };
}

export async function commitPreparedImportsToLibrary(
  items: PreparedImportItem[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ importedIds: string[]; lastLibraryId: string | null }> {
  const importedIds: string[] = [];
  let lastLibraryId: string | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cleanTitle = item.title.trim() || item.project.name;
    const finalProject: Project = { ...item.project, name: cleanTitle };

    onProgress?.({
      step: 'save',
      fileIndex: i + 1,
      totalFiles: items.length,
      fileName: cleanTitle,
      stage: `正在写入材料库（共 ${item.sentenceCount} 句）…`,
      sentenceCount: item.sentenceCount,
    });

    const serialized = await projectService.serialize(finalProject, new Map([[item.trackId, item.blob]]));
    const libraryId = await invoke<string>('library_add', { document: serialized });
    importedIds.push(libraryId);
    lastLibraryId = libraryId;
    audioEngine.retainBuffers([item.trackId]);
  }

  return { importedIds, lastLibraryId };
}

export async function importAudioFilesToLibrary(opts: {
  paths: string[];
  language: string;
  tier: ImportTierChoice;
  sourceKind?: 'user' | 'podcast';
  aiPolish?: ImportAiPolishOption;
  signal?: { cancelled: boolean };
  onProgress: (p: ImportProgress) => void;
}): Promise<{ importedIds: string[]; lastLibraryId: string | null; warnings: string[] }> {
  const { prepared, warnings } = await prepareAudioFilesForImport(opts);
  const { importedIds, lastLibraryId } = await commitPreparedImportsToLibrary(prepared, opts.onProgress);
  return { importedIds, lastLibraryId, warnings };
}
