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
  const apiKey = (process.env.LIRIO_LLM_API_KEY || '').trim();

  if (isMockMode()) {
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
    const promptTokens = estimateTokens(JSON.stringify(messages || []));
    const sysText = String(messages?.[0]?.content || '');
    let content = "That makes a lot of sense! Tell me a bit more about what stood out to you.";
    if (/qaPolishes|takeaways|headline|phonetic/i.test(sysText)) {
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
    return {
      provider,
      model,
      content,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
  }

  if (!apiKey) {
    throw new Error('服务器尚未配置主文本 API Key（LIRIO_LLM_API_KEY），暂时无法使用余额托管模式。');
  }

  const payload = {
    model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
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
    const msg = data?.error?.message || `上游 AI 服务返回错误 (${resp.status})`;
    throw new Error(msg);
  }

  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!content) {
    throw new Error('上游 AI 服务未返回有效内容。');
  }

  const promptTokens = Number(data?.usage?.prompt_tokens) || estimateTokens(JSON.stringify(messages));
  const completionTokens = Number(data?.usage?.completion_tokens) || estimateTokens(content);

  return {
    provider,
    model: data?.model || model,
    content,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

export async function forwardTts({ text, accent = 'uk', voice }) {
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('朗读文本不能为空。');
  const chosenVoice = voice || (accent === 'uk' ? 'fable' : 'alloy');

  if (isMockMode()) {
    // Tiny valid MP3-like header stub bytes for automated tests
    const stub = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00MOCK_AUDIO_DATA', 'utf8');
    return {
      provider: 'openai',
      model: 'tts-1',
      voice: chosenVoice,
      chars: cleanText.length,
      mime: 'audio/mpeg',
      audioBase64: stub.toString('base64'),
    };
  }

  const apiKey = (process.env.LIRIO_SPEECH_API_KEY || process.env.LIRIO_LLM_API_KEY || '').trim();
  const baseUrl = (process.env.LIRIO_SPEECH_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!apiKey) {
    throw new Error('服务器尚未配置云端语音 API Key（LIRIO_SPEECH_API_KEY）。');
  }

  const resp = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: cleanText,
      voice: chosenVoice,
      response_format: 'mp3',
    }),
  });

  if (!resp.ok) {
    const errJson = await resp.json().catch(() => ({}));
    throw new Error(errJson?.error?.message || `云端语音合成失败 (${resp.status})`);
  }

  const ab = await resp.arrayBuffer();
  return {
    provider: 'openai',
    model: 'tts-1',
    voice: chosenVoice,
    chars: cleanText.length,
    mime: 'audio/mpeg',
    audioBase64: Buffer.from(ab).toString('base64'),
  };
}

export async function forwardTranscribe({ wavBase64, durationSec }) {
  const buf = Buffer.from(String(wavBase64 || ''), 'base64');
  if (buf.length < 64) {
    throw new Error('录音内容过短或为空。');
  }
  const approxSec = Number(durationSec) > 0 ? Number(durationSec) : Math.max(1, Math.round(buf.length / 32000));

  if (isMockMode()) {
    return {
      provider: 'openai',
      model: 'whisper-1',
      durationSec: approxSec,
      text: 'I really enjoy spending weekends in quiet cafes with my friends.',
    };
  }

  const apiKey = (process.env.LIRIO_SPEECH_API_KEY || process.env.LIRIO_LLM_API_KEY || '').trim();
  const baseUrl = (process.env.LIRIO_SPEECH_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!apiKey) {
    throw new Error('服务器尚未配置云端语音识别 API Key（LIRIO_SPEECH_API_KEY）。');
  }

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', 'whisper-1');
  form.append('language', 'en');

  const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `云端语音识别失败 (${resp.status})`);
  }
  const text = String(data?.text || '').trim();
  if (!text) {
    throw new Error('未识别到清晰语音，请再试一次。');
  }

  return {
    provider: 'openai',
    model: 'whisper-1',
    durationSec: approxSec,
    text,
  };
}
