import type {
  DynamicSpreadEvaluation,
  NormalizedTick,
  StrategySettings,
  SymbolSpecification,
  TradeOrderRecord,
  TradeSignal,
} from '../src/types/connectivity.ts';
import {
  getEffectiveSideEntryPrice,
  roundToDigits,
} from '../src/utils/dynamicSpread.ts';
import { mergeEmaProConfig } from '../src/utils/emaStochasticPro.ts';
import { getLusakaClock, round2 } from '../src/utils/strategyEngine.ts';
import type { StoredUser } from './businessStore.ts';
import { isSafeExternalUrl } from './urlSafety.ts';
import { inferSymbolDigits } from '../src/utils/telegramSignalParser.ts';

function isGoldLikeSymbol(symbol: string | null | undefined): boolean {
  const upper = (symbol || 'XAUUSD').toUpperCase();
  return upper.includes('XAU') || upper.includes('GOLD');
}

const processedIdempotencyKeys = new Map<string, TradeOrderRecord>();

export interface ExecutionValidationResult {
  allowed: boolean;
  reason: string | null;
}

export function validateExecutionGate(params: {
  user: StoredUser;
  signal: TradeSignal;
  latestMarketPrice: number | null;
  latestTick?: NormalizedTick | null;
  symbolSpec?: SymbolSpecification;
  spreadEvaluation?: DynamicSpreadEvaluation | null;
  feedConnected: boolean;
  isWeekend: boolean;
  nowMs?: number;
}): ExecutionValidationResult {
  const {
    user,
    signal,
    latestMarketPrice,
    latestTick,
    symbolSpec,
    spreadEvaluation,
    feedConnected,
    isWeekend,
    nowMs = Date.now(),
  } = params;
  const cfg = mergeEmaProConfig(user.settings.emaPro);

  if (cfg.tradingMode === 'SIGNALS_ONLY') {
    return { allowed: false, reason: 'Trading mode is SIGNALS_ONLY (signals logged without placing orders)' };
  }
  if (cfg.tradingRunState !== 'RUNNING') {
    return { allowed: false, reason: `Trading halted: run state is ${cfg.tradingRunState}` };
  }
  if (isWeekend) {
    return { allowed: false, reason: 'Market closed (Weekend)' };
  }
  if (!feedConnected) {
    return { allowed: false, reason: 'TickerAll master feed disconnected — auto-execution blocked' };
  }
  if (!user.autoTradeEnabled) {
    return { allowed: false, reason: 'User auto-trade switch is disabled' };
  }
  if (cfg.demoOnlyMode && !cfg.liveTradingAuthorized && user.accountType === 'Live') {
    return {
      allowed: false,
      reason: 'Demo-Only Safety Lock active: Live MT5 auto-execution requires explicit Live Authorization',
    };
  }
  if (signal.action !== 'BUY' && signal.action !== 'SELL') {
    return { allowed: false, reason: 'No active BUY/SELL signal' };
  }
  if (signal.action === 'BUY' && !cfg.allowBuy) {
    return { allowed: false, reason: 'BUY direction disabled in strategy controls' };
  }
  if (signal.action === 'SELL' && !cfg.allowSell) {
    return { allowed: false, reason: 'SELL direction disabled in strategy controls' };
  }
  if (typeof user.equity !== 'number' || !Number.isFinite(user.equity) || user.equity <= 0) {
    return { allowed: false, reason: 'Account equity unavailable — refusing to place order' };
  }
  if (signal.expiresAt) {
    const expMs = Date.parse(signal.expiresAt);
    if (Number.isFinite(expMs) && nowMs > expMs) {
      return { allowed: false, reason: 'Signal expired before order dispatch' };
    }
  }

  const effectiveSymbol = signal.symbol || symbolSpec?.symbol || cfg.xauusdSymbol || 'XAUUSD';
  const isGold = isGoldLikeSymbol(effectiveSymbol);

  // Fresh MT5 Bid/Ask quote, exact symbol specs & dynamic spread / net R:R mandatory pre-trade checks (Gold/XAUUSD)
  if (isGold && latestTick) {
    if (!latestTick.hasTwoSidedQuote || latestTick.bid <= 0 || latestTick.ask <= 0 || latestTick.ask < latestTick.bid) {
      return {
        allowed: false,
        reason: 'DATA UNAVAILABLE: Valid two-sided MT5 Bid/Ask quote missing — order blocked',
      };
    }
    const tickAgeSec = (nowMs - Date.parse(latestTick.receivedAt || latestTick.upstreamTimestamp)) / 1000;
    if (!Number.isFinite(tickAgeSec) || tickAgeSec > cfg.maxQuoteAgeSeconds) {
      return {
        allowed: false,
        reason: `DATA UNAVAILABLE: Quote stale (${Number.isFinite(tickAgeSec) ? Math.round(tickAgeSec) : '?'}s > ${cfg.maxQuoteAgeSeconds}s)`,
      };
    }
    if (symbolSpec && symbolSpec.pointSize <= 0) {
      return {
        allowed: false,
        reason: 'Symbol point size specification invalid — order blocked',
      };
    }
  }

  if (isGold && spreadEvaluation) {
    if (!spreadEvaluation.dataAvailable || spreadEvaluation.classification === 'DATA_UNAVAILABLE') {
      return {
        allowed: false,
        reason: spreadEvaluation.reason || 'DATA UNAVAILABLE: Two-sided XM quote missing or stale',
      };
    }
    if (!spreadEvaluation.tradePermitted) {
      return {
        allowed: false,
        reason: `Pre-trade spread check blocked order [${spreadEvaluation.classification}]: ${spreadEvaluation.reason}`,
      };
    }
    if (
      spreadEvaluation.costBreakdown &&
      spreadEvaluation.costBreakdown.netRr !== null &&
      spreadEvaluation.costBreakdown.netRr < cfg.minNetRewardRisk
    ) {
      return {
        allowed: false,
        reason: `Net R:R (${spreadEvaluation.costBreakdown.netRr.toFixed(2)}:1) after costs below minimum (${cfg.minNetRewardRisk}:1)`,
      };
    }
  }

  const digits = isGold
    ? symbolSpec?.digits ?? latestTick?.digits ?? 2
    : inferSymbolDigits(effectiveSymbol);
  const sideReferencePrice = isGold
    ? latestTick && latestTick.hasTwoSidedQuote
      ? getEffectiveSideEntryPrice(signal.action, latestTick.bid, latestTick.ask, latestMarketPrice, digits)
      : latestMarketPrice
    : signal.entry;

  if (
    isGold &&
    sideReferencePrice !== null &&
    signal.entry !== null &&
    Number.isFinite(sideReferencePrice)
  ) {
    const pointSize = symbolSpec?.pointSize ?? latestTick?.pointSize ?? 0.01;
    const maxDevPrice = cfg.maxEntryDeviationPips * Math.max(pointSize * 10, 0.01);
    if (Math.abs(sideReferencePrice - signal.entry) > maxDevPrice) {
      return {
        allowed: false,
        reason: `Side quote (${sideReferencePrice.toFixed(digits)}) drifted beyond max deviation ($${maxDevPrice.toFixed(2)}) from $${signal.entry.toFixed(digits)}`,
      };
    }
  }
  if (
    signal.id &&
    (user.tradeLog ?? []).some((t) => t.status === 'OPEN' && t.signalId === signal.id)
  ) {
    return {
      allowed: false,
      reason: 'Duplicate signal ID: open position already active for this setup',
    };
  }
  if (!signal.suggestedLots || signal.suggestedLots < 0.01) {
    return { allowed: false, reason: 'Invalid calculated position volume' };
  }

  return { allowed: true, reason: null };
}

export async function executeTradeViaTickerAllAdapter(params: {
  user: StoredUser;
  signal: TradeSignal;
  latestMarketPrice: number | null;
  latestTick?: NormalizedTick | null;
  symbolSpec?: SymbolSpecification;
  spreadEvaluation?: DynamicSpreadEvaluation | null;
  feedConnected: boolean;
  isWeekend: boolean;
  nowMs?: number;
}): Promise<TradeOrderRecord> {
  const {
    user,
    signal,
    latestMarketPrice,
    latestTick,
    symbolSpec,
    spreadEvaluation,
    feedConnected,
    isWeekend,
    nowMs = Date.now(),
  } = params;
  const cfg = mergeEmaProConfig(user.settings.emaPro);
  const clk = getLusakaClock(nowMs);
  const requestedSymbol = (signal.symbol || '').trim();
  const isGold = isGoldLikeSymbol(requestedSymbol || symbolSpec?.symbol || cfg.xauusdSymbol);
  const symbol = isGold
    ? symbolSpec?.symbol || cfg.xauusdSymbol || 'XAUUSD'
    : requestedSymbol || 'EURUSD';
  const digits = isGold
    ? symbolSpec?.digits ?? latestTick?.digits ?? 2
    : inferSymbolDigits(symbol);
  const side: 'BUY' | 'SELL' = signal.action === 'SELL' ? 'SELL' : 'BUY';
  const idempotencyKey = `${user.id}:${signal.id}`;

  // 1) Idempotency guard — prevent duplicate execution of same signal ID
  const existing = processedIdempotencyKeys.get(idempotencyKey);
  if (existing) {
    return existing;
  }

  // Use Ask for BUY execution and Bid for SELL execution on Gold, or signal entry on non-Gold pairs
  const sideFillQuote = isGold
    ? latestTick
      ? getEffectiveSideEntryPrice(side, latestTick.bid, latestTick.ask, latestMarketPrice, digits)
      : latestMarketPrice
    : signal.entry;
  const requestedEntry = roundToDigits(sideFillQuote ?? signal.entry ?? 0, digits);
  const stop = roundToDigits(signal.stop ?? requestedEntry, digits);
  const tp1 = signal.tp1 !== null ? roundToDigits(signal.tp1, digits) : null;
  const tp2 = signal.tp2 !== null ? roundToDigits(signal.tp2, digits) : null;
  const tp3 = signal.tp3 != null ? roundToDigits(signal.tp3, digits) : null;
  const environment: 'DEMO' | 'LIVE' = user.accountType === 'Live' ? 'LIVE' : 'DEMO';

  // 2) Hard execution validation
  const gate = validateExecutionGate({
    user,
    signal,
    latestMarketPrice,
    latestTick,
    symbolSpec,
    spreadEvaluation,
    feedConnected,
    isWeekend,
    nowMs,
  });

  if (!gate.allowed) {
    const blockedRec: TradeOrderRecord = {
      id: `ord-${nowMs}-${Math.random().toString(36).slice(2, 7)}`,
      signalId: signal.id,
      idempotencyKey,
      timestamp: new Date(nowMs).toISOString(),
      lusakaTime: clk.timeLusaka,
      symbol,
      side,
      requestedEntry,
      actualFillPrice: null,
      lots: signal.suggestedLots || 0,
      stop,
      tp1,
      tp2,
      tp3,
      status: 'REJECTED',
      brokerOrderId: null,
      environment,
      adapterUsed: 'NONE',
      errorMessage: gate.reason,
    };
    return blockedRec;
  }

  // 3) Configured Broker Bridge HTTP endpoint dispatch (documented GOLD AI TRADER MT5 bridge interface)
  const bridgeUrl = (user.brokerBridgeUrl || '').trim();
  if (bridgeUrl && isSafeExternalUrl(bridgeUrl).safe) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(bridgeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          ...(user.brokerApiKeyEnc ? { 'X-Broker-Account': user.mt5Login } : {}),
        },
        body: JSON.stringify({
          action: 'order',
          idempotencyKey,
          signalId: signal.id,
          broker: user.brokerName || 'XM',
          server: user.brokerServer,
          account: user.mt5Login,
          accountType: user.accountType,
          accountVariant: symbolSpec?.accountVariant ?? user.brokerSetup?.accountVariant ?? 'STANDARD',
          contractSize: symbolSpec?.contractSize ?? 100,
          currency: symbolSpec?.currency ?? 'USD',
          symbol,
          side,
          lots: signal.suggestedLots,
          entry: requestedEntry,
          stop,
          tp1,
          tp2,
          tp3,
          target: tp2 ?? tp1,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      let bodyJson: Record<string, unknown> | null = null;
      const rawText = await res.text();
      try {
        bodyJson = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
      } catch {
        bodyJson = null;
      }

      if (!res.ok) {
        const rec: TradeOrderRecord = {
          id: `ord-${nowMs}`,
          signalId: signal.id,
          idempotencyKey,
          timestamp: new Date(nowMs).toISOString(),
          lusakaTime: clk.timeLusaka,
          symbol,
          side,
          requestedEntry,
          actualFillPrice: null,
          lots: signal.suggestedLots,
          stop,
          tp1,
          tp2,
          tp3,
          status: 'REJECTED',
          brokerOrderId: null,
          environment,
          adapterUsed: 'BROKER_BRIDGE',
          errorMessage: `Bridge HTTP ${res.status}: ${rawText.slice(0, 140)}`,
        };
        processedIdempotencyKeys.set(idempotencyKey, rec);
        return rec;
      }

      const confirmedFill =
        typeof bodyJson?.fillPrice === 'number' && Number.isFinite(bodyJson.fillPrice)
          ? roundToDigits(bodyJson.fillPrice, digits)
          : typeof bodyJson?.price === 'number' && Number.isFinite(bodyJson.price)
            ? roundToDigits(bodyJson.price, digits)
            : requestedEntry;
      const brokerOrderId =
        typeof bodyJson?.orderId === 'string'
          ? bodyJson.orderId
          : typeof bodyJson?.ticket === 'number' || typeof bodyJson?.ticket === 'string'
            ? String(bodyJson.ticket)
            : `mt5-${nowMs}`;

      const filledRec: TradeOrderRecord = {
        id: `ord-${nowMs}`,
        signalId: signal.id,
        idempotencyKey,
        timestamp: new Date(nowMs).toISOString(),
        lusakaTime: clk.timeLusaka,
        symbol,
        side,
        requestedEntry,
        actualFillPrice: confirmedFill,
        lots: signal.suggestedLots,
        stop,
        tp1,
        tp2,
        tp3,
        status: 'FILLED',
        brokerOrderId,
        environment,
        adapterUsed: 'BROKER_BRIDGE',
        errorMessage: null,
      };
      processedIdempotencyKeys.set(idempotencyKey, filledRec);
      return filledRec;
    } catch (err) {
      clearTimeout(timer);
      const errRec: TradeOrderRecord = {
        id: `ord-${nowMs}`,
        signalId: signal.id,
        idempotencyKey,
        timestamp: new Date(nowMs).toISOString(),
        lusakaTime: clk.timeLusaka,
        symbol,
        side,
        requestedEntry,
        actualFillPrice: null,
        lots: signal.suggestedLots,
        stop,
        tp1,
        tp2,
        tp3,
        status: 'REJECTED',
        brokerOrderId: null,
        environment,
        adapterUsed: 'BROKER_BRIDGE',
        errorMessage: err instanceof Error ? err.message : 'Broker bridge timeout/network failure',
      };
      return errRec;
    }
  }

  // 4) Demo Paper Mode (strictly for Demo accounts when no external bridge URL is configured)
  if (cfg.demoOnlyMode && environment === 'DEMO') {
    const demoRec: TradeOrderRecord = {
      id: `demo-ord-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
      signalId: signal.id,
      idempotencyKey,
      timestamp: new Date(nowMs).toISOString(),
      lusakaTime: clk.timeLusaka,
      symbol,
      side,
      requestedEntry,
      actualFillPrice: requestedEntry,
      lots: signal.suggestedLots,
      stop,
      tp1,
      tp2,
      tp3,
      status: 'DEMO_SIMULATED',
      brokerOrderId: `DEMO-${nowMs}`,
      environment: 'DEMO',
      adapterUsed: 'DEMO_PAPER',
      errorMessage: null,
    };
    processedIdempotencyKeys.set(idempotencyKey, demoRec);
    return demoRec;
  }

  // 5) Honest reporting: Never fabricate live MT5 broker execution without verified broker bridge/endpoint
  return {
    id: `ord-unavail-${nowMs}`,
    signalId: signal.id,
    idempotencyKey,
    timestamp: new Date(nowMs).toISOString(),
    lusakaTime: clk.timeLusaka,
    symbol,
    side,
    requestedEntry,
    actualFillPrice: null,
    lots: signal.suggestedLots,
    stop,
    tp1,
    tp2,
    tp3,
    status: 'EXECUTION_UNAVAILABLE',
    brokerOrderId: null,
    environment,
    adapterUsed: 'NONE',
    errorMessage:
      `Live ${user.brokerName || 'MT5'} (${user.accountType} #${user.mt5Login || 'account'}) order placement requires a verified Broker Bridge URL in Broker Settings. Signal was not marked filled.`,
  };
}

export async function closeAllPositionsSafely(params: {
  user: StoredUser;
  confirm: boolean;
  latestMarketPrice: number | null;
  bid?: number | null;
  ask?: number | null;
  digits?: number;
  contractSize?: number;
}): Promise<{
  ok: boolean;
  closedCount: number;
  message: string;
}> {
  const {
    user,
    confirm,
    latestMarketPrice,
    bid = null,
    ask = null,
    digits = 2,
    contractSize = 100,
  } = params;
  if (!confirm) {
    return {
      ok: false,
      closedCount: 0,
      message: 'Explicit user confirmation required to close all open positions.',
    };
  }

  const openTrades = (user.tradeLog ?? []).filter((t) => t.status === 'OPEN');
  if (openTrades.length === 0) {
    return {
      ok: true,
      closedCount: 0,
      message: 'No open positions to close.',
    };
  }

  const bridgeUrl = (user.brokerBridgeUrl || '').trim();
  if (bridgeUrl && isSafeExternalUrl(bridgeUrl).safe) {
    try {
      await fetch(bridgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'close_all',
          broker: user.brokerName || 'XM',
          server: user.brokerServer,
          account: user.mt5Login,
        }),
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      // Proceed to mark internal ledger closed while noting remote bridge notification attempted
    }
  }

  const nowIso = new Date().toISOString();
  let totalDelta = 0;
  let lastExitPx = latestMarketPrice ?? openTrades[0].entry;

  for (const t of openTrades) {
    const closingQuote =
      t.side === 'BUY'
        ? bid !== null && Number.isFinite(bid) && bid > 0
          ? bid
          : latestMarketPrice ?? t.entry
        : ask !== null && Number.isFinite(ask) && ask > 0
          ? ask
          : latestMarketPrice ?? t.entry;
    const exitPx = roundToDigits(closingQuote, digits);
    lastExitPx = exitPx;
    const remainingFrac = t.tp2Hit ? 0.33 : t.tp1Hit ? 0.66 : 1.0;
    const rawDiff = t.side === 'BUY' ? exitPx - t.entry : t.entry - exitPx;
    const remPnl = round2(rawDiff * t.lots * remainingFrac * contractSize);
    const partialRealized = (t.tp1RealizedPnl ?? 0) + (t.tp2RealizedPnl ?? 0);
    const finalPnl = round2(partialRealized + remPnl);
    t.status = 'CLOSED';
    t.closedAt = nowIso;
    t.exitPrice = exitPx;
    t.pnlDollars = finalPnl;
    t.notes = `${t.notes ? `${t.notes} · ` : ''}Closed via Close-All safeguard`;
    totalDelta = round2(totalDelta + remPnl);
  }

  if (totalDelta !== 0) {
    user.balance = round2(user.balance + totalDelta);
    user.equity = user.balance;
  }

  return {
    ok: true,
    closedCount: openTrades.length,
    message: `Closed ${openTrades.length} open position(s) near $${lastExitPx.toFixed(digits)}.`,
  };
}

export function getTickerAllCapabilitiesReport(settings?: StrategySettings) {
  const cfg = mergeEmaProConfig(settings?.emaPro);
  return {
    bridge: 'TickerAll Proxy Master Feed + Multi-Broker MT5 Bridge (XM / Exness / Weltrade / Other)',
    marketDataAuth: 'Bearer / X-API-Key / Query API Key via POST /v1/sessions',
    streamingFeed: 'WebSocket ticks, account equity/balance/margin, OHLC history',
    historicalRest: 'GET /v1/accounts/:id/candles & /v1/history (M5, M15, H1)',
    tradeExecution:
      'Safe Adapter: Demo Paper Simulation (Demo) + Live/Demo HTTP Broker Bridge URL with Idempotency Keys (XM Standard/Micro, Exness Standard/Cent/Raw, Weltrade Micro/Cent/Pro)',
    symbolMapping: `Feed: GOLD -> Order Symbol: ${cfg.xauusdSymbol}`,
    idempotency: 'Enabled (user.id + signal.id)',
  };
}
