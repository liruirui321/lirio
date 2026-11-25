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
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.008));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  }
  noiseBuffer = buffer;
  return buffer;
}

const CLICK_PROFILES: Record<
  ClickKind,
  {
    popStartHz: number;
    popEndHz: number;
    popGain: number;
    popDecay: number;
    sparkStartHz: number;
    sparkEndHz: number;
    sparkGain: number;
    sparkDecay: number;
    tickGain: number;
    tickDecay: number;
  }
> = {
  char: {
    popStartHz: 1550,
    popEndHz: 880,
    popGain: 0.16,
    popDecay: 0.011,
    sparkStartHz: 3100,
    sparkEndHz: 2100,
    sparkGain: 0.05,
    sparkDecay: 0.007,
    tickGain: 0.06,
    tickDecay: 0.0045,
  },
  space: {
    popStartHz: 1150,
    popEndHz: 660,
    popGain: 0.18,
    popDecay: 0.014,
    sparkStartHz: 2300,
    sparkEndHz: 1550,
    sparkGain: 0.045,
    sparkDecay: 0.008,
    tickGain: 0.06,
    tickDecay: 0.0045,
  },
  backspace: {
    popStartHz: 980,
    popEndHz: 580,
    popGain: 0.12,
    popDecay: 0.01,
    sparkStartHz: 1900,
    sparkEndHz: 1300,
    sparkGain: 0.03,
    sparkDecay: 0.006,
    tickGain: 0.045,
    tickDecay: 0.0045,
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

  const p = CLICK_PROFILES[kind];
  const jitter = 0.96 + Math.random() * 0.08;
  const now = ctx.currentTime;

  // 1. Primary pure sine crisp keypop
  const pop = ctx.createOscillator();
  pop.type = 'sine';
  pop.frequency.setValueAtTime(p.popStartHz * jitter, now);
  pop.frequency.exponentialRampToValueAtTime(p.popEndHz * jitter, now + p.popDecay);

  const popEnv = ctx.createGain();
  popEnv.gain.setValueAtTime(0.0001, now);
  popEnv.gain.linearRampToValueAtTime(p.popGain, now + 0.0005);
  popEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.001 + p.popDecay);

  pop.connect(popEnv);
  popEnv.connect(ctx.destination);
  pop.start(now);
  pop.stop(now + 0.003 + p.popDecay);

  // 2. Bright high-harmonic sparkle
  const spark = ctx.createOscillator();
  spark.type = 'sine';
  spark.frequency.setValueAtTime(p.sparkStartHz * jitter, now);
  spark.frequency.exponentialRampToValueAtTime(p.sparkEndHz * jitter, now + p.sparkDecay);

  const sparkEnv = ctx.createGain();
  sparkEnv.gain.setValueAtTime(0.0001, now);
  sparkEnv.gain.linearRampToValueAtTime(p.sparkGain, now + 0.0004);
  sparkEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.0008 + p.sparkDecay);

  spark.connect(sparkEnv);
  sparkEnv.connect(ctx.destination);
  spark.start(now);
  spark.stop(now + 0.002 + p.sparkDecay);

  // 3. Razor-short 4.5ms high-passed tactile front tick (zero low/mid mud)
  const tick = ctx.createBufferSource();
  tick.buffer = getNoiseBuffer(ctx);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(4200, now);

  const tickEnv = ctx.createGain();
  tickEnv.gain.setValueAtTime(p.tickGain, now);
  tickEnv.gain.exponentialRampToValueAtTime(0.0001, now + p.tickDecay);

  tick.connect(hp);
  hp.connect(tickEnv);
  tickEnv.connect(ctx.destination);
  tick.start(now);
  tick.stop(now + p.tickDecay + 0.002);
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
