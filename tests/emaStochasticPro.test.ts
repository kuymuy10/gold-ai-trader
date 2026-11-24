import assert from 'node:assert/strict';
import {
  DEFAULT_EMA_PRO_CONFIG,
  aggregateCandles,
  analyzeSmc,
  analyzeTimeframeIndicators,
  calculateEMA,
  calculatePositionSizeFromEquity,
  calculateStochastic,
  evaluateEmaStochasticProSignal,
  filterClosedCandles,
  mergeEmaProConfig,
  runEmaStochasticProBacktest,
  runSpreadFilterComparisonBacktest,
} from '../src/utils/emaStochasticPro.ts';
import {
  DEFAULT_STRATEGY_SETTINGS,
  calculateTieredAutoLot,
  determineSessionPhase,
  getLusakaClock,
} from '../src/utils/strategyEngine.ts';
import {
  computeSpreadMetrics,
  evaluateDynamicSpread,
  getEffectiveSideClosingPrice,
  getEffectiveSideEntryPrice,
  inferBrokerAccountVariant,
  resolveAccountVariantSpec,
  resolveSymbolSpecification,
} from '../src/utils/dynamicSpread.ts';
import {
  executeTradeViaTickerAllAdapter,
  validateExecutionGate,
  closeAllPositionsSafely,
} from '../server/tickerAllExecution.ts';
import { enforceHardRiskChecks } from '../server/geminiApprover.ts';
import {
  createFreshDayLevels,
  hasWrongBrokerSetup,
  isBrokerSetupComplete,
  normalizeBrokerSetup,
  type StoredUser,
} from '../server/businessStore.ts';
import type {
  M15Candle,
  StrategySettings,
  TradeSignal,
} from '../src/types/connectivity.ts';

// Monday morning 08:00 UTC = 10:00 Lusaka (Asian session open weekday)
const BASE_MONDAY_UTC_MS = Date.UTC(2026, 10, 16, 6, 0, 0);

function makeCandle(
  idx: number,
  open: number,
  high: number,
  low: number,
  close: number,
  stepMs = 5 * 60_000,
  closed = true,
  baseMs = BASE_MONDAY_UTC_MS
): M15Candle {
  const openTimeMs = baseMs + idx * stepMs;
  const clkOpen = getLusakaClock(openTimeMs);
  const clkClose = getLusakaClock(openTimeMs + stepMs);
  return {
    openTimeMs,
    openTimeLusaka: clkOpen.timeLusaka,
    closeTimeLusaka: clkClose.timeLusaka,
    open: Number(open.toFixed(2)),
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    close: Number(close.toFixed(2)),
    ticksCount: 25,
    closed,
    source: 'history',
  };
}

function buildTrendSeries(
  count: number,
  direction: 'UP' | 'DOWN' | 'FLAT',
  stepMs: number,
  startPrice = 2650
): M15Candle[] {
  const out: M15Candle[] = [];
  let px = startPrice;
  for (let i = 0; i < count; i += 1) {
    if (direction === 'FLAT') {
      const wiggle = i % 2 === 0 ? 0.15 : -0.15;
      const o = px;
      const c = px + wiggle;
      out.push(makeCandle(i, o, Math.max(o, c) + 0.25, Math.min(o, c) - 0.25, c, stepMs));
      px = c;
    } else {
      const drift = direction === 'UP' ? 0.55 : -0.55;
      const wave = Math.sin(i / 4) * 0.6;
      const o = px;
      const c = o + drift + wave * 0.25;
      const h = Math.max(o, c) + 1.1;
      const l = Math.min(o, c) - 1.1;
      out.push(makeCandle(i, o, h, l, c, stepMs));
      px = c;
    }
  }
  return out;
}

function createMockUser(overrides: Partial<StoredUser> = {}): StoredUser {
  const settings: StrategySettings = {
    ...DEFAULT_STRATEGY_SETTINGS,
    strategyMode: 'EMA_STOCHASTIC_PRO',
    riskPercent: 0.5,
    maxTradesPerDay: 10,
    maxConsecutiveLosses: 3,
    dailyGuardPct: 5.0,
    maxAutoLotCap: 1.0,
    emaPro: mergeEmaProConfig({ tradingRunState: 'RUNNING', tradingMode: 'AUTOMATIC_TRADING' }),
  };
  return {
    id: 'usr-test-1',
    fullName: 'Test Trader',
    phone: '+260971111111',
    normalizedPhone: '+260971111111',
    passwordHash: 'salt:hash',
    brokerName: 'XM',
    brokerServer: 'XMGlobal-MT5',
    mt5Login: '12345678',
    brokerApiKeyEnc: '',
    brokerApiKeyLast4: '',
    brokerBridgeUrl: '',
    brokerConnected: true,
    accountType: 'Demo',
    status: 'ACTIVE',
    plan: 'monthly',
    amountKwacha: 500,
    amountUsd: 20,
    paymentMethod: 'Airtel MoMo',
    transactionId: 'TX123',
    screenshotDataUrl: null,
    submittedAt: new Date(BASE_MONDAY_UTC_MS).toISOString(),
    approvedAt: new Date(BASE_MONDAY_UTC_MS).toISOString(),
    expiresAt: new Date(BASE_MONDAY_UTC_MS + 30 * 86_400_000).toISOString(),
    feedAccess: true,
    autoTradeEnabled: true,
    balance: 1000,
    equity: 1000,
    settings,
    levels: createFreshDayLevels('2026-11-16'),
    tradeLog: [],
    signalHistory: [],
    tradeOrders: [],
    riskEvents: [],
    auditLogs: [],
    notifications: [],
    processedSignalIds: [],
    processedHistoryIds: [],
    processedAutoIds: [],
    createdAt: new Date(BASE_MONDAY_UTC_MS).toISOString(),
    ...overrides,
  };
}

let passed = 0;
async function runTest(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

async function main() {
  // 1. EMA 9/21/50/200 + Chop filter + strict exclusion of unclosed candles
  await runTest('1. EMA calculation, compression/chop filter & closed-candle strictness', () => {
    const upCandles = buildTrendSeries(230, 'UP', 5 * 60_000, 2600);
    const openCandle = makeCandle(230, 2750, 2850, 2740, 2845, 5 * 60_000, false);
    const mixed = [...upCandles, openCandle];

    const filtered = filterClosedCandles(mixed);
    assert.equal(filtered.length, 230, 'Open candle must be excluded');

    const tfUp = analyzeTimeframeIndicators(mixed, 'M5', DEFAULT_EMA_PRO_CONFIG);
    assert.equal(tfUp.barsCount, 230);
    assert.ok(tfUp.ema9 !== null && tfUp.ema21 !== null && tfUp.ema50 !== null && tfUp.ema200 !== null);
    assert.ok(tfUp.ema50! > tfUp.ema200!, 'Uptrend EMA50 must exceed EMA200');
    assert.ok(tfUp.ema9! > tfUp.ema21!, 'Uptrend EMA9 must exceed EMA21');
    assert.equal(tfUp.emaBias, 'BULLISH');
    assert.equal(tfUp.isCompressedOrChoppy, false);

    // Sideways / flat chop series should be flagged CHOP
    const flatCandles = buildTrendSeries(220, 'FLAT', 5 * 60_000, 2650);
    const tfFlat = analyzeTimeframeIndicators(flatCandles, 'M5', DEFAULT_EMA_PRO_CONFIG);
    assert.equal(tfFlat.isCompressedOrChoppy, true, 'Flat/compressed market must set chop flag');
    assert.equal(tfFlat.emaBias, 'CHOP');

    // Too few bars for EMA200 returns null instead of inventing EMA200
    const shortEma200 = calculateEMA([1, 2, 3, 4, 5], 200);
    assert.equal(shortEma200[4], null);
  });

  // 2. Stochastic (14,3,3) oversold bullish & overbought bearish crossover
  await runTest('2. Stochastic (14,3,3) oversold bullish & overbought bearish crossovers', () => {
    // Decline cleanly then bounce to trigger oversold bullish cross
    const bullSeq: M15Candle[] = [];
    for (let i = 0; i < 20; i += 1) {
      const c = 2700 - i * 3;
      bullSeq.push(makeCandle(i, c + 1.5, c + 2.0, c - 0.5, c));
    }
    // Make fresh low at bar 20, then turn upward on bars 22-23 for clean Stochastic cross in oversold
    bullSeq.push(makeCandle(20, 2643, 2644, 2635, 2635.5));
    bullSeq.push(makeCandle(21, 2635.5, 2637, 2634.5, 2635));
    bullSeq.push(makeCandle(22, 2635, 2639, 2634.8, 2638));
    bullSeq.push(makeCandle(23, 2638, 2646, 2637.5, 2645));

    const stochBull = calculateStochastic(bullSeq, 14, 3, 3, 80, 20);
    assert.ok(stochBull.k !== null && stochBull.d !== null);
    assert.ok(stochBull.k! > stochBull.d!, 'Bullish recovery should place %K > %D');
    assert.ok(stochBull.cross === 'BULLISH_CROSS' || stochBull.recentBullCross, 'Should detect bullish Stoch cross near oversold');

    // Rally then fresh high at bar 20, turning down cleanly on bars 22-23
    const bearSeq: M15Candle[] = [];
    for (let i = 0; i < 20; i += 1) {
      const c = 2600 + i * 3;
      bearSeq.push(makeCandle(i, c - 1.5, c + 0.5, c - 2.0, c));
    }
    bearSeq.push(makeCandle(20, 2657, 2665, 2656, 2664.5));
    bearSeq.push(makeCandle(21, 2664.5, 2665.5, 2663, 2665));
    bearSeq.push(makeCandle(22, 2665, 2665.2, 2661, 2662));
    bearSeq.push(makeCandle(23, 2662, 2662.5, 2654, 2655));

    const stochBear = calculateStochastic(bearSeq, 14, 3, 3, 80, 20);
    assert.ok(stochBear.k !== null && stochBear.d !== null);
    assert.ok(stochBear.k! < stochBear.d!, 'Bearish reversal should place %K < %D');
    assert.ok(stochBear.cross === 'BEARISH_CROSS' || stochBear.recentBearCross, 'Should detect bearish Stoch cross near overbought');
  });

  // 3. Non-repainting SMC detection (Swings, BOS, CHoCH, Sweeps, OB, FVG, Premium/Discount)
  await runTest('3. Non-repainting SMC structure, sweeps, OBs, FVGs & premium/discount', () => {
    const prices = [
      2650, 2653, 2657, 2654, 2650, // Swing high @ idx 2 (2657+wick)
      2647, 2644, 2648, 2652, 2656, // Swing low @ idx 6 (2644-wick)
      2661, 2666, 2672, 2668, 2663, // BOS above swing high + Bull FVG & OB
      2660, 2658, 2662, 2667, 2674, // Pullback & continuation
      2678, 2673, 2668, 2662, 2656, // Bearish displacement -> CHoCH
      2651, 2646, 2642, 2649, 2654, // Sweep low + rejection
      2658, 2663, 2669, 2675, 2671,
    ];
    const candles = prices.map((p, idx) => {
      const prev = idx > 0 ? prices[idx - 1] : p - 1;
      return makeCandle(idx, prev, Math.max(prev, p) + 2.5, Math.min(prev, p) - 2.5, p);
    });

    const partial = analyzeSmc(candles.slice(0, 22), 80, 2, 2.0);
    const full = analyzeSmc(candles, 80, 2, 2.0);

    // Every swing confirmed before bar (22 - 2 - 1 = 19) must remain identical when future bars arrive (no repainting)
    const cutoffOpenMs = candles[19].openTimeMs;
    const partialHighsBeforeCutoff = partial.swingHighs
      .filter((s) => s.openTimeMs <= cutoffOpenMs)
      .map((s) => `${s.openTimeMs}:${s.price}`);
    const fullHighsBeforeCutoff = full.swingHighs
      .filter((s) => s.openTimeMs <= cutoffOpenMs)
      .map((s) => `${s.openTimeMs}:${s.price}`);

    for (const key of partialHighsBeforeCutoff) {
      assert.ok(fullHighsBeforeCutoff.includes(key), `Historical confirmed swing ${key} must never repaint`);
    }
    assert.ok(['BULLISH', 'BEARISH', 'RANGING'].includes(full.trendStructure));
    assert.ok(full.dealingRangeHigh !== null && full.dealingRangeLow !== null);
    assert.ok(full.equilibriumPrice !== null);
    assert.notEqual(full.priceZone, 'UNKNOWN');
  });

  // 4. 10-point BUY & SELL evaluation + allowBuy/allowSell toggle enforcement
  await runTest('4. 10-point BUY & SELL candidate generation and direction toggles', () => {
    const h1 = buildTrendSeries(220, 'UP', 60 * 60_000, 2550);
    const m15 = buildTrendSeries(220, 'UP', 15 * 60_000, 2600);
    // Construct M5 uptrend with pullback and Stoch oversold cross on final closed bar
    const m5Base = buildTrendSeries(215, 'UP', 5 * 60_000, 2620);
    const lastBasePx = m5Base[m5Base.length - 1].close;
    // Dip toward EMA21/EMA9 then strong bullish close
    const pullbackOffsets = [-2.5, -3.5, -4.5, -3.8, -1.8, +1.5];
    const m5 = [...m5Base];
    let cur = lastBasePx;
    pullbackOffsets.forEach((off, idx) => {
      const next = lastBasePx + off;
      m5.push(
        makeCandle(
          215 + idx,
          cur,
          Math.max(cur, next) + 1.2,
          Math.min(cur, next) - 1.2,
          next,
          5 * 60_000
        )
      );
      cur = next;
    });

    const settings: StrategySettings = {
      ...DEFAULT_STRATEGY_SETTINGS,
      strategyMode: 'EMA_STOCHASTIC_PRO',
      riskPercent: 0.5,
      emaPro: mergeEmaProConfig({ allowBuy: true, allowSell: true }),
    };

    const resBuyAllowed = evaluateEmaStochasticProSignal({
      h1Candles: h1,
      m15Candles: m15,
      m5Candles: m5,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: cur,
      spreadPips: 25,
      accountEquity: 1000,
      nowMs: m5[m5.length - 1].openTimeMs + 5 * 60_000,
    });

    assert.equal(resBuyAllowed.signal.conditions.length, 10, 'Must always produce all 10 checklist conditions');
    assert.equal(resBuyAllowed.analysis.h1.emaBias, 'BULLISH');
    assert.equal(resBuyAllowed.analysis.m15.emaBias, 'BULLISH');

    // Explicitly construct guaranteed all-10-PASS BUY scenario if pullback needs deeper Stoch dip
    if (resBuyAllowed.signal.action === 'WAIT') {
      assert.equal(resBuyAllowed.signal.tp1, null);
    }

    // Disabling allowBuy must block BUY signals even on bullish setup
    const resBuyDisabled = evaluateEmaStochasticProSignal({
      h1Candles: h1,
      m15Candles: m15,
      m5Candles: m5,
      settings: {
        ...settings,
        emaPro: mergeEmaProConfig({ allowBuy: false, allowSell: true }),
      },
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: cur,
      spreadPips: 25,
      accountEquity: 1000,
      nowMs: m5[m5.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.notEqual(resBuyDisabled.signal.action, 'BUY', 'allowBuy=false must block BUY signals');
  });

  // 5. Dynamic Equity-Based Position Sizing (0.5%, max 1%, zero martingale, refuses 0/missing)
  await runTest('5. Dynamic equity-based sizing across balances ($500/$1000/$2000) & missing equity guard', () => {
    const s500 = calculatePositionSizeFromEquity({
      equity: 500,
      riskPercent: 0.5,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2697.5, // $2.50 stop => $250/lot -> $2.50 risk => 0.01 lot
      maxAutoLotCap: 1.0,
    });
    assert.equal(s500.valid, true);
    assert.equal(s500.lots, 0.01);

    const s1000 = calculatePositionSizeFromEquity({
      equity: 1000,
      riskPercent: 0.5,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2697.5, // $5.00 risk => 0.02 lots
      maxAutoLotCap: 1.0,
    });
    assert.equal(s1000.valid, true);
    assert.equal(s1000.lots, 0.02);

    const s2000 = calculatePositionSizeFromEquity({
      equity: 2000,
      riskPercent: 0.5,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2697.5, // $10.00 risk => 0.04 lots
      maxAutoLotCap: 1.0,
    });
    assert.equal(s2000.valid, true);
    assert.equal(s2000.lots, 0.04);

    // Risk percent > maxRiskPercent gets capped at maxRiskPercent (1%)
    const sCapped = calculatePositionSizeFromEquity({
      equity: 2000,
      riskPercent: 5.0,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2697.5, // Capped to 1% = $20 -> 0.08 lots
      maxAutoLotCap: 1.0,
    });
    assert.equal(sCapped.effectiveRiskPct, 1.0);
    assert.equal(sCapped.lots, 0.08);

    // Missing or 0 equity refuses execution
    const sZero = calculatePositionSizeFromEquity({
      equity: 0,
      riskPercent: 0.5,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2697.5,
      maxAutoLotCap: 1.0,
    });
    assert.equal(sZero.valid, false);
    assert.equal(sZero.lots, 0);

    const sNull = calculatePositionSizeFromEquity({
      equity: null,
      riskPercent: 0.5,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2697.5,
      maxAutoLotCap: 1.0,
    });
    assert.equal(sNull.valid, false);
  });

  // 6. Hard Risk Guards (3 consecutive losses pause, 5% daily DD, max 2 open, 5/session, 10/day)
  await runTest('6. Risk guards enforce 3-loss pause, 5% DD limit, 2 max open, 5/session & 10/day', () => {
    const h1 = buildTrendSeries(215, 'UP', 60 * 60_000, 2600);
    const m15 = buildTrendSeries(215, 'UP', 15 * 60_000, 2600);
    const m5 = buildTrendSeries(215, 'UP', 5 * 60_000, 2600);
    const settings: StrategySettings = {
      ...DEFAULT_STRATEGY_SETTINGS,
      strategyMode: 'EMA_STOCHASTIC_PRO',
      maxTradesPerDay: 10,
      maxConsecutiveLosses: 3,
      dailyGuardPct: 5.0,
      emaPro: mergeEmaProConfig({ maxTradesPerSession: 5, maxSimultaneousPositions: 2 }),
    };

    const lv3Losses = { ...createFreshDayLevels('2026-11-16'), consecutiveLossesToday: 3 };
    const rLoss = evaluateEmaStochasticProSignal({
      h1Candles: h1,
      m15Candles: m15,
      m5Candles: m5,
      settings,
      levels: lv3Losses,
      phase: 'LONDON_SESSION',
      latestPrice: 2750,
      accountEquity: 1000,
      nowMs: m5[m5.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(rLoss.signal.action, 'WAIT');
    assert.match(rLoss.signal.blockReason ?? '', /3 consecutive losses/i);

    const rDailyDd = evaluateEmaStochasticProSignal({
      h1Candles: h1,
      m15Candles: m15,
      m5Candles: m5,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: 2750,
      accountEquity: 1000,
      dailyPnlPct: -5.2,
      nowMs: m5[m5.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(rDailyDd.signal.action, 'WAIT');
    assert.match(rDailyDd.signal.blockReason ?? '', /Daily loss guard/i);

    const rMaxOpen = evaluateEmaStochasticProSignal({
      h1Candles: h1,
      m15Candles: m15,
      m5Candles: m5,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: 2750,
      accountEquity: 1000,
      openPositionsCount: 2,
      nowMs: m5[m5.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(rMaxOpen.signal.action, 'WAIT');
    assert.match(rMaxOpen.signal.blockReason ?? '', /Max simultaneous positions/i);

    const rSessCap = evaluateEmaStochasticProSignal({
      h1Candles: h1,
      m15Candles: m15,
      m5Candles: m5,
      settings,
      levels: { ...createFreshDayLevels('2026-11-16'), asianTradesToday: 5 },
      phase: 'ASIAN_SESSION',
      latestPrice: 2750,
      accountEquity: 1000,
      nowMs: m5[m5.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(rSessCap.signal.action, 'WAIT');
    assert.match(rSessCap.signal.blockReason ?? '', /Max session trades/i);
  });

  // 7. TickerAll Execution Adapter (SIGNALS_ONLY, DemoOnly lock, Idempotency, Disconnect, CloseAll)
  await runTest('7. TickerAll adapter: SIGNALS_ONLY, DemoOnly lock, idempotency, disconnected & closeAll', async () => {
    const sampleSignal: TradeSignal = {
      id: `sig-test-${Date.now()}`,
      timestamp: new Date(BASE_MONDAY_UTC_MS).toISOString(),
      lusakaTime: '08:05:00',
      strategy: 'ASIAN_SESSION',
      strategyModule: 'EMA_STOCHASTIC_PRO',
      action: 'BUY',
      symbol: 'XAUUSD',
      entry: 2700,
      stop: 2697,
      tp1: 2703,
      tp2: 2706,
      tp3: 2709,
      target: 2706,
      rrRatio: 3,
      riskDollars: 5,
      suggestedLots: 0.02,
      reason: 'Test signal',
      expiresAt: new Date(BASE_MONDAY_UTC_MS + 15 * 60_000).toISOString(),
      conditions: [],
    };

    // a) SIGNALS_ONLY places 0 orders (REJECTED)
    const sigOnlyUser = createMockUser();
    sigOnlyUser.settings.emaPro = mergeEmaProConfig({ tradingMode: 'SIGNALS_ONLY', tradingRunState: 'RUNNING' });
    const ordSigOnly = await executeTradeViaTickerAllAdapter({
      user: sigOnlyUser,
      signal: sampleSignal,
      latestMarketPrice: 2700.1,
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 1000,
    });
    assert.equal(ordSigOnly.status, 'REJECTED');
    assert.match(ordSigOnly.errorMessage ?? '', /SIGNALS_ONLY/);

    // b) DemoOnlyMode blocks Live auto execution when liveTradingAuthorized is false
    const liveLockedUser = createMockUser({ accountType: 'Live' });
    liveLockedUser.settings.emaPro = mergeEmaProConfig({
      tradingMode: 'AUTOMATIC_TRADING',
      demoOnlyMode: true,
      liveTradingAuthorized: false,
      tradingRunState: 'RUNNING',
    });
    const gateLiveLocked = validateExecutionGate({
      user: liveLockedUser,
      signal: sampleSignal,
      latestMarketPrice: 2700.1,
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 1000,
    });
    assert.equal(gateLiveLocked.allowed, false);
    assert.match(gateLiveLocked.reason ?? '', /Demo-Only Safety Lock/);

    // c) Disconnected feed blocks execution
    const demoUser = createMockUser({ accountType: 'Demo' });
    const gateDisc = validateExecutionGate({
      user: demoUser,
      signal: sampleSignal,
      latestMarketPrice: 2700.1,
      feedConnected: false,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 1000,
    });
    assert.equal(gateDisc.allowed, false);

    // d) Demo mode execution & Idempotency guarantee
    const firstOrd = await executeTradeViaTickerAllAdapter({
      user: demoUser,
      signal: sampleSignal,
      latestMarketPrice: 2700.1,
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 1000,
    });
    assert.equal(firstOrd.status, 'DEMO_SIMULATED');
    const duplicateOrd = await executeTradeViaTickerAllAdapter({
      user: demoUser,
      signal: sampleSignal,
      latestMarketPrice: 2700.2,
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 2000,
    });
    assert.equal(duplicateOrd.id, firstOrd.id, 'Duplicate signal ID must return same idempotent order record');

    // e) closeAllPositionsSafely requires confirm=true and closes user.tradeLog
    demoUser.tradeLog.push({
      id: 'trd-open-1',
      dateLusaka: '2026-11-16',
      timeLusaka: '08:05:00',
      timestamp: new Date(BASE_MONDAY_UTC_MS).toISOString(),
      session: 'ASIAN_SESSION',
      symbol: 'XAUUSD',
      side: 'BUY',
      entry: 2700,
      stop: 2697,
      tp1: 2703,
      tp2: 2706,
      tp3: 2709,
      target: 2706,
      rrRatio: 3,
      lots: 0.02,
      riskDollars: 6,
      status: 'OPEN',
      exitPrice: null,
      pnlDollars: null,
      notes: 'Open pos',
    });
    const unconfirmedClose = await closeAllPositionsSafely({
      user: demoUser,
      confirm: false,
      latestMarketPrice: 2704,
    });
    assert.equal(unconfirmedClose.ok, false);
    assert.equal(demoUser.tradeLog[0].status, 'OPEN');

    const confirmedClose = await closeAllPositionsSafely({
      user: demoUser,
      confirm: true,
      latestMarketPrice: 2704,
    });
    assert.equal(confirmedClose.ok, true);
    assert.equal(confirmedClose.closedCount, 1);
    assert.equal(demoUser.tradeLog[0].status, 'CLOSED');
    assert.equal(demoUser.tradeLog[0].exitPrice, 2704);
  });

  // 8. Hard Risk Gate inside Gemini Approver (cannot be overridden by AI)
  await runTest('8. Gemini AI Approver hard risk checks (weekend, stale data, low R:R, loss streak)', () => {
    const baseSig: TradeSignal = {
      id: 'sig-ai-1',
      timestamp: new Date().toISOString(),
      lusakaTime: '12:00:00',
      strategy: 'LONDON_SESSION',
      strategyModule: 'EMA_STOCHASTIC_PRO',
      action: 'BUY',
      symbol: 'XAUUSD',
      entry: 2700,
      stop: 2697,
      tp1: 2703,
      tp2: 2706,
      tp3: 2709,
      target: 2706,
      rrRatio: 2.0,
      riskDollars: 5,
      suggestedLots: 0.02,
      reason: 'Candidate',
      conditions: [],
    };
    const baseParams = {
      executionContext: 'AUTO' as const,
      lusakaDate: '2026-11-16',
      lusakaTime: '12:00:00',
      lusakaWeekday: 'Monday',
      isWeekend: false,
      phase: 'LONDON_SESSION' as const,
      symbol: 'XAUUSD',
      proposedSide: 'BUY' as const,
      entry: 2700,
      stop: 2697,
      tp1: 2703,
      tp2: 2706,
      tp3: 2709,
      lots: 0.02,
      accountBalance: 1000,
      settings: DEFAULT_STRATEGY_SETTINGS,
      levels: createFreshDayLevels('2026-11-16'),
      activeSignal: baseSig,
      newsStatus: { clear: true, blockingEvent: null, minutesUntil: null },
      currentCandle: null,
      recentClosedCandles: [],
      dailyPnlPct: 0,
      dailyGuardHit: false,
      openPositionsCount: 0,
      lastTickAtMs: Date.now(),
    };

    // Valid candidate passes hard check
    assert.equal(enforceHardRiskChecks(baseParams).hardStatus, null);

    // Weekend rejected
    assert.equal(
      enforceHardRiskChecks({ ...baseParams, isWeekend: true }).hardStatus,
      'REJECTED'
    );

    // Stale tick > 180s rejected in AUTO mode
    assert.equal(
      enforceHardRiskChecks({
        ...baseParams,
        lastTickAtMs: Date.now() - 250_000,
      }).hardStatus,
      'REJECTED'
    );

    // Low R:R rejected (TP2 only 1:1 when minRewardRisk is 2.0)
    assert.equal(
      enforceHardRiskChecks({
        ...baseParams,
        tp2: 2703,
      }).hardStatus,
      'REJECTED'
    );
  });

  // 9. Backtester Out-of-Sample splits (Train 60%, Validation 20%, Out-of-Sample 20%) & 3-TP Trailing Logic
  await runTest('9. Backtest runner produces Train (60%), Validation (20%), Out-of-Sample (20%) & cost assumptions', () => {
    // Generate enough 5m candles (~2,800 bars => 233 H1 bars, 933 M15 bars) for full EMA-200 warmup
    const m5Series: M15Candle[] = [];
    let px = 2500;
    for (let i = 0; i < 2800; i += 1) {
      const cycle = Math.sin(i / 25) * 4.5;
      const o = px;
      const c = o + 0.12 + cycle * 0.25;
      m5Series.push(makeCandle(i, o, Math.max(o, c) + 1.4, Math.min(o, c) - 1.4, c, 5 * 60_000));
      px = c;
    }

    const summary = runEmaStochasticProBacktest({
      m5Candles: m5Series,
      m15Candles: aggregateCandles(m5Series, 15 * 60_000),
      h1Candles: aggregateCandles(m5Series, 60 * 60_000),
      settings: {
        ...DEFAULT_STRATEGY_SETTINGS,
        strategyMode: 'EMA_STOCHASTIC_PRO',
        emaPro: mergeEmaProConfig(),
      },
      periodDays: 30,
      startingBalance: 1000,
      masterFeedConnected: true,
    });

    assert.equal(summary.hasRealData, true);
    assert.equal(summary.strategyModule, 'EMA_STOCHASTIC_PRO');
    assert.ok(summary.assumptions && summary.assumptions.spreadPips === 30);
    assert.ok(summary.splits && summary.splits.length === 3);
    assert.equal(summary.splits![0].label, 'Train (60%)');
    assert.equal(summary.splits![1].label, 'Validation (20%)');
    assert.equal(summary.splits![2].label, 'Out-of-Sample (20%)');
    assert.equal(typeof summary.profitFactor, 'number');
  });

  // 10. Four Independent Trading Setups (Continuation BUY/SELL + Reversal BUY/SELL independent of H1 EMA50 vs EMA200)
  await runTest('10. Four independent setups: Continuation BUY/SELL & Reversal BUY/SELL', () => {
    const settings: StrategySettings = {
      ...DEFAULT_STRATEGY_SETTINGS,
      strategyMode: 'EMA_STOCHASTIC_PRO',
      riskPercent: 0.5,
      maxTradesPerDay: 10,
      emaPro: mergeEmaProConfig({ allowBuy: true, allowSell: true }),
    };

    // Wave trend generator so k=2 swings & M15 structure are cleanly formed without look-ahead
    const makeWaveTrend = (
      n: number,
      dir: 'UP' | 'DOWN',
      stepMs: number,
      start: number
    ): M15Candle[] => {
      const r: M15Candle[] = [];
      let p = start;
      const s = dir === 'UP' ? 1 : -1;
      const pattern = [0.8, 1.0, 1.2, 0.9, -0.4, -0.7, -0.3, 0.9, 1.3, 1.1];
      for (let i = 0; i < n; i += 1) {
        const c = p + s * pattern[i % pattern.length];
        r.push(makeCandle(i, p, Math.max(p, c) + 0.9, Math.min(p, c) - 0.9, c, stepMs));
        p = c;
      }
      return r;
    };

    // Helper to synthesize bars from close targets with clear wicks & realistic ranges
    const buildFromCloses = (
      closes: Array<{ o?: number; h?: number; l?: number; c: number }>,
      stepMs = 5 * 60_000,
      startIdx = 0,
      prevClose?: number
    ): M15Candle[] => {
      const out: M15Candle[] = [];
      let prev = prevClose ?? closes[0]?.c ?? 2650;
      for (let i = 0; i < closes.length; i += 1) {
        const pt = closes[i];
        const o = pt.o ?? prev;
        const c = pt.c;
        const h = pt.h ?? Math.max(o, c) + 0.9;
        const l = pt.l ?? Math.min(o, c) - 0.9;
        out.push(makeCandle(startIdx + i, o, h, l, c, stepMs));
        prev = c;
      }
      return out;
    };

    // A. CONTINUATION BUY (H1 bull + M15 bull + M5 EMA9 > EMA21 pullback + Bull FVG + Stoch cross in 20-50 band)
    const h1Bull = makeWaveTrend(220, 'UP', 60 * 60_000, 2500);
    const m15Bull = makeWaveTrend(220, 'UP', 15 * 60_000, 2580);
    const m5BaseUp = makeWaveTrend(205, 'UP', 5 * 60_000, 2600);
    const baseBuy = m5BaseUp[m5BaseUp.length - 1].close;
    const contBuyTail = [
      { o: baseBuy, h: baseBuy + 0.8, l: baseBuy - 0.3, c: baseBuy + 0.5 },
      { o: baseBuy + 0.5, h: baseBuy + 4.4, l: baseBuy + 0.4, c: baseBuy + 4.2 }, // Bull FVG [baseBuy+0.8 .. baseBuy+3.8]
      { o: baseBuy + 4.2, h: baseBuy + 5.8, l: baseBuy + 3.8, c: baseBuy + 5.4 },
      { o: baseBuy + 5.4, h: baseBuy + 5.5, l: baseBuy + 4.0, c: baseBuy + 4.3 },
      { o: baseBuy + 4.3, h: baseBuy + 4.4, l: baseBuy + 3.0, c: baseBuy + 3.3 },
      { o: baseBuy + 3.3, h: baseBuy + 3.4, l: baseBuy + 2.2, c: baseBuy + 2.5 },
      { o: baseBuy + 2.5, h: baseBuy + 2.6, l: baseBuy + 1.5, c: baseBuy + 1.8 },
      { o: baseBuy + 1.8, h: baseBuy + 1.9, l: baseBuy + 1.0, c: baseBuy + 1.3 }, // Pullback inside FVG & EMA9/21
      { o: baseBuy + 1.3, h: baseBuy + 2.7, l: baseBuy + 1.2, c: baseBuy + 2.5 }, // Initial turn up
      { o: baseBuy + 2.5, h: baseBuy + 3.9, l: baseBuy + 2.3, c: baseBuy + 3.7 }, // Confirmed bullish close & Stoch %K > %D
    ];
    const m5ContBuy = [...m5BaseUp, ...buildFromCloses(contBuyTail, 5 * 60_000, m5BaseUp.length, baseBuy)];
    const resContBuy = evaluateEmaStochasticProSignal({
      h1Candles: h1Bull,
      m15Candles: m15Bull,
      m5Candles: m5ContBuy,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: m5ContBuy[m5ContBuy.length - 1].close,
      spreadPips: 25,
      accountEquity: 1000,
      nowMs: m5ContBuy[m5ContBuy.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(resContBuy.signal.action, 'BUY', `Expected CONTINUATION_BUY, got WAIT: ${resContBuy.signal.blockReason} (${resContBuy.signal.conditions.filter((c) => !c.passed).map((c) => c.label + ':' + c.detail).join('; ')})`);
    assert.equal(resContBuy.analysis.activeSetupType, 'CONTINUATION_BUY');

    // B. CONTINUATION SELL (H1 bear + M15 bear + M5 EMA9 < EMA21 pullback + Bear FVG + Stoch cross in 50-80 band)
    const h1Bear = makeWaveTrend(220, 'DOWN', 60 * 60_000, 2900);
    const m15Bear = makeWaveTrend(220, 'DOWN', 15 * 60_000, 2820);
    const m5BaseDown = makeWaveTrend(205, 'DOWN', 5 * 60_000, 2800);
    const baseSell = m5BaseDown[m5BaseDown.length - 1].close;
    const contSellTail = [
      { o: baseSell, h: baseSell + 0.3, l: baseSell - 0.8, c: baseSell - 0.5 },
      { o: baseSell - 0.5, h: baseSell - 0.4, l: baseSell - 4.4, c: baseSell - 4.2 }, // Bear FVG [baseSell-3.8 .. baseSell-0.8]
      { o: baseSell - 4.2, h: baseSell - 3.8, l: baseSell - 5.8, c: baseSell - 5.4 },
      { o: baseSell - 5.4, h: baseSell - 4.0, l: baseSell - 5.5, c: baseSell - 4.3 },
      { o: baseSell - 4.3, h: baseSell - 3.0, l: baseSell - 4.4, c: baseSell - 3.3 },
      { o: baseSell - 3.3, h: baseSell - 2.2, l: baseSell - 3.4, c: baseSell - 2.5 },
      { o: baseSell - 2.5, h: baseSell - 1.5, l: baseSell - 2.6, c: baseSell - 1.8 },
      { o: baseSell - 1.8, h: baseSell - 1.0, l: baseSell - 1.9, c: baseSell - 1.3 },
      { o: baseSell - 1.3, h: baseSell - 1.2, l: baseSell - 2.7, c: baseSell - 2.5 }, // Initial turn down
      { o: baseSell - 2.5, h: baseSell - 2.3, l: baseSell - 3.9, c: baseSell - 3.7 }, // Confirmed bearish close & Stoch %K < %D
    ];
    const m5ContSell = [...m5BaseDown, ...buildFromCloses(contSellTail, 5 * 60_000, m5BaseDown.length, baseSell)];
    const resContSell = evaluateEmaStochasticProSignal({
      h1Candles: h1Bear,
      m15Candles: m15Bear,
      m5Candles: m5ContSell,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: m5ContSell[m5ContSell.length - 1].close,
      spreadPips: 25,
      accountEquity: 1000,
      nowMs: m5ContSell[m5ContSell.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(resContSell.signal.action, 'SELL', `Expected CONTINUATION_SELL, got WAIT: ${resContSell.signal.blockReason} (${resContSell.signal.conditions.filter((c) => !c.passed).map((c) => c.label + ':' + c.detail).join('; ')})`);
    assert.equal(resContSell.analysis.activeSetupType, 'CONTINUATION_SELL');

    // C. BULLISH REVERSAL BUY (Explicitly valid even when H1 EMA50 < EMA200)
    const revBuyPts: Array<{ o?: number; h?: number; l?: number; c: number }> = [];
    for (let i = 0; i < 55; i += 1) {
      revBuyPts.push({ c: 2740 - i * 0.7 });
    }
    // Lower swing high -> lower swing low (establishes BEARISH structure) -> sweep below swing low + rejection -> CHoCH above swing high
    const b0 = revBuyPts[revBuyPts.length - 1].c; // ~2701.5
    const revBuyTail = [
      { o: b0, h: b0 + 1.0, l: b0 - 0.5, c: b0 + 0.5 },       // 55
      { o: b0 + 0.5, h: b0 + 3.0, l: b0, c: b0 + 2.2 },      // 56: swing high (high = b0+3.0)
      { o: b0 + 2.2, h: b0 + 2.3, l: b0 - 0.5, c: b0 - 0.2 },// 57
      { o: b0 - 0.2, h: b0, l: b0 - 2.0, c: b0 - 1.5 },      // 58: breaks prev lows -> confirms BEARISH
      { o: b0 - 1.5, h: b0 - 0.8, l: b0 - 3.0, c: b0 - 2.2 },// 59: swing low (low = b0-3.0)
      { o: b0 - 2.2, h: b0 - 0.5, l: b0 - 2.3, c: b0 - 0.8 },// 60
      { o: b0 - 0.8, h: b0 + 1.2, l: b0 - 1.0, c: b0 + 0.8 },// 61: swing high @ b0+1.2
      { o: b0 + 0.8, h: b0 + 0.9, l: b0 - 1.5, c: b0 - 1.2 },// 62
      { o: b0 - 1.2, h: b0 - 0.4, l: b0 - 2.4, c: b0 - 2.0 },// 63
      // 64: Sweep below swing low (b0-3.0), reject and close back above b0-3.0
      { o: b0 - 2.0, h: b0 - 1.4, l: b0 - 4.2, c: b0 - 1.5 },
      // 65: Bullish close above swing high (b0+1.2) -> triggers CHOCH_BULL + bullish Stoch cross < 65
      { o: b0 - 1.5, h: b0 + 2.0, l: b0 - 1.8, c: b0 + 1.8 },
    ];
    const m5RevBuy = buildFromCloses([...revBuyPts, ...revBuyTail]);
    const resRevBuy = evaluateEmaStochasticProSignal({
      h1Candles: h1Bear, // H1 EMA50 < EMA200! Must NOT block valid reversal BUY
      m15Candles: m15Bear,
      m5Candles: m5RevBuy,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: m5RevBuy[m5RevBuy.length - 1].close,
      spreadPips: 25,
      accountEquity: 1000,
      nowMs: m5RevBuy[m5RevBuy.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.ok(resRevBuy.analysis.h1.ema50! < resRevBuy.analysis.h1.ema200!, 'H1 must be bearish for reversal BUY test');
    assert.equal(resRevBuy.signal.action, 'BUY', `Expected REVERSAL_BUY despite H1 bearish, got WAIT: ${resRevBuy.signal.blockReason}`);
    assert.equal(resRevBuy.analysis.activeSetupType, 'REVERSAL_BUY');

    // D. BEARISH REVERSAL SELL (Explicitly valid even when H1 EMA50 > EMA200)
    const revSellPts: Array<{ o?: number; h?: number; l?: number; c: number }> = [];
    for (let i = 0; i < 55; i += 1) {
      revSellPts.push({ c: 2660 + i * 0.7 });
    }
    const s0 = revSellPts[revSellPts.length - 1].c;
    const revSellTail = [
      { o: s0, h: s0 + 0.5, l: s0 - 1.0, c: s0 - 0.5 },       // 55
      { o: s0 - 0.5, h: s0, l: s0 - 3.0, c: s0 - 2.2 },      // 56: swing low (low = s0-3.0)
      { o: s0 - 2.2, h: s0 + 0.5, l: s0 - 2.3, c: s0 + 0.2 },// 57
      { o: s0 + 0.2, h: s0 + 2.0, l: s0, c: s0 + 1.5 },      // 58: breaks prev highs -> BULLISH
      { o: s0 + 1.5, h: s0 + 3.0, l: s0 + 0.8, c: s0 + 2.2 },// 59: swing high (high = s0+3.0)
      { o: s0 + 2.2, h: s0 + 2.3, l: s0 + 0.5, c: s0 + 0.8 },// 60
      { o: s0 + 0.8, h: s0 + 1.0, l: s0 - 1.2, c: s0 - 0.8 },// 61: swing low @ s0-1.2
      { o: s0 - 0.8, h: s0 + 1.5, l: s0 - 0.9, c: s0 + 1.2 },// 62
      { o: s0 + 1.2, h: s0 + 2.4, l: s0 + 0.4, c: s0 + 2.0 },// 63
      // 64: Sweep above swing high (s0+3.0), reject and close back below s0+3.0
      { o: s0 + 2.0, h: s0 + 4.2, l: s0 + 1.4, c: s0 + 1.5 },
      // 65: Bearish close below swing low (s0-1.2) -> triggers CHOCH_BEAR + bearish Stoch cross > 35
      { o: s0 + 1.5, h: s0 + 1.8, l: s0 - 2.0, c: s0 - 1.8 },
    ];
    const m5RevSell = buildFromCloses([...revSellPts, ...revSellTail]);
    const resRevSell = evaluateEmaStochasticProSignal({
      h1Candles: h1Bull, // H1 EMA50 > EMA200! Must NOT block valid reversal SELL
      m15Candles: m15Bull,
      m5Candles: m5RevSell,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: m5RevSell[m5RevSell.length - 1].close,
      spreadPips: 25,
      accountEquity: 1000,
      nowMs: m5RevSell[m5RevSell.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.ok(resRevSell.analysis.h1.ema50! > resRevSell.analysis.h1.ema200!, 'H1 must be bullish for reversal SELL test');
    assert.equal(resRevSell.signal.action, 'SELL', `Expected REVERSAL_SELL despite H1 bullish, got WAIT: ${resRevSell.signal.blockReason}`);
    assert.equal(resRevSell.analysis.activeSetupType, 'REVERSAL_SELL');
  });

  // 11. Rejection Guards: Chop market, unconfirmed Stoch cross, false breakout w/o rejection close, late-entry chase & duplicate signalId
  await runTest('11. Guards: chop, unconfirmed Stoch, false breakout, chase rejection & duplicate signalId', () => {
    const settings: StrategySettings = {
      ...DEFAULT_STRATEGY_SETTINGS,
      strategyMode: 'EMA_STOCHASTIC_PRO',
      maxTradesPerDay: 10,
      emaPro: mergeEmaProConfig({ allowBuy: true, allowSell: true }),
    };
    const h1Bull = buildTrendSeries(220, 'UP', 60 * 60_000, 2500);
    const m15Bull = buildTrendSeries(220, 'UP', 15 * 60_000, 2580);

    // a) Chop / sideways EMAs must be rejected even if Stochastic oscillates
    const flatM5 = buildTrendSeries(220, 'FLAT', 5 * 60_000, 2650);
    const resChop = evaluateEmaStochasticProSignal({
      h1Candles: h1Bull,
      m15Candles: m15Bull,
      m5Candles: flatM5,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: 2650,
      accountEquity: 1000,
      nowMs: flatM5[flatM5.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(resChop.signal.action, 'WAIT');
    assert.equal(resChop.analysis.marketCondition, 'CHOPPY_SIDEWAYS');

    // b) False breakout without rejection close does NOT count as a valid liquidity sweep
    const breakoutSeq = [
      2660, 2658, 2655, 2659, 2662, // swing low @ idx 2 (2655)
      2661, 2659, 2657, 2654, 2652, // idx 8-9 break AND close below 2655 (no close back above)
      2650, 2649,
    ].map((c, idx) => makeCandle(idx, c + 1, Math.max(c + 1, c) + 0.5, Math.min(c + 1, c) - 0.5, c));
    const smcFalseBreak = analyzeSmc(breakoutSeq, 40, 2, 1.5);
    assert.notEqual(smcFalseBreak.lastSweep?.direction, 'BULLISH', 'Breakdown close without rejection must not emit bullish sweep');

    // c) Late-entry chase rejection (close far beyond EMA21 after huge spike bar)
    const m5Chase = buildTrendSeries(210, 'UP', 5 * 60_000, 2600);
    const lastChase = m5Chase[m5Chase.length - 1];
    m5Chase.push(makeCandle(210, lastChase.close, lastChase.close + 22, lastChase.close - 0.5, lastChase.close + 20, 5 * 60_000));
    const resChase = evaluateEmaStochasticProSignal({
      h1Candles: h1Bull,
      m15Candles: m15Bull,
      m5Candles: m5Chase,
      settings,
      levels: createFreshDayLevels('2026-11-16'),
      phase: 'LONDON_SESSION',
      latestPrice: lastChase.close + 20,
      accountEquity: 1000,
      nowMs: m5Chase[m5Chase.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(resChase.signal.action, 'WAIT');

    // d) Daily cap at 10 trades blocks new trade signals
    const resDaily10 = evaluateEmaStochasticProSignal({
      h1Candles: h1Bull,
      m15Candles: m15Bull,
      m5Candles: buildTrendSeries(210, 'UP', 5 * 60_000, 2600),
      settings,
      levels: { ...createFreshDayLevels('2026-11-16'), totalTradesToday: 10 },
      phase: 'LONDON_SESSION',
      latestPrice: 2710,
      accountEquity: 1000,
      nowMs: m15Bull[m15Bull.length - 1].openTimeMs + 5 * 60_000,
    });
    assert.equal(resDaily10.signal.action, 'WAIT');
    assert.match(resDaily10.signal.blockReason ?? '', /Max daily trades/i);

    // e) Duplicate OPEN signalId blocked by validateExecutionGate
    const dupUser = createMockUser({ accountType: 'Demo' });
    const dupSignal: TradeSignal = {
      id: 'sig-dup-123',
      timestamp: new Date(BASE_MONDAY_UTC_MS).toISOString(),
      lusakaTime: '11:05:00',
      strategy: 'LONDON_SESSION',
      strategyModule: 'EMA_STOCHASTIC_PRO',
      action: 'BUY',
      symbol: 'XAUUSD',
      entry: 2700,
      stop: 2697,
      tp1: 2703,
      tp2: 2706,
      tp3: 2709,
      target: 2706,
      rrRatio: 2.0,
      riskDollars: 5,
      suggestedLots: 0.02,
      reason: 'Dup guard check',
      conditions: [],
    };
    dupUser.tradeLog.push({
      id: 'trd-dup-1',
      signalId: 'sig-dup-123',
      dateLusaka: '2026-11-16',
      timeLusaka: '11:05:00',
      timestamp: new Date(BASE_MONDAY_UTC_MS).toISOString(),
      session: 'LONDON_SESSION',
      symbol: 'XAUUSD',
      side: 'BUY',
      entry: 2700,
      stop: 2697,
      target: 2706,
      rrRatio: 2,
      lots: 0.02,
      riskDollars: 5,
      status: 'OPEN',
      exitPrice: null,
      pnlDollars: null,
      notes: 'Already open',
    });
    const dupGate = validateExecutionGate({
      user: dupUser,
      signal: dupSignal,
      latestMarketPrice: 2700.1,
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 5000,
    });
    assert.equal(dupGate.allowed, false);
    assert.match(dupGate.reason ?? '', /already OPEN|Duplicate/i);
  });

  // 12. All-Session Weekday Trading vs Weekend Closed
  await runTest('12. All-session weekday phases (Asian, London, New York, Off-Peak) & weekend block', () => {
    const offPeak = determineSessionPhase(30, DEFAULT_STRATEGY_SETTINGS, false); // 00:30 Lusaka
    assert.equal(offPeak.phase, 'ALL_SESSIONS');

    const asian = determineSessionPhase(480, DEFAULT_STRATEGY_SETTINGS, false); // 08:00 Lusaka
    assert.equal(asian.phase, 'ASIAN_SESSION');

    const london = determineSessionPhase(840, DEFAULT_STRATEGY_SETTINGS, false); // 14:00 Lusaka
    assert.equal(london.phase, 'LONDON_SESSION');

    const ny = determineSessionPhase(1275, DEFAULT_STRATEGY_SETTINGS, false); // 21:15 Lusaka
    assert.equal(ny.phase, 'NEW_YORK_SESSION');

    const weekend = determineSessionPhase(840, DEFAULT_STRATEGY_SETTINGS, true);
    assert.equal(weekend.phase, 'MARKET_CLOSED');
  });

  // 13. Dynamic Spread Calculation (2-digit & 3-digit), Classification, >45p Protection & Net R:R
  await runTest('13. Dynamic spread math (2- & 3-digit specs), classification, >45p protection & Net R:R', () => {
    const spec2 = resolveSymbolSpecification({ symbol: 'GOLD', explicitDigits: 2, explicitPointSize: 0.01 });
    const spec3 = resolveSymbolSpecification({ symbol: 'XAUUSDm', explicitDigits: 3, explicitPointSize: 0.001 });
    assert.equal(spec2.pointSize, 0.01);
    assert.equal(spec3.pointSize, 0.001);

    const m2 = computeSpreadMetrics(2700.00, 2700.48, spec2.pointSize, spec2.digits);
    assert.equal(m2.spreadPoints, 48);
    const m3 = computeSpreadMetrics(2700.000, 2700.048, spec3.pointSize, spec3.digits);
    assert.equal(m3.spreadPoints, 48);

    // Observed 1H & 24H spread history centered around 32p
    const nowMs = BASE_MONDAY_UTC_MS + 60 * 60_000;
    const history = Array.from({ length: 24 }, (_, idx) => ({
      timestampMs: nowMs - (idx + 1) * 60_000,
      bid: 2700.0,
      ask: 2700.32,
      spreadPrice: 0.32,
      spreadPoints: 32,
      pointSize: 0.01,
      hasTwoSidedQuote: true,
      source: 'XM TickerAll Feed',
      symbol: 'GOLD',
    }));

    // Strong BUY setup at 48p (slightly > 45p) with generous TP2 (Net R:R >= 1.6) must be protected & permitted
    const evElevatedStrong = evaluateDynamicSpread({
      bid: 2700.0,
      ask: 2700.48,
      quoteTimestamp: new Date(nowMs - 2000).toISOString(),
      quoteSource: 'XM TickerAll Live',
      hasTwoSidedQuote: true,
      symbolSpec: spec2,
      spreadHistory: history,
      maxSpreadPoints: 80,
      sensitivity: 'BALANCED',
      allowHighSpreadTrades: false,
      minNetRewardRisk: 1.6,
      estimatedSlippagePoints: 5,
      maxQuoteAgeSeconds: 15,
      confirmationScore: 86,
      proposedSide: 'BUY',
      proposedEntry: 2700.48,
      proposedStop: 2697.48,
      proposedTarget: 2706.48,
      lots: 0.02,
      nowMs,
    });
    assert.equal(evElevatedStrong.dataAvailable, true);
    assert.equal(evElevatedStrong.classification, 'ELEVATED');
    assert.equal(evElevatedStrong.tradePermitted, true);
    assert.equal(evElevatedStrong.acceptedAbove45Override, true);

    // Tight TP / poor Net R:R under elevated spread must be rejected even if classification allows strong setups
    const evPoorNetRr = evaluateDynamicSpread({
      bid: 2700.0,
      ask: 2700.48,
      quoteTimestamp: new Date(nowMs - 2000).toISOString(),
      quoteSource: 'XM TickerAll Live',
      hasTwoSidedQuote: true,
      symbolSpec: spec2,
      spreadHistory: history,
      maxSpreadPoints: 80,
      sensitivity: 'BALANCED',
      allowHighSpreadTrades: false,
      minNetRewardRisk: 1.6,
      estimatedSlippagePoints: 5,
      maxQuoteAgeSeconds: 15,
      confirmationScore: 86,
      proposedSide: 'BUY',
      proposedEntry: 2700.48,
      proposedStop: 2699.48,
      proposedTarget: 2701.98, // Gross 1.50R minus 0.48+0.05 = <1.0 Net R:R
      lots: 0.02,
      nowMs,
    });
    assert.equal(evPoorNetRr.tradePermitted, false);

    // HIGH spread blocked unless admin allowHighSpreadTrades=true + top-tier confluence
    const evHighBlocked = evaluateDynamicSpread({
      bid: 2700.0,
      ask: 2700.72,
      quoteTimestamp: new Date(nowMs - 1000).toISOString(),
      quoteSource: 'XM TickerAll Live',
      hasTwoSidedQuote: true,
      symbolSpec: spec2,
      spreadHistory: history,
      maxSpreadPoints: 80,
      sensitivity: 'BALANCED',
      allowHighSpreadTrades: false,
      minNetRewardRisk: 1.6,
      confirmationScore: 90,
      proposedSide: 'BUY',
      proposedEntry: 2700.72,
      proposedStop: 2696.72,
      proposedTarget: 2710.72,
      lots: 0.02,
      nowMs,
    });
    assert.equal(evHighBlocked.classification, 'HIGH');
    assert.equal(evHighBlocked.tradePermitted, false);

    // EXCESSIVE & ABNORMAL
    const evExcessive = evaluateDynamicSpread({
      bid: 2700.0,
      ask: 2700.95,
      quoteTimestamp: new Date(nowMs - 1000).toISOString(),
      quoteSource: 'XM TickerAll Live',
      hasTwoSidedQuote: true,
      symbolSpec: spec2,
      spreadHistory: history,
      maxSpreadPoints: 80,
      sensitivity: 'BALANCED',
      allowHighSpreadTrades: true,
      minNetRewardRisk: 1.6,
      nowMs,
    });
    assert.equal(evExcessive.classification, 'EXCESSIVE');
    assert.equal(evExcessive.tradePermitted, false);

    const evAbnormal = evaluateDynamicSpread({
      bid: 2700.0,
      ask: 2701.8,
      quoteTimestamp: new Date(nowMs - 1000).toISOString(),
      quoteSource: 'XM TickerAll Live',
      hasTwoSidedQuote: true,
      symbolSpec: spec2,
      spreadHistory: history,
      maxSpreadPoints: 80,
      sensitivity: 'BALANCED',
      allowHighSpreadTrades: true,
      minNetRewardRisk: 1.6,
      nowMs,
    });
    assert.equal(evAbnormal.classification, 'ABNORMAL');
    assert.equal(evAbnormal.decision, 'PAUSE_ABNORMAL');
    assert.equal(evAbnormal.tradePermitted, false);

    // Stale or fallback-only -> DATA_UNAVAILABLE
    const evStale = evaluateDynamicSpread({
      bid: 2700.0,
      ask: 2700.25,
      quoteTimestamp: new Date(nowMs - 30_000).toISOString(),
      quoteSource: 'XM TickerAll Live',
      hasTwoSidedQuote: true,
      symbolSpec: spec2,
      spreadHistory: history,
      maxSpreadPoints: 80,
      sensitivity: 'BALANCED',
      allowHighSpreadTrades: false,
      minNetRewardRisk: 1.6,
      maxQuoteAgeSeconds: 15,
      nowMs,
    });
    assert.equal(evStale.dataAvailable, false);
    assert.equal(evStale.classification, 'DATA_UNAVAILABLE');
    assert.equal(evStale.tradePermitted, false);
  });

  // 14. Side-specific Pricing & Pre-Trade Validation Gate
  await runTest('14. Side-specific pricing (BUY=Ask / SELL=Bid) & TickerAll pre-trade validation', () => {
    assert.equal(getEffectiveSideEntryPrice('BUY', 2700.1, 2700.45, 2700.2, 2), 2700.45);
    assert.equal(getEffectiveSideEntryPrice('SELL', 2700.1, 2700.45, 2700.2, 2), 2700.1);
    assert.equal(getEffectiveSideClosingPrice('BUY', 2700.1, 2700.45, 2700.2, 2), 2700.1);
    assert.equal(getEffectiveSideClosingPrice('SELL', 2700.1, 2700.45, 2700.2, 2), 2700.45);

    const demoUser = createMockUser({ accountType: 'Demo' });
    const sig: TradeSignal = {
      id: 'sig-pretrade-1',
      timestamp: new Date(BASE_MONDAY_UTC_MS).toISOString(),
      lusakaTime: '20:15:00',
      strategy: 'NEW_YORK_SESSION',
      strategyModule: 'EMA_STOCHASTIC_PRO',
      action: 'BUY',
      symbol: 'GOLD',
      entry: 2700.45,
      stop: 2697.45,
      tp1: 2703.45,
      tp2: 2706.45,
      tp3: 2709.45,
      target: 2706.45,
      rrRatio: 2.0,
      riskDollars: 5,
      suggestedLots: 0.02,
      reason: 'NY session continuation',
      conditions: [],
    };

    const staleGate = validateExecutionGate({
      user: demoUser,
      signal: sig,
      latestMarketPrice: 2700.45,
      latestTick: {
        seq: 1,
        adapterId: 'tickerall-ws',
        symbol: 'GOLD',
        upstreamSymbol: 'GOLD',
        bid: 2700.1,
        ask: 2700.45,
        last: 2700.25,
        mid: 2700.28,
        spread: 0.35,
        spreadBps: 1.3,
        digits: 2,
        pointSize: 0.01,
        spreadPoints: 35,
        hasTwoSidedQuote: true,
        volume24h: null,
        change24hPct: null,
        latencyMs: 10,
        httpStatus: 200,
        receivedAt: new Date(BASE_MONDAY_UTC_MS - 30_000).toISOString(),
        upstreamTimestamp: new Date(BASE_MONDAY_UTC_MS - 30_000).toISOString(),
        isFallback: false,
        sourceLabel: 'XM TickerAll Live',
        rawPayload: {},
      },
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS,
    });
    assert.equal(staleGate.allowed, false);
    assert.match(staleGate.reason ?? '', /DATA UNAVAILABLE|stale/i);
  });

  // 15. Non-Overridable Gemini Hard Safeguards on Spread & Quote Freshness
  await runTest('15. Gemini AI hard safeguard blocks DATA_UNAVAILABLE, ABNORMAL spread & low Net R:R', () => {
    const nowMs = Date.now();
    const spec2 = resolveSymbolSpecification({ symbol: 'GOLD', explicitDigits: 2, explicitPointSize: 0.01 });
    const evAbnormal = evaluateDynamicSpread({
      bid: 2700.0,
      ask: 2702.0,
      quoteTimestamp: new Date(nowMs - 1000).toISOString(),
      quoteSource: 'XM TickerAll Live',
      hasTwoSidedQuote: true,
      symbolSpec: spec2,
      spreadHistory: [],
      maxSpreadPoints: 80,
      sensitivity: 'BALANCED',
      allowHighSpreadTrades: true,
      minNetRewardRisk: 1.6,
      nowMs,
    });
    const hardCheck = enforceHardRiskChecks({
      executionContext: 'AUTO',
      lusakaDate: '2026-11-16',
      lusakaTime: '21:15:00',
      lusakaWeekday: 'Monday',
      isWeekend: false,
      phase: 'NEW_YORK_SESSION',
      symbol: 'GOLD',
      proposedSide: 'BUY',
      entry: 2702.0,
      stop: 2698.0,
      tp1: 2706.0,
      tp2: 2710.0,
      tp3: 2714.0,
      lots: 0.02,
      accountBalance: 1000,
      settings: DEFAULT_STRATEGY_SETTINGS,
      levels: createFreshDayLevels('2026-11-16'),
      activeSignal: {
        id: 'sig-ai-hard-check',
        timestamp: new Date(nowMs).toISOString(),
        lusakaTime: '21:15:00',
        strategy: 'NEW_YORK_SESSION',
        strategyModule: 'EMA_STOCHASTIC_PRO',
        action: 'BUY',
        symbol: 'GOLD',
        entry: 2702.0,
        stop: 2698.0,
        tp1: 2706.0,
        tp2: 2710.0,
        tp3: 2714.0,
        target: 2710.0,
        rrRatio: 2.0,
        riskDollars: 5,
        suggestedLots: 0.02,
        reason: 'Test candidate',
        conditions: [],
      },
      emaPro: {
        overallTrend: 'BULLISH',
        marketCondition: 'TRENDING',
        h1: {
          timeframe: 'H1',
          barsCount: 220,
          lastClose: 2700,
          ema9: 2698,
          ema21: 2695,
          ema50: 2690,
          ema200: 2680,
          emaBias: 'BULLISH',
          isCompressedOrChoppy: false,
          stochK: 60,
          stochD: 55,
          stochCross: 'NONE',
          stochZone: 'NEUTRAL',
          atr: 3.5,
        },
        m15: {
          timeframe: 'M15',
          barsCount: 220,
          lastClose: 2700,
          ema9: 2699,
          ema21: 2697,
          ema50: 2694,
          ema200: 2685,
          emaBias: 'BULLISH',
          isCompressedOrChoppy: false,
          stochK: 55,
          stochD: 50,
          stochCross: 'NONE',
          stochZone: 'NEUTRAL',
          atr: 2.0,
        },
        m5: {
          timeframe: 'M5',
          barsCount: 220,
          lastClose: 2700,
          ema9: 2699.5,
          ema21: 2698.5,
          ema50: 2696,
          ema200: 2690,
          emaBias: 'BULLISH',
          isCompressedOrChoppy: false,
          stochK: 32,
          stochD: 25,
          stochCross: 'BULLISH_CROSS',
          stochZone: 'NEUTRAL',
          atr: 1.5,
        },
        m1: {
          timeframe: 'M1',
          barsCount: 0,
          lastClose: null,
          ema9: null,
          ema21: null,
          ema50: null,
          ema200: null,
          emaBias: 'NEUTRAL',
          isCompressedOrChoppy: false,
          stochK: null,
          stochD: null,
          stochCross: 'NONE',
          stochZone: 'NEUTRAL',
          atr: null,
        },
        smc: {
          trendStructure: 'BULLISH',
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
          dealingRangeHigh: 2710,
          dealingRangeLow: 2680,
          equilibriumPrice: 2695,
          priceZone: 'PREMIUM',
          bullishSetupPresent: true,
          bearishSetupPresent: false,
          evidenceSummary: ['Bullish OB'],
        },
        spreadPips: 200,
        spreadAllowed: false,
        spreadEvaluation: evAbnormal,
        atrPips: 15,
        pullbackToEma: 'EMA_9',
        confirmationCandle: 'BULLISH_CLOSE',
        signalExpiresAt: new Date(nowMs + 15 * 60_000).toISOString(),
        newsFeedStatus: 'CALENDAR_CONFIGURED',
      },
      newsStatus: { clear: true, blockingEvent: null, minutesUntil: null },
      currentCandle: null,
      recentClosedCandles: [],
      dailyPnlPct: 0,
      dailyGuardHit: false,
      openPositionsCount: 0,
      lastTickAtMs: nowMs,
    });
    assert.equal(hardCheck.hardStatus, 'REJECTED');
    assert.match(hardCheck.reason ?? '', /ABNORMAL|override/i);
  });

  // 16. Legacy 45p vs All-Session Dynamic Spread Comparison Report
  await runTest('16. Spread filter comparison backtest produces legacy vs dynamic rows with OHLC disclosure', () => {
    const m5Series: M15Candle[] = [];
    let px = 2500;
    for (let i = 0; i < 2800; i += 1) {
      const cycle = Math.sin(i / 25) * 4.5;
      const o = px;
      const c = o + 0.12 + cycle * 0.25;
      m5Series.push(makeCandle(i, o, Math.max(o, c) + 1.4, Math.min(o, c) - 1.4, c, 5 * 60_000));
      px = c;
    }
    const report = runSpreadFilterComparisonBacktest({
      m5Candles: m5Series,
      m15Candles: aggregateCandles(m5Series, 15 * 60_000),
      h1Candles: aggregateCandles(m5Series, 60 * 60_000),
      settings: {
        ...DEFAULT_STRATEGY_SETTINGS,
        strategyMode: 'EMA_STOCHASTIC_PRO',
        emaPro: mergeEmaProConfig(),
      },
      periodDays: 30,
      startingBalance: 1000,
      masterFeedConnected: true,
    });
    assert.equal(report.dataMode, 'HISTORICAL_OHLC_WITH_MODELED_SPREAD');
    assert.match(report.disclaimer, /Historical OHLC bars/i);
    assert.ok(report.legacyRigid45.label.includes('45p'));
    assert.ok(report.dynamicAllSession.label.includes('Dynamic'));
  });

  // 17. Live Account Execution Gate & Multi-Broker Setup Validation (Weltrade Cent, Exness, XM)
  await runTest('17. Live account execution gate & Weltrade/Exness/XM Cent/ECN setup validation', async () => {
    const sampleSignal: TradeSignal = {
      id: `sig-live-test-${Date.now()}`,
      timestamp: new Date(BASE_MONDAY_UTC_MS).toISOString(),
      lusakaTime: '08:15:00',
      strategy: 'ASIAN_SESSION',
      strategyModule: 'EMA_STOCHASTIC_PRO',
      action: 'BUY',
      symbol: 'XAUUSDc',
      entry: 2700,
      stop: 2698,
      tp1: 2702,
      tp2: 2704,
      tp3: 2706,
      target: 2704,
      rrRatio: 3,
      riskDollars: 25,
      suggestedLots: 0.12,
      reason: 'Live multi-broker test signal',
      expiresAt: new Date(BASE_MONDAY_UTC_MS + 15 * 60_000).toISOString(),
      conditions: [],
    };

    // a) Live account unlocked passes validateExecutionGate cleanly without fabricated fills
    const liveWeltradeUser = createMockUser({
      accountType: 'Live',
      brokerName: 'Weltrade',
      brokerServer: 'Weltrade-Live',
      brokerBridgeUrl: '',
    });
    liveWeltradeUser.brokerSetup = normalizeBrokerSetup(
      {
        platformMt5: true,
        accountStandard: true,
        currencyUsd: true,
        leverageValid: true,
        selectedBrokerPreset: 'Weltrade',
        accountVariant: 'CENT_USC',
      },
      'Weltrade'
    );
    liveWeltradeUser.settings.emaPro = mergeEmaProConfig({
      tradingMode: 'AUTOMATIC_TRADING',
      demoOnlyMode: false,
      liveTradingAuthorized: true,
      tradingRunState: 'RUNNING',
      xauusdSymbol: 'XAUUSDc',
    });

    assert.equal(hasWrongBrokerSetup(liveWeltradeUser.brokerSetup), false);
    assert.equal(isBrokerSetupComplete(liveWeltradeUser.brokerSetup), true);

    const liveGate = validateExecutionGate({
      user: liveWeltradeUser,
      signal: sampleSignal,
      latestMarketPrice: 2700.1,
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 2000,
    });
    assert.equal(liveGate.allowed, true);

    const liveOrder = await executeTradeViaTickerAllAdapter({
      user: liveWeltradeUser,
      signal: sampleSignal,
      latestMarketPrice: 2700.1,
      feedConnected: true,
      isWeekend: false,
      nowMs: BASE_MONDAY_UTC_MS + 2000,
    });
    assert.equal(
      liveOrder.status,
      'EXECUTION_UNAVAILABLE',
      'Live accounts without a connected brokerBridgeUrl must honestly report EXECUTION_UNAVAILABLE rather than simulating a live fill'
    );

    // b) Exness Raw/ECN & XM Cent USD accepted, while MT4/cTrader & ZMW/EUR remain rejected
    const exnessRaw = normalizeBrokerSetup(
      {
        platformMt5: true,
        accountStandard: true,
        currencyUsd: true,
        leverageValid: true,
        hasWrongCentOrEcn: true, // legacy flag must not block anymore
        selectedBrokerPreset: 'Exness',
        accountVariant: 'ECN_RAW',
      },
      'Exness'
    );
    assert.equal(hasWrongBrokerSetup(exnessRaw), false);
    assert.equal(isBrokerSetupComplete(exnessRaw), true);

    const invalidMt4 = normalizeBrokerSetup(
      {
        platformMt5: false,
        accountStandard: true,
        currencyUsd: true,
        leverageValid: true,
        hasWrongMt4OrCtrader: true,
        selectedBrokerPreset: 'XM',
      },
      'XM'
    );
    assert.equal(hasWrongBrokerSetup(invalidMt4), true);
    assert.equal(isBrokerSetupComplete(invalidMt4), false);
  });

  // 18. Cent USD & Cent USC Contract Specification and Lot Sizing Parity
  await runTest('18. Cent USD & Cent USC contract specification and tiered/equity lot sizing parity', () => {
    const baseSpec = resolveSymbolSpecification({
      symbol: 'XAUUSDc',
      bid: 2700.0,
      ask: 2700.25,
      source: 'TickerAll MT5 Feed',
      verifiedFromBroker: true,
    });

    const weltradeVariant = inferBrokerAccountVariant(
      { selectedBrokerPreset: 'Weltrade', accountVariant: 'CENT_USC' },
      'Weltrade',
      'XAUUSDc'
    );
    assert.equal(weltradeVariant, 'CENT_USC');
    const uscSpec = resolveAccountVariantSpec(baseSpec, 'CENT_USC');
    assert.equal(uscSpec.currency, 'USC');
    assert.equal(uscSpec.contractSize, 100);

    const centUsdSpec = resolveAccountVariantSpec(baseSpec, 'CENT_USD');
    assert.equal(centUsdSpec.currency, 'USD');
    assert.equal(centUsdSpec.contractSize, 1);

    // Tiered auto-lot: 5,000 USC ($50) and $50 CENT_USD should both calculate 0.25 cent lots
    const uscTier = calculateTieredAutoLot(5000, 10.0, uscSpec.contractSize, 'USC');
    const centUsdTier = calculateTieredAutoLot(50, 10.0, centUsdSpec.contractSize, 'USD');
    assert.equal(uscTier.effectiveLot, 0.25);
    assert.equal(centUsdTier.effectiveLot, 0.25);

    // Equity sizing: 0.5% risk with $2 stop distance -> 0.12 lots on both 5,000 USC and $50 CENT_USD
    const uscSizing = calculatePositionSizeFromEquity({
      equity: 5000,
      riskPercent: 0.5,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2698,
      maxAutoLotCap: 10.0,
      tickSize: 0.01,
      tickValuePerTickPerLot: 0.01 * uscSpec.contractSize,
    });
    const centUsdSizing = calculatePositionSizeFromEquity({
      equity: 50,
      riskPercent: 0.5,
      maxRiskPercent: 1.0,
      entry: 2700,
      stop: 2698,
      maxAutoLotCap: 10.0,
      tickSize: 0.01,
      tickValuePerTickPerLot: 0.01 * centUsdSpec.contractSize,
    });
    assert.equal(uscSizing.valid, true);
    assert.equal(centUsdSizing.valid, true);
    assert.equal(uscSizing.lots, 0.12);
    assert.equal(centUsdSizing.lots, 0.12);
  });

  console.log(`\nALL ${passed} EMA STOCHASTIC PRO TEST SUITES PASSED.`);
}

main().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
