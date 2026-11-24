import type {
  AdminSpreadPolicy,
  BrokerAccountSetup,
  BrokerAccountVariant,
  DynamicSpreadEvaluation,
  SpreadClassification,
  SpreadSampleRecord,
  SpreadSensitivity,
  SpreadWindowStats,
  SymbolSpecification,
  TransactionCostBreakdown,
} from '../types/connectivity.ts';

export const DEFAULT_SYMBOL_SPEC: SymbolSpecification = {
  symbol: 'XAUUSD',
  digits: 2,
  pointSize: 0.01,
  tickSize: 0.01,
  contractSize: 100,
  commissionPerLot: 0,
  currency: 'USD',
  accountVariant: 'STANDARD',
  source: 'MT5_STANDARD_DEFAULT',
  verifiedFromBroker: false,
};

export function inferBrokerAccountVariant(
  setup?: Partial<BrokerAccountSetup> | null,
  brokerName?: string,
  symbolHint?: string
): BrokerAccountVariant {
  if (
    setup?.accountVariant === 'STANDARD' ||
    setup?.accountVariant === 'CENT_USD' ||
    setup?.accountVariant === 'CENT_USC' ||
    setup?.accountVariant === 'ECN_RAW'
  ) {
    return setup.accountVariant;
  }
  const combined = `${brokerName ?? ''} ${symbolHint ?? ''}`.toLowerCase();
  if (combined.includes('cent') || combined.includes('micro') || symbolHint?.toLowerCase().endsWith('c')) {
    return combined.includes('usc') || brokerName?.toLowerCase().includes('weltrade') || brokerName?.toLowerCase().includes('exness')
      ? 'CENT_USC'
      : 'CENT_USD';
  }
  if (combined.includes('raw') || combined.includes('ecn') || combined.includes('zero') || combined.includes('pro')) {
    return 'ECN_RAW';
  }
  return 'STANDARD';
}

export function resolveAccountVariantSpec(
  baseSpec: SymbolSpecification,
  variant: BrokerAccountVariant
): SymbolSpecification {
  if (variant === 'CENT_USD') {
    return {
      ...baseSpec,
      contractSize: baseSpec.verifiedFromBroker && baseSpec.contractSize < 50 ? baseSpec.contractSize : 1,
      currency: 'USD',
      accountVariant: 'CENT_USD',
    };
  }
  if (variant === 'CENT_USC') {
    return {
      ...baseSpec,
      contractSize: 100, // 1.00 cent lot moves 100 USC ($1.00) per $1.00 XAUUSD move
      currency: 'USC',
      accountVariant: 'CENT_USC',
    };
  }
  return {
    ...baseSpec,
    contractSize: baseSpec.verifiedFromBroker ? baseSpec.contractSize : 100,
    currency: 'USD',
    accountVariant: variant,
  };
}

export const DEFAULT_ADMIN_SPREAD_POLICY: AdminSpreadPolicy = {
  maxSpreadPoints: 80,
  spreadSensitivity: 'BALANCED',
  allowHighSpreadTrades: false,
  commissionPerLot: 0,
  estimatedSlippagePoints: 5,
  maxQuoteAgeSeconds: 15,
  minNetRewardRisk: 1.6,
  defaultSymbol: 'GOLD',
  defaultDigits: 2,
  defaultPointSize: 0.01,
};

export function roundToDigits(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const safeDigits = Math.max(0, Math.min(6, Math.round(digits)));
  const factor = Math.pow(10, safeDigits);
  return Math.round(value * factor) / factor;
}

export function countSignificantDecimals(val: number | null | undefined, maxDecimals = 5): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
  for (let d = 0; d <= maxDecimals; d += 1) {
    const factor = Math.pow(10, d);
    if (Math.abs(val * factor - Math.round(val * factor)) < 1e-6) {
      return d;
    }
  }
  return maxDecimals;
}

export function resolveSymbolSpecification(params: {
  symbol?: string | null;
  explicitDigits?: number | null;
  explicitPointSize?: number | null;
  explicitTickSize?: number | null;
  explicitContractSize?: number | null;
  commissionPerLot?: number | null;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  source?: string | null;
  verifiedFromBroker?: boolean;
  fallbackSpec?: SymbolSpecification;
}): SymbolSpecification {
  const base = params.fallbackSpec ?? DEFAULT_SYMBOL_SPEC;
  let digits = base.digits;
  let pointSize = base.pointSize;
  let verified = Boolean(params.verifiedFromBroker);

  if (
    typeof params.explicitPointSize === 'number' &&
    Number.isFinite(params.explicitPointSize) &&
    params.explicitPointSize > 0 &&
    params.explicitPointSize <= 1
  ) {
    pointSize = params.explicitPointSize;
    digits = Math.max(0, Math.min(5, Math.round(-Math.log10(pointSize))));
    verified = true;
  } else if (
    typeof params.explicitDigits === 'number' &&
    Number.isFinite(params.explicitDigits) &&
    params.explicitDigits >= 0 &&
    params.explicitDigits <= 5
  ) {
    digits = Math.round(params.explicitDigits);
    pointSize = Math.pow(10, -digits);
    verified = true;
  } else {
    const observedMaxDecimals = Math.max(
      countSignificantDecimals(params.bid, 4),
      countSignificantDecimals(params.ask, 4),
      countSignificantDecimals(params.last, 4)
    );
    if (observedMaxDecimals >= 3) {
      digits = Math.min(3, observedMaxDecimals);
      pointSize = Math.pow(10, -digits);
    } else {
      digits = Math.max(2, base.digits);
      pointSize = Math.pow(10, -digits);
    }
  }

  const tickSize =
    typeof params.explicitTickSize === 'number' &&
    Number.isFinite(params.explicitTickSize) &&
    params.explicitTickSize > 0
      ? params.explicitTickSize
      : pointSize;

  const contractSize =
    typeof params.explicitContractSize === 'number' &&
    Number.isFinite(params.explicitContractSize) &&
    params.explicitContractSize > 0
      ? params.explicitContractSize
      : base.contractSize;

  const commissionPerLot =
    typeof params.commissionPerLot === 'number' &&
    Number.isFinite(params.commissionPerLot) &&
    params.commissionPerLot >= 0
      ? params.commissionPerLot
      : base.commissionPerLot;

  return {
    symbol: (params.symbol || base.symbol || 'XAUUSD').trim(),
    digits,
    pointSize,
    tickSize,
    contractSize,
    commissionPerLot,
    currency: base.currency ?? 'USD',
    accountVariant: base.accountVariant ?? 'STANDARD',
    source: params.source?.trim() || base.source,
    verifiedFromBroker: verified || base.verifiedFromBroker,
  };
}

export function computeSpreadMetrics(
  bid: number,
  ask: number,
  pointSize = 0.01,
  digits = 2
): { spreadPrice: number; spreadPoints: number } {
  const safePoint = Number.isFinite(pointSize) && pointSize > 0 ? pointSize : 0.01;
  const rawSpread = Math.max(0, ask - bid);
  const spreadPrice = roundToDigits(rawSpread, Math.max(digits + 1, 3));
  const spreadPoints = Math.round((rawSpread / safePoint) * 10) / 10;
  return { spreadPrice, spreadPoints };
}

function interpolatePercentile(sortedAsc: number[], pct: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (pct / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const weight = rank - lo;
  return Math.round((sortedAsc[lo] * (1 - weight) + sortedAsc[hi] * weight) * 10) / 10;
}

export function computeSpreadWindowStats(
  samples: SpreadSampleRecord[],
  windowMs: number,
  windowLabel: '1H' | '24H',
  nowMs = Date.now(),
  minSamplesRequired = 10
): SpreadWindowStats {
  const cutoff = nowMs - windowMs;
  const values = samples
    .filter(
      (s) =>
        s &&
        Number.isFinite(s.timestampMs) &&
        s.timestampMs >= cutoff &&
        s.timestampMs <= nowMs + 5000 &&
        Number.isFinite(s.spreadPoints) &&
        s.spreadPoints >= 0
    )
    .map((s) => s.spreadPoints)
    .sort((a, b) => a - b);

  if (values.length === 0) {
    return {
      windowLabel,
      sampleCount: 0,
      sufficientData: false,
      minSamplesRequired,
      medianPoints: null,
      p75Points: null,
      p90Points: null,
      minPoints: null,
      maxPoints: null,
      avgPoints: null,
    };
  }

  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    windowLabel,
    sampleCount: values.length,
    sufficientData: values.length >= minSamplesRequired,
    minSamplesRequired,
    medianPoints: interpolatePercentile(values, 50),
    p75Points: interpolatePercentile(values, 75),
    p90Points: interpolatePercentile(values, 90),
    minPoints: Math.round(values[0] * 10) / 10,
    maxPoints: Math.round(values[values.length - 1] * 10) / 10,
    avgPoints: Math.round((sum / values.length) * 10) / 10,
  };
}

export function calculateTransactionCosts(params: {
  side: 'BUY' | 'SELL' | null;
  bid: number | null;
  ask: number | null;
  entryPrice?: number | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  lots?: number;
  symbolSpec: SymbolSpecification;
  estimatedSlippagePoints?: number;
}): TransactionCostBreakdown | null {
  const { bid, ask, symbolSpec } = params;
  if (
    bid === null ||
    ask === null ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask < bid
  ) {
    return null;
  }

  const lots = Math.max(0.01, params.lots ?? 0.01);
  const slippagePoints = Math.max(0, params.estimatedSlippagePoints ?? 5);
  const { spreadPrice, spreadPoints } = computeSpreadMetrics(
    bid,
    ask,
    symbolSpec.pointSize,
    symbolSpec.digits
  );
  const dollarPerPriceUnit = lots * symbolSpec.contractSize;
  const spreadCostDollars = Math.round(spreadPrice * dollarPerPriceUnit * 100) / 100;
  const commissionDollars = Math.round(symbolSpec.commissionPerLot * lots * 100) / 100;
  const estimatedSlippageDollars =
    Math.round(slippagePoints * symbolSpec.pointSize * dollarPerPriceUnit * 100) / 100;
  const totalEstimatedCostDollars =
    Math.round((spreadCostDollars + commissionDollars + estimatedSlippageDollars) * 100) / 100;

  const commissionInPoints =
    symbolSpec.pointSize > 0 && dollarPerPriceUnit > 0
      ? commissionDollars / (symbolSpec.pointSize * dollarPerPriceUnit)
      : 0;
  const totalCostPoints = Math.round((spreadPoints + slippagePoints + commissionInPoints) * 10) / 10;

  let grossRewardDollars: number | null = null;
  let netRewardDollars: number | null = null;
  let netRiskDollars: number | null = null;
  let grossRr: number | null = null;
  let netRr: number | null = null;

  const side = params.side;
  const entry =
    typeof params.entryPrice === 'number' && Number.isFinite(params.entryPrice) && params.entryPrice > 0
      ? params.entryPrice
      : side === 'BUY'
        ? ask
        : side === 'SELL'
          ? bid
          : (bid + ask) / 2;
  const stop = params.stopPrice;
  const target = params.targetPrice;

  if (
    side &&
    typeof stop === 'number' &&
    Number.isFinite(stop) &&
    typeof target === 'number' &&
    Number.isFinite(target)
  ) {
    const riskDist = side === 'BUY' ? entry - stop : stop - entry;
    const rewardDist = side === 'BUY' ? target - entry : entry - target;
    if (riskDist > 0 && rewardDist > 0) {
      grossRewardDollars = Math.round(rewardDist * dollarPerPriceUnit * 100) / 100;
      const grossRiskDollars = Math.round(riskDist * dollarPerPriceUnit * 100) / 100;
      netRewardDollars = Math.round((grossRewardDollars - totalEstimatedCostDollars) * 100) / 100;
      netRiskDollars = Math.round((grossRiskDollars + commissionDollars + estimatedSlippageDollars) * 100) / 100;
      grossRr = Math.round((rewardDist / riskDist) * 100) / 100;
      netRr =
        netRiskDollars > 0
          ? Math.round((Math.max(0, netRewardDollars) / netRiskDollars) * 100) / 100
          : 0;
    }
  }

  return {
    spreadPrice,
    spreadPoints,
    spreadCostDollars,
    commissionDollars,
    estimatedSlippagePoints: slippagePoints,
    estimatedSlippageDollars,
    totalEstimatedCostDollars,
    totalCostPoints,
    grossRewardDollars,
    netRewardDollars,
    netRiskDollars,
    grossRr,
    netRr,
  };
}

export function evaluateDynamicSpread(params: {
  bid: number | null;
  ask: number | null;
  quoteTimestamp: string | null;
  quoteSource: string;
  hasTwoSidedQuote: boolean;
  isFallbackOnly?: boolean;
  symbolSpec: SymbolSpecification;
  spreadHistory: SpreadSampleRecord[];
  maxSpreadPoints: number;
  sensitivity: SpreadSensitivity;
  allowHighSpreadTrades: boolean;
  minNetRewardRisk: number;
  estimatedSlippagePoints?: number;
  maxQuoteAgeSeconds?: number;
  atrPrice?: number | null;
  confirmationScore?: number; // 0..100
  proposedSide?: 'BUY' | 'SELL' | null;
  proposedEntry?: number | null;
  proposedStop?: number | null;
  proposedTarget?: number | null;
  lots?: number;
  nowMs?: number;
}): DynamicSpreadEvaluation {
  const nowMs = params.nowMs ?? Date.now();
  const maxQuoteAgeMs = Math.max(3, params.maxQuoteAgeSeconds ?? 15) * 1000;
  const maxSpreadPoints = Math.max(20, Math.min(500, params.maxSpreadPoints || 80));
  const sensitivity = params.sensitivity || 'BALANCED';
  const symbolSpec = params.symbolSpec || DEFAULT_SYMBOL_SPEC;

  const stats1h = computeSpreadWindowStats(params.spreadHistory, 60 * 60 * 1000, '1H', nowMs, 10);
  const stats24h = computeSpreadWindowStats(
    params.spreadHistory,
    24 * 60 * 60 * 1000,
    '24H',
    nowMs,
    20
  );

  const sensitivityFactors: Record<
    SpreadSensitivity,
    { normal: number; elevated: number; abnormalMult: number; strongThreshold: number }
  > = {
    CONSERVATIVE: { normal: 0.52, elevated: 0.75, abnormalMult: 1.55, strongThreshold: 78 },
    BALANCED: { normal: 0.62, elevated: 0.85, abnormalMult: 1.75, strongThreshold: 72 },
    AGGRESSIVE: { normal: 0.72, elevated: 0.94, abnormalMult: 2.0, strongThreshold: 65 },
  };
  const sf = sensitivityFactors[sensitivity];

  const atrPoints =
    typeof params.atrPrice === 'number' && Number.isFinite(params.atrPrice) && params.atrPrice > 0
      ? params.atrPrice / symbolSpec.pointSize
      : 0;
  const volAllowance = Math.min(12, Math.round(atrPoints * 0.03 * 10) / 10);

  const baselineMedian = stats1h.sufficientData
    ? (stats1h.medianPoints as number)
    : stats24h.sufficientData
      ? (stats24h.medianPoints as number)
      : null;
  const baselineP90 = stats1h.sufficientData
    ? (stats1h.p90Points as number)
    : stats24h.sufficientData
      ? (stats24h.p90Points as number)
      : null;

  const highMax = maxSpreadPoints;
  let normalMax = Math.round(highMax * sf.normal);
  let elevatedMax = Math.round(highMax * sf.elevated);
  if (baselineMedian !== null) {
    const adaptiveNormal = Math.round(baselineMedian * 1.35 + volAllowance);
    normalMax = Math.max(20, Math.min(Math.round(highMax * sf.normal), Math.max(normalMax * 0.75, adaptiveNormal)));
  }
  if (baselineP90 !== null) {
    const adaptiveElevated = Math.round(Math.max(normalMax + 8, baselineP90 * 1.15 + volAllowance));
    elevatedMax = Math.max(normalMax + 6, Math.min(Math.round(highMax * sf.elevated), adaptiveElevated));
  }
  if (elevatedMax >= highMax) {
    elevatedMax = Math.max(normalMax + 4, highMax - 4);
  }
  if (normalMax >= elevatedMax) {
    normalMax = Math.max(15, elevatedMax - 6);
  }

  let abnormalMin = Math.round(highMax * sf.abnormalMult);
  if (baselineMedian !== null && baselineMedian > 0) {
    abnormalMin = Math.max(highMax + 15, Math.min(abnormalMin, Math.round(Math.max(highMax * 1.3, baselineMedian * 3.5))));
  }

  const thresholdsPoints = {
    normalMax,
    elevatedMax,
    highMax,
    abnormalMin,
  };

  const tsMs = params.quoteTimestamp ? Date.parse(params.quoteTimestamp) : NaN;
  const quoteAgeMs = Number.isFinite(tsMs) ? Math.max(0, nowMs - tsMs) : null;
  const quoteFresh = quoteAgeMs !== null && quoteAgeMs <= maxQuoteAgeMs;

  const validQuoteValues =
    params.bid !== null &&
    params.ask !== null &&
    Number.isFinite(params.bid) &&
    Number.isFinite(params.ask) &&
    params.bid > 0 &&
    params.ask >= params.bid;

  const dataAvailable =
    Boolean(params.hasTwoSidedQuote) &&
    !params.isFallbackOnly &&
    validQuoteValues &&
    quoteFresh;

  if (!dataAvailable) {
    const missingReason = params.isFallbackOnly
      ? 'DATA UNAVAILABLE — Fallback reference price active; live XM Bid/Ask quote required'
      : !params.hasTwoSidedQuote || !validQuoteValues
        ? 'DATA UNAVAILABLE — Live XM two-sided Bid/Ask quote missing'
        : `DATA UNAVAILABLE — XM quote stale (${quoteAgeMs !== null ? `${Math.round(quoteAgeMs / 1000)}s` : 'no timestamp'} > ${Math.round(maxQuoteAgeMs / 1000)}s limit)`;

    return {
      dataAvailable: false,
      quoteFresh,
      hasTwoSidedQuote: Boolean(params.hasTwoSidedQuote && validQuoteValues),
      quoteAgeMs,
      quoteTimestamp: params.quoteTimestamp,
      quoteSource: params.quoteSource || 'UNAVAILABLE',
      symbol: symbolSpec.symbol,
      digits: symbolSpec.digits,
      pointSize: symbolSpec.pointSize,
      bid: validQuoteValues ? roundToDigits(params.bid as number, symbolSpec.digits) : null,
      ask: validQuoteValues ? roundToDigits(params.ask as number, symbolSpec.digits) : null,
      spreadPrice: null,
      spreadPoints: null,
      classification: 'DATA_UNAVAILABLE',
      decision: 'BLOCK_DATA_UNAVAILABLE',
      tradePermitted: false,
      requiresStrongConfirmation: false,
      reason: missingReason,
      configuredMaxSpreadPoints: maxSpreadPoints,
      sensitivity,
      allowHighSpreadTrades: params.allowHighSpreadTrades,
      acceptedAbove45Override: false,
      proposedSide: params.proposedSide ?? null,
      stats1h,
      stats24h,
      costBreakdown: null,
      thresholdsPoints,
    };
  }

  const bid = roundToDigits(params.bid as number, symbolSpec.digits);
  const ask = roundToDigits(params.ask as number, symbolSpec.digits);
  const { spreadPrice, spreadPoints } = computeSpreadMetrics(
    bid,
    ask,
    symbolSpec.pointSize,
    symbolSpec.digits
  );

  const costBreakdown = calculateTransactionCosts({
    side: params.proposedSide ?? null,
    bid,
    ask,
    entryPrice: params.proposedEntry,
    stopPrice: params.proposedStop,
    targetPrice: params.proposedTarget,
    lots: params.lots,
    symbolSpec,
    estimatedSlippagePoints: params.estimatedSlippagePoints,
  });

  let classification: SpreadClassification;
  if (spreadPoints <= thresholdsPoints.normalMax) {
    classification = 'NORMAL';
  } else if (spreadPoints <= thresholdsPoints.elevatedMax) {
    classification = 'ELEVATED';
  } else if (spreadPoints <= thresholdsPoints.highMax) {
    classification = 'HIGH';
  } else if (spreadPoints < thresholdsPoints.abnormalMin) {
    classification = 'EXCESSIVE';
  } else {
    classification = 'ABNORMAL';
  }

  const confirmationScore = params.confirmationScore ?? 0;
  const strongConfirmed = confirmationScore >= sf.strongThreshold;
  const highSpreadStrongConfirmed = confirmationScore >= Math.min(95, sf.strongThreshold + 10);
  const netRr = costBreakdown?.netRr ?? null;
  const minNetRr = Math.max(1.0, params.minNetRewardRisk || 1.6);
  const netRrPasses = netRr === null || netRr >= minNetRr;

  let decision: DynamicSpreadEvaluation['decision'] = 'ALLOW';
  let tradePermitted = false;
  let requiresStrongConfirmation = false;
  let reason = '';

  if (classification === 'NORMAL') {
    decision = 'ALLOW';
    if (!netRrPasses) {
      tradePermitted = false;
      reason = `Net R:R ${netRr?.toFixed(2)} after costs ($${costBreakdown?.totalEstimatedCostDollars.toFixed(2)}) is below minimum ${minNetRr.toFixed(2)}`;
    } else {
      tradePermitted = true;
      reason = `Spread ${spreadPoints.toFixed(1)} pts ($${spreadPrice.toFixed(symbolSpec.digits)}) is NORMAL (≤ ${thresholdsPoints.normalMax} pts)`;
    }
  } else if (classification === 'ELEVATED') {
    decision = 'ALLOW_STRONG_ONLY';
    requiresStrongConfirmation = true;
    if (!netRrPasses) {
      tradePermitted = false;
      reason = `ELEVATED spread (${spreadPoints.toFixed(1)} pts) rejected: Net R:R ${netRr?.toFixed(2)} < ${minNetRr.toFixed(2)} after costs`;
    } else if (params.proposedSide && !strongConfirmed) {
      tradePermitted = false;
      reason = `ELEVATED spread (${spreadPoints.toFixed(1)} pts): requires strong confirmation (${confirmationScore}/${sf.strongThreshold})`;
    } else {
      tradePermitted = true;
      reason = `ELEVATED spread (${spreadPoints.toFixed(1)} pts): allowed with strong confirmation & net R:R ${netRr !== null ? netRr.toFixed(2) : 'OK'}`;
    }
  } else if (classification === 'HIGH') {
    decision = 'ALLOW_ADMIN_HIGH';
    requiresStrongConfirmation = true;
    if (!params.allowHighSpreadTrades) {
      tradePermitted = false;
      reason = `HIGH spread (${spreadPoints.toFixed(1)} pts > elevated limit ${thresholdsPoints.elevatedMax} pts) blocked by Admin high-spread policy`;
    } else if (!netRrPasses) {
      tradePermitted = false;
      reason = `HIGH spread (${spreadPoints.toFixed(1)} pts) rejected: Net R:R ${netRr?.toFixed(2)} < ${minNetRr.toFixed(2)} after costs`;
    } else if (params.proposedSide && !highSpreadStrongConfirmed) {
      tradePermitted = false;
      reason = `HIGH spread (${spreadPoints.toFixed(1)} pts): requires top-tier confluence (${confirmationScore}/${Math.min(95, sf.strongThreshold + 10)})`;
    } else {
      tradePermitted = true;
      reason = `HIGH spread (${spreadPoints.toFixed(1)} pts): permitted under Admin high-spread policy with strong confluence`;
    }
  } else if (classification === 'EXCESSIVE') {
    decision = 'REJECT_EXCESSIVE';
    tradePermitted = false;
    reason = `EXCESSIVE spread (${spreadPoints.toFixed(1)} pts > max ${thresholdsPoints.highMax} pts) — new entries rejected`;
  } else {
    decision = 'PAUSE_ABNORMAL';
    tradePermitted = false;
    reason = `ABNORMAL spread spike (${spreadPoints.toFixed(1)} pts ≥ ${thresholdsPoints.abnormalMin} pts) — trading paused until spread normalizes`;
  }

  return {
    dataAvailable: true,
    quoteFresh: true,
    hasTwoSidedQuote: true,
    quoteAgeMs,
    quoteTimestamp: params.quoteTimestamp,
    quoteSource: params.quoteSource || 'XM TickerAll Feed',
    symbol: symbolSpec.symbol,
    digits: symbolSpec.digits,
    pointSize: symbolSpec.pointSize,
    bid,
    ask,
    spreadPrice,
    spreadPoints,
    classification,
    decision,
    tradePermitted,
    requiresStrongConfirmation,
    reason,
    configuredMaxSpreadPoints: maxSpreadPoints,
    sensitivity,
    allowHighSpreadTrades: params.allowHighSpreadTrades,
    acceptedAbove45Override: tradePermitted && spreadPoints > 45,
    proposedSide: params.proposedSide ?? null,
    stats1h,
    stats24h,
    costBreakdown,
    thresholdsPoints,
  };
}

export function getEffectiveSideEntryPrice(
  side: 'BUY' | 'SELL',
  bid: number | null,
  ask: number | null,
  fallbackPrice: number | null,
  digits = 2
): number | null {
  const raw = side === 'BUY' ? ask ?? fallbackPrice : bid ?? fallbackPrice;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  return roundToDigits(raw, digits);
}

export function getEffectiveSideClosingPrice(
  side: 'BUY' | 'SELL',
  bid: number | null,
  ask: number | null,
  fallbackPrice: number | null,
  digits = 2
): number | null {
  // MT5 BUY positions exit on Bid; SELL positions exit on Ask
  const raw = side === 'BUY' ? bid ?? fallbackPrice : ask ?? fallbackPrice;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  return roundToDigits(raw, digits);
}
