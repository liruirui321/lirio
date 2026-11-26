import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { audioEngine } from './audioEngine';
import { sentences } from './dictation';
import { projectService } from './projectService';
import { proofreadDictationSentences } from './speakService';

export type ImportTierChoice = 'auto' | 'L1' | 'L2' | 'L3' | 'L4';

export interface ImportAiPolishOption {
  enabled: boolean;
  fixText?: boolean;
  addTranslation?: boolean;
}

export interface ImportProgress {
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  stage: string;
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

export async function importAudioFilesToLibrary(opts: {
  paths: string[];
  language: string;
  tier: ImportTierChoice;
  aiPolish?: ImportAiPolishOption;
  onProgress: (p: ImportProgress) => void;
}): Promise<{ importedIds: string[]; lastLibraryId: string | null; warnings: string[] }> {
  const { paths, language, tier, aiPolish, onProgress } = opts;
  const importedIds: string[] = [];
  const warnings: string[] = [];
  let lastLibraryId: string | null = null;

  for (let i = 0; i < paths.length; i++) {
    const filePath = paths[i];
    const baseWithExt = filePath.split(/[/\\]/).pop() || `Audio-${i + 1}`;
    const rawName = baseWithExt.replace(/\.[^/.]+$/, '');
    const ext = baseWithExt.split('.').pop()?.toLowerCase() || '';
    const hasTierPrefix = /^\[(L[1-4])\]/i.test(rawName);
    const finalTitle = tier !== 'auto' && !hasTierPrefix ? `[${tier}] ${rawName}` : rawName;

    let currentStage = '正在检查并解码音频…';
    const emitStage = (stage: string) => {
      currentStage = stage;
      onProgress({
        fileIndex: i + 1,
        totalFiles: paths.length,
        fileName: rawName,
        stage,
      });
    };

    let unlisten: (() => void) | undefined;
    try {
      emitStage('正在检查并解码音频…');
      await invoke('inspect_audio_file', { path: filePath });
      const bytes = await readFile(filePath);
      const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
      const blob = new Blob([bytes], { type: mime });
      const arrayBuffer = await blob.arrayBuffer();

      const project = projectService.createProject(finalTitle, filePath, 0);
      const trackId = project.tracks[0].id;
      const duration = await audioEngine.loadAudio(trackId, arrayBuffer);
      project.duration = duration;
      project.tracks[0].duration = duration;

      emitStage('正在提取 16kHz 语音并识别字幕…');
      const wavBytes = await audioEngine.exportWav(trackId);
      const asrId = crypto.randomUUID();
      const cacheDir = await appCacheDir();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(await join(cacheDir, `asr-input-${asrId}.wav`), wavBytes);

      unlisten = await listen<string>('transcription-progress', (ev) => {
        if (ev.payload && ev.payload !== currentStage) {
          emitStage(ev.payload);
        }
      });

      const result = await invoke<{
        segments: Array<{ start: number; end: number; text: string }>;
        words?: Array<{ start: number; end: number; text: string }>;
        source: string;
      }>('transcribe_audio', { id: asrId, language });

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

      let finalSentences = trimmedSentences;
      let finalSource = result.source;
      let aiPolished = false;

      if (aiPolish?.enabled && trimmedSentences.length > 0) {
        try {
          const polishRes = await proofreadDictationSentences(
            trimmedSentences.map((s) => ({ id: s.id, text: s.text, translation: s.translation })),
            {
              fixText: aiPolish.fixText ?? true,
              addTranslation: aiPolish.addTranslation ?? true,
              materialTitle: finalTitle,
              onProgress: (done, total, bIdx, bTotal) => {
                emitStage(`正在 AI 精校字幕（第 ${bIdx}/${bTotal} 批，${done}/${total} 句）…`);
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
          aiPolished = true;
          finalSource = `${result.source} · AI 精校`;
        } catch (aiErr) {
          const reason = aiErr instanceof Error ? aiErr.message : String(aiErr);
          warnings.push(`「${rawName}」已完成本机离线识别入库，但 AI 精校跳过：${reason}`);
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

      emitStage(`正在写入材料库（共 ${finalSentences.length} 句）…`);
      const serialized = await projectService.serialize(project, new Map([[trackId, blob]]));
      const libraryId = await invoke<string>('library_add', { document: serialized });
      importedIds.push(libraryId);
      lastLibraryId = libraryId;
      audioEngine.retainBuffers([trackId]);
    } finally {
      unlisten?.();
    }
  }

  return { importedIds, lastLibraryId, warnings };
}
