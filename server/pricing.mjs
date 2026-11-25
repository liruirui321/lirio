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

// Retail rates in units per 1M tokens (¥1 = 10,000 units).
// E.g. ¥2.5 / 1M tokens = 25,000 units / 1M tokens = 0.025 units/token.
const MODEL_RATES_PER_1M = {
  'deepseek-chat': { inputUnits: 25000, outputUnits: 100000 },
  'deepseek-reasoner': { inputUnits: 50000, outputUnits: 200000 },
  'gpt-4o-mini': { inputUnits: 20000, outputUnits: 80000 },
  'gpt-4o': { inputUnits: 220000, outputUnits: 880000 },
  'gemini-2.5-flash': { inputUnits: 18000, outputUnits: 72000 },
  'gemini-2.0-flash': { inputUnits: 15000, outputUnits: 60000 },
};

const DEFAULT_CHAT_RATE = { inputUnits: 25000, outputUnits: 100000 };

export function calculateChatCostUnits(model, promptTokens = 0, completionTokens = 0) {
  const key = String(model || '').toLowerCase();
  const rate =
    Object.entries(MODEL_RATES_PER_1M).find(([k]) => key.includes(k))?.[1] || DEFAULT_CHAT_RATE;
  const raw =
    (Math.max(0, promptTokens) * rate.inputUnits) / 1_000_000 +
    (Math.max(0, completionTokens) * rate.outputUnits) / 1_000_000;
  return Math.max(1, Math.ceil(raw));
}

// tts-1: ¥0.12 / 1,000 chars = 1,200 units / 1,000 chars = 1.2 units/char
export function calculateTtsCostUnits(chars = 0) {
  const n = Math.max(1, Number(chars) || 0);
  return Math.max(1, Math.ceil(n * 1.2));
}

// whisper-1: ¥0.05 / minute = 500 units / 60s
export function calculateAsrCostUnits(seconds = 0) {
  const s = Math.max(1, Number(seconds) || 0);
  return Math.max(2, Math.ceil((s / 60) * 500));
}

export function formatYuan(units) {
  const val = (Number(units) || 0) / UNITS_PER_YUAN;
  return `¥${val.toFixed(2)}`;
}
