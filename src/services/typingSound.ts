const STORAGE_KEY = 'aboboo-typing-sound';

type ClickKind = 'char' | 'space' | 'backspace';

let sharedCtx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;
let lastClickAt = 0;

export function isTypingSoundEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setTypingSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {}
}

function ensureAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new Ctor();
    noiseBuffer = null;
  }
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer;
  }
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.035));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    // Slightly weighted toward crisp initial transient
    const decay = 1 - i / length;
    data[i] = (Math.random() * 2 - 1) * (0.45 + 0.55 * decay);
  }
  noiseBuffer = buffer;
  return buffer;
}

const CLICK_PROFILES: Record<
  ClickKind,
  {
    noiseFreq: number;
    noiseQ: number;
    noiseGain: number;
    noiseDecay: number;
    bodyStartHz: number;
    bodyEndHz: number;
    bodyGain: number;
    bodyDecay: number;
  }
> = {
  char: {
    noiseFreq: 2250,
    noiseQ: 1.8,
    noiseGain: 0.22,
    noiseDecay: 0.016,
    bodyStartHz: 300,
    bodyEndHz: 125,
    bodyGain: 0.08,
    bodyDecay: 0.019,
  },
  space: {
    noiseFreq: 1380,
    noiseQ: 1.5,
    noiseGain: 0.24,
    noiseDecay: 0.022,
    bodyStartHz: 210,
    bodyEndHz: 90,
    bodyGain: 0.09,
    bodyDecay: 0.024,
  },
  backspace: {
    noiseFreq: 1650,
    noiseQ: 1.6,
    noiseGain: 0.15,
    noiseDecay: 0.014,
    bodyStartHz: 240,
    bodyEndHz: 110,
    bodyGain: 0.07,
    bodyDecay: 0.018,
  },
};

export function playTypingClick(kind: ClickKind = 'char', opts?: { repeat?: boolean }): void {
  if (!isTypingSoundEnabled()) return;
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const minGap = opts?.repeat ? 55 : 22;
  if (nowMs - lastClickAt < minGap) return;
  lastClickAt = nowMs;

  const ctx = ensureAudioCtx();
  if (!ctx) return;

  const profile = CLICK_PROFILES[kind];
  const jitter = 0.95 + Math.random() * 0.1;
  const now = ctx.currentTime;

  // Layer 1: crisp mechanical transient click
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(profile.noiseFreq * jitter, now);
  filter.Q.setValueAtTime(profile.noiseQ, now);

  const noiseEnv = ctx.createGain();
  noiseEnv.gain.setValueAtTime(0.0001, now);
  noiseEnv.gain.linearRampToValueAtTime(profile.noiseGain, now + 0.001);
  noiseEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.001 + profile.noiseDecay);

  src.connect(filter);
  filter.connect(noiseEnv);
  noiseEnv.connect(ctx.destination);
  src.start(now);
  src.stop(now + 0.004 + profile.noiseDecay);

  // Layer 2: warm PBT keycap thock body
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(profile.bodyStartHz * jitter, now);
  osc.frequency.exponentialRampToValueAtTime(profile.bodyEndHz * jitter, now + profile.bodyDecay);

  const bodyEnv = ctx.createGain();
  bodyEnv.gain.setValueAtTime(0.0001, now);
  bodyEnv.gain.linearRampToValueAtTime(profile.bodyGain, now + 0.001);
  bodyEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.001 + profile.bodyDecay);

  osc.connect(bodyEnv);
  bodyEnv.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.003 + profile.bodyDecay);
}

export function handleDictationKeySound(e: {
  key: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): void {
  if (
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    e.nativeEvent?.isComposing ||
    e.key === 'Process' ||
    e.key === 'Unidentified'
  ) {
    return;
  }
  if (e.key === ' ' && !e.repeat) {
    playTypingClick('space');
  } else if (e.key.length === 1 && !e.repeat) {
    playTypingClick('char');
  } else if (e.key === 'Backspace') {
    playTypingClick('backspace', { repeat: Boolean(e.repeat) });
  }
}
