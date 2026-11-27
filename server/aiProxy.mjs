import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_URLS = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

const DEFAULT_MODELS = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

function redactSecretText(raw) {
  return String(raw || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/https?:\/\/\S+/gi, '[upstream]');
}

function sanitizeUpstreamError(tag, detail, publicMsg) {
  console.error(`[${tag}]`, redactSecretText(detail));
  return new Error(publicMsg);
}

function isMockMode() {
  return process.env.LIRIO_MOCK_AI === '1' || process.env.LIRIO_MOCK_AI === 'true';
}

function estimateTokens(text) {
  return Math.max(8, Math.ceil(String(text || '').length / 3.2));
}

export async function forwardChatCompletion({ messages, temperature = 0.7, maxTokens }) {
  const provider = (process.env.LIRIO_LLM_PROVIDER || 'deepseek').toLowerCase();
  const model = process.env.LIRIO_LLM_MODEL || DEFAULT_MODELS[provider] || 'deepseek-chat';
  const baseUrl = (process.env.LIRIO_LLM_BASE_URL || DEFAULT_URLS[provider] || DEFAULT_URLS.deepseek).replace(/\/+$/, '');
  const apiKey =
    (process.env.LIRIO_LLM_API_KEY || '').trim() ||
    (provider === 'deepseek' ? (process.env.DEEPSEEK_API_KEY || '').trim() : '');
  const safeMaxTokens = Math.min(Math.max(64, Number(maxTokens) || 1200), 2048);

  if (isMockMode()) {
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
    const promptTokens = estimateTokens(JSON.stringify(messages || []));
    const sysText = String(messages?.[0]?.content || '');
    let content = "That makes a lot of sense! Tell me a bit more about what stood out to you.";
    if (/字幕精校|"items"/i.test(sysText)) {
      const arrMatch = lastUser.match(/\[[\s\S]*\]/);
      let parsedRows = [];
      if (arrMatch) {
        try {
          const arr = JSON.parse(arrMatch[0]);
          if (Array.isArray(arr)) parsedRows = arr;
        } catch {}
      }
      const items = parsedRows.map((row, idx) => {
        const rawText = String(row?.t || '').trim();
        const normText = rawText
          ? rawText.charAt(0).toUpperCase() + rawText.slice(1)
          : `Sample sentence ${idx + 1}.`;
        return {
          i: Number(row?.i) || idx + 1,
          t: normText,
          zh: `（测试译文）${normText.slice(0, 28)}`,
        };
      });
      content = JSON.stringify({ items });
    } else if (/qaPolishes|takeaways|headline|phonetic/i.test(sysText)) {
      if (/phonetic/.test(sysText)) {
        content = JSON.stringify({ phonetic: '/səˈsteɪnəbl/', meaning: 'adj. 可持续的', note: '高频环保与经济话题词' });
      } else if (/headline/.test(sysText)) {
        content = JSON.stringify({
          headline: '当前主要失分在弱读虚词与连读吞音',
          patterns: ['介词/冠词弱读漏听', '辅音结尾与元音开头的连读边界'],
          nextActions: ['对错句开启 0.75x 慢速二听', '把漏写高频实词收进错词本巩固'],
        });
      } else {
        content = JSON.stringify({
          summary: '整体交流流畅自然，能够给出具体细节并保持连贯展开。',
          qaPolishes: [{
            question: 'Sample question',
            userSaid: lastUser.slice(0, 80) || 'My hometown has great food.',
            polished: "I'm originally from a vibrant coastal city that's best known for its street food and laid-back pace of life.",
            tip: '用 vibrant 和 laid-back 替代笼统形容词更地道',
          }],
          takeaways: [{
            said: lastUser.slice(0, 60) || 'good place',
            native: 'a vibrant city with a laid-back pace of life',
            phrase: 'laid-back pace of life',
            zh: '悠闲自在的生活节奏',
            why: '口语 Part 1/2 描述城市的高频 7.5+ 表达',
          }],
        });
      }
    }
    const completionTokens = estimateTokens(content);
    const cacheHitTokens = Math.floor(promptTokens * 0.6);
    const cacheMissTokens = promptTokens - cacheHitTokens;
    return {
      provider,
      model,
      content,
      usage: {
        promptTokens,
        completionTokens,
        cacheHitTokens,
        cacheMissTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  if (!apiKey) {
    throw new Error('服务器尚未配置主文本 API Key（LIRIO_LLM_API_KEY），暂时无法使用官方 API 模式。');
  }

  const payload = {
    model,
    messages,
    temperature,
    max_tokens: safeMaxTokens,
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw sanitizeUpstreamError(
      'LLM',
      `status=${resp.status} ${data?.error?.message || ''}`,
      '上游 AI 服务暂时不可用，请稍后重试。',
    );
  }

  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!content) {
    throw new Error('上游 AI 服务未返回有效内容。');
  }

  const promptTokens = Number(data?.usage?.prompt_tokens) || estimateTokens(JSON.stringify(messages));
  const completionTokens = Number(data?.usage?.completion_tokens) || estimateTokens(content);
  const cacheHitTokens =
    data?.usage?.prompt_cache_hit_tokens !== undefined
      ? Number(data.usage.prompt_cache_hit_tokens) || 0
      : Number(data?.usage?.prompt_tokens_details?.cached_tokens) || 0;
  const cacheMissTokens =
    data?.usage?.prompt_cache_miss_tokens !== undefined
      ? Number(data.usage.prompt_cache_miss_tokens) || 0
      : Math.max(0, promptTokens - cacheHitTokens);

  return {
    provider,
    model: data?.model || model,
    content,
    usage: {
      promptTokens,
      completionTokens,
      cacheHitTokens,
      cacheMissTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

export async function forwardChatCompletionStream({ messages, temperature = 0.7, maxTokens, onDelta }) {
  const provider = (process.env.LIRIO_LLM_PROVIDER || 'deepseek').toLowerCase();
  const model = process.env.LIRIO_LLM_MODEL || DEFAULT_MODELS[provider] || 'deepseek-chat';
  const baseUrl = (process.env.LIRIO_LLM_BASE_URL || DEFAULT_URLS[provider] || DEFAULT_URLS.deepseek).replace(/\/+$/, '');
  const apiKey =
    (process.env.LIRIO_LLM_API_KEY || '').trim() ||
    (provider === 'deepseek' ? (process.env.DEEPSEEK_API_KEY || '').trim() : '');
  const safeMaxTokens = Math.min(Math.max(64, Number(maxTokens) || 1200), 2048);

  if (isMockMode()) {
    const res = await forwardChatCompletion({ messages, temperature, maxTokens: safeMaxTokens });
    const parts = res.content.match(/.{1,36}/g) || [res.content];
    for (const part of parts) {
      onDelta?.(part);
    }
    return res;
  }

  if (!apiKey) {
    throw new Error('服务器尚未配置主文本 API Key（LIRIO_LLM_API_KEY），暂时无法使用官方 API 模式。');
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: safeMaxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!resp.ok || !resp.body) {
    const data = await resp.json().catch(() => ({}));
    throw sanitizeUpstreamError(
      'LLM-Stream',
      `status=${resp.status} ${data?.error?.message || ''}`,
      '上游 AI 服务暂时不可用，请稍后重试。',
    );
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullContent = '';
  let resolvedModel = model;
  let usageData = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nlIdx;
    while ((nlIdx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nlIdx).trim();
      buf = buf.slice(nlIdx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (parsed?.model) resolvedModel = parsed.model;
      if (parsed?.usage) usageData = parsed.usage;
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        fullContent += delta;
        onDelta?.(delta);
      }
    }
  }

  const content = fullContent.trim();
  if (!content) {
    throw new Error('上游 AI 服务未返回有效内容。');
  }

  const promptTokens = Number(usageData?.prompt_tokens) || estimateTokens(JSON.stringify(messages));
  const completionTokens = Number(usageData?.completion_tokens) || estimateTokens(content);
  const cacheHitTokens =
    usageData?.prompt_cache_hit_tokens !== undefined
      ? Number(usageData.prompt_cache_hit_tokens) || 0
      : Number(usageData?.prompt_tokens_details?.cached_tokens) || 0;
  const cacheMissTokens =
    usageData?.prompt_cache_miss_tokens !== undefined
      ? Number(usageData.prompt_cache_miss_tokens) || 0
      : Math.max(0, promptTokens - cacheHitTokens);

  return {
    provider,
    model: resolvedModel,
    content,
    usage: {
      promptTokens,
      completionTokens,
      cacheHitTokens,
      cacheMissTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

const NEURAL_VOICE_BY_ACCENT = {
  uk: 'en-GB-SoniaNeural',
  us: 'en-US-AndrewMultilingualNeural',
  au: 'en-AU-NatashaNeural',
  in: 'en-IN-NeerjaNeural',
};

const NEURAL_VOICE_ALIAS = {
  shimmer: 'en-US-AvaMultilingualNeural',
  nova: 'en-US-AvaMultilingualNeural',
  alloy: 'en-US-AvaMultilingualNeural',
  claire: 'en-US-AvaMultilingualNeural',
  echo: 'en-US-AndrewMultilingualNeural',
  onyx: 'en-US-AndrewMultilingualNeural',
  ash: 'en-US-AndrewMultilingualNeural',
  alex: 'en-US-AndrewMultilingualNeural',
  benjamin: 'en-US-AndrewMultilingualNeural',
  fable: 'en-GB-RyanNeural',
  ballad: 'en-GB-RyanNeural',
  charles: 'en-GB-RyanNeural',
  sage: 'en-GB-SoniaNeural',
  anna: 'en-GB-SoniaNeural',
};

function resolveNeuralEdgeVoice(accent, voice) {
  const raw = String(voice || '').trim();
  if (/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(raw)) {
    return raw;
  }
  const alias = NEURAL_VOICE_ALIAS[raw.toLowerCase()];
  if (alias) return alias;
  return NEURAL_VOICE_BY_ACCENT[accent] || NEURAL_VOICE_BY_ACCENT.uk;
}

const EDGE_WORKER_PY = `
import sys, json, asyncio, edge_tts

async def handle(req):
    rid = req.get("id")
    try:
        comm = edge_tts.Communicate(req["text"], req["voice"])
        await comm.save(req["out"])
        print(json.dumps({"id": rid, "ok": True}), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "ok": False, "err": str(e)}), flush=True)

async def main():
    loop = asyncio.get_running_loop()
    tasks = set()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        t = asyncio.create_task(handle(req))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

asyncio.run(main())
`;

function resolveEdgePythonBin() {
  const custom = (process.env.LIRIO_EDGE_TTS_PYTHON || '').trim();
  if (custom) return custom;
  const venvPy = '/opt/lirio/venv/bin/python3';
  if (fs.existsSync(venvPy)) return venvPy;
  return 'python3';
}

const TTS_CACHE_MAX = 200;
const ttsCache = new Map();

function getCachedTts(key) {
  const hit = ttsCache.get(key);
  if (!hit) return null;
  ttsCache.delete(key);
  ttsCache.set(key, hit);
  return hit;
}

function setCachedTts(key, val) {
  if (ttsCache.has(key)) ttsCache.delete(key);
  ttsCache.set(key, val);
  if (ttsCache.size > TTS_CACHE_MAX) {
    const oldest = ttsCache.keys().next().value;
    if (oldest !== undefined) ttsCache.delete(oldest);
  }
}

let edgeWorker = null;

function killEdgeWorker() {
  if (!edgeWorker) return;
  try {
    edgeWorker.rl?.close();
  } catch {}
  try {
    edgeWorker.proc?.kill('SIGKILL');
  } catch {}
  edgeWorker = null;
}

function ensureEdgeWorker() {
  if (edgeWorker && !edgeWorker.proc.killed && edgeWorker.proc.exitCode === null) {
    return edgeWorker;
  }
  const pyBin = resolveEdgePythonBin();
  const proc = spawn(pyBin, ['-u', '-c', EDGE_WORKER_PY], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stdin?.unref?.();
  proc.stdout?.unref?.();
  proc.stderr?.unref?.();

  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let nextReqId = 1;
  let stderrTail = '';

  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600);
  });

  rl.on('line', (line) => {
    const raw = String(line || '').trim();
    if (!raw) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve('OK');
    } else {
      entry.reject(new Error(msg.err || 'Edge TTS 异常'));
    }
  });

  const failAll = (msg) => {
    for (const [, entry] of pending) {
      entry.reject(new Error(msg));
    }
    pending.clear();
    if (edgeWorker && edgeWorker.proc === proc) {
      edgeWorker = null;
    }
  };

  proc.on('error', (err) => failAll(`Edge TTS worker error: ${err.message}`));
  proc.on('close', (code) => {
    const detail = stderrTail.trim();
    failAll(`Edge TTS worker closed (${code ?? 'signal'})${detail ? `: ${detail}` : ''}`);
  });

  edgeWorker = {
    proc,
    rl,
    request(payload, timeoutMs = 12000) {
      return new Promise((resolve, reject) => {
        const id = nextReqId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Edge TTS 请求超时'));
        }, timeoutMs);
        timer.unref?.();

        const entry = {
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        pending.set(id, entry);
        try {
          proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          killEdgeWorker();
          reject(err);
        }
      });
    },
  };
  return edgeWorker;
}

export function warmupEdgeWorker() {
  if (isMockMode()) return;
  try {
    ensureEdgeWorker();
  } catch {}
}

async function synthLocalNeuralEdgeTts(text, accent, requestedVoice) {
  const voice = resolveNeuralEdgeVoice(accent, requestedVoice);
  const outPath = path.join(os.tmpdir(), `lirio-pro-tts-${randomUUID()}.mp3`);
  try {
    const worker = ensureEdgeWorker();
    await worker.request({ text, voice, out: outPath }, 12000);
    const bytes = fs.readFileSync(outPath);
    if (bytes.length < 300) throw new Error('语音合成输出为空');
    return {
      provider: 'lirio-neural',
      model: 'lirio-tts-neural',
      voice,
      chars: Buffer.byteLength(text, 'utf8'),
      mime: 'audio/mpeg',
      audioBuf: bytes,
      audioBase64: bytes.toString('base64'),
    };
  } finally {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}
  }
}

const COSYVOICE_VOICE_MAP = {
  claire: 'claire',
  anna: 'anna',
  bella: 'bella',
  diana: 'diana',
  alex: 'alex',
  benjamin: 'benjamin',
  charles: 'charles',
  david: 'david',
  nova: 'claire',
  shimmer: 'claire',
  sage: 'anna',
  alloy: 'claire',
  echo: 'alex',
  onyx: 'benjamin',
  ash: 'alex',
  fable: 'charles',
  ballad: 'charles',
};

function resolveCosyVoiceName(ttsModel, accent, voice) {
  const raw = String(voice || '').trim();
  if (raw.includes(':')) return raw;
  const key = raw.toLowerCase();
  if (COSYVOICE_VOICE_MAP[key]) {
    return `${ttsModel}:${COSYVOICE_VOICE_MAP[key]}`;
  }
  const byAccent = accent === 'uk' ? 'charles' : 'claire';
  return `${ttsModel}:${byAccent}`;
}

export async function forwardTts({ text, accent = 'uk', voice }) {
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('朗读文本不能为空。');
  if (cleanText.length > 1200) throw new Error('朗读文本过长（单次最多 1200 字符）。');
  const chosenVoice = voice || (accent === 'uk' ? 'fable' : 'alloy');

  if (isMockMode()) {
    const stub = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00MOCK_AUDIO_DATA', 'utf8');
    return {
      provider: 'lirio-neural',
      model: 'lirio-tts-neural',
      voice: resolveNeuralEdgeVoice(accent, chosenVoice),
      chars: Buffer.byteLength(cleanText, 'utf8'),
      mime: 'audio/mpeg',
      audioBuf: stub,
      audioBase64: stub.toString('base64'),
    };
  }

  const resolvedVoice = resolveNeuralEdgeVoice(accent, chosenVoice);
  const cacheKey = `${resolvedVoice}\0${cleanText}`;
  if (cleanText.length <= 320) {
    const hit = getCachedTts(cacheKey);
    if (hit) return hit;
  }
  try {
    const res = await synthLocalNeuralEdgeTts(cleanText, accent, chosenVoice);
    if (cleanText.length <= 320) setCachedTts(cacheKey, res);
    return res;
  } catch (edgeErr) {
    const allowCloudFallback = process.env.LIRIO_TTS_ALLOW_CLOUD_FALLBACK === '1';
    const speechKey = (process.env.LIRIO_SPEECH_API_KEY || '').trim();
    if (!allowCloudFallback || !speechKey) {
      throw sanitizeUpstreamError('TTS', edgeErr?.message || String(edgeErr), '语音合成服务暂时繁忙，请稍后重试。');
    }
    console.warn('[TTS] Edge Neural failed, falling back to cloud API:', redactSecretText(edgeErr?.message || edgeErr));

    const baseUrl = (process.env.LIRIO_SPEECH_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const ttsModel = (process.env.LIRIO_TTS_MODEL || 'tts-1').trim();
    const isCosyVoice = ttsModel.includes('CosyVoice2');
    const finalVoice = isCosyVoice ? resolveCosyVoiceName(ttsModel, accent, chosenVoice) : chosenVoice;
    const billedChars = isCosyVoice ? Buffer.byteLength(cleanText, 'utf8') : cleanText.length;

    const cloudCacheKey = `${finalVoice}\0${cleanText}`;
    if (cleanText.length <= 320) {
      const hit = getCachedTts(cloudCacheKey);
      if (hit) return hit;
    }

    const resp = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${speechKey}`,
      },
      body: JSON.stringify({
        model: ttsModel,
        input: cleanText,
        voice: finalVoice,
        response_format: 'mp3',
      }),
    });

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      throw sanitizeUpstreamError(
        'TTS-Cloud',
        `status=${resp.status} ${errJson?.error?.message || ''}`,
        '语音合成服务暂时繁忙，请稍后重试。',
      );
    }

    const ab = await resp.arrayBuffer();
    const audioBuf = Buffer.from(ab);
    const res = {
      provider: baseUrl.includes('siliconflow') ? 'siliconflow' : 'openai',
      model: ttsModel,
      voice: finalVoice,
      chars: billedChars,
      mime: 'audio/mpeg',
      audioBuf,
      audioBase64: audioBuf.toString('base64'),
    };
    if (cleanText.length <= 320) setCachedTts(cloudCacheKey, res);
    return res;
  }
}

async function callAsrOnce(baseUrl, apiKey, buf, cleanMime, ext, model) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: cleanMime }), `speech.${ext}`);
  form.append('model', model);
  if (model === 'whisper-1') {
    form.append('language', 'en');
  }

  const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw sanitizeUpstreamError(
      'ASR',
      `status=${resp.status} ${data?.error?.message || ''}`,
      '云端语音识别服务暂时不可用，请稍后重试。',
    );
  }
  const text = String(data?.text || '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .trim();
  if (!text) {
    throw new Error('未识别到清晰语音，请再试一次。');
  }
  return text;
}

export async function forwardTranscribe({ wavBuf, wavBase64, mimeType, durationSec }) {
  const buf = Buffer.isBuffer(wavBuf) ? wavBuf : Buffer.from(String(wavBase64 || ''), 'base64');
  if (buf.length < 64) {
    throw new Error('录音内容过短或为空。');
  }
  if (buf.length > 5 * 1024 * 1024) {
    throw new Error('录音文件过大（单次最多 5 MB）。');
  }
  const approxSec = Number(durationSec) > 0 ? Number(durationSec) : Math.max(1, Math.round(buf.length / 32000));

  const baseUrl = (process.env.LIRIO_SPEECH_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const defaultModel = baseUrl.includes('siliconflow') ? 'FunAudioLLM/SenseVoiceSmall' : 'whisper-1';
  const asrModel = (process.env.LIRIO_ASR_MODEL || defaultModel).trim();
  const isSenseVoice = asrModel.includes('SenseVoiceSmall');

  if (isMockMode()) {
    return {
      provider: 'openai',
      model: asrModel,
      isFree: isSenseVoice,
      durationSec: approxSec,
      text: 'I really enjoy spending weekends in quiet cafes with my friends.',
    };
  }

  const apiKey = (process.env.LIRIO_SPEECH_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('服务器尚未配置云端语音识别 API Key（LIRIO_SPEECH_API_KEY）。');
  }

  const cleanMime = String(mimeType || 'audio/wav').split(';')[0].trim() || 'audio/wav';
  const ext = cleanMime.includes('webm') ? 'webm' : cleanMime.includes('ogg') ? 'ogg' : cleanMime.includes('mpeg') ? 'mp3' : 'wav';

  let usedModel = asrModel;
  let text;
  try {
    text = await callAsrOnce(baseUrl, apiKey, buf, cleanMime, ext, asrModel);
  } catch (err) {
    const canFallback =
      baseUrl.includes('siliconflow') && asrModel !== 'FunAudioLLM/SenseVoiceSmall';
    if (!canFallback) throw err;
    console.warn('[ASR] primary model failed, falling back to SenseVoiceSmall:', err?.message || err);
    usedModel = 'FunAudioLLM/SenseVoiceSmall';
    text = await callAsrOnce(baseUrl, apiKey, buf, cleanMime, ext, usedModel);
  }

  return {
    provider: baseUrl.includes('siliconflow') ? 'siliconflow' : 'openai',
    model: usedModel,
    isFree: usedModel.includes('SenseVoiceSmall'),
    durationSec: approxSec,
    text,
  };
}
