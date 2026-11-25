// Monetary unit: 10,000 units = ¥1.00 CNY (1 unit = ¥0.0001)
export const UNITS_PER_YUAN = 10000;

export const RECHARGE_PACKS = [
  {
    id: 'pack_10',
    label: '轻享包 ¥10',
    payYuan: 10,
    bonusYuan: 0,
    creditUnits: 100000,
    note: '基础按量充值 ¥10.00',
  },
  {
    id: 'pack_30',
    label: '备考包 ¥30（送¥3）',
    payYuan: 30,
    bonusYuan: 3,
    creditUnits: 330000,
    note: '备考充值 ¥30.00（含赠送 ¥3.00）',
  },
  {
    id: 'pack_100',
    label: '冲刺 Pro 包 ¥100（送¥15）',
    payYuan: 100,
    bonusYuan: 15,
    creditUnits: 1150000,
    note: '冲刺 Pro 充值 ¥100.00（含赠送 ¥15.00）',
  },
];

// Official DeepSeek CNY peak/off-peak pricing (per 1M tokens, 1 CNY = 10,000 units):
// Peak (Beijing Mon-Fri 09:00-12:00 & 14:00-18:00): hit ¥0.04, miss ¥2.00, out ¥8.00
// Off-peak (all other hours): hit ¥0.02, miss ¥1.00, out ¥4.00
export function isDeepSeekPeakBeijing(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const day = bj.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const hour = bj.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export function getDeepSeekPeriodLabel(now = new Date()) {
  return isDeepSeekPeakBeijing(now) ? '高峰价' : '空闲价';
}

export function getDeepSeekRatesPer1M(now = new Date()) {
  if (isDeepSeekPeakBeijing(now)) {
    return { hitUnits: 400, missUnits: 20000, outputUnits: 80000 };
  }
  return { hitUnits: 200, missUnits: 10000, outputUnits: 40000 };
}

const OTHER_MODEL_RATES_PER_1M = {
  'gpt-4o-mini': { inputUnits: 20000, outputUnits: 80000 },
  'gpt-4o': { inputUnits: 220000, outputUnits: 880000 },
  'gemini-2.5-flash': { inputUnits: 18000, outputUnits: 72000 },
  'gemini-2.0-flash': { inputUnits: 15000, outputUnits: 60000 },
};

export function calculateChatCostUnits(
  model,
  promptTokens = 0,
  completionTokens = 0,
  opts = {},
) {
  const key = String(model || '').toLowerCase();
  if (key.includes('deepseek') || !Object.keys(OTHER_MODEL_RATES_PER_1M).some((k) => key.includes(k))) {
    const isReasoner = key.includes('reasoner');
    const mult = isReasoner ? 2 : 1;
    const rates = getDeepSeekRatesPer1M(opts.now || new Date());
    const hitTokens = Math.max(0, Number(opts.cacheHitTokens) || 0);
    const missTokens =
      opts.cacheMissTokens !== undefined
        ? Math.max(0, Number(opts.cacheMissTokens) || 0)
        : Math.max(0, Number(promptTokens) - hitTokens);
    const outTokens = Math.max(0, Number(completionTokens) || 0);
    const raw =
      ((hitTokens * rates.hitUnits +
        missTokens * rates.missUnits +
        outTokens * rates.outputUnits) *
        mult) /
      1_000_000;
    return Math.max(1, Math.ceil(raw));
  }

  const rate =
    Object.entries(OTHER_MODEL_RATES_PER_1M).find(([k]) => key.includes(k))?.[1] ||
    OTHER_MODEL_RATES_PER_1M['gpt-4o-mini'];
  const raw =
    (Math.max(0, promptTokens) * rate.inputUnits) / 1_000_000 +
    (Math.max(0, completionTokens) * rate.outputUnits) / 1_000_000;
  return Math.max(1, Math.ceil(raw));
}

// Simulated affordable commercial neural TTS rate: ¥0.03 / 1,000 chars = 300 units / 1,000 chars (0.3 units/char)
export function calculateTtsCostUnits(chars = 0) {
  const n = Math.max(1, Number(chars) || 0);
  return Math.max(1, Math.ceil(n * 0.3));
}

// whisper-1: ¥0.05 / minute = 500 units / 60s
export function calculateAsrCostUnits(seconds = 0) {
  const s = Math.max(1, Number(seconds) || 0);
  return Math.max(2, Math.ceil((s / 60) * 500));
}

export function formatYuan(units, decimals = 2) {
  const val = (Number(units) || 0) / UNITS_PER_YUAN;
  return `¥${val.toFixed(decimals)}`;
}
