import type {
  DaySessionLevels,
  M15Candle,
  SessionPhase,
  StrategySettings,
  UsdNewsEvent,
} from '../types/connectivity.ts';

export const DEFAULT_STRATEGY_SETTINGS: StrategySettings = {
  strategyMode: 'EMA_STOCHASTIC_PRO',
  asianStart: '03:00',
  asianEnd: '11:00',
  londonStart: '11:00',
  londonEnd: '19:00',
  slPips: 15, // 15 pips = $1.50 baseline reference on GOLD/XAUUSD
  maxSlPips: 25, // 25 pips = $2.50 reference stop cap
  newsClearanceMins: 60, // 1 hour BEFORE and 1 hour AFTER high-impact USD news
  maxTradesPerDay: 10,
  maxConsecutiveLosses: 3,
  riskPercent: 0.5,
  defaultLotSize: 0.01,
  autoLogSignals: true,
  aiApproverEnabled: true,
  maxAutoLotCap: 0.5,
  dailyGuardPct: 5.0,
  emaPro: {
    emaFast: 9,
    emaMid: 21,
    emaIntermediate: 50,
    emaMajor: 200,
    stochK: 14,
    stochD: 3,
    stochSlowing: 3,
    stochOverbought: 80,
    stochOversold: 20,
    stochMidpoint: 50,
    atrPeriod: 14,
    atrSlMultiplier: 1.5,
    smcLookbackBars: 80,
    swingStrength: 2,
    m1RefinementEnabled: false,
    aiConfidenceThreshold: 75,
    maxRiskPercent: 1.0,
    maxSimultaneousPositions: 2,
    maxTradesPerSession: 5,
    minRewardRisk: 2.0,
    tp1Rr: 1.0,
    tp2Rr: 2.0,
    tp3Rr: 3.0,
    partialProfitEnabled: true,
    moveSlToTp1OnTp1: true,
    moveSlToTp2OnTp2: true,
    maxSpreadPips: 80,
    spreadSensitivity: 'BALANCED',
    allowHighSpreadTrades: false,
    minNetRewardRisk: 1.6,
    commissionPerLot: 0,
    estimatedSlippagePoints: 5,
    maxQuoteAgeSeconds: 15,
    signalExpiryMinutes: 15,
    maxEntryDeviationPips: 15,
    xauusdSymbol: 'XAUUSD',
    demoOnlyMode: true,
    liveTradingAuthorized: false,
    allowBuy: true,
    allowSell: true,
    tradingMode: 'SIGNALS_ONLY',
    tradingRunState: 'RUNNING',
    settingsVersion: 1,
  },
  newsEvents: [
    {
      id: 'usd-cpi-sample',
      title: 'US CPI / Core CPI (Red Folder - Toggle When Active)',
      timeLusaka: '15:30',
      impact: 'HIGH',
      enabled: false,
    },
    {
      id: 'usd-nfp-sample',
      title: 'US NFP / Non-Farm Payrolls (Red Folder - Toggle When Active)',
      timeLusaka: '15:30',
      impact: 'HIGH',
      enabled: false,
    },
    {
      id: 'usd-fomc-sample',
      title: 'FOMC / Interest Rate Decision (Red Folder - Toggle When Active)',
      timeLusaka: '21:00',
      impact: 'HIGH',
      enabled: false,
    },
    {
      id: 'usd-gdp-sample',
      title: 'US GDP / Retail Sales / PPI (Red Folder - Toggle When Active)',
      timeLusaka: '15:30',
      impact: 'HIGH',
      enabled: false,
    },
  ],
};

export function parseHHMMToMinutes(hhmm: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return fallback;
  }
  return h * 60 + m;
}

export function getLusakaClock(dateInput: Date | number = new Date()): {
  dateLusaka: string;
  timeLusaka: string;
  hhmm: string;
  minutes: number;
  weekday: string;
  dayOfWeek: number;
  isWeekend: boolean;
} {
  const rawDate = typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
  const date =
    rawDate instanceof Date && Number.isFinite(rawDate.getTime()) ? rawDate : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lusaka',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hourNum = Number(map.hour ?? '0') % 24;
  const minNum = Number(map.minute ?? '0');
  const secStr = map.second ?? '00';
  const hourStr = String(hourNum).padStart(2, '0');
  const minStr = String(minNum).padStart(2, '0');
  const weekday = (map.weekday ?? 'Monday').trim();
  const weekdayLower = weekday.toLowerCase();
  const dayOfWeekMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const dayOfWeek = dayOfWeekMap[weekdayLower] ?? 1;
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  return {
    dateLusaka: `${map.year}-${map.month}-${map.day}`,
    timeLusaka: `${hourStr}:${minStr}:${secStr}`,
    hhmm: `${hourStr}:${minStr}`,
    minutes: hourNum * 60 + minNum,
    weekday,
    dayOfWeek,
    isWeekend,
  };
}

// Fast O(1) Lusaka (UTC+2, no DST) clock helper
function fastLusakaClock(ms: number): {
  dateLusaka: string;
  hhmm: string;
  minutes: number;
  isWeekend: boolean;
} {
  const d = new Date(ms + 7_200_000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hhNum = d.getUTCHours();
  const mmNum = d.getUTCMinutes();
  const hh = String(hhNum).padStart(2, '0');
  const mm = String(mmNum).padStart(2, '0');
  const dow = d.getUTCDay();
  return {
    dateLusaka: `${year}-${month}-${day}`,
    hhmm: `${hh}:${mm}`,
    minutes: hhNum * 60 + mmNum,
    isWeekend: dow === 0 || dow === 6,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function determineSessionPhase(
  lusakaMinutes: number,
  settings: StrategySettings,
  isWeekend = false
): { phase: SessionPhase; phaseLabel: string; activeStrategyName: string } {
  const labelPrefix = 'EMA STOCHASTIC PRO';
  if (isWeekend) {
    return {
      phase: 'MARKET_CLOSED',
      phaseLabel: 'MARKET CLOSED',
      activeStrategyName: 'MARKET CLOSED · BACKTEST MODE ONLY',
    };
  }
  const asianStartMin = parseHHMMToMinutes(settings.asianStart, 180); // 03:00
  const asianEndMin = parseHHMMToMinutes(settings.asianEnd, 660); // 11:00
  const londonStartMin = parseHHMMToMinutes(settings.londonStart, 660); // 11:00
  const londonEndMin = parseHHMMToMinutes(settings.londonEnd, 1140); // 19:00

  if (lusakaMinutes >= asianStartMin && lusakaMinutes < asianEndMin) {
    return {
      phase: 'ASIAN_SESSION',
      phaseLabel: `Asian Session (${settings.asianStart}–${settings.asianEnd} Lusaka)`,
      activeStrategyName: `${labelPrefix} · Asian Session (All-Session Trading Active)`,
    };
  }
  if (lusakaMinutes >= londonStartMin && lusakaMinutes <= londonEndMin) {
    return {
      phase: 'LONDON_SESSION',
      phaseLabel: `London / NY Overlap (${settings.londonStart}–${settings.londonEnd} Lusaka)`,
      activeStrategyName: `${labelPrefix} · London / NY Overlap (All-Session Trading Active)`,
    };
  }
  if (lusakaMinutes > londonEndMin) {
    return {
      phase: 'NEW_YORK_SESSION',
      phaseLabel: `New York Session (${settings.londonEnd}–23:59 Lusaka)`,
      activeStrategyName: `${labelPrefix} · New York Session (All-Session Trading Active)`,
    };
  }
  return {
    phase: 'ALL_SESSIONS',
    phaseLabel: `All-Session Global Gold Window (00:00–${settings.asianStart} Lusaka)`,
    activeStrategyName: `${labelPrefix} · All-Session Active`,
  };
}

export function evaluateUsdNewsClearance(
  lusakaMinutes: number,
  settings: StrategySettings
): { clear: boolean; blockingEvent: UsdNewsEvent | null; minutesUntil: number | null } {
  const guardMins = Math.max(0, settings.newsClearanceMins ?? 60);
  let closestBlocking: UsdNewsEvent | null = null;
  let closestDiff: number | null = null;

  for (const ev of settings.newsEvents) {
    if (!ev.enabled || ev.impact !== 'HIGH') continue;
    const evMin = parseHHMMToMinutes(ev.timeLusaka, -9999);
    if (evMin < 0) continue;
    // Block 1 hour BEFORE AND 1 hour AFTER high-impact USD news
    const diff = evMin - lusakaMinutes;
    if (Math.abs(diff) <= guardMins) {
      if (closestDiff === null || Math.abs(diff) < Math.abs(closestDiff)) {
        closestBlocking = ev;
        closestDiff = diff;
      }
    }
  }

  return {
    clear: closestBlocking === null,
    blockingEvent: closestBlocking,
    minutesUntil: closestDiff,
  };
}

export function calculateTieredAutoLot(
  balance: number | null | undefined,
  maxAutoLotCap = 0.5,
  contractSize = 100,
  accountCurrency: 'USD' | 'USC' = 'USD'
): {
  balance: number;
  tierLot: number;
  effectiveLot: number;
  maxAutoLotCap: number;
  nextTierBalance: number | null;
  nextTierLot: number | null;
  progressPct: number;
  tierLabel: string;
} {
  const safeBalance =
    typeof balance === 'number' && Number.isFinite(balance) && balance >= 0
      ? round2(balance)
      : 0;
  const safeCap =
    typeof maxAutoLotCap === 'number' && Number.isFinite(maxAutoLotCap) && maxAutoLotCap >= 0.01
      ? round2(maxAutoLotCap)
      : 0.5;
  const safeContract =
    typeof contractSize === 'number' && Number.isFinite(contractSize) && contractSize > 0
      ? contractSize
      : 100;

  // Cent/Micro USD (1 oz/lot) or Cent USC (100 cent-oz/lot where 100 USC = $1 USD)
  if (accountCurrency === 'USC' || safeContract < 50) {
    const usdEquiv = accountCurrency === 'USC' ? safeBalance / 100 : safeBalance;
    const usdPerDollarMovePerLot = accountCurrency === 'USC' ? safeContract * 0.01 : safeContract;
    const multiplierFromStandard = 100 / Math.max(0.01, usdPerDollarMovePerLot);
    const rawTier = Math.max(0.01, round2((usdEquiv / 20000) * multiplierFromStandard));
    const effectiveLot = round2(Math.min(Math.max(0.01, rawTier), safeCap));
    const unitLabel = accountCurrency === 'USC' ? 'USC' : '$';
    return {
      balance: safeBalance,
      tierLot: rawTier,
      effectiveLot,
      maxAutoLotCap: safeCap,
      nextTierBalance: round2(safeBalance * 1.5),
      nextTierLot: round2(Math.min(safeCap, rawTier * 1.5)),
      progressPct: 100,
      tierLabel: `${accountCurrency === 'USC' ? `${safeBalance.toFixed(0)} ${unitLabel}` : `$${safeBalance.toFixed(2)}`} Cent (${effectiveLot.toFixed(2)} lots)`,
    };
  }

  // Standard / ECN USD (100 oz/lot) reference lot tier ladder capped by maxAutoLotCap
  let tierLot = 0.01;
  let nextTierBalance: number | null = 250;
  let nextTierLot: number | null = 0.02;
  let tierLabel = '< $250 (0.01)';

  if (safeBalance >= 1500) {
    tierLot = 0.07;
    nextTierBalance = null;
    nextTierLot = null;
    tierLabel = '$1500+ (0.07)';
  } else if (safeBalance >= 1000) {
    tierLot = 0.05;
    nextTierBalance = 1500;
    nextTierLot = 0.07;
    tierLabel = '$1000–$1499.99 (0.05)';
  } else if (safeBalance >= 750) {
    tierLot = 0.04;
    nextTierBalance = 1000;
    nextTierLot = 0.05;
    tierLabel = '$750–$999.99 (0.04)';
  } else if (safeBalance >= 500) {
    tierLot = 0.03;
    nextTierBalance = 750;
    nextTierLot = 0.04;
    tierLabel = '$500–$749.99 (0.03)';
  } else if (safeBalance >= 250) {
    tierLot = 0.02;
    nextTierBalance = 500;
    nextTierLot = 0.03;
    tierLabel = '$250–$499.99 (0.02)';
  }

  const effectiveLot = round2(Math.min(tierLot, safeCap));
  const progressPct =
    nextTierBalance && nextTierBalance > 0
      ? Math.max(0, Math.min(100, Math.round((safeBalance / nextTierBalance) * 100)))
      : 100;

  return {
    balance: safeBalance,
    tierLot,
    effectiveLot,
    maxAutoLotCap: safeCap,
    nextTierBalance,
    nextTierLot,
    progressPct,
    tierLabel,
  };
}

export function derivePreviousDayRangeFromCandles(
  candles: M15Candle[],
  currentDateLusaka: string
): { pdh: number | null; pdl: number | null; prevDayDate: string | null } {
  if (!candles || candles.length === 0) {
    return { pdh: null, pdl: null, prevDayDate: null };
  }
  const dayBuckets = new Map<string, { high: number; low: number }>();
  for (const bar of candles) {
    if (!bar || !bar.closed) continue;
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;
    const c = fastLusakaClock(bar.openTimeMs);
    if (c.isWeekend) continue;
    if (c.dateLusaka >= currentDateLusaka) continue;
    const prev = dayBuckets.get(c.dateLusaka);
    if (!prev) {
      dayBuckets.set(c.dateLusaka, { high: round2(bar.high), low: round2(bar.low) });
    } else {
      prev.high = round2(Math.max(prev.high, bar.high));
      prev.low = round2(Math.min(prev.low, bar.low));
    }
  }
  if (dayBuckets.size === 0) {
    return { pdh: null, pdl: null, prevDayDate: null };
  }
  const sortedDates = Array.from(dayBuckets.keys()).sort();
  const latestPrevDate = sortedDates[sortedDates.length - 1];
  const range = dayBuckets.get(latestPrevDate)!;
  return {
    pdh: range.high,
    pdl: range.low,
    prevDayDate: latestPrevDate,
  };
}
