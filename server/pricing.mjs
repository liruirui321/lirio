// Monetary unit: 10,000 units = ¥1.00 CNY = 100 积分 (1 积分 = 100 units = ¥0.01)
export const UNITS_PER_YUAN = 10000;
export const POINTS_PER_YUAN = 100;
export const UNITS_PER_POINT = 100;

export function roundUpToPointUnits(rawUnits) {
  return Math.max(1, Math.ceil((Number(rawUnits) || 0) / UNITS_PER_POINT)) * UNITS_PER_POINT;
}

export function unitsToPoints(units) {
  return Math.round((Number(units) || 0) / UNITS_PER_POINT);
}

export function formatPoints(units, withUnit = true) {
  const num = unitsToPoints(units).toLocaleString('en-US');
  return withUnit ? `${num} 积分` : num;
}

export const RECHARGE_PACKS = [
  {
    id: 'pack_10',
    label: '¥10 积分包（1,000 积分）',
    payYuan: 10,
    bonusYuan: 0,
    creditUnits: 100000,
    note: '基础积分包 1,000 积分',
  },
  {
    id: 'pack_30',
    label: '¥30 积分包（3,300 积分）',
    payYuan: 30,
    bonusYuan: 3,
    creditUnits: 330000,
    note: '备考积分包 3,000 + 赠 300 积分',
  },
  {
    id: 'pack_100',
    label: '¥100 Pro 积分包（11,500 积分）',
    payYuan: 100,
    bonusYuan: 15,
    creditUnits: 1150000,
    note: '冲刺 Pro 积分包 10,000 + 赠 1,500 积分',
  },
];

// 3x DeepSeek official CNY peak/off-peak rates (per 1M tokens, 1 CNY = 10,000 units):
// Peak (Beijing Mon-Fri 09:00-12:00 & 14:00-18:00): hit ¥0.12, miss ¥6.00, out ¥24.00
// Off-peak (all other hours): hit ¥0.06, miss ¥3.00, out ¥12.00
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
    return { hitUnits: 1200, missUnits: 60000, outputUnits: 240000 };
  }
  return { hitUnits: 600, missUnits: 30000, outputUnits: 120000 };
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
    return roundUpToPointUnits(raw);
  }

  const rate =
    Object.entries(OTHER_MODEL_RATES_PER_1M).find(([k]) => key.includes(k))?.[1] ||
    OTHER_MODEL_RATES_PER_1M['gpt-4o-mini'];
  const raw =
    (Math.max(0, promptTokens) * rate.inputUnits) / 1_000_000 +
    (Math.max(0, completionTokens) * rate.outputUnits) / 1_000_000;
  return roundUpToPointUnits(raw);
}

// Cloud TTS rate: 3x upstream (¥0.15 / 1,000 UTF-8 bytes = 15 points / 1,000 bytes, 1.5 units/byte), rounded up to whole points
export function calculateTtsCostUnits(chars = 0) {
  const n = Math.max(1, Number(chars) || 0);
  return roundUpToPointUnits(n * 1.5);
}

// Paid fallback ASR rate (rounded up to whole points)
export function calculateAsrCostUnits(seconds = 0) {
  const s = Math.max(1, Number(seconds) || 0);
  return roundUpToPointUnits((s / 60) * 500);
}

export function formatYuan(units, decimals = 2) {
  const val = (Number(units) || 0) / UNITS_PER_YUAN;
  return `¥${val.toFixed(decimals)}`;
}
