import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { encodeWavMono16 } from './corpusService';
import { loadSpeakState, synthesizeSpeech } from './speakService';
import type { Project, Sentence } from '../types/project';

export const SAVED_SENTENCES_LIBRARY_ID = '00000000-0000-4000-8000-5a7ed5e47e01';
const SAVED_SENTENCES_NAME = '我收藏的句子';
const TARGET_RATE = 22050;
const GAP_SECONDS = 0.55;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function decodeBytesToMono22k(ctx: AudioContext, bytes: Uint8Array): Promise<Float32Array> {
  const ab = bytes.slice().buffer as ArrayBuffer;
  const decoded = await ctx.decodeAudioData(ab);
  if (decoded.sampleRate === TARGET_RATE && decoded.numberOfChannels === 1) {
    return new Float32Array(decoded.getChannelData(0));
  }
  const outLen = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, outLen, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

export async function addSavedSentenceToLibrary(
  rawText: string,
  translation?: string,
): Promise<{ added: boolean; total: number }> {
  const cleanText = rawText.replace(/\s+/g, ' ').trim();
  if (!cleanText) return { added: false, total: 0 };
  const cleanTrans = (translation || '').trim();

  type StoredDoc = Project & {
    format?: string;
    embeddedAudio?: Record<string, { data: string; mime: string }>;
  };

  let existingDoc: StoredDoc | null = null;
  try {
    const raw = await invoke<string>('library_open', { id: SAVED_SENTENCES_LIBRARY_ID });
    existingDoc = JSON.parse(raw) as StoredDoc;
  } catch {
    existingDoc = null;
  }

  const prevSentences: Sentence[] = Array.isArray(existingDoc?.dictation?.sentences)
    ? [...existingDoc!.dictation!.sentences]
    : [];

  const normKey = cleanText.toLowerCase();
  const dupIdx = prevSentences.findIndex((s) => s.text.replace(/\s+/g, ' ').trim().toLowerCase() === normKey);
  if (dupIdx >= 0 && existingDoc) {
    if (cleanTrans && !prevSentences[dupIdx].translation) {
      prevSentences[dupIdx] = { ...prevSentences[dupIdx], translation: cleanTrans };
      const updatedDoc: StoredDoc = {
        ...existingDoc,
        name: SAVED_SENTENCES_NAME,
        metadata: { ...existingDoc.metadata, updatedAt: new Date().toISOString() },
        dictation: {
          ...existingDoc.dictation!,
          sentences: prevSentences,
        },
      };
      await invoke('library_add', { document: JSON.stringify(updatedDoc) });
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('lirio-library-updated'));
    }
    return { added: false, total: prevSentences.length };
  }

  const accent = loadSpeakState().config.accent || 'us';
  const ttsUrl = await synthesizeSpeech(cleanText, accent);
  let ttsBytes: Uint8Array;
  try {
    const resp = await fetch(ttsUrl);
    ttsBytes = new Uint8Array(await resp.arrayBuffer());
  } finally {
    URL.revokeObjectURL(ttsUrl);
  }

  const ctx = new AudioContext({ sampleRate: TARGET_RATE });
  let mergedSamples: Float32Array;
  let segStartSec = 0;
  let segEndSec = 0;

  try {
    const newSamples = await decodeBytesToMono22k(ctx, ttsBytes);
    const clipSec = newSamples.length / TARGET_RATE;

    const prevTrack = existingDoc?.tracks?.[0];
    const prevEmbedded = prevTrack ? existingDoc?.embeddedAudio?.[prevTrack.id] : undefined;
    if (prevEmbedded?.data && prevSentences.length > 0) {
      const prevSamples = await decodeBytesToMono22k(ctx, base64ToUint8(prevEmbedded.data));
      const gap = new Float32Array(Math.floor(TARGET_RATE * GAP_SECONDS));
      segStartSec = Math.round(((prevSamples.length + gap.length) / TARGET_RATE) * 100) / 100;
      segEndSec = Math.round((segStartSec + clipSec) * 100) / 100;
      mergedSamples = new Float32Array(prevSamples.length + gap.length + newSamples.length);
      mergedSamples.set(prevSamples, 0);
      mergedSamples.set(gap, prevSamples.length);
      mergedSamples.set(newSamples, prevSamples.length + gap.length);
    } else {
      segStartSec = 0;
      segEndSec = Math.round(clipSec * 100) / 100;
      mergedSamples = newSamples;
    }
  } finally {
    await ctx.close();
  }

  const wavBytes = encodeWavMono16(mergedSamples, TARGET_RATE);
  const totalDuration = Math.round((mergedSamples.length / TARGET_RATE) * 100) / 100;
  const trackId = existingDoc?.tracks?.[0]?.id || uuidv4();
  const nowIso = new Date().toISOString();

  const nextSentences: Sentence[] = [
    ...prevSentences,
    {
      id: uuidv4(),
      start: segStartSec,
      end: Math.max(segStartSec + 0.3, segEndSec),
      text: cleanText,
      translation: cleanTrans,
      answer: '',
      submitted: false,
      revealed: false,
      attempts: 0,
    },
  ];

  const doc: StoredDoc = {
    id: SAVED_SENTENCES_LIBRARY_ID,
    name: SAVED_SENTENCES_NAME,
    originalAudioPath: existingDoc?.originalAudioPath || `${SAVED_SENTENCES_LIBRARY_ID}.wav`,
    duration: totalDuration,
    tracks: [
      {
        id: trackId,
        type: 'original',
        name: 'Original',
        audioPath: `${trackId}.wav`,
        startTime: 0,
        duration: totalDuration,
        volume: 1,
        muted: false,
      },
    ],
    metadata: {
      createdAt: existingDoc?.metadata?.createdAt || nowIso,
      updatedAt: nowIso,
    },
    format: 'aboboo-community-v1',
    embeddedAudio: {
      [trackId]: {
        data: uint8ToBase64(wavBytes),
        mime: 'audio/wav',
      },
    },
    favorites: existingDoc?.favorites || [],
    dictation: {
      sentences: nextSentences,
      index: existingDoc?.dictation?.index ?? 0,
      source: existingDoc?.dictation?.source || 'ai',
      aiPolished: true,
    },
  };

  await invoke('library_add', { document: JSON.stringify(doc) });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('lirio-library-updated'));
  }
  return { added: true, total: nextSentences.length };
}
