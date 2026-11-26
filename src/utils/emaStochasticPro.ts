import type {
  BacktestEquityPoint,
  BacktestSplitMetric,
  BacktestSummary,
  BacktestTradeResult,
  DaySessionLevels,
  DynamicSpreadEvaluation,
  EmaStochasticProConfig,
  EmaStochasticProSnapshot,
  M15Candle,
  PerformanceMetricsSummary,
  SessionPhase,
  SetupType,
  SignalAction,
  SignalHistoryEntry,
  SmcAnalysis,
  SmcFvgZone,
  SmcLiquiditySweep,
  SmcOrderBlock,
  SmcStructureEvent,
  SmcSwingPoint,
  SpreadFilterComparisonReport,
  SpreadFilterComparisonRow,
  SpreadSampleRecord,
  StrategyConditionItem,
  StrategySettings,
  SymbolSpecification,
  TimeframeIndicatorSnapshot,
  TradeLogEntry,
  TradeSignal,
  TradingSessionTag,
} from '../types/connectivity.ts';
import {
  DEFAULT_SYMBOL_SPEC,
  evaluateDynamicSpread,
  getEffectiveSideEntryPrice,
  roundToDigits,
} from './dynamicSpread.ts';
import {
  evaluateUsdNewsClearance,
  getLusakaClock,
  round2,
} from './strategyEngine.ts';

export const DEFAULT_EMA_PRO_CONFIG: EmaStochasticProConfig = {
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
  maxSpreadPips: 80, // Configurable dynamic ceiling in points
  spreadSensitivity: 'BALANCED',
  allowHighSpreadTrades: false,
  minNetRewardRisk: 1.6,
  commissionPerLot: 0,
  estimatedSlippagePoints: 5,
  maxQuoteAgeSeconds: 15,
  signalExpiryMinutes: 15,
  maxEntryDeviationPips: 15, // $1.50 max entry slippage drift
  xauusdSymbol: 'XAUUSD',
  demoOnlyMode: true,
  liveTradingAuthorized: false,
  allowBuy: true,
  allowSell: true,
  tradingMode: 'SIGNALS_ONLY',
  tradingRunState: 'RUNNING',
  settingsVersion: 1,
  telegramNotifyExecutions: true,
  telegramNotifyTpSl: true,
};

export function mergeEmaProConfig(
  partial?: Partial<EmaStochasticProConfig> | null
): EmaStochasticProConfig {
  const finiteNum = (val: unknown, fallback: number): number => {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && val.trim() !== '') {
      const parsed = Number(val);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  };
  const sens =
    partial?.spreadSensitivity === 'CONSERVATIVE' ||
    partial?.spreadSensitivity === 'AGGRESSIVE'
      ? partial.spreadSensitivity
      : DEFAULT_EMA_PRO_CONFIG.spreadSensitivity;

  return {
    ...DEFAULT_EMA_PRO_CONFIG,
    ...(partial ?? {}),
    emaFast: Math.max(2, Math.min(50, finiteNum(partial?.emaFast, DEFAULT_EMA_PRO_CONFIG.emaFast))),
    emaMid: Math.max(5, Math.min(100, finiteNum(partial?.emaMid, DEFAULT_EMA_PRO_CONFIG.emaMid))),
    emaIntermediate: Math.max(10, Math.min(200, finiteNum(partial?.emaIntermediate, DEFAULT_EMA_PRO_CONFIG.emaIntermediate))),
    emaMajor: Math.max(50, Math.min(400, finiteNum(partial?.emaMajor, DEFAULT_EMA_PRO_CONFIG.emaMajor))),
    stochK: Math.max(3, Math.min(50, finiteNum(partial?.stochK, DEFAULT_EMA_PRO_CONFIG.stochK))),
    stochD: Math.max(1, Math.min(20, finiteNum(partial?.stochD, DEFAULT_EMA_PRO_CONFIG.stochD))),
    stochSlowing: Math.max(1, Math.min(20, finiteNum(partial?.stochSlowing, DEFAULT_EMA_PRO_CONFIG.stochSlowing))),
    stochOverbought: Math.max(60, Math.min(95, finiteNum(partial?.stochOverbought, DEFAULT_EMA_PRO_CONFIG.stochOverbought))),
    stochOversold: Math.max(5, Math.min(40, finiteNum(partial?.stochOversold, DEFAULT_EMA_PRO_CONFIG.stochOversold))),
    stochMidpoint: Math.max(30, Math.min(70, finiteNum(partial?.stochMidpoint, DEFAULT_EMA_PRO_CONFIG.stochMidpoint))),
    atrPeriod: Math.max(5, Math.min(50, finiteNum(partial?.atrPeriod, DEFAULT_EMA_PRO_CONFIG.atrPeriod))),
    atrSlMultiplier: Math.max(0.5, Math.min(4.0, finiteNum(partial?.atrSlMultiplier, DEFAULT_EMA_PRO_CONFIG.atrSlMultiplier))),
    smcLookbackBars: Math.max(30, Math.min(250, finiteNum(partial?.smcLookbackBars, DEFAULT_EMA_PRO_CONFIG.smcLookbackBars))),
    swingStrength: Math.max(1, Math.min(5, finiteNum(partial?.swingStrength, DEFAULT_EMA_PRO_CONFIG.swingStrength))),
    aiConfidenceThreshold: Math.max(40, Math.min(99, finiteNum(partial?.aiConfidenceThreshold, DEFAULT_EMA_PRO_CONFIG.aiConfidenceThreshold))),
    maxRiskPercent: Math.max(0.1, Math.min(5.0, finiteNum(partial?.maxRiskPercent, DEFAULT_EMA_PRO_CONFIG.maxRiskPercent))),
    maxSimultaneousPositions: Math.max(1, Math.min(10, finiteNum(partial?.maxSimultaneousPositions, DEFAULT_EMA_PRO_CONFIG.maxSimultaneousPositions))),
    maxTradesPerSession: Math.max(1, Math.min(20, finiteNum(partial?.maxTradesPerSession, DEFAULT_EMA_PRO_CONFIG.maxTradesPerSession))),
    minRewardRisk: Math.max(1.0, Math.min(5.0, finiteNum(partial?.minRewardRisk, DEFAULT_EMA_PRO_CONFIG.minRewardRisk))),
    tp1Rr: Math.max(0.5, Math.min(3.0, finiteNum(partial?.tp1Rr, DEFAULT_EMA_PRO_CONFIG.tp1Rr))),
    tp2Rr: Math.max(1.0, Math.min(5.0, finiteNum(partial?.tp2Rr, DEFAULT_EMA_PRO_CONFIG.tp2Rr))),
    tp3Rr: Math.max(1.5, Math.min(10.0, finiteNum(partial?.tp3Rr, DEFAULT_EMA_PRO_CONFIG.tp3Rr))),
    maxSpreadPips: Math.max(15, Math.min(500, finiteNum(partial?.maxSpreadPips, DEFAULT_EMA_PRO_CONFIG.maxSpreadPips))),
    spreadSensitivity: sens,
    allowHighSpreadTrades: Boolean(partial?.allowHighSpreadTrades ?? DEFAULT_EMA_PRO_CONFIG.allowHighSpreadTrades),
    minNetRewardRisk: Math.max(1.0, Math.min(4.0, finiteNum(partial?.minNetRewardRisk, DEFAULT_EMA_PRO_CONFIG.minNetRewardRisk))),
    commissionPerLot: Math.max(0, Math.min(50, finiteNum(partial?.commissionPerLot, DEFAULT_EMA_PRO_CONFIG.commissionPerLot))),
    estimatedSlippagePoints: Math.max(0, Math.min(50, finiteNum(partial?.estimatedSlippagePoints, DEFAULT_EMA_PRO_CONFIG.estimatedSlippagePoints))),
    maxQuoteAgeSeconds: Math.max(3, Math.min(120, finiteNum(partial?.maxQuoteAgeSeconds, DEFAULT_EMA_PRO_CONFIG.maxQuoteAgeSeconds))),
    signalExpiryMinutes: Math.max(1, Math.min(60, finiteNum(partial?.signalExpiryMinutes, DEFAULT_EMA_PRO_CONFIG.signalExpiryMinutes))),
    maxEntryDeviationPips: Math.max(1, Math.min(100, finiteNum(partial?.maxEntryDeviationPips, DEFAULT_EMA_PRO_CONFIG.maxEntryDeviationPips))),
    xauusdSymbol: String(partial?.xauusdSymbol ?? DEFAULT_EMA_PRO_CONFIG.xauusdSymbol).trim() || 'XAUUSD',
    demoOnlyMode: partial?.demoOnlyMode ?? DEFAULT_EMA_PRO_CONFIG.demoOnlyMode,
    liveTradingAuthorized: partial?.liveTradingAuthorized ?? DEFAULT_EMA_PRO_CONFIG.liveTradingAuthorized,
    allowBuy: partial?.allowBuy ?? DEFAULT_EMA_PRO_CONFIG.allowBuy,
    allowSell: partial?.allowSell ?? DEFAULT_EMA_PRO_CONFIG.allowSell,
    tradingMode: partial?.tradingMode ?? DEFAULT_EMA_PRO_CONFIG.tradingMode,
    tradingRunState: partial?.tradingRunState ?? DEFAULT_EMA_PRO_CONFIG.tradingRunState,
    settingsVersion: Math.max(1, finiteNum(partial?.settingsVersion, DEFAULT_EMA_PRO_CONFIG.settingsVersion)),
    telegramNotifyExecutions:
      partial?.telegramNotifyExecutions !== undefined
        ? Boolean(partial.telegramNotifyExecutions)
        : DEFAULT_EMA_PRO_CONFIG.telegramNotifyExecutions,
    telegramNotifyTpSl:
      partial?.telegramNotifyTpSl !== undefined
        ? Boolean(partial.telegramNotifyTpSl)
        : DEFAULT_EMA_PRO_CONFIG.telegramNotifyTpSl,
  };
}

export function filterClosedCandles(candles: M15Candle[] | undefined | null): M15Candle[] {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const byTs = new Map<number, M15Candle>();
  for (const c of candles) {
    if (
      !c ||
      !c.closed ||
      !Number.isFinite(c.openTimeMs) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
    ) {
      continue;
    }
    byTs.set(c.openTimeMs, c);
  }
  return Array.from(byTs.values()).sort((a, b) => a.openTimeMs - b.openTimeMs);
}

/**
 * Standard EMA computed strictly over closed values.
 * Returns null for indices before period - 1 so insufficient history never fabricates an EMA200.
 */
export function calculateEMA(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    sum += values[i];
  }
  let ema = sum / period;
  out[period - 1] = round2(ema);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = round2(ema);
  }
  return out;
}

export function calculateATR(
  candles: M15Candle[],
  period = 14
): { series: Array<number | null>; current: number | null } {
  const n = candles.length;
  const series: Array<number | null> = new Array(n).fill(null);
  if (n < period + 1 || period < 1) {
    return { series, current: null };
  }
  const trs: number[] = new Array(n).fill(0);
  trs[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let atrSum = 0;
  for (let i = 1; i <= period; i += 1) {
    atrSum += trs[i];
  }
  let atr = atrSum / period;
  series[period] = round2(atr);
  for (let i = period + 1; i < n; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period;
    series[i] = round2(atr);
  }
  return { series, current: series[n - 1] };
}

export interface StochasticResult {
  kSeries: Array<number | null>;
  dSeries: Array<number | null>;
  k: number | null;
  d: number | null;
  prevK: number | null;
  prevD: number | null;
  crossK: number | null;
  cross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NONE';
  recentBullCross: boolean;
  recentBearCross: boolean;
  zone: 'OVERSOLD' | 'OVERBOUGHT' | 'NEUTRAL';
}

export function calculateStochastic(
  candles: M15Candle[],
  kPeriod = 14,
  dPeriod = 3,
  slowing = 3,
  overbought = 80,
  oversold = 20
): StochasticResult {
  const n = candles.length;
  const kSeries: Array<number | null> = new Array(n).fill(null);
  const dSeries: Array<number | null> = new Array(n).fill(null);
  const minBars = kPeriod + slowing + dPeriod - 2;
  if (n < minBars) {
    return {
      kSeries,
      dSeries,
      k: null,
      d: null,
      prevK: null,
      prevD: null,
      crossK: null,
      cross: 'NONE',
      recentBullCross: false,
      recentBearCross: false,
      zone: 'NEUTRAL',
    };
  }

  const rawK: Array<number | null> = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }
    const range = highest - lowest;
    rawK[i] = range <= 1e-6 ? 50 : ((candles[i].close - lowest) / range) * 100;
  }

  for (let i = kPeriod - 1 + slowing - 1; i < n; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = i - slowing + 1; j <= i; j += 1) {
      const val = rawK[j];
      if (val !== null) {
        sum += val;
        count += 1;
      }
    }
    if (count === slowing) {
      kSeries[i] = round2(sum / slowing);
    }
  }

  for (let i = minBars - 1; i < n; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = i - dPeriod + 1; j <= i; j += 1) {
      const val = kSeries[j];
      if (val !== null) {
        sum += val;
        count += 1;
      }
    }
    if (count === dPeriod) {
      dSeries[i] = round2(sum / dPeriod);
    }
  }

  const k = kSeries[n - 1];
  const d = dSeries[n - 1];
  const prevK = n >= 2 ? kSeries[n - 2] : null;
  const prevD = n >= 2 ? dSeries[n - 2] : null;

  let cross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NONE' = 'NONE';
  let crossK: number | null = null;
  if (k !== null && d !== null && prevK !== null && prevD !== null) {
    if (prevK <= prevD && k > d) {
      cross = 'BULLISH_CROSS';
      crossK = k;
    } else if (prevK >= prevD && k < d) {
      cross = 'BEARISH_CROSS';
      crossK = k;
    }
  }

  // Detect any genuine %K/%D crossover on current or last 3 closed bars across oversold, 20-50, midpoint, or 50-80 zones.
  // Trend & SMC structure (not Stoch thresholds alone) determine trade direction.
  let recentBullCross = cross === 'BULLISH_CROSS';
  let recentBearCross = cross === 'BEARISH_CROSS';

  if (!recentBullCross && k !== null && d !== null && k > d) {
    for (let idx = n - 1; idx >= Math.max(2, n - 3); idx -= 1) {
      const ck = kSeries[idx];
      const cd = dSeries[idx];
      const pk = kSeries[idx - 1];
      const pd = dSeries[idx - 1];
      if (ck !== null && cd !== null && pk !== null && pd !== null) {
        if (pk <= pd && ck > cd) {
          recentBullCross = true;
          crossK = ck;
          break;
        }
      }
    }
  }
  if (!recentBearCross && k !== null && d !== null && k < d) {
    for (let idx = n - 1; idx >= Math.max(2, n - 3); idx -= 1) {
      const ck = kSeries[idx];
      const cd = dSeries[idx];
      const pk = kSeries[idx - 1];
      const pd = dSeries[idx - 1];
      if (ck !== null && cd !== null && pk !== null && pd !== null) {
        if (pk >= pd && ck < cd) {
          recentBearCross = true;
          crossK = ck;
          break;
        }
      }
    }
  }

  let zone: 'OVERSOLD' | 'OVERBOUGHT' | 'NEUTRAL' = 'NEUTRAL';
  if (k !== null) {
    if (k <= oversold) zone = 'OVERSOLD';
    else if (k >= overbought) zone = 'OVERBOUGHT';
  }

  return {
    kSeries,
    dSeries,
    k,
    d,
    prevK,
    prevD,
    crossK,
    cross,
    recentBullCross,
    recentBearCross,
    zone,
  };
}

export function analyzeTimeframeIndicators(
  rawCandles: M15Candle[],
  timeframe: 'H1' | 'M15' | 'M5' | 'M1',
  cfg: EmaStochasticProConfig
): TimeframeIndicatorSnapshot {
  const candles = filterClosedCandles(rawCandles);
  const n = candles.length;
  if (n === 0) {
    return {
      timeframe,
      barsCount: 0,
      lastClose: null,
      ema9: null,
      ema21: null,
      ema50: null,
      ema200: null,
      ema50Slope: 'FLAT',
      emaBias: 'NEUTRAL',
      isCompressedOrChoppy: false,
      stochK: null,
      stochD: null,
      stochCross: 'NONE',
      stochZone: 'NEUTRAL',
      atr: null,
    };
  }

  const closes = candles.map((c) => c.close);
  const ema9Series = calculateEMA(closes, cfg.emaFast);
  const ema21Series = calculateEMA(closes, cfg.emaMid);
  const ema50Series = calculateEMA(closes, cfg.emaIntermediate);
  const ema200Series = calculateEMA(closes, cfg.emaMajor);
  const atrRes = calculateATR(candles, cfg.atrPeriod);
  const stoch = calculateStochastic(
    candles,
    cfg.stochK,
    cfg.stochD,
    cfg.stochSlowing,
    cfg.stochOverbought,
    cfg.stochOversold
  );

  const lastClose = candles[n - 1].close;
  const ema9 = ema9Series[n - 1];
  const ema21 = ema21Series[n - 1];
  const ema50 = ema50Series[n - 1];
  const ema200 = ema200Series[n - 1];
  const atr = atrRes.current;

  let ema50Slope: 'RISING' | 'FALLING' | 'FLAT' = 'FLAT';
  const prevEma50Idx = Math.max(0, n - 6);
  const prevEma50 = ema50Series[prevEma50Idx];
  if (ema50 !== null && prevEma50 !== null) {
    const slopeDelta = ema50 - prevEma50;
    if (slopeDelta >= 0.12) ema50Slope = 'RISING';
    else if (slopeDelta <= -0.12) ema50Slope = 'FALLING';
  }

  // Detect EMA compression / repeated crossovers in sideways markets
  let isCompressedOrChoppy = false;
  if (ema9 !== null && ema21 !== null && ema50 !== null) {
    const bandSpread = Math.max(ema9, ema21, ema50) - Math.min(ema9, ema21, ema50);
    const atrRef = atr ?? 2.0;
    let flipCount = 0;
    const checkStart = Math.max(1, n - 12);
    for (let i = checkStart; i < n; i += 1) {
      const a0 = ema9Series[i - 1];
      const b0 = ema21Series[i - 1];
      const a1 = ema9Series[i];
      const b1 = ema21Series[i];
      if (a0 !== null && b0 !== null && a1 !== null && b1 !== null) {
        if ((a0 <= b0 && a1 > b1) || (a0 >= b0 && a1 < b1)) {
          flipCount += 1;
        }
      }
    }
    if (bandSpread < atrRef * 0.35 || flipCount >= 3) {
      isCompressedOrChoppy = true;
    }
  }

  let emaBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'CHOP' = 'NEUTRAL';
  if (isCompressedOrChoppy) {
    emaBias = 'CHOP';
  } else if (ema9 !== null && ema21 !== null && ema50 !== null && ema200 !== null) {
    if (ema50 > ema200 && ema9 > ema21 && lastClose >= ema50 * 0.999) {
      emaBias = 'BULLISH';
    } else if (ema50 < ema200 && ema9 < ema21 && lastClose <= ema50 * 1.001) {
      emaBias = 'BEARISH';
    }
  }

  return {
    timeframe,
    barsCount: n,
    lastClose: round2(lastClose),
    ema9,
    ema21,
    ema50,
    ema200,
    ema50Slope,
    emaBias,
    isCompressedOrChoppy,
    stochK: stoch.k,
    stochD: stoch.d,
    stochCross: stoch.cross,
    stochZone: stoch.zone,
    atr,
  };
}

/**
 * Non-repainting Smart Money Concepts Analyzer.
 * Swings are only confirmed after `swingStrength` right-side closed bars.
 * BOS and CHoCH are strictly confirmed on candle closes, never intrabar wicks.
 */
export function analyzeSmc(
  rawCandles: M15Candle[],
  lookbackBars = 80,
  swingStrength = 2,
  atrRef: number | null = null
): SmcAnalysis {
  const allClosed = filterClosedCandles(rawCandles);
  const candles = allClosed.slice(-Math.max(30, lookbackBars));
  const n = candles.length;
  if (n < swingStrength * 2 + 5) {
    return {
      trendStructure: 'RANGING',
      lastBos: null,
      lastChoch: null,
      lastSweep: null,
      equalHighs: [],
      equalLows: [],
      swingHighs: [],
      swingLows: [],
      activeBullishObs: [],
      activeBearishObs: [],
      activeBullishFvgs: [],
      activeBearishFvgs: [],
      dealingRangeHigh: null,
      dealingRangeLow: null,
      equilibriumPrice: null,
      priceZone: 'UNKNOWN',
      bullishSetupPresent: false,
      bearishSetupPresent: false,
      evidenceSummary: ['Insufficient closed candles for SMC analysis'],
    };
  }

  const k = Math.max(1, swingStrength);
  const swingHighs: SmcSwingPoint[] = [];
  const swingLows: SmcSwingPoint[] = [];

  for (let i = k; i <= n - 1 - k; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (j < i) {
        if (candles[j].high > candles[i].high) isHigh = false;
        if (candles[j].low < candles[i].low) isLow = false;
      } else {
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low <= candles[i].low) isLow = false;
      }
    }
    if (isHigh) {
      swingHighs.push({
        index: i,
        openTimeMs: candles[i].openTimeMs,
        timeLusaka: candles[i].closeTimeLusaka,
        type: 'HIGH',
        price: round2(candles[i].high),
      });
    }
    if (isLow) {
      swingLows.push({
        index: i,
        openTimeMs: candles[i].openTimeMs,
        timeLusaka: candles[i].closeTimeLusaka,
        type: 'LOW',
        price: round2(candles[i].low),
      });
    }
  }

  // Equal Highs / Equal Lows
  const eqTol = Math.max(0.6, (atrRef ?? 2.0) * 0.25);
  const equalHighs: number[] = [];
  const equalLows: number[] = [];
  for (let i = 1; i < swingHighs.length; i += 1) {
    if (Math.abs(swingHighs[i].price - swingHighs[i - 1].price) <= eqTol) {
      equalHighs.push(round2((swingHighs[i].price + swingHighs[i - 1].price) / 2));
    }
  }
  for (let i = 1; i < swingLows.length; i += 1) {
    if (Math.abs(swingLows[i].price - swingLows[i - 1].price) <= eqTol) {
      equalLows.push(round2((swingLows[i].price + swingLows[i - 1].price) / 2));
    }
  }

  // Walk chronologically to detect confirmed-close BOS & CHoCH and Order Blocks
  let trendStructure: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';
  let lastBos: SmcStructureEvent | null = null;
  let lastChoch: SmcStructureEvent | null = null;
  const rawBullObs: SmcOrderBlock[] = [];
  const rawBearObs: SmcOrderBlock[] = [];

  let activeHighTarget: SmcSwingPoint | null = null;
  let activeLowTarget: SmcSwingPoint | null = null;
  let shPtr = 0;
  let slPtr = 0;

  for (let i = 0; i < n; i += 1) {
    // Only swings confirmed at least `k` bars ago are visible at bar `i` (strictly non-repainting)
    while (shPtr < swingHighs.length && swingHighs[shPtr].index + k <= i) {
      activeHighTarget = swingHighs[shPtr];
      shPtr += 1;
    }
    while (slPtr < swingLows.length && swingLows[slPtr].index + k <= i) {
      activeLowTarget = swingLows[slPtr];
      slPtr += 1;
    }

    const bar = candles[i];
    if (activeHighTarget && bar.close > activeHighTarget.price) {
      const evType: SmcStructureEvent['type'] =
        trendStructure === 'BEARISH' ? 'CHOCH_BULL' : 'BOS_BULL';
      const ev: SmcStructureEvent = {
        type: evType,
        price: activeHighTarget.price,
        timeLusaka: bar.closeTimeLusaka,
        openTimeMs: bar.openTimeMs,
      };
      if (evType === 'CHOCH_BULL') lastChoch = ev;
      else lastBos = ev;
      trendStructure = 'BULLISH';

      // Locate last bearish candle preceding displacement
      for (let b = i - 1; b >= Math.max(0, activeHighTarget.index - 2); b -= 1) {
        if (candles[b].close < candles[b].open) {
          rawBullObs.push({
            direction: 'BULLISH',
            high: round2(candles[b].high),
            low: round2(candles[b].low),
            openTimeMs: candles[b].openTimeMs,
            timeLusaka: candles[b].closeTimeLusaka,
            mitigated: false,
          });
          break;
        }
      }
      activeHighTarget = null;
    } else if (activeLowTarget && bar.close < activeLowTarget.price) {
      const evType: SmcStructureEvent['type'] =
        trendStructure === 'BULLISH' ? 'CHOCH_BEAR' : 'BOS_BEAR';
      const ev: SmcStructureEvent = {
        type: evType,
        price: activeLowTarget.price,
        timeLusaka: bar.closeTimeLusaka,
        openTimeMs: bar.openTimeMs,
      };
      if (evType === 'CHOCH_BEAR') lastChoch = ev;
      else lastBos = ev;
      trendStructure = 'BEARISH';

      for (let b = i - 1; b >= Math.max(0, activeLowTarget.index - 2); b -= 1) {
        if (candles[b].close > candles[b].open) {
          rawBearObs.push({
            direction: 'BEARISH',
            high: round2(candles[b].high),
            low: round2(candles[b].low),
            openTimeMs: candles[b].openTimeMs,
            timeLusaka: candles[b].closeTimeLusaka,
            mitigated: false,
          });
          break;
        }
      }
      activeLowTarget = null;
    }
  }

  // Evaluate OB mitigation on subsequent closed candles
  const activeBullishObs: SmcOrderBlock[] = [];
  for (const ob of rawBullObs.slice(-5)) {
    const invalidated = candles.some(
      (c) => c.openTimeMs > ob.openTimeMs && c.close < ob.low
    );
    if (!invalidated) {
      activeBullishObs.push(ob);
    }
  }
  const activeBearishObs: SmcOrderBlock[] = [];
  for (const ob of rawBearObs.slice(-5)) {
    const invalidated = candles.some(
      (c) => c.openTimeMs > ob.openTimeMs && c.close > ob.high
    );
    if (!invalidated) {
      activeBearishObs.push(ob);
    }
  }

  // Fair Value Gaps (3-candle imbalances)
  const activeBullishFvgs: SmcFvgZone[] = [];
  const activeBearishFvgs: SmcFvgZone[] = [];
  for (let i = 2; i < n; i += 1) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (c2.low > c0.high + 0.1) {
      const mitigated = candles.slice(i + 1).some((c) => c.low <= c0.high);
      if (!mitigated) {
        activeBullishFvgs.push({
          direction: 'BULLISH',
          top: round2(c2.low),
          bottom: round2(c0.high),
          timeLusaka: c2.closeTimeLusaka,
          openTimeMs: c2.openTimeMs,
          mitigated: false,
        });
      }
    } else if (c2.high < c0.low - 0.1) {
      const mitigated = candles.slice(i + 1).some((c) => c.high >= c0.low);
      if (!mitigated) {
        activeBearishFvgs.push({
          direction: 'BEARISH',
          top: round2(c0.low),
          bottom: round2(c2.high),
          timeLusaka: c2.closeTimeLusaka,
          openTimeMs: c2.openTimeMs,
          mitigated: false,
        });
      }
    }
  }

  // Liquidity Sweep detection in the most recent 10 closed bars against prior confirmed swings
  // False breakouts without rejection close back inside/past swept swing are ignored.
  let lastSweep: SmcLiquiditySweep | null = null;
  const sweepStart = Math.max(k + 2, n - 10);
  for (let i = n - 1; i >= sweepStart; i -= 1) {
    const bar = candles[i];
    const priorLows = swingLows.filter((s) => s.index + k < i);
    const priorHighs = swingHighs.filter((s) => s.index + k < i);

    const sweptLow = priorLows
      .slice()
      .reverse()
      .find((s) => bar.low < s.price && bar.close > s.price);
    if (sweptLow && bar.close >= bar.open - 0.25) {
      lastSweep = {
        direction: 'BULLISH',
        sweptLevel: sweptLow.price,
        sweepExtreme: round2(bar.low),
        closePrice: round2(bar.close),
        timeLusaka: bar.closeTimeLusaka,
        openTimeMs: bar.openTimeMs,
        label: `Bullish SSL Sweep @ ${sweptLow.price.toFixed(2)}`,
      };
      break;
    }

    const sweptHigh = priorHighs
      .slice()
      .reverse()
      .find((s) => bar.high > s.price && bar.close < s.price);
    if (sweptHigh && bar.close <= bar.open + 0.25) {
      lastSweep = {
        direction: 'BEARISH',
        sweptLevel: sweptHigh.price,
        sweepExtreme: round2(bar.high),
        closePrice: round2(bar.close),
        timeLusaka: bar.closeTimeLusaka,
        openTimeMs: bar.openTimeMs,
        label: `Bearish BSL Sweep @ ${sweptHigh.price.toFixed(2)}`,
      };
      break;
    }
  }

  // Dealing Range & Premium/Discount Zone
  const lastSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : null;
  const lastSwingLow = swingLows.length > 0 ? swingLows[swingLows.length - 1].price : null;
  const dealingRangeHigh =
    lastSwingHigh !== null && lastSwingLow !== null && lastSwingHigh > lastSwingLow
      ? lastSwingHigh
      : round2(Math.max(...candles.slice(-25).map((c) => c.high)));
  const dealingRangeLow =
    lastSwingHigh !== null && lastSwingLow !== null && lastSwingHigh > lastSwingLow
      ? lastSwingLow
      : round2(Math.min(...candles.slice(-25).map((c) => c.low)));
  const equilibriumPrice = round2((dealingRangeHigh + dealingRangeLow) / 2);
  const lastClose = candles[n - 1].close;
  const rangeSpan = Math.max(0.1, dealingRangeHigh - dealingRangeLow);
  let priceZone: SmcAnalysis['priceZone'] = 'EQUILIBRIUM';
  if (lastClose <= equilibriumPrice - rangeSpan * 0.05) priceZone = 'DISCOUNT';
  else if (lastClose >= equilibriumPrice + rangeSpan * 0.05) priceZone = 'PREMIUM';

  const latestNearBullOb = activeBullishObs.some(
    (ob) => lastClose >= ob.low - 1.5 && lastClose <= ob.high + 3.0
  );
  const latestNearBearOb = activeBearishObs.some(
    (ob) => lastClose <= ob.high + 1.5 && lastClose >= ob.low - 3.0
  );
  const latestNearBullFvg = activeBullishFvgs.some(
    (f) => lastClose >= f.bottom - 1.5 && lastClose <= f.top + 3.0
  );
  const latestNearBearFvg = activeBearishFvgs.some(
    (f) => lastClose <= f.top + 1.5 && lastClose >= f.bottom - 3.0
  );

  const bullishSetupPresent =
    (lastSweep?.direction === 'BULLISH' ||
      lastBos?.type === 'BOS_BULL' ||
      lastChoch?.type === 'CHOCH_BULL' ||
      latestNearBullOb ||
      latestNearBullFvg ||
      (trendStructure === 'BULLISH' && priceZone !== 'PREMIUM'));

  const bearishSetupPresent =
    (lastSweep?.direction === 'BEARISH' ||
      lastBos?.type === 'BOS_BEAR' ||
      lastChoch?.type === 'CHOCH_BEAR' ||
      latestNearBearOb ||
      latestNearBearFvg ||
      (trendStructure === 'BEARISH' && priceZone !== 'DISCOUNT'));

  const evidenceSummary: string[] = [];
  evidenceSummary.push(`Structure: ${trendStructure}`);
  if (lastBos) evidenceSummary.push(`${lastBos.type} @ ${lastBos.price.toFixed(2)}`);
  if (lastChoch) evidenceSummary.push(`${lastChoch.type} @ ${lastChoch.price.toFixed(2)}`);
  if (lastSweep) evidenceSummary.push(lastSweep.label);
  if (activeBullishObs.length > 0) evidenceSummary.push(`${activeBullishObs.length} Bull OB`);
  if (activeBearishObs.length > 0) evidenceSummary.push(`${activeBearishObs.length} Bear OB`);
  if (activeBullishFvgs.length > 0) evidenceSummary.push(`${activeBullishFvgs.length} Bull FVG`);
  if (activeBearishFvgs.length > 0) evidenceSummary.push(`${activeBearishFvgs.length} Bear FVG`);
  evidenceSummary.push(`Zone: ${priceZone} (Eq ${equilibriumPrice.toFixed(2)})`);

  return {
    trendStructure,
    lastBos,
    lastChoch,
    lastSweep,
    equalHighs: equalHighs.slice(-4),
    equalLows: equalLows.slice(-4),
    swingHighs: swingHighs.slice(-8),
    swingLows: swingLows.slice(-8),
    activeBullishObs: activeBullishObs.slice(-4),
    activeBearishObs: activeBearishObs.slice(-4),
    activeBullishFvgs: activeBullishFvgs.slice(-4),
    activeBearishFvgs: activeBearishFvgs.slice(-4),
    dealingRangeHigh,
    dealingRangeLow,
    equilibriumPrice,
    priceZone,
    bullishSetupPresent,
    bearishSetupPresent,
    evidenceSummary,
  };
}

export function calculatePositionSizeFromEquity(params: {
  equity: number | null | undefined;
  riskPercent: number;
  maxRiskPercent: number;
  entry: number;
  stop: number;
  maxAutoLotCap: number;
  tickSize?: number;
  tickValuePerTickPerLot?: number;
}): {
  valid: boolean;
  lots: number;
  riskDollars: number;
  effectiveRiskPct: number;
  reason?: string;
} {
  const {
    equity,
    riskPercent,
    maxRiskPercent,
    entry,
    stop,
    maxAutoLotCap,
    tickSize = 0.01,
    tickValuePerTickPerLot = 1.0,
  } = params;

  if (typeof equity !== 'number' || !Number.isFinite(equity) || equity <= 0) {
    return {
      valid: false,
      lots: 0,
      riskDollars: 0,
      effectiveRiskPct: 0,
      reason: 'Account equity is unavailable',
    };
  }
  const stopDist = Math.abs(entry - stop);
  if (!Number.isFinite(stopDist) || stopDist < 0.1) {
    return {
      valid: false,
      lots: 0,
      riskDollars: 0,
      effectiveRiskPct: 0,
      reason: 'Invalid stop loss distance',
    };
  }

  const effectiveRiskPct = Math.min(
    Math.max(0.05, Number.isFinite(riskPercent) ? riskPercent : 0.5),
    Math.max(0.1, Number.isFinite(maxRiskPercent) ? maxRiskPercent : 1.0)
  );
  const targetRiskDollars = round2((equity * effectiveRiskPct) / 100);
  const riskPerLot = (stopDist / tickSize) * tickValuePerTickPerLot;
  if (riskPerLot <= 0) {
    return {
      valid: false,
      lots: 0,
      riskDollars: 0,
      effectiveRiskPct,
      reason: 'Invalid contract tick calculation',
    };
  }

  const cap = Math.max(0.01, Number.isFinite(maxAutoLotCap) ? maxAutoLotCap : 0.5);
  const rawLots = targetRiskDollars / riskPerLot;
  let lots = Math.floor(rawLots * 100) / 100;
  if (lots < 0.01) {
    // Only allow minimum 0.01 if its risk does not breach hard 2x maxRiskPercent on small accounts
    const minLotRisk = 0.01 * riskPerLot;
    if (minLotRisk <= equity * ((maxRiskPercent * 2) / 100)) {
      lots = 0.01;
    } else {
      return {
        valid: false,
        lots: 0,
        riskDollars: 0,
        effectiveRiskPct,
        reason: `Minimum 0.01 lot risk ($${minLotRisk.toFixed(2)}) exceeds safe limit for $${equity.toFixed(2)} equity`,
      };
    }
  }
  lots = round2(Math.min(cap, lots));
  const actualRiskDollars = round2(lots * riskPerLot);

  return {
    valid: true,
    lots,
    riskDollars: actualRiskDollars,
    effectiveRiskPct,
  };
}

export function evaluateEmaStochasticProSignal(params: {
  h1Candles: M15Candle[];
  m15Candles: M15Candle[];
  m5Candles: M15Candle[];
  m1Candles?: M15Candle[];
  settings: StrategySettings;
  levels: DaySessionLevels;
  phase: SessionPhase;
  latestPrice: number | null;
  bid?: number | null;
  ask?: number | null;
  quoteTimestamp?: string | null;
  quoteSource?: string;
  hasTwoSidedQuote?: boolean;
  isFallbackOnly?: boolean;
  symbolSpec?: SymbolSpecification | null;
  spreadHistory?: SpreadSampleRecord[];
  spreadEvaluation?: DynamicSpreadEvaluation | null;
  spreadPips?: number | null;
  accountEquity: number | null | undefined;
  openPositionsCount?: number;
  dailyPnlPct?: number;
  isWeekend?: boolean;
  feedConnected?: boolean;
  nowMs?: number;
}): {
  analysis: EmaStochasticProSnapshot;
  signal: TradeSignal;
} {
  const {
    h1Candles,
    m15Candles,
    m5Candles,
    m1Candles = [],
    settings,
    levels,
    phase,
    latestPrice,
    spreadPips = null,
    accountEquity,
    openPositionsCount = 0,
    dailyPnlPct = 0,
    isWeekend = false,
    feedConnected = true,
    nowMs = Date.now(),
  } = params;

  const cfg = mergeEmaProConfig(settings.emaPro);
  const clock = getLusakaClock(nowMs);
  const symbolSpec: SymbolSpecification = params.symbolSpec ?? {
    ...DEFAULT_SYMBOL_SPEC,
    symbol: cfg.xauusdSymbol || 'XAUUSD',
    commissionPerLot: cfg.commissionPerLot,
  };

  const closedH1 = filterClosedCandles(h1Candles);
  const closedM15 = filterClosedCandles(m15Candles);
  const closedM5 = filterClosedCandles(m5Candles);
  const closedM1 = filterClosedCandles(m1Candles);

  const h1 = analyzeTimeframeIndicators(closedH1, 'H1', cfg);
  const m15 = analyzeTimeframeIndicators(closedM15, 'M15', cfg);
  const m5 = analyzeTimeframeIndicators(closedM5, 'M5', cfg);
  const m1 = analyzeTimeframeIndicators(closedM1, 'M1', cfg);

  const smcSource = closedM5.length >= 30 ? closedM5 : closedM15;
  const smc = analyzeSmc(
    smcSource,
    cfg.smcLookbackBars,
    cfg.swingStrength,
    m5.atr ?? m15.atr
  );
  const m15Smc = analyzeSmc(
    closedM15,
    cfg.smcLookbackBars,
    cfg.swingStrength,
    m15.atr ?? m5.atr
  );

  const m5Stoch = calculateStochastic(
    closedM5,
    cfg.stochK,
    cfg.stochD,
    cfg.stochSlowing,
    cfg.stochOverbought,
    cfg.stochOversold
  );

  const lastM5 = closedM5.length > 0 ? closedM5[closedM5.length - 1] : null;
  const prevM5 = closedM5.length > 1 ? closedM5[closedM5.length - 2] : null;

  let pullbackToEma: 'EMA_9' | 'EMA_21' | 'NONE' = 'NONE';
  let confirmationCandle: 'BULLISH_CLOSE' | 'BEARISH_CLOSE' | 'NONE' = 'NONE';
  let strongCandleBody = false;
  if (lastM5 && m5.ema9 !== null && m5.ema21 !== null) {
    const tol = Math.max(0.6, (m5.atr ?? 1.5) * 0.45);
    const barRange = Math.max(0.05, lastM5.high - lastM5.low);
    const body = Math.abs(lastM5.close - lastM5.open);
    const lowerWick = Math.min(lastM5.open, lastM5.close) - lastM5.low;
    const upperWick = lastM5.high - Math.max(lastM5.open, lastM5.close);

    const barBullishBody = lastM5.close > lastM5.open && body >= barRange * 0.25;
    const barBullishRejection =
      lowerWick >= barRange * 0.45 && lastM5.close >= lastM5.low + barRange * 0.55;
    const barBearishBody = lastM5.close < lastM5.open && body >= barRange * 0.25;
    const barBearishRejection =
      upperWick >= barRange * 0.45 && lastM5.close <= lastM5.high - barRange * 0.55;

    if (barBullishBody || barBullishRejection) confirmationCandle = 'BULLISH_CLOSE';
    else if (barBearishBody || barBearishRejection) confirmationCandle = 'BEARISH_CLOSE';
    strongCandleBody = body >= barRange * 0.4 || barBullishRejection || barBearishRejection;

    const touchedEma9 = lastM5.low <= m5.ema9 + tol && lastM5.high >= m5.ema9 - tol;
    const touchedEma21 = lastM5.low <= m5.ema21 + tol && lastM5.high >= m5.ema21 - tol;
    const prevTouched9 = prevM5 ? prevM5.low <= m5.ema9 + tol && prevM5.high >= m5.ema9 - tol : false;
    const prevTouched21 = prevM5 ? prevM5.low <= m5.ema21 + tol && prevM5.high >= m5.ema21 - tol : false;

    if (touchedEma21 || prevTouched21) pullbackToEma = 'EMA_21';
    else if (touchedEma9 || prevTouched9) pullbackToEma = 'EMA_9';
  }

  const overallTrend: EmaStochasticProSnapshot['overallTrend'] =
    h1.ema50 !== null && h1.ema200 !== null && h1.ema50 > h1.ema200 && m15.ema9 !== null && m15.ema21 !== null && m15.ema9 > m15.ema21
      ? 'BULLISH'
      : h1.ema50 !== null && h1.ema200 !== null && h1.ema50 < h1.ema200 && m15.ema9 !== null && m15.ema21 !== null && m15.ema9 < m15.ema21
        ? 'BEARISH'
        : 'SIDEWAYS';

  const atrPips = m5.atr !== null ? Math.round(m5.atr * 10) : m15.atr !== null ? Math.round(m15.atr * 10) : null;

  let marketCondition: EmaStochasticProSnapshot['marketCondition'] = 'TRENDING';
  if (m5.barsCount < 35 || m15.barsCount < 30 || m5.atr === null) {
    marketCondition = 'LOW_DATA';
  } else if (m5.atr > 9.5) {
    marketCondition = 'HIGH_VOLATILITY';
  } else if (m5.isCompressedOrChoppy || (overallTrend === 'SIDEWAYS' && !smc.lastChoch && !m15Smc.lastChoch)) {
    marketCondition = 'CHOPPY_SIDEWAYS';
  }

  const enabledNewsCount = settings.newsEvents.filter((n) => n.enabled && n.impact === 'HIGH').length;
  const newsFeedStatus: EmaStochasticProSnapshot['newsFeedStatus'] =
    enabledNewsCount > 0 ? 'CALENDAR_CONFIGURED' : 'NEWS_DATA_UNAVAILABLE';
  const newsStatus = evaluateUsdNewsClearance(clock.minutes, settings);

  // All-session trading: tag current market session accurately while never blocking weekday open hours
  const strategyWindow: TradingSessionTag =
    phase === 'ASIAN_SESSION' ||
    phase === 'LONDON_SESSION' ||
    phase === 'NEW_YORK_SESSION' ||
    phase === 'ALL_SESSIONS'
      ? phase
      : clock.minutes >= 180 && clock.minutes < 660
        ? 'ASIAN_SESSION'
        : clock.minutes >= 660 && clock.minutes <= 1140
          ? 'LONDON_SESSION'
          : clock.minutes > 1140
            ? 'NEW_YORK_SESSION'
            : 'ALL_SESSIONS';

  const sessionTrades =
    strategyWindow === 'ASIAN_SESSION'
      ? levels.asianTradesToday
      : strategyWindow === 'LONDON_SESSION'
        ? levels.londonTradesToday
        : Math.max(0, levels.totalTradesToday - levels.asianTradesToday - levels.londonTradesToday);

  const dailyLossLimitHit = dailyPnlPct <= -Math.abs(settings.dailyGuardPct || 5.0);
  const consecutiveLossHit = levels.consecutiveLossesToday >= (settings.maxConsecutiveLosses || 3);
  const maxDailyTrades = settings.maxTradesPerDay || 10;
  const dailyTradeCapHit = levels.totalTradesToday >= maxDailyTrades;
  const sessionTradeCapHit = sessionTrades >= cfg.maxTradesPerSession;
  const maxPosHit = openPositionsCount >= cfg.maxSimultaneousPositions;

  const hasContinuationData =
    h1.ema50 !== null &&
    h1.ema200 !== null &&
    m15.ema9 !== null &&
    m15.ema21 !== null &&
    m5.ema9 !== null &&
    m5.ema21 !== null &&
    m5.atr !== null &&
    lastM5 !== null;

  const hasReversalData =
    m5.barsCount >= 35 &&
    m15.barsCount >= 30 &&
    m5.atr !== null &&
    lastM5 !== null;

  const volatilityOk = m5.atr !== null && m5.atr >= 0.4 && m5.atr <= 9.5;
  const riskHealthy =
    feedConnected &&
    !isWeekend &&
    cfg.tradingRunState === 'RUNNING' &&
    newsStatus.clear &&
    !dailyLossLimitHit &&
    !consecutiveLossHit &&
    !dailyTradeCapHit &&
    !sessionTradeCapHit &&
    !maxPosHit &&
    typeof accountEquity === 'number' &&
    accountEquity > 0;

  const stochCrossK = m5Stoch.crossK ?? m5Stoch.k ?? 50;
  const bullStochCrossOk =
    m5Stoch.k !== null &&
    m5Stoch.d !== null &&
    m5Stoch.recentBullCross &&
    m5Stoch.k > m5Stoch.d &&
    stochCrossK <= Math.min(72, cfg.stochOverbought - 8);
  const bearStochCrossOk =
    m5Stoch.k !== null &&
    m5Stoch.d !== null &&
    m5Stoch.recentBearCross &&
    m5Stoch.k < m5Stoch.d &&
    stochCrossK >= Math.max(28, cfg.stochOversold + 8);

  const stochNote = m5Stoch.recentBullCross
    ? stochCrossK < cfg.stochOversold
      ? `Bull cross in Oversold (<${cfg.stochOversold}) @ ${stochCrossK.toFixed(1)}`
      : stochCrossK <= cfg.stochMidpoint
        ? `Bull cross in Preferred 20-50 band @ ${stochCrossK.toFixed(1)}`
        : bullStochCrossOk
          ? `Trend-aligned bull cross near Midpoint @ ${stochCrossK.toFixed(1)}`
          : `Extended bull cross (${stochCrossK.toFixed(1)})`
    : m5Stoch.recentBearCross
      ? stochCrossK > cfg.stochOverbought
        ? `Bear cross in Overbought (>${cfg.stochOverbought}) @ ${stochCrossK.toFixed(1)}`
        : stochCrossK >= cfg.stochMidpoint
          ? `Bear cross in Preferred 50-80 band @ ${stochCrossK.toFixed(1)}`
          : bearStochCrossOk
            ? `Trend-aligned bear cross near Midpoint @ ${stochCrossK.toFixed(1)}`
            : `Extended bear cross (${stochCrossK.toFixed(1)})`
      : `K ${m5Stoch.k ?? '—'} / D ${m5Stoch.d ?? '—'} (${m5Stoch.zone})`;

  const m1BuyOk = !cfg.m1RefinementEnabled || m1.barsCount < 30 || m1.emaBias !== 'BEARISH';
  const m1SellOk = !cfg.m1RefinementEnabled || m1.barsCount < 30 || m1.emaBias !== 'BULLISH';

  const maxChaseFromEma = Math.max((m5.atr ?? 1.5) * 2.2, cfg.maxEntryDeviationPips * 0.15);
  const notChasingBuy =
    !lastM5 || m5.ema21 === null ? false : lastM5.close - m5.ema21 <= maxChaseFromEma;
  const notChasingSell =
    !lastM5 || m5.ema21 === null ? false : m5.ema21 - lastM5.close <= maxChaseFromEma;

  // --- SETUP A: BULLISH TREND CONTINUATION BUY ---
  const contBuy_H1 = h1.ema50 !== null && h1.ema200 !== null && h1.ema50 > h1.ema200 && !h1.isCompressedOrChoppy;
  const contBuy_M15 =
    m15.ema9 !== null &&
    m15.ema21 !== null &&
    m15.ema9 > m15.ema21 &&
    !m15.isCompressedOrChoppy &&
    (m15Smc.trendStructure === 'BULLISH' ||
      m15.emaBias === 'BULLISH' ||
      m15Smc.lastBos?.type === 'BOS_BULL' ||
      m15Smc.lastChoch?.type === 'CHOCH_BULL');
  const contBuy_M5Ema = m5.ema9 !== null && m5.ema21 !== null && m5.ema9 > m5.ema21 && !m5.isCompressedOrChoppy;
  const contBuy_Pullback = pullbackToEma !== 'NONE';
  const contBuy_Stoch = bullStochCrossOk;
  const contBuy_Candle = confirmationCandle === 'BULLISH_CLOSE' && m1BuyOk;
  const contBuy_Smc = smc.bullishSetupPresent || m15Smc.bullishSetupPresent;
  const contBuy_Filter = volatilityOk && notChasingBuy;

  const isContBuyPattern =
    hasContinuationData &&
    contBuy_H1 &&
    contBuy_M15 &&
    contBuy_M5Ema &&
    contBuy_Pullback &&
    contBuy_Stoch &&
    contBuy_Candle &&
    contBuy_Smc &&
    contBuy_Filter &&
    riskHealthy &&
    cfg.allowBuy;

  // --- SETUP B: BEARISH TREND CONTINUATION SELL ---
  const contSell_H1 = h1.ema50 !== null && h1.ema200 !== null && h1.ema50 < h1.ema200 && !h1.isCompressedOrChoppy;
  const contSell_M15 =
    m15.ema9 !== null &&
    m15.ema21 !== null &&
    m15.ema9 < m15.ema21 &&
    !m15.isCompressedOrChoppy &&
    (m15Smc.trendStructure === 'BEARISH' ||
      m15.emaBias === 'BEARISH' ||
      m15Smc.lastBos?.type === 'BOS_BEAR' ||
      m15Smc.lastChoch?.type === 'CHOCH_BEAR');
  const contSell_M5Ema = m5.ema9 !== null && m5.ema21 !== null && m5.ema9 < m5.ema21 && !m5.isCompressedOrChoppy;
  const contSell_Pullback = pullbackToEma !== 'NONE';
  const contSell_Stoch = bearStochCrossOk;
  const contSell_Candle = confirmationCandle === 'BEARISH_CLOSE' && m1SellOk;
  const contSell_Smc = smc.bearishSetupPresent || m15Smc.bearishSetupPresent;
  const contSell_Filter = volatilityOk && notChasingSell;

  const isContSellPattern =
    hasContinuationData &&
    contSell_H1 &&
    contSell_M15 &&
    contSell_M5Ema &&
    contSell_Pullback &&
    contSell_Stoch &&
    contSell_Candle &&
    contSell_Smc &&
    contSell_Filter &&
    riskHealthy &&
    cfg.allowSell;

  // --- SETUP C: BULLISH REVERSAL BUY (Independent of H1 EMA50 > EMA200) ---
  const bullSweepObj =
    smc.lastSweep?.direction === 'BULLISH'
      ? smc.lastSweep
      : m15Smc.lastSweep?.direction === 'BULLISH'
        ? m15Smc.lastSweep
        : null;
  const revBuy_Sweep = Boolean(
    bullSweepObj && lastM5 && lastM5.close > bullSweepObj.sweptLevel
  );
  const revBuy_Choch =
    smc.lastChoch?.type === 'CHOCH_BULL' || m15Smc.lastChoch?.type === 'CHOCH_BULL';
  const revBuy_ObOrFvg = Boolean(
    lastM5 &&
      (smc.activeBullishObs.some((ob) => lastM5.low <= ob.high + 2.5 && lastM5.close >= ob.low - 1.5) ||
        smc.activeBullishFvgs.some((f) => lastM5.low <= f.top + 2.5 && lastM5.close >= f.bottom - 1.5) ||
        m15Smc.activeBullishObs.some((ob) => lastM5.low <= ob.high + 3.0 && lastM5.close >= ob.low - 2.0) ||
        m15Smc.activeBullishFvgs.some((f) => lastM5.low <= f.top + 3.0 && lastM5.close >= f.bottom - 2.0))
  );
  const revBuy_Stoch = bullStochCrossOk && stochCrossK <= 65;
  const revBuy_Candle = confirmationCandle === 'BULLISH_CLOSE' && m1BuyOk;
  const revBuy_NotLate =
    !lastM5 || !bullSweepObj
      ? false
      : lastM5.close - bullSweepObj.sweepExtreme <= Math.max((m5.atr ?? 1.5) * 4.5, 6.5);
  const revBuy_Filter = volatilityOk && revBuy_NotLate;

  const isRevBuyPattern =
    hasReversalData &&
    revBuy_Sweep &&
    revBuy_Choch &&
    revBuy_Stoch &&
    revBuy_Candle &&
    revBuy_Filter &&
    riskHealthy &&
    cfg.allowBuy;

  // --- SETUP D: BEARISH REVERSAL SELL (Independent of H1 EMA50 < EMA200) ---
  const bearSweepObj =
    smc.lastSweep?.direction === 'BEARISH'
      ? smc.lastSweep
      : m15Smc.lastSweep?.direction === 'BEARISH'
        ? m15Smc.lastSweep
        : null;
  const revSell_Sweep = Boolean(
    bearSweepObj && lastM5 && lastM5.close < bearSweepObj.sweptLevel
  );
  const revSell_Choch =
    smc.lastChoch?.type === 'CHOCH_BEAR' || m15Smc.lastChoch?.type === 'CHOCH_BEAR';
  const revSell_ObOrFvg = Boolean(
    lastM5 &&
      (smc.activeBearishObs.some((ob) => lastM5.high >= ob.low - 2.5 && lastM5.close <= ob.high + 1.5) ||
        smc.activeBearishFvgs.some((f) => lastM5.high >= f.bottom - 2.5 && lastM5.close <= f.top + 1.5) ||
        m15Smc.activeBearishObs.some((ob) => lastM5.high >= ob.low - 3.0 && lastM5.close <= ob.high + 2.0) ||
        m15Smc.activeBearishFvgs.some((f) => lastM5.high >= f.bottom - 3.0 && lastM5.close <= f.top + 2.0))
  );
  const revSell_Stoch = bearStochCrossOk && stochCrossK >= 35;
  const revSell_Candle = confirmationCandle === 'BEARISH_CLOSE' && m1SellOk;
  const revSell_NotLate =
    !lastM5 || !bearSweepObj
      ? false
      : bearSweepObj.sweepExtreme - lastM5.close <= Math.max((m5.atr ?? 1.5) * 4.5, 6.5);
  const revSell_Filter = volatilityOk && revSell_NotLate;

  const isRevSellPattern =
    hasReversalData &&
    revSell_Sweep &&
    revSell_Choch &&
    revSell_Stoch &&
    revSell_Candle &&
    revSell_Filter &&
    riskHealthy &&
    cfg.allowSell;

  let candidateAction: SignalAction = 'WAIT';
  let activeSetupType: SetupType | null = null;
  if (isContBuyPattern) {
    candidateAction = 'BUY';
    activeSetupType = 'CONTINUATION_BUY';
  } else if (isContSellPattern) {
    candidateAction = 'SELL';
    activeSetupType = 'CONTINUATION_SELL';
  } else if (isRevBuyPattern) {
    candidateAction = 'BUY';
    activeSetupType = 'REVERSAL_BUY';
  } else if (isRevSellPattern) {
    candidateAction = 'SELL';
    activeSetupType = 'REVERSAL_SELL';
  }

  // Deterministic confirmation score (0..100) for ELEVATED/HIGH dynamic spread checks
  let confirmationScore = 0;
  if (activeSetupType === 'CONTINUATION_BUY') {
    confirmationScore += contBuy_H1 ? (h1.ema50Slope === 'RISING' ? 25 : 18) : 0;
    confirmationScore += contBuy_M15 ? 20 : 0;
    confirmationScore += contBuy_M5Ema && contBuy_Pullback ? 15 : 0;
    confirmationScore += stochCrossK <= cfg.stochMidpoint ? 15 : 10;
    confirmationScore += smc.bullishSetupPresent && m15Smc.bullishSetupPresent ? 15 : contBuy_Smc ? 10 : 0;
    confirmationScore += strongCandleBody ? 10 : 6;
  } else if (activeSetupType === 'CONTINUATION_SELL') {
    confirmationScore += contSell_H1 ? (h1.ema50Slope === 'FALLING' ? 25 : 18) : 0;
    confirmationScore += contSell_M15 ? 20 : 0;
    confirmationScore += contSell_M5Ema && contSell_Pullback ? 15 : 0;
    confirmationScore += stochCrossK >= cfg.stochMidpoint ? 15 : 10;
    confirmationScore += smc.bearishSetupPresent && m15Smc.bearishSetupPresent ? 15 : contSell_Smc ? 10 : 0;
    confirmationScore += strongCandleBody ? 10 : 6;
  } else if (activeSetupType === 'REVERSAL_BUY') {
    confirmationScore += revBuy_Sweep ? 25 : 0;
    confirmationScore += revBuy_Choch ? 25 : 0;
    confirmationScore += revBuy_ObOrFvg ? 20 : 8;
    confirmationScore += stochCrossK <= cfg.stochMidpoint ? 15 : 9;
    confirmationScore += strongCandleBody ? 15 : 10;
  } else if (activeSetupType === 'REVERSAL_SELL') {
    confirmationScore += revSell_Sweep ? 25 : 0;
    confirmationScore += revSell_Choch ? 25 : 0;
    confirmationScore += revSell_ObOrFvg ? 20 : 8;
    confirmationScore += stochCrossK >= cfg.stochMidpoint ? 15 : 9;
    confirmationScore += strongCandleBody ? 15 : 10;
  }

  // Resolve Bid/Ask & Quote context cleanly
  let resolvedBid: number | null =
    typeof params.bid === 'number' && Number.isFinite(params.bid) && params.bid > 0
      ? params.bid
      : null;
  let resolvedAsk: number | null =
    typeof params.ask === 'number' && Number.isFinite(params.ask) && params.ask > 0
      ? params.ask
      : null;
  let resolvedHasTwoSided = params.hasTwoSidedQuote;
  let resolvedQuoteTs = params.quoteTimestamp;

  if (resolvedBid === null && resolvedAsk === null) {
    if (params.spreadEvaluation) {
      resolvedBid = params.spreadEvaluation.bid;
      resolvedAsk = params.spreadEvaluation.ask;
      resolvedHasTwoSided = params.spreadEvaluation.hasTwoSidedQuote;
      resolvedQuoteTs = params.spreadEvaluation.quoteTimestamp;
    } else if (spreadPips !== null && latestPrice !== null && Number.isFinite(latestPrice) && latestPrice > 0) {
      const halfSpread = (spreadPips * symbolSpec.pointSize) / 2;
      resolvedBid = roundToDigits(latestPrice - halfSpread, symbolSpec.digits);
      resolvedAsk = roundToDigits(latestPrice + halfSpread, symbolSpec.digits);
      resolvedHasTwoSided = resolvedHasTwoSided ?? true;
      resolvedQuoteTs = resolvedQuoteTs ?? new Date(nowMs).toISOString();
    } else if (
      feedConnected &&
      latestPrice !== null &&
      Number.isFinite(latestPrice) &&
      latestPrice > 0 &&
      resolvedHasTwoSided === undefined &&
      resolvedQuoteTs === undefined
    ) {
      // Pure unit-test compatibility when caller omits spread fields
      const halfSpread = (25 * symbolSpec.pointSize) / 2;
      resolvedBid = roundToDigits(latestPrice - halfSpread, symbolSpec.digits);
      resolvedAsk = roundToDigits(latestPrice + halfSpread, symbolSpec.digits);
      resolvedHasTwoSided = true;
      resolvedQuoteTs = new Date(nowMs).toISOString();
    }
  }

  let entry: number | null = null;
  let stop: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;
  let lots = 0;
  let riskDollars = 0;
  let riskReason: string | null = null;

  if (candidateAction !== 'WAIT' && lastM5 && m5.atr !== null) {
    // Side-specific execution price: Ask for BUY, Bid for SELL
    const sideEntry = getEffectiveSideEntryPrice(
      candidateAction,
      resolvedBid,
      resolvedAsk,
      latestPrice ?? lastM5.close,
      symbolSpec.digits
    );
    entry = sideEntry ?? roundToDigits(lastM5.close, symbolSpec.digits);
    const atrBuffer = roundToDigits(m5.atr * cfg.atrSlMultiplier, symbolSpec.digits);

    if (candidateAction === 'BUY') {
      const relevantSwing = smc.swingLows
        .slice()
        .reverse()
        .find((s) => s.price < entry!);
      const sweepAnchor =
        activeSetupType === 'REVERSAL_BUY' && bullSweepObj
          ? bullSweepObj.sweepExtreme
          : lastM5.low;
      const baseInvalidation = relevantSwing
        ? Math.min(relevantSwing.price, sweepAnchor, lastM5.low)
        : Math.min(sweepAnchor, lastM5.low);
      const rawSl = roundToDigits(baseInvalidation - atrBuffer * 0.5, symbolSpec.digits);
      const minStop = roundToDigits(entry - Math.max(0.8, atrBuffer), symbolSpec.digits);
      const maxStopDist = Math.max(2.0, (settings.maxSlPips || 25) * 0.1 * 2.5);
      stop = roundToDigits(Math.min(minStop, rawSl), symbolSpec.digits);
      if (entry - stop > maxStopDist) {
        stop = roundToDigits(entry - maxStopDist, symbolSpec.digits);
      }
      const slDist = roundToDigits(entry - stop, symbolSpec.digits);
      tp1 = roundToDigits(entry + slDist * cfg.tp1Rr, symbolSpec.digits);
      tp2 = roundToDigits(entry + slDist * cfg.tp2Rr, symbolSpec.digits);
      tp3 = roundToDigits(entry + slDist * cfg.tp3Rr, symbolSpec.digits);
    } else {
      const relevantSwing = smc.swingHighs
        .slice()
        .reverse()
        .find((s) => s.price > entry!);
      const sweepAnchor =
        activeSetupType === 'REVERSAL_SELL' && bearSweepObj
          ? bearSweepObj.sweepExtreme
          : lastM5.high;
      const baseInvalidation = relevantSwing
        ? Math.max(relevantSwing.price, sweepAnchor, lastM5.high)
        : Math.max(sweepAnchor, lastM5.high);
      const rawSl = roundToDigits(baseInvalidation + atrBuffer * 0.5, symbolSpec.digits);
      const minStop = roundToDigits(entry + Math.max(0.8, atrBuffer), symbolSpec.digits);
      const maxStopDist = Math.max(2.0, (settings.maxSlPips || 25) * 0.1 * 2.5);
      stop = roundToDigits(Math.max(minStop, rawSl), symbolSpec.digits);
      if (stop - entry > maxStopDist) {
        stop = roundToDigits(entry + maxStopDist, symbolSpec.digits);
      }
      const slDist = roundToDigits(stop - entry, symbolSpec.digits);
      tp1 = roundToDigits(entry - slDist * cfg.tp1Rr, symbolSpec.digits);
      tp2 = roundToDigits(entry - slDist * cfg.tp2Rr, symbolSpec.digits);
      tp3 = roundToDigits(entry - slDist * cfg.tp3Rr, symbolSpec.digits);
    }

    const tickSizeForSizing = symbolSpec.tickSize > 0 ? symbolSpec.tickSize : 0.01;
    const sizing = calculatePositionSizeFromEquity({
      equity: accountEquity,
      riskPercent: settings.riskPercent,
      maxRiskPercent: cfg.maxRiskPercent,
      entry,
      stop,
      maxAutoLotCap: settings.maxAutoLotCap,
      tickSize: tickSizeForSizing,
      tickValuePerTickPerLot: tickSizeForSizing * Math.max(1, symbolSpec.contractSize),
    });
    if (!sizing.valid) {
      riskReason = sizing.reason ?? 'Position sizing blocked';
      candidateAction = 'WAIT';
      activeSetupType = null;
    } else {
      lots = sizing.lots;
      riskDollars = sizing.riskDollars;
    }
  }

  // Evaluate dynamic spread & transaction costs against actual Bid/Ask and trade geometry
  const spreadEvaluation = evaluateDynamicSpread({
    bid: resolvedBid,
    ask: resolvedAsk,
    quoteTimestamp: resolvedQuoteTs ?? params.spreadEvaluation?.quoteTimestamp ?? null,
    quoteSource: params.quoteSource ?? params.spreadEvaluation?.quoteSource ?? (feedConnected ? 'TickerAll MT5 Feed' : 'UNAVAILABLE'),
    hasTwoSidedQuote: Boolean(resolvedHasTwoSided && !params.isFallbackOnly),
    isFallbackOnly: Boolean(params.isFallbackOnly),
    symbolSpec,
    spreadHistory: params.spreadHistory ?? [],
    maxSpreadPoints: cfg.maxSpreadPips,
    sensitivity: cfg.spreadSensitivity,
    allowHighSpreadTrades: cfg.allowHighSpreadTrades,
    minNetRewardRisk: cfg.minNetRewardRisk,
    estimatedSlippagePoints: cfg.estimatedSlippagePoints,
    maxQuoteAgeSeconds: cfg.maxQuoteAgeSeconds,
    atrPrice: m5.atr ?? m15.atr,
    confirmationScore,
    proposedSide: candidateAction === 'BUY' || candidateAction === 'SELL' ? candidateAction : null,
    proposedEntry: entry,
    proposedStop: stop,
    proposedTarget: tp2,
    lots: lots >= 0.01 ? lots : 0.01,
    nowMs,
  });

  const resolvedSpreadPoints = spreadEvaluation.spreadPoints ?? spreadPips;
  const spreadAllowed = spreadEvaluation.tradePermitted;

  if (candidateAction !== 'WAIT' && !spreadAllowed) {
    candidateAction = 'WAIT';
    activeSetupType = null;
  }

  let blockReason: string | null = null;
  if (!feedConnected) blockReason = 'Master TickerAll feed offline';
  else if (isWeekend) blockReason = 'Market closed (Weekend)';
  else if (cfg.tradingRunState !== 'RUNNING') blockReason = `Trading state: ${cfg.tradingRunState}`;
  else if (!spreadEvaluation.dataAvailable) blockReason = spreadEvaluation.reason;
  else if (!hasReversalData) blockReason = `Waiting for closed M15/M5 history (M15:${m15.barsCount}, M5:${m5.barsCount})`;
  else if (dailyLossLimitHit) blockReason = `Daily loss guard hit (${dailyPnlPct.toFixed(2)}% <= -${settings.dailyGuardPct}%)`;
  else if (consecutiveLossHit) blockReason = `Paused after ${levels.consecutiveLossesToday} consecutive losses`;
  else if (dailyTradeCapHit) blockReason = `Max daily trades reached (${levels.totalTradesToday}/${maxDailyTrades})`;
  else if (sessionTradeCapHit) blockReason = `Max session trades reached (${sessionTrades}/${cfg.maxTradesPerSession})`;
  else if (maxPosHit) blockReason = `Max simultaneous positions reached (${openPositionsCount}/${cfg.maxSimultaneousPositions})`;
  else if (!newsStatus.clear) blockReason = `USD News blackout: ${newsStatus.blockingEvent?.title ?? 'High impact news'}`;
  else if (!spreadAllowed) blockReason = spreadEvaluation.reason;
  else if (!volatilityOk) blockReason = `Abnormal ATR volatility ($${m5.atr ?? '—'}) outside safe range ($0.40–$9.50)`;
  else if (riskReason) blockReason = riskReason;

  // Build dynamic checklist reflecting active setup or strongest candidate direction
  const isReversalFocus =
    activeSetupType === 'REVERSAL_BUY' ||
    activeSetupType === 'REVERSAL_SELL' ||
    (candidateAction === 'WAIT' &&
      ((revBuy_Sweep && revBuy_Choch) || (revSell_Sweep && revSell_Choch)));

  const displayBull =
    candidateAction === 'BUY' ||
    (candidateAction === 'WAIT' &&
      (isReversalFocus
        ? revBuy_Sweep || revBuy_Choch || smc.lastChoch?.type === 'CHOCH_BULL'
        : h1.emaBias === 'BULLISH' || (h1.emaBias !== 'BEARISH' && smc.trendStructure !== 'BEARISH')));

  const spreadDetailText = spreadEvaluation.dataAvailable
    ? `Spread ${spreadEvaluation.spreadPoints?.toFixed(1)}p [${spreadEvaluation.classification}] · Max ${spreadEvaluation.configuredMaxSpreadPoints}p (${spreadEvaluation.sensitivity})`
    : spreadEvaluation.reason;

  const conditions: StrategyConditionItem[] = isReversalFocus
    ? [
        {
          label: '1. Liquidity Sweep + Rejection Close',
          passed: displayBull ? revBuy_Sweep : revSell_Sweep,
          detail: displayBull
            ? bullSweepObj
              ? `${bullSweepObj.label} (closed $${bullSweepObj.closePrice.toFixed(2)})`
              : 'Waiting for swing low sweep & rejection close'
            : bearSweepObj
              ? `${bearSweepObj.label} (closed $${bearSweepObj.closePrice.toFixed(2)})`
              : 'Waiting for swing high sweep & rejection close',
        },
        {
          label: '2. Confirmed CHoCH (M5 or M15)',
          passed: displayBull ? revBuy_Choch : revSell_Choch,
          detail: `M5 CHoCH: ${smc.lastChoch?.type ?? 'None'} · M15 CHoCH: ${m15Smc.lastChoch?.type ?? 'None'}`,
        },
        {
          label: '3. Order Block / FVG Retracement (Preferred)',
          passed: displayBull ? revBuy_ObOrFvg : revSell_ObOrFvg,
          detail: displayBull
            ? `Bull OBs: ${smc.activeBullishObs.length + m15Smc.activeBullishObs.length} · Bull FVGs: ${smc.activeBullishFvgs.length + m15Smc.activeBullishFvgs.length}`
            : `Bear OBs: ${smc.activeBearishObs.length + m15Smc.activeBearishObs.length} · Bear FVGs: ${smc.activeBearishFvgs.length + m15Smc.activeBearishFvgs.length}`,
        },
        {
          label: `4. Stochastic (${cfg.stochK},${cfg.stochD},${cfg.stochSlowing}) Crossover Timing`,
          passed: displayBull ? revBuy_Stoch : revSell_Stoch,
          detail: stochNote,
        },
        {
          label: '5. Reversal Confirmation / Rejection Close',
          passed: displayBull ? revBuy_Candle : revSell_Candle,
          detail: `Last closed M5: ${confirmationCandle}`,
        },
        {
          label: '6. Higher-TF Context (Non-Blocking for Reversal)',
          passed: true,
          detail: `H1 EMA50 slope ${h1.ema50Slope ?? 'FLAT'} (${h1.emaBias}) — Reversal allowed independently`,
        },
        {
          label: '7. Dynamic Spread, Net R:R & Anti-Chase Filter',
          passed: spreadAllowed && (displayBull ? revBuy_Filter : revSell_Filter),
          detail: `ATR ${m5.atr ?? '—'} · ${spreadDetailText}`,
        },
        {
          label: '8. Risk, All-Session & Account Guard',
          passed: riskHealthy && (displayBull ? cfg.allowBuy : cfg.allowSell),
          detail: blockReason ? blockReason : `Equity $${Number(accountEquity ?? 0).toFixed(2)} · Risk ${settings.riskPercent}% · All-Session`,
        },
      ]
    : [
        {
          label: '1. H1 Major Direction (EMA 50 vs 200)',
          passed: displayBull ? contBuy_H1 : contSell_H1,
          detail: `H1 EMA50 ${h1.ema50 ?? '—'} (${h1.ema50Slope ?? 'FLAT'}) vs EMA200 ${h1.ema200 ?? '—'}`,
        },
        {
          label: '2. M15 Trend & Market Structure',
          passed: displayBull ? contBuy_M15 : contSell_M15,
          detail: `M15 EMA9/21: ${m15.ema9 ?? '—'}/${m15.ema21 ?? '—'} · M15 SMC: ${m15Smc.trendStructure}`,
        },
        {
          label: '3. M5 Momentum (EMA 9/21 & Non-Chop)',
          passed: displayBull ? contBuy_M5Ema : contSell_M5Ema,
          detail: m5.isCompressedOrChoppy
            ? 'EMA band compressed/choppy (sideways avoided)'
            : `M5 EMA9 ${m5.ema9 ?? '—'} / EMA21 ${m5.ema21 ?? '—'}`,
        },
        {
          label: '4. Pullback to EMA 9 or EMA 21',
          passed: displayBull ? contBuy_Pullback : contSell_Pullback,
          detail: pullbackToEma === 'NONE' ? 'Waiting for pullback touch' : `Touched ${pullbackToEma}`,
        },
        {
          label: `5. Stochastic (${cfg.stochK},${cfg.stochD},${cfg.stochSlowing}) Crossover`,
          passed: displayBull ? contBuy_Stoch : contSell_Stoch,
          detail: stochNote,
        },
        {
          label: '6. Bullish/Bearish SMC Confirmation',
          passed: displayBull ? contBuy_Smc : contSell_Smc,
          detail: smc.evidenceSummary.slice(0, 3).join(' · '),
        },
        {
          label: '7. M5 Rejection / Confirmation Close',
          passed: displayBull ? contBuy_Candle : contSell_Candle,
          detail: `Last closed M5: ${confirmationCandle}`,
        },
        {
          label: '8. Dynamic Spread, Net R:R & Anti-Chase Filter',
          passed: spreadAllowed && (displayBull ? contBuy_Filter : contSell_Filter),
          detail: `ATR ${m5.atr ?? '—'} · ${spreadDetailText}`,
        },
        {
          label: '9. Multi-TF Data Warmup',
          passed: hasContinuationData,
          detail: `H1 ${h1.barsCount} · M15 ${m15.barsCount} · M5 ${m5.barsCount} closed bars`,
        },
        {
          label: '10. Risk, All-Session & Account Guard',
          passed: riskHealthy && (displayBull ? cfg.allowBuy : cfg.allowSell),
          detail: blockReason ? blockReason : `Equity $${Number(accountEquity ?? 0).toFixed(2)} · Risk ${settings.riskPercent}% · All-Session`,
        },
      ];

  const expiresAt =
    candidateAction !== 'WAIT'
      ? new Date(nowMs + cfg.signalExpiryMinutes * 60_000).toISOString()
      : null;

  const emaSummary = `H1:${h1.emaBias}(${h1.ema50Slope ?? 'FLAT'}) M15:${m15.emaBias} M5:${m5.ema9 ?? '—'}/${m5.ema21 ?? '—'}/${m5.ema50 ?? '—'}/${m5.ema200 ?? '—'}`;
  const stochSummary = `K:${m5Stoch.k ?? '—'} D:${m5Stoch.d ?? '—'} (${m5Stoch.cross} · ${stochNote})`;
  const smcSummary = [...smc.evidenceSummary, `M15:${m15Smc.trendStructure}${m15Smc.lastChoch ? ` ${m15Smc.lastChoch.type}` : ''}`].join(' | ');

  const setupLabel = activeSetupType ? `${activeSetupType} · ${marketCondition}` : marketCondition;

  const reason =
    candidateAction !== 'WAIT' && activeSetupType
      ? activeSetupType === 'REVERSAL_BUY' || activeSetupType === 'REVERSAL_SELL'
        ? `EMA STOCHASTIC PRO ${activeSetupType}: ${bullSweepObj?.label ?? bearSweepObj?.label ?? 'Liquidity Sweep'} + CHoCH (${smc.lastChoch?.type ?? m15Smc.lastChoch?.type})${(revBuy_ObOrFvg || revSell_ObOrFvg) ? ' + OB/FVG' : ''}, ${stochNote} · Spread ${resolvedSpreadPoints?.toFixed(1) ?? '—'}p [${spreadEvaluation.classification}]`
        : `EMA STOCHASTIC PRO ${activeSetupType}: H1/M15 ${overallTrend}, M5 pullback ${pullbackToEma}, ${stochNote}, SMC ${smc.lastSweep?.label ?? smc.lastBos?.type ?? smc.trendStructure} · Spread ${resolvedSpreadPoints?.toFixed(1) ?? '—'}p [${spreadEvaluation.classification}]`
      : blockReason ?? 'Scanning closed H1/M15/M5 candles across all open XM sessions';

  const signal: TradeSignal = {
    id: `emapro-${lastM5?.openTimeMs ?? nowMs}-${activeSetupType ?? candidateAction}`,
    timestamp: new Date(nowMs).toISOString(),
    lusakaTime: clock.timeLusaka,
    strategy: strategyWindow,
    strategyModule: 'EMA_STOCHASTIC_PRO',
    setupType: activeSetupType ?? undefined,
    action: candidateAction,
    symbol: symbolSpec.symbol || cfg.xauusdSymbol,
    entry:
      candidateAction !== 'WAIT'
        ? entry
        : latestPrice
          ? roundToDigits(latestPrice, symbolSpec.digits)
          : null,
    stop,
    tp1,
    tp2,
    tp3,
    target: tp2, // Minimum 1:2 R:R target
    rrRatio: cfg.tp2Rr,
    netRrRatio: spreadEvaluation.costBreakdown?.netRr ?? null,
    estimatedCostDollars: spreadEvaluation.costBreakdown?.totalEstimatedCostDollars ?? null,
    riskDollars,
    suggestedLots: lots,
    reason,
    setupLabel,
    blockReason,
    expiresAt,
    emaSummary,
    stochSummary,
    smcSummary,
    conditions,
  };

  const analysis: EmaStochasticProSnapshot = {
    h1,
    m15,
    m5,
    m1,
    smc,
    m15Smc,
    activeSetupType,
    stochNote,
    confirmationScore,
    overallTrend,
    marketCondition,
    spreadPips: resolvedSpreadPoints,
    spreadAllowed,
    spreadEvaluation,
    symbolSpec,
    atrPips,
    pullbackToEma,
    confirmationCandle,
    signalExpiresAt: expiresAt,
    newsFeedStatus,
  };

  return { analysis, signal };
}

export function computePerformanceSummary(params: {
  tradeLog: TradeLogEntry[];
  signalHistory: SignalHistoryEntry[];
  startingBalance: number;
}): PerformanceMetricsSummary {
  const { tradeLog, signalHistory, startingBalance } = params;

  const approvedSignals = signalHistory.filter((s) => s.signalStatus === 'APPROVED' || s.signalStatus === 'EXECUTED').length;
  const rejectedSignals = signalHistory.filter((s) => s.signalStatus === 'REJECTED' || s.signalStatus === 'BLOCKED').length;
  const waitingSignals = signalHistory.filter((s) => s.signalStatus === 'WAITING' || s.signalStatus === 'GENERATED').length;

  const closedTrades = tradeLog.filter((t) => t.status === 'TP_HIT' || t.status === 'SL_HIT' || t.status === 'CLOSED');
  const signalOnlyTrades = closedTrades.filter((t) => t.executionStatus === 'SIGNAL_ONLY' || t.status === 'SIGNALED');
  const actualTrades = closedTrades.filter((t) => t.executionStatus !== 'SIGNAL_ONLY');

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let sumRr = 0;
  let totalCommission = 0;
  let totalSwap = 0;
  let sumDurationMins = 0;
  let durationCount = 0;

  let peakEq = Math.max(1, startingBalance);
  let curEq = Math.max(1, startingBalance);
  let maxDrawdownPct = 0;

  const bySession: PerformanceMetricsSummary['bySession'] = {
    ASIAN_SESSION: { trades: 0, wins: 0, netProfit: 0 },
    LONDON_SESSION: { trades: 0, wins: 0, netProfit: 0 },
    NEW_YORK_SESSION: { trades: 0, wins: 0, netProfit: 0 },
    ALL_SESSIONS: { trades: 0, wins: 0, netProfit: 0 },
  };
  const condMap = new Map<string, { trades: number; wins: number; netProfit: number }>();

  const chrono = [...closedTrades].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const t of chrono) {
    const pnl = t.pnlDollars ?? 0;
    const comm = t.commissionDollars ?? 0;
    const swap = t.swapDollars ?? 0;
    totalCommission += comm;
    totalSwap += swap;
    if (pnl > 0) {
      grossProfit += pnl;
      wins += 1;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
      losses += 1;
    }
    sumRr += t.rrRatio || 0;
    if (t.closedAt && t.timestamp) {
      const mins = (Date.parse(t.closedAt) - Date.parse(t.timestamp)) / 60_000;
      if (Number.isFinite(mins) && mins >= 0) {
        sumDurationMins += mins;
        durationCount += 1;
      }
    }

    curEq += pnl;
    if (curEq > peakEq) peakEq = curEq;
    if (peakEq > 0) {
      const dd = ((peakEq - curEq) / peakEq) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    const sKey: TradingSessionTag =
      t.session === 'ASIAN_SESSION' ||
      t.session === 'LONDON_SESSION' ||
      t.session === 'NEW_YORK_SESSION' ||
      t.session === 'ALL_SESSIONS'
        ? t.session
        : 'ALL_SESSIONS';
    bySession[sKey].trades += 1;
    if (pnl > 0) bySession[sKey].wins += 1;
    bySession[sKey].netProfit = round2(bySession[sKey].netProfit + pnl);

    const cond = t.marketCondition || t.setupStatus || 'STANDARD';
    const prevCond = condMap.get(cond) ?? { trades: 0, wins: 0, netProfit: 0 };
    prevCond.trades += 1;
    if (pnl > 0) prevCond.wins += 1;
    prevCond.netProfit = round2(prevCond.netProfit + pnl);
    condMap.set(cond, prevCond);
  }

  const netProfit = round2(grossProfit - grossLoss);
  const profitFactor = grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? 9.99 : 0;

  const sigWins = signalOnlyTrades.filter((t) => (t.pnlDollars ?? 0) > 0).length;
  const sigLosses = signalOnlyTrades.filter((t) => (t.pnlDollars ?? 0) < 0).length;
  const sigNet = round2(signalOnlyTrades.reduce((a, b) => a + (b.pnlDollars ?? 0), 0));

  const actWins = actualTrades.filter((t) => (t.pnlDollars ?? 0) > 0).length;
  const actLosses = actualTrades.filter((t) => (t.pnlDollars ?? 0) < 0).length;
  const actNet = round2(actualTrades.reduce((a, b) => a + (b.pnlDollars ?? 0), 0));

  return {
    totalSignals: signalHistory.length,
    approvedSignals,
    rejectedSignals,
    waitingSignals,
    executedTrades: actualTrades.length,
    winningTrades: wins,
    losingTrades: losses,
    winRatePct: closedTrades.length > 0 ? round2((wins / closedTrades.length) * 100) : 0,
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    netProfit,
    profitFactor,
    averageRr: closedTrades.length > 0 ? round2(sumRr / closedTrades.length) : 0,
    maxDrawdownPct: round2(maxDrawdownPct),
    avgTradeDurationMins: durationCount > 0 ? Math.round(sumDurationMins / durationCount) : 0,
    totalCommission: round2(totalCommission),
    totalSwap: round2(totalSwap),
    signalOnlyStats: {
      count: signalOnlyTrades.length,
      wins: sigWins,
      losses: sigLosses,
      winRatePct: signalOnlyTrades.length > 0 ? round2((sigWins / signalOnlyTrades.length) * 100) : 0,
      theoreticalNetDollars: sigNet,
    },
    actualExecutionStats: {
      count: actualTrades.length,
      wins: actWins,
      losses: actLosses,
      winRatePct: actualTrades.length > 0 ? round2((actWins / actualTrades.length) * 100) : 0,
      netDollars: actNet,
    },
    bySession,
    byMarketCondition: Array.from(condMap.entries()).map(([condition, val]) => ({
      condition,
      ...val,
    })),
  };
}

/**
 * Resample finer candles (e.g. M5 or M15) into higher timeframe candles (M15 or H1)
 * strictly keeping closed bars in chronological order.
 */
export function aggregateCandles(
  candles: M15Candle[],
  bucketMs: number
): M15Candle[] {
  const closed = filterClosedCandles(candles);
  if (closed.length === 0) return [];
  const buckets = new Map<number, M15Candle[]>();
  for (const c of closed) {
    const start = Math.floor(c.openTimeMs / bucketMs) * bucketMs;
    const arr = buckets.get(start) ?? [];
    arr.push(c);
    buckets.set(start, arr);
  }
  const out: M15Candle[] = [];
  for (const [start, group] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    const first = group[0];
    const last = group[group.length - 1];
    out.push({
      openTimeMs: start,
      openTimeLusaka: first.openTimeLusaka,
      closeTimeLusaka: last.closeTimeLusaka,
      open: first.open,
      high: round2(Math.max(...group.map((g) => g.high))),
      low: round2(Math.min(...group.map((g) => g.low))),
      close: last.close,
      ticksCount: group.reduce((a, b) => a + b.ticksCount, 0),
      closed: true,
      source: last.source,
    });
  }
  return out;
}

/**
 * Deterministically estimate spread in points on historical OHLC bars when raw tick Bid/Ask
 * quotes are unavailable, anchored to observed spread median (or 30p baseline).
 */
export function estimateModeledOhlcSpreadPoints(params: {
  bar: M15Candle;
  baselinePoints: number;
  rollingAtrPrice: number;
  minutesLusaka: number;
}): number {
  const { bar, baselinePoints, rollingAtrPrice, minutesLusaka } = params;
  const range = Math.max(0.05, bar.high - bar.low);
  const atr = Math.max(0.5, rollingAtrPrice);
  const volRatio = range / atr;
  const isRollover = minutesLusaka >= 1380 || minutesLusaka < 60;
  const isNewYorkOverlap = minutesLusaka >= 840 && minutesLusaka <= 1080;

  let spread = baselinePoints;
  if (isRollover) spread += 24;
  else if (isNewYorkOverlap) spread -= 2;

  if (volRatio > 1.8) spread += 28;
  else if (volRatio > 1.35) spread += 16;
  else if (volRatio > 1.05) spread += 7;

  return Math.max(12, Math.min(130, Math.round(spread * 10) / 10));
}

function classifyLusakaTradingSession(minutes: number): TradingSessionTag {
  if (minutes >= 180 && minutes < 660) return 'ASIAN_SESSION';
  if (minutes >= 660 && minutes <= 1140) return 'LONDON_SESSION';
  if (minutes > 1140) return 'NEW_YORK_SESSION';
  return 'ALL_SESSIONS';
}

interface BacktestInternalRunResult {
  summary: BacktestSummary;
  qualifiedOpportunities: number;
  rejectedBySpread: number;
  acceptedAbove45Points: number;
  avgSpreadAtEntryPoints: number | null;
  totalCostsDollars: number;
}

function executeBacktestSimulation(params: {
  m5Candles: M15Candle[];
  m15Candles?: M15Candle[];
  h1Candles?: M15Candle[];
  settings: StrategySettings;
  periodDays?: 30 | 90 | 180;
  startingBalance?: number;
  maxAutoLotCap?: number;
  lastUpdatedAt?: string | null;
  masterFeedConnected?: boolean;
  symbolSpec?: SymbolSpecification;
  observedSpreadSamples?: SpreadSampleRecord[];
  spreadFilterMode?: 'DYNAMIC_ALL_SESSION' | 'LEGACY_RIGID_45';
}): BacktestInternalRunResult {
  const {
    m5Candles,
    m15Candles = [],
    h1Candles = [],
    settings,
    periodDays = 30,
    startingBalance = 1000,
    maxAutoLotCap = settings.maxAutoLotCap || 0.5,
    lastUpdatedAt = null,
    masterFeedConnected = true,
    spreadFilterMode = 'DYNAMIC_ALL_SESSION',
  } = params;

  const cfg = mergeEmaProConfig(settings.emaPro);
  const symbolSpec: SymbolSpecification = params.symbolSpec ?? {
    ...DEFAULT_SYMBOL_SPEC,
    symbol: cfg.xauusdSymbol || 'XAUUSD',
    commissionPerLot: cfg.commissionPerLot,
  };

  const observedSamples = (params.observedSpreadSamples ?? []).filter(
    (s) => s.hasTwoSidedQuote !== false && Number.isFinite(s.spreadPoints) && s.spreadPoints > 0
  );
  const observedMedian =
    observedSamples.length > 0
      ? (() => {
          const sorted = observedSamples.map((s) => s.spreadPoints).sort((a, b) => a - b);
          return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
        })()
      : null;

  const spreadPips = observedMedian ?? 30;
  const commissionPerLot = cfg.commissionPerLot > 0 ? cfg.commissionPerLot : 7.0;
  const slippagePips = cfg.estimatedSlippagePoints > 0 ? cfg.estimatedSlippagePoints : 10;

  const closedM5 = filterClosedCandles(m5Candles);
  const closedM15 =
    filterClosedCandles(m15Candles).length >= 200
      ? filterClosedCandles(m15Candles)
      : aggregateCandles(closedM5, 15 * 60_000);
  const closedH1 =
    filterClosedCandles(h1Candles).length >= 200
      ? filterClosedCandles(h1Candles)
      : aggregateCandles(closedM15, 60 * 60_000);

  const entrySeries = closedM5.length >= 220 ? closedM5 : closedM15;
  const cutoffMs = Date.now() - periodDays * 86_400_000;
  const scopedEntries = entrySeries.filter((c) => c.openTimeMs >= cutoffMs);
  const workingBars = scopedEntries.length >= 220 ? scopedEntries : entrySeries;

  if (!masterFeedConnected || workingBars.length < 220) {
    return {
      qualifiedOpportunities: 0,
      rejectedBySpread: 0,
      acceptedAbove45Points: 0,
      avgSpreadAtEntryPoints: null,
      totalCostsDollars: 0,
      summary: {
        hasRealData: false,
        strategyModule: 'EMA_STOCHASTIC_PRO',
        errorCode: !masterFeedConnected ? 'NO_MASTER_FEED' : 'PERIOD_UNAVAILABLE',
        errorMessage: !masterFeedConnected
          ? 'Connect Master TickerAll MT5 feed before running backtests.'
          : `Need at least 220 closed candles for EMA-200 warmup (found ${workingBars.length}).`,
        dataSource: 'TickerAll MT5 Real Feed',
        lastUpdatedAt,
        periodDays,
        periodLabel: `${periodDays} Days`,
        candlesTested: workingBars.length,
        m15CandlesCount: closedM15.length,
        m5CandlesCount: closedM5.length,
        h1CandlesCount: closedH1.length,
        d1DaysCount: 0,
        daysTested: 0,
        weeksTested: 0,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        tp1PartialsHit: 0,
        winRatePct: 0,
        netR: 0,
        profitFactor: 0,
        avgRr: 0,
        startingBalance,
        endingBalance: startingBalance,
        balanceGrowthPct: 0,
        totalProfitDollars: 0,
        totalLossDollars: 0,
        netProfitDollars: 0,
        largestWinDollars: 0,
        largestLossDollars: 0,
        maxDrawdownPct: 0,
        maxAutoLotCap,
        skippedSetupsCount: 0,
        assumptions: { spreadPips, commissionPerLot, slippagePips },
        equityCurve: [],
        trades: [],
        blockedEntries: [],
        allEntries: [],
      },
    };
  }

  let balance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdownPct = 0;

  interface SimOpenTrade {
    id: string;
    openTimeMs: number;
    dateLusaka: string;
    timeLusaka: string;
    session: TradingSessionTag;
    side: 'BUY' | 'SELL';
    entry: number;
    initialStop: number;
    currentStop: number;
    tp1: number;
    tp2: number;
    tp3: number;
    tp1Hit: boolean;
    tp2Hit: boolean;
    lots: number;
    remainingFrac: number;
    realizedDollars: number;
    marketCondition: string;
    setupType?: SetupType;
    reason: string;
    entrySpreadPoints: number;
  }

  const openTrades: SimOpenTrade[] = [];
  const trades: BacktestTradeResult[] = [];
  const blockedEntries: BacktestTradeResult[] = [];
  const equityCurve: BacktestEquityPoint[] = [
    {
      index: 0,
      timestampMs: workingBars[0].openTimeMs,
      dateLusaka: workingBars[0].openTimeLusaka.slice(0, 10) || 'Start',
      timeLusaka: workingBars[0].openTimeLusaka,
      balance: round2(balance),
      pnlDollars: 0,
      label: 'Start',
    },
  ];

  let curDay = '';
  let dayStartBal = balance;
  let tradesToday = 0;
  let asianToday = 0;
  let londonToday = 0;
  let consecLosses = 0;
  let tp1PartialsHit = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let netR = 0;
  let qualifiedOpportunities = 0;
  let rejectedBySpread = 0;
  let acceptedAbove45Points = 0;
  let sumSpreadAtEntry = 0;
  let totalCostsDollars = 0;
  const distinctDays = new Set<string>();

  const slippageDollarsPerPrice = slippagePips * symbolSpec.pointSize;
  const simSpreadHistory: SpreadSampleRecord[] = observedSamples.slice(-120).map((s) => ({ ...s }));
  const { series: atrSeries } = calculateATR(workingBars, cfg.atrPeriod);

  // Advancing M15 & H1 pointers keep chronological slicing fast without look-ahead
  let m15Ptr = 0;
  let h1Ptr = 0;

  for (let i = 205; i < workingBars.length; i += 1) {
    const bar = workingBars[i];
    const clk = getLusakaClock(bar.openTimeMs);
    distinctDays.add(clk.dateLusaka);

    while (m15Ptr < closedM15.length && closedM15[m15Ptr].openTimeMs <= bar.openTimeMs) {
      m15Ptr += 1;
    }
    while (h1Ptr < closedH1.length && closedH1[h1Ptr].openTimeMs <= bar.openTimeMs) {
      h1Ptr += 1;
    }

    if (clk.dateLusaka !== curDay) {
      curDay = clk.dateLusaka;
      dayStartBal = balance;
      tradesToday = 0;
      asianToday = 0;
      londonToday = 0;
      consecLosses = 0;
    }

    const barSpreadPoints = estimateModeledOhlcSpreadPoints({
      bar,
      baselinePoints: spreadPips,
      rollingAtrPrice: atrSeries[i] ?? 1.6,
      minutesLusaka: clk.minutes,
    });
    const halfSpreadPrice = (barSpreadPoints * symbolSpec.pointSize) / 2;
    const barBid = roundToDigits(bar.close - halfSpreadPrice, symbolSpec.digits);
    const barAsk = roundToDigits(bar.close + halfSpreadPrice, symbolSpec.digits);

    if (spreadFilterMode === 'DYNAMIC_ALL_SESSION') {
      simSpreadHistory.push({
        timestampMs: bar.openTimeMs,
        symbol: symbolSpec.symbol,
        bid: barBid,
        ask: barAsk,
        spreadPrice: roundToDigits(barAsk - barBid, symbolSpec.digits),
        spreadPoints: barSpreadPoints,
        pointSize: symbolSpec.pointSize,
        hasTwoSidedQuote: true,
        source: 'MODELED_OHLC_SPREAD',
      });
      if (simSpreadHistory.length > 240) simSpreadHistory.shift();
    }

    // 1) Update open positions strictly using bar high/low
    for (let idx = openTrades.length - 1; idx >= 0; idx -= 1) {
      const pos = openTrades[idx];
      let closedNow = false;
      let exitPrice = bar.close;
      let outcome: 'WIN' | 'LOSS' = 'WIN';

      if (pos.side === 'BUY') {
        if (bar.low <= pos.currentStop) {
          closedNow = true;
          exitPrice = roundToDigits(pos.currentStop - slippageDollarsPerPrice, symbolSpec.digits);
          const remPnl = (exitPrice - pos.entry) * pos.lots * pos.remainingFrac * symbolSpec.contractSize;
          pos.realizedDollars += remPnl;
          outcome = pos.realizedDollars >= 0 ? 'WIN' : 'LOSS';
        } else {
          if (!pos.tp1Hit && bar.high >= pos.tp1) {
            pos.tp1Hit = true;
            tp1PartialsHit += 1;
            const partFrac = cfg.partialProfitEnabled ? 0.34 : 0;
            if (partFrac > 0) {
              pos.realizedDollars += (pos.tp1 - pos.entry) * pos.lots * partFrac * symbolSpec.contractSize;
              pos.remainingFrac = round2(pos.remainingFrac - partFrac);
            }
            if (cfg.moveSlToTp1OnTp1) pos.currentStop = pos.tp1;
          }
          if (!pos.tp2Hit && bar.high >= pos.tp2) {
            pos.tp2Hit = true;
            const partFrac = cfg.partialProfitEnabled ? 0.33 : 0;
            if (partFrac > 0) {
              pos.realizedDollars += (pos.tp2 - pos.entry) * pos.lots * partFrac * symbolSpec.contractSize;
              pos.remainingFrac = round2(pos.remainingFrac - partFrac);
            }
            if (cfg.moveSlToTp2OnTp2) pos.currentStop = pos.tp2;
          }
          if (bar.high >= pos.tp3) {
            closedNow = true;
            exitPrice = roundToDigits(pos.tp3 - slippageDollarsPerPrice * 0.5, symbolSpec.digits);
            pos.realizedDollars += (exitPrice - pos.entry) * pos.lots * pos.remainingFrac * symbolSpec.contractSize;
            outcome = pos.realizedDollars >= 0 ? 'WIN' : 'LOSS';
          }
        }
      } else {
        // SELL closes against Ask — conservative bar check adds full bar spread to bar.high / bar.low
        const barAskHigh = bar.high + barSpreadPoints * symbolSpec.pointSize;
        const barAskLow = bar.low + barSpreadPoints * symbolSpec.pointSize;
        if (barAskHigh >= pos.currentStop) {
          closedNow = true;
          exitPrice = roundToDigits(pos.currentStop + slippageDollarsPerPrice, symbolSpec.digits);
          const remPnl = (pos.entry - exitPrice) * pos.lots * pos.remainingFrac * symbolSpec.contractSize;
          pos.realizedDollars += remPnl;
          outcome = pos.realizedDollars >= 0 ? 'WIN' : 'LOSS';
        } else {
          if (!pos.tp1Hit && barAskLow <= pos.tp1) {
            pos.tp1Hit = true;
            tp1PartialsHit += 1;
            const partFrac = cfg.partialProfitEnabled ? 0.34 : 0;
            if (partFrac > 0) {
              pos.realizedDollars += (pos.entry - pos.tp1) * pos.lots * partFrac * symbolSpec.contractSize;
              pos.remainingFrac = round2(pos.remainingFrac - partFrac);
            }
            if (cfg.moveSlToTp1OnTp1) pos.currentStop = pos.tp1;
          }
          if (!pos.tp2Hit && barAskLow <= pos.tp2) {
            pos.tp2Hit = true;
            const partFrac = cfg.partialProfitEnabled ? 0.33 : 0;
            if (partFrac > 0) {
              pos.realizedDollars += (pos.entry - pos.tp2) * pos.lots * partFrac * symbolSpec.contractSize;
              pos.remainingFrac = round2(pos.remainingFrac - partFrac);
            }
            if (cfg.moveSlToTp2OnTp2) pos.currentStop = pos.tp2;
          }
          if (barAskLow <= pos.tp3) {
            closedNow = true;
            exitPrice = roundToDigits(pos.tp3 + slippageDollarsPerPrice * 0.5, symbolSpec.digits);
            pos.realizedDollars += (pos.entry - exitPrice) * pos.lots * pos.remainingFrac * symbolSpec.contractSize;
            outcome = pos.realizedDollars >= 0 ? 'WIN' : 'LOSS';
          }
        }
      }

      if (closedNow) {
        const commCost = round2(pos.lots * commissionPerLot);
        const slipCost = round2(slippageDollarsPerPrice * pos.lots * symbolSpec.contractSize);
        const spreadCost = round2(pos.entrySpreadPoints * symbolSpec.pointSize * pos.lots * symbolSpec.contractSize);
        totalCostsDollars = round2(totalCostsDollars + commCost + slipCost + spreadCost);
        const netPnl = round2(pos.realizedDollars - commCost);
        const balBefore = round2(balance);
        balance = round2(balance + netPnl);
        if (balance > peakBalance) peakBalance = balance;
        if (peakBalance > 0) {
          const dd = ((peakBalance - balance) / peakBalance) * 100;
          if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        }
        if (netPnl > 0) {
          grossProfit += netPnl;
          if (netPnl > largestWin) largestWin = netPnl;
          consecLosses = 0;
        } else {
          grossLoss += Math.abs(netPnl);
          if (netPnl < largestLoss) largestLoss = netPnl;
          consecLosses += 1;
        }
        const riskOneR = Math.max(0.5, Math.abs(pos.entry - pos.initialStop) * pos.lots * symbolSpec.contractSize);
        const pnlR = round2(netPnl / riskOneR);
        netR = round2(netR + pnlR);

        const rec: BacktestTradeResult = {
          id: pos.id,
          openTimeMs: pos.openTimeMs,
          dateLusaka: pos.dateLusaka,
          timeLusaka: pos.timeLusaka,
          session: pos.session,
          side: pos.side,
          status: 'EXECUTED',
          entry: pos.entry,
          stop: pos.initialStop,
          tp1: pos.tp1,
          tp2: pos.tp2,
          tp3: pos.tp3,
          target: pos.tp2,
          tp1Hit: pos.tp1Hit,
          tp2Hit: pos.tp2Hit,
          exit: exitPrice,
          outcome,
          pnlR,
          lotsUsed: pos.lots,
          balanceBefore: balBefore,
          balanceAfter: balance,
          pnlDollars: netPnl,
          commissionDollars: commCost,
          slippageDollars: slipCost,
          setupStatus: pos.marketCondition,
          setupType: pos.setupType,
          reason: pos.reason,
          blockReason: '',
          wouldHaveBeenOutcome: null,
          wouldHaveBeenR: null,
          counterfactualNote: null,
        };
        trades.push(rec);
        equityCurve.push({
          index: trades.length,
          timestampMs: bar.openTimeMs,
          dateLusaka: clk.dateLusaka,
          timeLusaka: clk.timeLusaka,
          balance,
          pnlDollars: netPnl,
          label: `#${trades.length} ${pos.side}`,
        });
        openTrades.splice(idx, 1);
      }
    }

    // 2) Evaluate new entry strictly up to bar i
    // Legacy mode restricts hours to Asian/London (03:00-19:00); Dynamic All-Session trades all open weekday hours.
    if (clk.isWeekend) continue;
    if (spreadFilterMode === 'LEGACY_RIGID_45' && (clk.minutes < 180 || clk.minutes > 1140)) {
      continue;
    }

    const m5Slice = workingBars.slice(Math.max(0, i - 260), i + 1);
    const m15Slice = closedM15.slice(Math.max(0, m15Ptr - 260), m15Ptr);
    const h1Slice = closedH1.slice(Math.max(0, h1Ptr - 260), h1Ptr);
    if (m15Slice.length < 200 || h1Slice.length < 200) continue;

    const session = classifyLusakaTradingSession(clk.minutes);
    const dailyPnlPct = dayStartBal > 0 ? ((balance - dayStartBal) / dayStartBal) * 100 : 0;

    const simLevels: DaySessionLevels = {
      dateLusaka: curDay,
      pdh: null,
      pdl: null,
      prevDayDate: null,
      asianHigh: null,
      asianLow: null,
      londonHigh: null,
      londonLow: null,
      asianTradesToday: asianToday,
      londonTradesToday: londonToday,
      totalTradesToday: tradesToday,
      consecutiveLossesToday: consecLosses,
      manualOverride: false,
    };

    const evalCfg =
      spreadFilterMode === 'LEGACY_RIGID_45'
        ? {
            ...cfg,
            maxSpreadPips: 45,
            spreadSensitivity: 'CONSERVATIVE' as const,
            allowHighSpreadTrades: false,
          }
        : cfg;

    const { analysis, signal } = evaluateEmaStochasticProSignal({
      h1Candles: h1Slice,
      m15Candles: m15Slice,
      m5Candles: m5Slice,
      settings: { ...settings, emaPro: evalCfg },
      levels: simLevels,
      phase: session,
      latestPrice: bar.close,
      bid: barBid,
      ask: barAsk,
      quoteTimestamp: new Date(bar.openTimeMs).toISOString(),
      quoteSource: observedSamples.length > 0 ? 'XM TickerAll + Modeled Bar' : 'Modeled Historical Spread',
      hasTwoSidedQuote: true,
      symbolSpec,
      spreadHistory: simSpreadHistory,
      spreadPips: barSpreadPoints,
      accountEquity: balance,
      openPositionsCount: openTrades.length,
      dailyPnlPct,
      isWeekend: clk.isWeekend,
      feedConnected: true,
      nowMs: bar.openTimeMs,
    });

    const evalSpread = analysis.spreadEvaluation;
    const isStrategyCandidate = Boolean(evalSpread?.proposedSide);
    if (isStrategyCandidate) {
      qualifiedOpportunities += 1;
    }

    // In LEGACY_RIGID_45, enforce the hard 45-point ceiling even if dynamic evaluator had slack
    const legacyRejected =
      spreadFilterMode === 'LEGACY_RIGID_45' &&
      isStrategyCandidate &&
      barSpreadPoints > 45;

    const dynamicRejected =
      isStrategyCandidate && evalSpread && !evalSpread.tradePermitted;

    if (legacyRejected || dynamicRejected) {
      rejectedBySpread += 1;
      if (blockedEntries.length < 50) {
        blockedEntries.push({
          id: `blk-${bar.openTimeMs}`,
          openTimeMs: bar.openTimeMs,
          dateLusaka: clk.dateLusaka,
          timeLusaka: clk.timeLusaka,
          session,
          side: evalSpread?.proposedSide === 'SELL' ? 'SELL' : 'BUY',
          status: 'BLOCKED',
          entry: bar.close,
          stop: bar.close,
          tp1: bar.close,
          tp2: bar.close,
          tp3: bar.close,
          target: bar.close,
          tp1Hit: false,
          exit: bar.close,
          outcome: 'BLOCKED',
          pnlR: 0,
          lotsUsed: 0,
          balanceBefore: balance,
          balanceAfter: balance,
          pnlDollars: 0,
          setupStatus: analysis.marketCondition,
          setupType: signal.setupType,
          reason: signal.reason,
          blockReason: legacyRejected
            ? `Legacy 45p ceiling blocked spread (${barSpreadPoints}p > 45p)`
            : evalSpread?.reason || signal.blockReason || 'Spread filter blocked entry',
          wouldHaveBeenOutcome: null,
          wouldHaveBeenR: null,
          counterfactualNote: null,
        });
      }
      continue;
    }

    if (signal.action === 'BUY' || signal.action === 'SELL') {
      if (
        signal.entry !== null &&
        signal.stop !== null &&
        signal.tp1 !== null &&
        signal.tp2 !== null &&
        typeof signal.tp3 === 'number' &&
        signal.suggestedLots >= 0.01
      ) {
        // Side-specific fill price with modeled slippage (BUY at Ask + slip, SELL at Bid - slip)
        const filledEntry =
          signal.action === 'BUY'
            ? roundToDigits(barAsk + slippageDollarsPerPrice, symbolSpec.digits)
            : roundToDigits(barBid - slippageDollarsPerPrice, symbolSpec.digits);

        if (barSpreadPoints > 45) {
          acceptedAbove45Points += 1;
        }
        sumSpreadAtEntry += barSpreadPoints;

        openTrades.push({
          id: `bt-${trades.length + openTrades.length + 1}-${bar.openTimeMs}`,
          openTimeMs: bar.openTimeMs,
          dateLusaka: clk.dateLusaka,
          timeLusaka: clk.timeLusaka,
          session,
          side: signal.action,
          entry: filledEntry,
          initialStop: signal.stop,
          currentStop: signal.stop,
          tp1: signal.tp1,
          tp2: signal.tp2,
          tp3: signal.tp3,
          tp1Hit: false,
          tp2Hit: false,
          lots: signal.suggestedLots,
          remainingFrac: 1.0,
          realizedDollars: 0,
          marketCondition: signal.setupLabel ?? analysis.marketCondition,
          setupType: signal.setupType,
          reason: signal.reason,
          entrySpreadPoints: barSpreadPoints,
        });
        tradesToday += 1;
        if (session === 'ASIAN_SESSION') asianToday += 1;
        else if (session === 'LONDON_SESSION') londonToday += 1;
      }
    } else if (signal.blockReason && tradesToday > 0 && blockedEntries.length < 50) {
      blockedEntries.push({
        id: `blk-${bar.openTimeMs}`,
        openTimeMs: bar.openTimeMs,
        dateLusaka: clk.dateLusaka,
        timeLusaka: clk.timeLusaka,
        session,
        side: 'BUY',
        status: 'BLOCKED',
        entry: bar.close,
        stop: bar.close,
        tp1: bar.close,
        tp2: bar.close,
        tp3: bar.close,
        target: bar.close,
        tp1Hit: false,
        exit: bar.close,
        outcome: 'BLOCKED',
        pnlR: 0,
        lotsUsed: 0,
        balanceBefore: balance,
        balanceAfter: balance,
        pnlDollars: 0,
        setupStatus: analysis.marketCondition,
        setupType: signal.setupType,
        reason: signal.reason,
        blockReason: signal.blockReason,
        wouldHaveBeenOutcome: null,
        wouldHaveBeenR: null,
        counterfactualNote: null,
      });
    }
  }

  const startMs = workingBars[0].openTimeMs;
  const endMs = workingBars[workingBars.length - 1].openTimeMs;
  const span = Math.max(1, endMs - startMs);
  const t60 = startMs + span * 0.6;
  const t80 = startMs + span * 0.8;

  const buildSplit = (
    label: BacktestSplitMetric['label'],
    minTs: number,
    maxTs: number
  ): BacktestSplitMetric => {
    const sliceCandles = workingBars.filter((c) => c.openTimeMs >= minTs && c.openTimeMs <= maxTs);
    const sliceTrades = trades.filter((t) => (t.openTimeMs ?? 0) >= minTs && (t.openTimeMs ?? 0) <= maxTs);
    let gp = 0;
    let gl = 0;
    let w = 0;
    let eq = startingBalance;
    let pk = startingBalance;
    let ddMax = 0;
    for (const tr of sliceTrades) {
      if (tr.pnlDollars > 0) {
        gp += tr.pnlDollars;
        w += 1;
      } else {
        gl += Math.abs(tr.pnlDollars);
      }
      eq += tr.pnlDollars;
      if (eq > pk) pk = eq;
      if (pk > 0) ddMax = Math.max(ddMax, ((pk - eq) / pk) * 100);
    }
    return {
      label,
      candlesCount: sliceCandles.length,
      trades: sliceTrades.length,
      winRatePct: sliceTrades.length > 0 ? round2((w / sliceTrades.length) * 100) : 0,
      netProfitDollars: round2(gp - gl),
      profitFactor: gl > 0 ? round2(gp / gl) : gp > 0 ? 9.99 : 0,
      maxDrawdownPct: round2(ddMax),
    };
  };

  const splits: BacktestSplitMetric[] = [
    buildSplit('Train (60%)', startMs, t60),
    buildSplit('Validation (20%)', t60 + 1, t80),
    buildSplit('Out-of-Sample (20%)', t80 + 1, endMs),
  ];

  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const netProfitDollars = round2(balance - startingBalance);
  const profitFactor = grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? 9.99 : 0;

  return {
    qualifiedOpportunities,
    rejectedBySpread,
    acceptedAbove45Points,
    avgSpreadAtEntryPoints:
      trades.length > 0 ? Math.round((sumSpreadAtEntry / trades.length) * 10) / 10 : null,
    totalCostsDollars: round2(totalCostsDollars),
    summary: {
      hasRealData: true,
      strategyModule: 'EMA_STOCHASTIC_PRO',
      errorCode: null,
      errorMessage: null,
      dataSource: `TickerAll MT5 (${closedM5.length} M5 · ${closedM15.length} M15 · ${closedH1.length} H1 · All-Session)`,
      lastUpdatedAt,
      periodDays,
      periodLabel: `${periodDays} Days`,
      candlesTested: workingBars.length,
      m15CandlesCount: closedM15.length,
      m5CandlesCount: closedM5.length,
      h1CandlesCount: closedH1.length,
      d1DaysCount: distinctDays.size,
      daysTested: distinctDays.size,
      weeksTested: Math.max(1, Math.round(distinctDays.size / 5)),
      totalTrades: trades.length,
      wins,
      losses,
      tp1PartialsHit,
      winRatePct: trades.length > 0 ? round2((wins / trades.length) * 100) : 0,
      netR,
      profitFactor,
      avgRr: trades.length > 0 ? round2(trades.reduce((a, b) => a + b.pnlR, 0) / trades.length) : 0,
      startingBalance,
      endingBalance: round2(balance),
      balanceGrowthPct: startingBalance > 0 ? round2((netProfitDollars / startingBalance) * 100) : 0,
      totalProfitDollars: round2(grossProfit),
      totalLossDollars: round2(grossLoss),
      netProfitDollars,
      largestWinDollars: round2(largestWin),
      largestLossDollars: round2(largestLoss),
      maxDrawdownPct: round2(maxDrawdownPct),
      maxAutoLotCap,
      skippedSetupsCount: blockedEntries.length,
      splits,
      assumptions: {
        spreadPips,
        commissionPerLot,
        slippagePips,
      },
      equityCurve,
      trades,
      blockedEntries,
      allEntries: [...trades, ...blockedEntries],
    },
  };
}

function toComparisonRow(
  label: string,
  res: BacktestInternalRunResult
): SpreadFilterComparisonRow {
  return {
    label,
    qualifiedOpportunities: res.qualifiedOpportunities,
    rejectedBySpread: res.rejectedBySpread,
    tradesAccepted: res.summary.totalTrades,
    wins: res.summary.wins,
    losses: res.summary.losses,
    winRatePct: res.summary.winRatePct,
    netProfitDollars: res.summary.netProfitDollars,
    totalCostsDollars: res.totalCostsDollars,
    maxDrawdownPct: res.summary.maxDrawdownPct,
    profitFactor: res.summary.profitFactor ?? 0,
    avgSpreadAtEntryPoints: res.avgSpreadAtEntryPoints ?? 0,
    acceptedAbove45Points: res.acceptedAbove45Points,
  };
}

export function runSpreadFilterComparisonBacktest(params: {
  m5Candles: M15Candle[];
  m15Candles?: M15Candle[];
  h1Candles?: M15Candle[];
  settings: StrategySettings;
  periodDays?: 30 | 90 | 180;
  startingBalance?: number;
  maxAutoLotCap?: number;
  lastUpdatedAt?: string | null;
  masterFeedConnected?: boolean;
  symbolSpec?: SymbolSpecification;
  observedSpreadSamples?: SpreadSampleRecord[];
}): SpreadFilterComparisonReport {
  const legacyRes = executeBacktestSimulation({
    ...params,
    spreadFilterMode: 'LEGACY_RIGID_45',
  });
  const dynamicRes = executeBacktestSimulation({
    ...params,
    spreadFilterMode: 'DYNAMIC_ALL_SESSION',
  });

  const observedCount = (params.observedSpreadSamples ?? []).filter((s) => s.hasTwoSidedQuote !== false).length;
  const dataMode: SpreadFilterComparisonReport['dataMode'] =
    observedCount >= 50 ? 'TICK_OBSERVED' : 'HISTORICAL_OHLC_WITH_MODELED_SPREAD';

  return {
    generatedAt: new Date().toISOString(),
    periodDays: params.periodDays ?? 30,
    candlesTested: dynamicRes.summary.candlesTested,
    dataMode,
    disclaimer:
      dataMode === 'TICK_OBSERVED'
        ? `Spread comparison uses ${observedCount} observed two-sided MT5 quotes from TickerAll.`
        : observedCount > 0
          ? `Modeled OHLC bar spreads anchored to ${observedCount} observed MT5 Bid/Ask quote baseline(s); historical OHLC bars do not record per-bar ticks.`
          : 'Historical OHLC bars from TickerAll do not store tick-level Bid/Ask quotes; bar spreads are conservatively modeled from volatility/session rollover anchored to observed spread baseline.',
    legacyRigid45: toComparisonRow('Legacy Rigid 45p + Restricted Hours', legacyRes),
    dynamicAllSession: toComparisonRow('All-Session Dynamic Spread Filter', dynamicRes),
  };
}

export function runEmaStochasticProBacktest(params: {
  m5Candles: M15Candle[];
  m15Candles?: M15Candle[];
  h1Candles?: M15Candle[];
  settings: StrategySettings;
  periodDays?: 30 | 90 | 180;
  startingBalance?: number;
  maxAutoLotCap?: number;
  lastUpdatedAt?: string | null;
  masterFeedConnected?: boolean;
  symbolSpec?: SymbolSpecification;
  observedSpreadSamples?: SpreadSampleRecord[];
  includeSpreadComparison?: boolean;
}): BacktestSummary {
  const mainRes = executeBacktestSimulation({
    ...params,
    spreadFilterMode: 'DYNAMIC_ALL_SESSION',
  });

  if (!mainRes.summary.hasRealData || params.includeSpreadComparison === false) {
    return mainRes.summary;
  }

  const legacyRes = executeBacktestSimulation({
    ...params,
    spreadFilterMode: 'LEGACY_RIGID_45',
  });

  const observedCount = (params.observedSpreadSamples ?? []).filter((s) => s.hasTwoSidedQuote !== false).length;
  const dataMode: SpreadFilterComparisonReport['dataMode'] =
    observedCount >= 50 ? 'TICK_OBSERVED' : 'HISTORICAL_OHLC_WITH_MODELED_SPREAD';

  return {
    ...mainRes.summary,
    spreadComparison: {
      generatedAt: new Date().toISOString(),
      periodDays: params.periodDays ?? 30,
      candlesTested: mainRes.summary.candlesTested,
      dataMode,
      disclaimer:
        dataMode === 'TICK_OBSERVED'
          ? `Spread comparison uses ${observedCount} observed two-sided MT5 quotes from TickerAll.`
          : observedCount > 0
            ? `Modeled OHLC bar spreads anchored to ${observedCount} observed MT5 Bid/Ask quote baseline(s); historical OHLC bars do not record per-bar ticks.`
            : 'Historical OHLC bars from TickerAll do not store tick-level Bid/Ask quotes; bar spreads are conservatively modeled from volatility/session rollover anchored to observed spread baseline.',
      legacyRigid45: toComparisonRow('Legacy Rigid 45p + Restricted Hours', legacyRes),
      dynamicAllSession: toComparisonRow('All-Session Dynamic Spread Filter', mainRes),
    },
  };
}

