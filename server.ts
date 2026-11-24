import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { Request, Response } from 'express';
import {
  calculateTieredAutoLot,
  DEFAULT_STRATEGY_SETTINGS,
  derivePreviousDayRangeFromCandles,
  determineSessionPhase,
  evaluateUsdNewsClearance,
  getLusakaClock,
  parseHHMMToMinutes,
  round2,
} from './src/utils/strategyEngine.ts';
import {
  computePerformanceSummary,
  DEFAULT_EMA_PRO_CONFIG,
  evaluateEmaStochasticProSignal,
  mergeEmaProConfig,
  runEmaStochasticProBacktest,
} from './src/utils/emaStochasticPro.ts';
import {
  computeSpreadMetrics,
  DEFAULT_SYMBOL_SPEC,
  evaluateDynamicSpread,
  getEffectiveSideClosingPrice,
  inferBrokerAccountVariant,
  resolveAccountVariantSpec,
  resolveSymbolSpecification,
  roundToDigits,
} from './src/utils/dynamicSpread.ts';
import {
  closeAllPositionsSafely,
  executeTradeViaTickerAllAdapter,
  getTickerAllCapabilitiesReport,
} from './server/tickerAllExecution.ts';
import {
  extractBarsFromTickerAllPayload,
  fetchRealTickerAllHistoricalCandles,
  getTickerAllHistorySnapshot,
  ingestRealTickerAllHistoryCandles,
  recordPrimaryTickerAllTick,
  saveHistoryCacheNow,
} from './server/tickerAllHistory.ts';
import {
  ADMIN_COOKIE_NAME,
  applyMasterConfigSyncBundle,
  applyPublicConfigHydration,
  buildDefaultUserSettings,
  clearAuthCookie,
  computeUserDailyPnl,
  createFreshDayLevels,
  createOrAuthorizeTestAccount,
  decryptSecret,
  encryptSecret,
  ensureUserDayRollover,
  findUserByFirebaseUid,
  findUserById,
  findUserByPhone,
  getAdminMasterPassword,
  getAdminSpreadPolicy,
  getAdminTickerAllKey,
  getAuthenticatedUser,
  getStore,
  getUserSessionMeta,
  hashPassword,
  hasWrongBrokerSetup,
  incrementTickerAllQuota,
  isAdminAuthenticated,
  isBrokerSetupComplete,
  issueAdminSessionCookie,
  issueUserSessionCookie,
  normalizeBrokerSetup,
  normalizePhone,
  recomputeUserTradeCountsForToday,
  refreshAllUserExpiries,
  saveStoreNow,
  scheduleStoreSave,
  toAdminUserRow,
  toMasterConfigSyncBundle,
  toPublicUser,
  toUserSyncBundle,
  updateAdminSpreadPolicy,
  upsertUserFromSyncBundle,
  USER_COOKIE_NAME,
  verifyPassword,
  type StoredUser,
} from './server/businessStore.ts';
import {
  fetchFirestoreCollectionWithUserToken,
  fetchFirestoreDocWithUserToken,
  fetchPublicFirestoreDoc,
  verifyFirebaseIdToken,
} from './server/firebaseTokenVerifier.ts';
import { reviewTradeWithGeminiApprover } from './server/geminiApprover.ts';
import { isSafeExternalUrl } from './server/urlSafety.ts';
import type {
  AdminDashboardData,
  AdminSpreadPolicy,
  BotStateSnapshot,
  BrokerAccountSetup,
  DaySessionLevels,
  DynamicSpreadEvaluation,
  M15Candle,
  MasterConfigSyncBundle,
  MoMoConfig,
  NormalizedTick,
  PlanPricing,
  RiskEventRecord,
  SessionPhase,
  SignalHistoryEntry,
  SpreadSampleRecord,
  StrategySettings,
  SubscriptionPlan,
  SymbolSpecification,
  TradeLogEntry,
  TradingSessionTag,
  UsdNewsEvent,
  UserSyncBundle,
} from './src/types/connectivity.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_DEV_MODE =
  process.env.npm_lifecycle_event === 'dev' ||
  (process.env.NODE_ENV !== 'production' &&
    process.env.npm_lifecycle_event !== 'start' &&
    Boolean(process.env.NGINX_PORT));

function resolveServerPort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (args[i].startsWith('--port=')) {
      const parsed = Number(args[i].slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const envPort = Number(process.env.PORT);
  if (IS_DEV_MODE) {
    if (Number.isFinite(envPort) && envPort > 0 && envPort !== 8080) {
      return envPort;
    }
    return 3000;
  }
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}

const PORT = resolveServerPort();

type AdapterId =
  | 'tickerall-ws'
  | 'bullion-kraken'
  | 'bullion-coinbase'
  | 'comex-futures'
  | 'spot-gold-api';

type AuthHeaderMode = 'bearer' | 'x-api-key' | 'query-param' | 'none';
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error';
type TransportMode = 'websocket' | 'http-poll';

interface SchemaMapping {
  symbolPath: string;
  pricePath: string;
  bidPath: string;
  askPath: string;
  volumePath: string;
  change24hPath: string;
  timestampPath: string;
}

interface SymbolBinding {
  internalSymbol: string;
  upstreamSymbol: string;
  contractUnit: string;
  tickSize: number;
  enabled: boolean;
}

type BrokerType = 'mt5' | 'mt4' | 'ctrader' | 'dxtrade';

interface ConnectionConfig {
  adapterId: AdapterId;
  connectionName: string;
  baseUrl: string;
  endpointPath: string;
  symbol: string;
  authHeaderMode: AuthHeaderMode;
  pollIntervalMs: number;
  timeoutMs: number;
  brokerType: BrokerType;
  brokerServer: string;
  mt5AccountNumber: string;
  hasBrokerPassword?: boolean;
  schemaMapping: SchemaMapping;
  symbolBindings: SymbolBinding[];
}

interface DiagnosticLog {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warning' | 'error';
  event: string;
  adapterId: AdapterId;
  endpoint: string;
  httpStatus: number | null;
  latencyMs: number | null;
  detail: string;
}

interface RawWsFrame {
  index: number;
  receivedAt: string;
  payload: string;
  isJson?: boolean;
}

interface SessionInfo {
  transport: TransportMode;
  sessionId: string | null;
  accountId: string | null;
  wsUrl: string | null;
  wsReadyState: 'closed' | 'connecting' | 'open';
  tickConfirmed: boolean;
  subscribedConfirmed: boolean;
  quietMarketNotice: string | null;
  subscribedSymbols: string[];
  rejectedSymbols: string[];
  lastTickAt: string | null;
  totalTickFrames: number;
  rawWsFrames: RawWsFrame[];
  rawSessionResponse: unknown | null;
  rawSessionResponseAt: string | null;
}

interface AccountProbeAttempt {
  method: 'GET' | 'POST';
  endpoint: string;
  httpStatus: number | null;
  statusLabel: string;
  worked: boolean;
  detail?: string;
}

interface AccountBalanceInfo {
  broker: string;
  server: string;
  accountNumber: string;
  accountId: string;
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  currency: string;
  sourceEndpoint: string | null;
  statusMessage: string | null;
  lastUpdatedAt: string | null;
  attempts: AccountProbeAttempt[];
}

const ADAPTER_DEFAULTS: Record<
  AdapterId,
  {
    connectionName: string;
    baseUrl: string;
    endpointPath: string;
    symbol: string;
    authHeaderMode: AuthHeaderMode;
    transport: TransportMode;
    schemaMapping: SchemaMapping;
    sourceLabel: string;
  }
> = {
  'tickerall-ws': {
    connectionName: 'TickerAll Session + WebSocket',
    baseUrl: process.env.TICKERALL_BASE_URL?.trim() || 'https://api.tickerall.com',
    endpointPath: '/v1/sessions',
    symbol: 'GOLD',
    authHeaderMode: 'bearer',
    transport: 'websocket',
    schemaMapping: {
      symbolPath: 'symbol',
      pricePath: 'last',
      bidPath: 'bid',
      askPath: 'ask',
      volumePath: 'volume',
      change24hPath: 'change_pct',
      timestampPath: 'timestamp',
    },
    sourceLabel: 'TickerAll Live',
  },
  'bullion-kraken': {
    connectionName: 'Kraken Gold Bullion Spot',
    baseUrl: 'https://api.kraken.com',
    endpointPath: '/0/public/Ticker?pair={symbol}',
    symbol: 'PAXGUSD',
    authHeaderMode: 'none',
    transport: 'http-poll',
    schemaMapping: {
      symbolPath: 'result.PAXGUSD',
      pricePath: 'result.PAXGUSD.c[0]',
      bidPath: 'result.PAXGUSD.b[0]',
      askPath: 'result.PAXGUSD.a[0]',
      volumePath: 'result.PAXGUSD.v[1]',
      change24hPath: 'result.PAXGUSD.o',
      timestampPath: '',
    },
    sourceLabel: 'Kraken Public Spot',
  },
  'bullion-coinbase': {
    connectionName: 'Coinbase PAXG Bullion Ticker',
    baseUrl: 'https://api.exchange.coinbase.com',
    endpointPath: '/products/{symbol}/ticker',
    symbol: 'PAXG-USD',
    authHeaderMode: 'none',
    transport: 'http-poll',
    schemaMapping: {
      symbolPath: 'trade_id',
      pricePath: 'price',
      bidPath: 'bid',
      askPath: 'ask',
      volumePath: 'volume',
      change24hPath: '',
      timestampPath: 'time',
    },
    sourceLabel: 'Coinbase Exchange',
  },
  'comex-futures': {
    connectionName: 'COMEX Gold Futures Feed',
    baseUrl: 'https://query1.finance.yahoo.com',
    endpointPath: '/v8/finance/chart/{symbol}?interval=1m&range=1d',
    symbol: 'GC=F',
    authHeaderMode: 'none',
    transport: 'http-poll',
    schemaMapping: {
      symbolPath: 'chart.result[0].meta.symbol',
      pricePath: 'chart.result[0].meta.regularMarketPrice',
      bidPath: 'chart.result[0].meta.bid',
      askPath: 'chart.result[0].meta.ask',
      volumePath: 'chart.result[0].meta.regularMarketVolume',
      change24hPath: 'chart.result[0].meta.chartPreviousClose',
      timestampPath: 'chart.result[0].meta.regularMarketTime',
    },
    sourceLabel: 'COMEX Futures (GC=F)',
  },
  'spot-gold-api': {
    connectionName: 'Spot XAU/USD Reference',
    baseUrl: 'https://api.gold-api.com',
    endpointPath: '/price/{symbol}',
    symbol: 'XAU',
    authHeaderMode: 'none',
    transport: 'http-poll',
    schemaMapping: {
      symbolPath: 'symbol',
      pricePath: 'price',
      bidPath: 'price',
      askPath: 'price',
      volumePath: '',
      change24hPath: '',
      timestampPath: 'updatedAt',
    },
    sourceLabel: 'Gold-API Spot XAU',
  },
};

const DEFAULT_BINDINGS: SymbolBinding[] = [
  {
    internalSymbol: 'XAU/USD',
    upstreamSymbol: 'XAUUSD',
    contractUnit: '1 troy oz',
    tickSize: 0.01,
    enabled: true,
  },
  {
    internalSymbol: 'XAU/USD-SPOT',
    upstreamSymbol: 'PAXGUSD',
    contractUnit: '1 troy oz',
    tickSize: 0.01,
    enabled: true,
  },
  {
    internalSymbol: 'GC=F',
    upstreamSymbol: 'GC=F',
    contractUnit: '100 troy oz',
    tickSize: 0.1,
    enabled: true,
  },
  {
    internalSymbol: 'PAXG/USD',
    upstreamSymbol: 'PAXG-USD',
    contractUnit: '1 token (1 oz)',
    tickSize: 0.01,
    enabled: true,
  },
];

const storeRef = getStore();
const initialAdapter: AdapterId = 'tickerall-ws';

const state: {
  status: ConnectionState;
  lastError: string | null;
  connectedSince: string | null;
  packetsReceived: number;
  failedProbes: number;
  latencySamples: number[];
  config: ConnectionConfig;
  sessionInfo: SessionInfo;
  accountInfo: AccountBalanceInfo;
  latestTick: NormalizedTick | null;
  fallbackTick: NormalizedTick | null;
  recentTicks: NormalizedTick[];
  fallbackTicks: NormalizedTick[];
  logs: DiagnosticLog[];
  seqCounter: number;
  wsFrameCounter: number;
  sessionGeneration: number;
  timer: ReturnType<typeof setInterval> | null;
  fallbackTimer: ReturnType<typeof setInterval> | null;
  accountTimer: ReturnType<typeof setInterval> | null;
  activeWs: WebSocket | null;
  probeInFlight: boolean;
  fallbackInFlight: boolean;
  lastMasterFetchAttemptMs: number;
  lastPrimaryTickMs: number;
  lastAnyFeedSuccessMs: number;
  lastFeedBootMs: number;
  lastAutoReconnectAttemptMs: number;
} = {
  status: 'disconnected',
  lastError: null,
  connectedSince: null,
  packetsReceived: 0,
  failedProbes: 0,
  latencySamples: [],
  config: {
    adapterId: initialAdapter,
    connectionName: ADAPTER_DEFAULTS[initialAdapter].connectionName,
    baseUrl: storeRef.tickerAllMaster.baseUrl || ADAPTER_DEFAULTS[initialAdapter].baseUrl,
    endpointPath: ADAPTER_DEFAULTS[initialAdapter].endpointPath,
    symbol: ADAPTER_DEFAULTS[initialAdapter].symbol,
    authHeaderMode: ADAPTER_DEFAULTS[initialAdapter].authHeaderMode,
    pollIntervalMs: 2000,
    timeoutMs: 6000,
    brokerType: 'mt5',
    brokerServer: storeRef.tickerAllMaster.brokerServer || '',
    mt5AccountNumber: storeRef.tickerAllMaster.mt5AccountNumber || '',
    hasBrokerPassword: Boolean(getAdminMasterPassword()),
    schemaMapping: { ...ADAPTER_DEFAULTS[initialAdapter].schemaMapping },
    symbolBindings: DEFAULT_BINDINGS,
  },
  sessionInfo: {
    transport: ADAPTER_DEFAULTS[initialAdapter].transport,
    sessionId: null,
    accountId: null,
    wsUrl: null,
    wsReadyState: 'closed',
    tickConfirmed: false,
    subscribedConfirmed: false,
    quietMarketNotice: null,
    subscribedSymbols: [],
    rejectedSymbols: [],
    lastTickAt: null,
    totalTickFrames: 0,
    rawWsFrames: [],
    rawSessionResponse: null,
    rawSessionResponseAt: null,
  },
  accountInfo: {
    broker: 'mt5',
    server: storeRef.tickerAllMaster.brokerServer || '',
    accountNumber: storeRef.tickerAllMaster.mt5AccountNumber || '',
    accountId: '',
    balance: null,
    equity: null,
    margin: null,
    freeMargin: null,
    currency: 'USD',
    sourceEndpoint: null,
    statusMessage: null,
    lastUpdatedAt: null,
    attempts: [],
  },
  latestTick: null,
  fallbackTick: null,
  recentTicks: [],
  fallbackTicks: [],
  logs: [],
  seqCounter: 0,
  wsFrameCounter: 0,
  sessionGeneration: 0,
  timer: null,
  fallbackTimer: null,
  accountTimer: null,
  activeWs: null,
  probeInFlight: false,
  fallbackInFlight: false,
  lastMasterFetchAttemptMs: 0,
  lastPrimaryTickMs: 0,
  lastAnyFeedSuccessMs: 0,
  lastFeedBootMs: Date.now(),
  lastAutoReconnectAttemptMs: 0,
};

const proxyMarketState: {
  currentCandle: M15Candle | null;
  currentM5Candle: M15Candle | null;
  closedCandles: M15Candle[];
  closedM5Candles: M15Candle[];
  lastBroadcastKey: string;
  clockTimer: ReturnType<typeof setInterval> | null;
} = {
  currentCandle: null,
  currentM5Candle: null,
  closedCandles: getTickerAllHistorySnapshot()
    .m15Candles.slice(-120)
    .reverse(),
  closedM5Candles: getTickerAllHistorySnapshot()
    .m5Candles.slice(-260)
    .reverse(),
  lastBroadcastKey: '',
  clockTimer: null,
};

const initialSpreadPolicy = getAdminSpreadPolicy();
const spreadTelemetryState: {
  observedSpreadHistory: SpreadSampleRecord[];
  liveSymbolSpec: SymbolSpecification;
} = {
  observedSpreadHistory: [],
  liveSymbolSpec: {
    ...DEFAULT_SYMBOL_SPEC,
    digits: initialSpreadPolicy.defaultDigits,
    pointSize: initialSpreadPolicy.defaultPointSize,
    commissionPerLot: initialSpreadPolicy.commissionPerLot,
  },
};

function recordObservedSpreadSample(tick: NormalizedTick): void {
  if (tick.isFallback || !tick.hasTwoSidedQuote) return;
  if (!Number.isFinite(tick.bid) || !Number.isFinite(tick.ask) || tick.bid <= 0 || tick.ask < tick.bid) {
    return;
  }
  const tsMs = Date.parse(tick.receivedAt);
  const nowMs = Number.isFinite(tsMs) ? tsMs : Date.now();
  const pointSize = tick.pointSize ?? spreadTelemetryState.liveSymbolSpec.pointSize;
  const spreadPrice = tick.ask - tick.bid;
  const spreadPoints =
    typeof tick.spreadPoints === 'number' && Number.isFinite(tick.spreadPoints)
      ? tick.spreadPoints
      : pointSize > 0
        ? Math.round((spreadPrice / pointSize) * 10) / 10
        : 0;

  spreadTelemetryState.observedSpreadHistory.push({
    timestampMs: nowMs,
    symbol: tick.upstreamSymbol || spreadTelemetryState.liveSymbolSpec.symbol,
    bid: tick.bid,
    ask: tick.ask,
    spreadPrice,
    spreadPoints,
    pointSize,
    hasTwoSidedQuote: true,
    source: tick.sourceLabel || 'XM TickerAll Live Feed',
  });

  const cutoff24h = nowMs - 24 * 60 * 60 * 1000;
  if (
    spreadTelemetryState.observedSpreadHistory.length > 10_000 ||
    (spreadTelemetryState.observedSpreadHistory.length > 500 &&
      spreadTelemetryState.observedSpreadHistory[0].timestampMs < cutoff24h)
  ) {
    spreadTelemetryState.observedSpreadHistory = spreadTelemetryState.observedSpreadHistory
      .filter((s) => s.timestampMs >= cutoff24h)
      .slice(-10_000);
  }
}

function get24hSpreadHistory(nowMs = Date.now()): SpreadSampleRecord[] {
  const cutoff24h = nowMs - 24 * 60 * 60 * 1000;
  return spreadTelemetryState.observedSpreadHistory.filter(
    (s) => s.timestampMs >= cutoff24h && s.hasTwoSidedQuote
  );
}

function updateLiveSymbolSpecFromPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const policy = getAdminSpreadPolicy();
  const stack: unknown[] = [payload];
  const objs: Array<Record<string, unknown>> = [];
  let depth = 0;
  while (stack.length > 0 && depth < 40) {
    depth += 1;
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      for (const el of item.slice(0, 12)) stack.push(el);
      continue;
    }
    const rec = item as Record<string, unknown>;
    objs.push(rec);
    for (const k of ['data', 'symbolInfo', 'symbol_info', 'symbolSpec', 'instrument', 'session', 'result', 'symbols']) {
      if (rec[k] && typeof rec[k] === 'object') stack.push(rec[k]);
    }
  }

  for (const rec of objs) {
    const rawDigits = toFiniteNumber(rec.digits ?? rec.precision);
    const rawPoint = toFiniteNumber(rec.pointSize ?? rec.point_size ?? rec.point);
    const rawTick = toFiniteNumber(rec.tickSize ?? rec.tick_size);
    const rawContract = toFiniteNumber(rec.contractSize ?? rec.contract_size);
    const rawSym = typeof rec.symbol === 'string' && rec.symbol.trim() ? rec.symbol.trim() : null;
    if (rawDigits !== null || rawPoint !== null || rawTick !== null || rawContract !== null) {
      spreadTelemetryState.liveSymbolSpec = resolveSymbolSpecification({
        symbol: rawSym || spreadTelemetryState.liveSymbolSpec.symbol,
        explicitDigits: rawDigits,
        explicitPointSize: rawPoint,
        explicitTickSize: rawTick,
        explicitContractSize: rawContract,
        commissionPerLot: policy.commissionPerLot,
        fallbackSpec: spreadTelemetryState.liveSymbolSpec,
      });
      return;
    }
  }
}

function getEffectiveSymbolSpecForUser(user?: StoredUser): SymbolSpecification {
  const policy = getAdminSpreadPolicy();
  const cfg = user ? mergeEmaProConfig(user.settings.emaPro) : null;
  const baseSpec: SymbolSpecification = {
    ...spreadTelemetryState.liveSymbolSpec,
    symbol: cfg?.xauusdSymbol || spreadTelemetryState.liveSymbolSpec.symbol || 'XAUUSD',
    commissionPerLot:
      cfg && cfg.commissionPerLot > 0 ? cfg.commissionPerLot : policy.commissionPerLot,
  };
  if (!user) return baseSpec;
  const variant = inferBrokerAccountVariant(user.brokerSetup, user.brokerName, baseSpec.symbol);
  return resolveAccountVariantSpec(baseSpec, variant);
}

function buildEffectiveSettingsForEvaluation(user: StoredUser): StrategySettings {
  const policy = getAdminSpreadPolicy();
  const userCfg = mergeEmaProConfig(user.settings.emaPro);
  // Respect admin max spread cap as upper bound while allowing user tighter configuration
  const effectiveMaxSpread = Math.min(userCfg.maxSpreadPips, policy.maxSpreadPoints);
  return {
    ...user.settings,
    emaPro: {
      ...userCfg,
      maxSpreadPips: effectiveMaxSpread,
    },
  };
}

function getLiveQuoteContext(
  nowMs = Date.now(),
  feedInfo?: ReturnType<typeof getProxyFeedInfo>
): {
  tick: NormalizedTick | null;
  bid: number | null;
  ask: number | null;
  latestPrice: number | null;
  hasTwoSidedQuote: boolean;
  isFallbackOnly: boolean;
  quoteTimestamp: string | null;
  quoteSource: string;
} {
  if (feedInfo && (!feedInfo.allowed || feedInfo.reconnecting)) {
    return {
      tick: null,
      bid: null,
      ask: null,
      latestPrice: null,
      hasTwoSidedQuote: false,
      isFallbackOnly: false,
      quoteTimestamp: null,
      quoteSource: feedInfo.message,
    };
  }
  const hasPrimaryTick =
    Boolean(state.latestTick) &&
    !state.latestTick?.isFallback &&
    Boolean(state.sessionInfo.tickConfirmed) &&
    (feedInfo ? feedInfo.isLive : state.status === 'connected');

  if (hasPrimaryTick && state.latestTick) {
    const t = state.latestTick;
    return {
      tick: t,
      bid: t.hasTwoSidedQuote ? t.bid : null,
      ask: t.hasTwoSidedQuote ? t.ask : null,
      latestPrice: t.last,
      hasTwoSidedQuote: Boolean(t.hasTwoSidedQuote),
      isFallbackOnly: false,
      quoteTimestamp: t.receivedAt,
      quoteSource: `${t.sourceLabel} (${t.upstreamSymbol || 'GOLD'})`,
    };
  }

  if (state.fallbackTick) {
    return {
      tick: null,
      bid: null,
      ask: null,
      latestPrice: state.fallbackTick.last,
      hasTwoSidedQuote: false,
      isFallbackOnly: true,
      quoteTimestamp: state.fallbackTick.receivedAt,
      quoteSource: 'Fallback Reference Price (MT5 Two-Sided Quote Unavailable)',
    };
  }

  return {
    tick: null,
    bid: null,
    ask: null,
    latestPrice: null,
    hasTwoSidedQuote: false,
    isFallbackOnly: false,
    quoteTimestamp: null,
    quoteSource: 'UNAVAILABLE',
  };
}

// Strictly track SSE connections mapped to their authenticated userId
const sseClients = new Map<Response, string>();

function sanitizeTickForUser(tick: NormalizedTick | null): NormalizedTick | null {
  if (!tick) return null;
  return {
    seq: tick.seq,
    adapterId: 'tickerall-ws',
    symbol: 'GOLD',
    upstreamSymbol: 'GOLD',
    last: tick.last,
    bid: tick.bid,
    ask: tick.ask,
    mid: tick.mid,
    spread: tick.spread,
    spreadPoints: tick.spreadPoints,
    spreadBps: tick.spreadBps,
    digits: tick.digits ?? spreadTelemetryState.liveSymbolSpec.digits,
    pointSize: tick.pointSize ?? spreadTelemetryState.liveSymbolSpec.pointSize,
    hasTwoSidedQuote: Boolean(tick.hasTwoSidedQuote),
    volume24h: tick.volume24h,
    change24hPct: tick.change24hPct,
    latencyMs: tick.latencyMs,
    httpStatus: 200,
    receivedAt: tick.receivedAt,
    upstreamTimestamp: tick.upstreamTimestamp,
    sourceLabel: tick.isFallback ? 'Proxy Reference' : 'Proxy Feed',
    isFallback: tick.isFallback,
    rawPayload: undefined,
  };
}

const MASTER_FEED_CACHE_MS = 2800;
const FEED_STALE_PAUSE_MS = 15_000;

function getLatestFeedDataMs(): number {
  const latestTickMs = state.latestTick?.receivedAt ? Date.parse(state.latestTick.receivedAt) : 0;
  const fallbackTickMs = state.fallbackTick?.receivedAt ? Date.parse(state.fallbackTick.receivedAt) : 0;
  return Math.max(
    state.lastAnyFeedSuccessMs || 0,
    Number.isFinite(latestTickMs) ? latestTickMs : 0,
    Number.isFinite(fallbackTickMs) ? fallbackTickMs : 0
  );
}

function isMasterFeedStale15s(nowMs = Date.now()): boolean {
  if (getLusakaClock(nowMs).isWeekend) return false;
  const latestMs = getLatestFeedDataMs();
  const refMs = latestMs > 0 ? latestMs : state.lastFeedBootMs;
  return nowMs - refMs >= FEED_STALE_PAUSE_MS;
}

function getProxyFeedInfo(user: StoredUser, nowMs = Date.now()): {
  status: 'LIVE' | 'OFFLINE' | 'LOCKED' | 'RECONNECTING';
  label: string;
  isLive: boolean;
  reconnecting: boolean;
  lastUpdatedAt: string | null;
  message: string;
  allowed: boolean;
} {
  refreshAllUserExpiries();
  const latestMs = getLatestFeedDataMs();
  const lastUpdatedAt = latestMs > 0 ? new Date(latestMs).toISOString() : null;

  if (user.status !== 'ACTIVE' || !user.feedAccess) {
    const reasonLabel =
      user.status === 'PENDING'
        ? 'Pending Admin Approval'
        : user.status === 'EXPIRED'
          ? 'Subscription Expired'
          : user.status === 'BLOCKED'
            ? 'Account Blocked'
            : 'Feed Paused by Admin';
    return {
      status: 'LOCKED',
      label: 'Feed Locked ●',
      isLive: false,
      reconnecting: false,
      lastUpdatedAt: null,
      message: `${reasonLabel} — No Feed Access`,
      allowed: false,
    };
  }

  if (isMasterFeedStale15s(nowMs)) {
    return {
      status: 'RECONNECTING',
      label: 'Feed Paused ●',
      isLive: false,
      reconnecting: true,
      lastUpdatedAt,
      message: 'Feed Paused - Reconnecting...',
      allowed: true,
    };
  }

  const adminFeedOnline =
    state.status === 'connected' ||
    (state.status === 'connecting' && state.sessionInfo.subscribedConfirmed) ||
    Boolean(state.latestTick && state.sessionInfo.tickConfirmed);

  if (adminFeedOnline) {
    return {
      status: 'LIVE',
      label: 'Feed: Live ●',
      isLive: true,
      reconnecting: false,
      lastUpdatedAt,
      message: state.latestTick
        ? 'Proxy GOLD Feed Live'
        : 'Proxy Subscribed — Waiting for Market Tick',
      allowed: true,
    };
  }

  return {
    status: 'OFFLINE',
    label: 'Feed Offline ●',
    isLive: false,
    reconnecting: false,
    lastUpdatedAt,
    message: 'Feed Offline - Contact Admin',
    allowed: true,
  };
}

function getEffectiveProxyPrice(nowMs = Date.now()): number | null {
  if (isMasterFeedStale15s(nowMs)) return null;
  return state.latestTick?.last ?? state.fallbackTick?.last ?? null;
}

function mergeCandleCollections(a: M15Candle[], b: M15Candle[]): M15Candle[] {
  const byTs = new Map<number, M15Candle>();
  for (const c of a) {
    if (c && c.closed) byTs.set(c.openTimeMs, c);
  }
  for (const c of b) {
    if (c && c.closed) byTs.set(c.openTimeMs, c);
  }
  return Array.from(byTs.values()).sort((a, b) => a.openTimeMs - b.openTimeMs);
}

function getUserBotSnapshot(user: StoredUser, nowMs = Date.now()): BotStateSnapshot {
  ensureUserDayRollover(user, nowMs);
  const feedInfo = getProxyFeedInfo(user, nowMs);
  const clock = getLusakaClock(nowMs);
  const hist = feedInfo.allowed
    ? getTickerAllHistorySnapshot()
    : { m1Candles: [], m5Candles: [], m15Candles: [], h1Candles: [] };

  const livePrice = feedInfo.allowed && !feedInfo.reconnecting ? getEffectiveProxyPrice(nowMs) : null;
  const strategyModule = 'EMA_STOCHASTIC_PRO' as const;
  const phaseRes = determineSessionPhase(clock.minutes, user.settings, clock.isWeekend);
  const newsStatus = evaluateUsdNewsClearance(clock.minutes, user.settings);
  const d1Derived = derivePreviousDayRangeFromCandles(
    feedInfo.allowed ? hist.m15Candles : [],
    clock.dateLusaka
  );

  if (!user.levels.manualOverride && d1Derived.pdh !== null && d1Derived.pdl !== null) {
    user.levels.pdh = d1Derived.pdh;
    user.levels.pdl = d1Derived.pdl;
    user.levels.prevDayDate = d1Derived.prevDayDate;
  }

  const { dailyPnlDollars, dailyPnlPct, dailyGuardHit } = computeUserDailyPnl(
    user,
    clock.dateLusaka
  );
  const symbolSpec = getEffectiveSymbolSpecForUser(user);
  const autoLotInfo = calculateTieredAutoLot(
    user.balance,
    user.settings.maxAutoLotCap ?? 0.5,
    symbolSpec.contractSize,
    symbolSpec.currency ?? 'USD'
  );

  const m5Combined = feedInfo.allowed
    ? mergeCandleCollections(hist.m5Candles, proxyMarketState.closedM5Candles)
    : [];
  const m15Combined = feedInfo.allowed
    ? mergeCandleCollections(hist.m15Candles, proxyMarketState.closedCandles)
    : [];
  const h1Combined = feedInfo.allowed ? hist.h1Candles : [];
  const openCount = user.tradeLog.filter((t) => t.status === 'OPEN').length;
  const quoteCtx = getLiveQuoteContext(nowMs, feedInfo);
  const effectiveSettings = buildEffectiveSettingsForEvaluation(user);
  const spreadHistory = feedInfo.allowed ? get24hSpreadHistory(nowMs) : [];

  const emaEval = evaluateEmaStochasticProSignal({
    h1Candles: h1Combined,
    m15Candles: m15Combined,
    m5Candles: m5Combined,
    m1Candles: hist.m1Candles,
    settings: effectiveSettings,
    levels: user.levels,
    phase: phaseRes.phase,
    latestPrice: quoteCtx.latestPrice,
    bid: quoteCtx.bid,
    ask: quoteCtx.ask,
    quoteTimestamp: quoteCtx.quoteTimestamp,
    quoteSource: quoteCtx.quoteSource,
    hasTwoSidedQuote: quoteCtx.hasTwoSidedQuote,
    isFallbackOnly: quoteCtx.isFallbackOnly,
    symbolSpec,
    spreadHistory,
    accountEquity: user.equity > 0 ? user.equity : user.balance,
    openPositionsCount: openCount,
    dailyPnlPct,
    isWeekend: clock.isWeekend,
    feedConnected: feedInfo.isLive,
    nowMs,
  });

  const performance = computePerformanceSummary({
    tradeLog: user.tradeLog,
    signalHistory: user.signalHistory,
    startingBalance: user.balance,
  });

  return {
    strategyModule,
    lusakaDate: clock.dateLusaka,
    lusakaTime: clock.timeLusaka,
    lusakaMinutes: clock.minutes,
    lusakaWeekday: clock.weekday,
    isWeekend: clock.isWeekend,
    m15HistoryCount: feedInfo.allowed ? m15Combined.length : 0,
    m5HistoryCount: feedInfo.allowed ? m5Combined.length : 0,
    m1HistoryCount: feedInfo.allowed ? hist.m1Candles.length : 0,
    h1HistoryCount: feedInfo.allowed ? h1Combined.length : 0,
    phase: phaseRes.phase,
    phaseLabel: phaseRes.phaseLabel,
    activeStrategyName: phaseRes.activeStrategyName,
    brokerFeedLabel: `${user.brokerName || 'MT5'} (${user.accountType || 'Demo'}) · TickerAll`,
    newsStatus: {
      ...newsStatus,
      feedAvailable: emaEval.analysis.newsFeedStatus === 'CALENDAR_CONFIGURED',
    },
    settings: user.settings,
    levels: user.levels,
    currentCandle: feedInfo.allowed ? proxyMarketState.currentCandle : null,
    currentM5Candle: feedInfo.allowed ? proxyMarketState.currentM5Candle : null,
    closedCandles: feedInfo.allowed ? proxyMarketState.closedCandles : [],
    closedM5Candles: feedInfo.allowed ? m5Combined.slice(-220).reverse() : [],
    closedH1Candles: feedInfo.allowed ? h1Combined.slice(-120).reverse() : [],
    emaPro: emaEval.analysis,
    activeSignal: emaEval.signal,
    recentSignals: [],
    signalHistory: user.signalHistory,
    tradeLog: user.tradeLog,
    tradeOrders: user.tradeOrders ?? [],
    riskEvents: user.riskEvents ?? [],
    auditLogs: user.auditLogs ?? [],
    notifications: user.notifications ?? [],
    performance,
    dailyPnlDollars,
    dailyPnlPct,
    dailyDrawdownPct: performance.maxDrawdownPct,
    dailyGuardHit,
    consecutiveLossesToday: user.levels.consecutiveLossesToday,
    autoLotInfo,
    spreadEvaluation: emaEval.analysis.spreadEvaluation ?? undefined,
    spreadRejectedCount: user.spreadRejectedCountToday ?? 0,
    acceptedAbove45Count: user.acceptedAbove45CountToday ?? 0,
    symbolSpec,
    latestQuote: {
      bid: quoteCtx.bid,
      ask: quoteCtx.ask,
      last: quoteCtx.latestPrice,
      spreadPrice:
        quoteCtx.bid !== null && quoteCtx.ask !== null
          ? roundToDigits(Math.max(0, quoteCtx.ask - quoteCtx.bid), symbolSpec.digits)
          : null,
      spreadPoints: quoteCtx.tick?.spreadPoints ?? null,
      timestamp: quoteCtx.quoteTimestamp,
      source: quoteCtx.quoteSource,
      ageMs: quoteCtx.quoteTimestamp
        ? Math.max(0, nowMs - Date.parse(quoteCtx.quoteTimestamp))
        : null,
      hasTwoSidedQuote: quoteCtx.hasTwoSidedQuote,
      isFallbackOnly: quoteCtx.isFallbackOnly,
    },
    feedInfo: {
      status: feedInfo.status,
      label: feedInfo.label,
      isLive: feedInfo.isLive,
      reconnecting: feedInfo.reconnecting,
      lastUpdatedAt: feedInfo.lastUpdatedAt,
      message: feedInfo.message,
    },
    lastAiApproval: user.lastAiApproval ?? null,
    pendingAiApproval: pendingAiUserIds.has(user.id),
  };
}

// Builds strictly isolated, zero-secret snapshot for the authenticated subscriber
function getUserSnapshot(user: StoredUser) {
  const nowMs = Date.now();
  const feedInfo = getProxyFeedInfo(user, nowMs);
  const hideFrozenPrice = !feedInfo.allowed || feedInfo.reconnecting;
  const liveTick =
    !hideFrozenPrice && feedInfo.isLive ? sanitizeTickForUser(state.latestTick) : null;
  const refTick = !hideFrozenPrice ? sanitizeTickForUser(state.fallbackTick) : null;
  const usingFallback = !hideFrozenPrice && !liveTick && Boolean(refTick);

  const sanitizedTicks = !hideFrozenPrice
    ? (state.recentTicks.length > 0 ? state.recentTicks : state.fallbackTicks)
        .map((t) => sanitizeTickForUser(t))
        .filter((t): t is NormalizedTick => Boolean(t))
    : [];

  return {
    status: !feedInfo.allowed || feedInfo.reconnecting
      ? 'disconnected'
      : feedInfo.isLive
        ? 'connected'
        : state.status === 'connecting'
          ? 'connecting'
          : 'disconnected',
    lastError: !feedInfo.allowed || feedInfo.reconnecting
      ? feedInfo.message
      : !feedInfo.isLive
        ? 'Feed Offline - Contact Admin'
        : null,
    connectedSince: feedInfo.allowed && feedInfo.isLive ? state.connectedSince : null,
    packetsReceived: feedInfo.allowed && feedInfo.isLive ? state.packetsReceived : 0,
    failedProbes: 0,
    avgLatencyMs: feedInfo.allowed ? getAvgLatency() : null,
    config: {
      adapterId: 'tickerall-ws' as AdapterId,
      connectionName: 'Gold AI Trader Proxy Feed (OANDA / TickerAll)',
      baseUrl: 'proxy://admin-tickerall',
      endpointPath: '/proxy/gold',
      symbol: 'GOLD',
      authHeaderMode: 'none' as AuthHeaderMode,
      pollIntervalMs: 2000,
      timeoutMs: 6000,
      brokerType: 'mt5' as BrokerType,
      brokerServer: user.brokerServer,
      mt5AccountNumber: user.mt5Login,
      hasBrokerPassword: user.brokerConnected,
      schemaMapping: state.config.schemaMapping,
      symbolBindings: state.config.symbolBindings,
    },
    envStatus: {
      // NEVER expose admin TickerAll key status or upstream URL to regular subscribers
      hasTickerAllApiKey: false,
      configuredTickerAllBaseUrl: null,
      runtimeEnvironment: 'subscriber',
    },
    sessionInfo: {
      transport: 'websocket' as TransportMode,
      sessionId: null,
      accountId: null,
      wsUrl: null,
      wsReadyState: feedInfo.allowed && feedInfo.isLive ? ('open' as const) : ('closed' as const),
      tickConfirmed: Boolean(feedInfo.allowed && state.sessionInfo.tickConfirmed && feedInfo.isLive),
      subscribedConfirmed: Boolean(feedInfo.allowed && state.sessionInfo.subscribedConfirmed),
      quietMarketNotice: feedInfo.allowed ? state.sessionInfo.quietMarketNotice : feedInfo.message,
      subscribedSymbols: feedInfo.allowed ? ['GOLD'] : [],
      rejectedSymbols: [],
      lastTickAt: feedInfo.allowed ? state.sessionInfo.lastTickAt : null,
      totalTickFrames: feedInfo.allowed ? state.sessionInfo.totalTickFrames : 0,
      rawWsFrames: [],
      rawSessionResponse: null,
      rawSessionResponseAt: null,
    },
    accountInfo: {
      broker: user.brokerName || 'mt5',
      server: user.brokerServer || '',
      accountNumber: user.mt5Login || '',
      accountId: user.id,
      balance: round2(user.balance),
      equity: round2(user.equity),
      margin:
        user.mt5Login &&
        user.mt5Login.trim() === (state.accountInfo.accountNumber || state.config.mt5AccountNumber || '').trim()
          ? state.accountInfo.margin
          : null,
      freeMargin:
        user.mt5Login &&
        user.mt5Login.trim() === (state.accountInfo.accountNumber || state.config.mt5AccountNumber || '').trim()
          ? state.accountInfo.freeMargin
          : null,
      currency: 'USD',
      sourceEndpoint: user.brokerConnected
        ? user.balanceSyncSource === 'TICKERALL_MT5'
          ? `TickerAll MT5 Sync (#${user.mt5Login})`
          : user.balanceSyncSource === 'BROKER_BRIDGE'
            ? `Broker Bridge Sync (#${user.mt5Login})`
            : user.balanceSyncSource === 'TRADE_PNL'
              ? `Live Trade P&L (${user.brokerName})`
              : `Broker: ${user.brokerName} (${user.accountType})`
        : null,
      statusMessage: user.brokerConnected
        ? user.lastBalanceSyncAt
          ? `Synced (${user.balanceSyncSource || 'LIVE'})`
          : 'Connected'
        : 'Broker not connected',
      lastUpdatedAt: user.lastBalanceSyncAt || new Date().toISOString(),
      attempts: [],
    },
    latestTick: liveTick,
    fallbackTick: refTick,
    isFallbackPriceActive: usingFallback,
    recentTicks: sanitizedTicks,
    logs: [],
    bot: getUserBotSnapshot(user, Date.now()),
    userProfile: toPublicUser(user),
  };
}

function broadcastSse(event: 'status' | 'tick' | 'log', logPayload?: unknown) {
  for (const [client, userId] of sseClients.entries()) {
    const user = findUserById(userId);
    if (!user) {
      sseClients.delete(client);
      continue;
    }
    try {
      if (event === 'log' && logPayload) {
        // Admin upstream logs are NOT sent to regular subscribers
        continue;
      }
      const userSnap = getUserSnapshot(user);
      const dataObj =
        event === 'tick'
          ? { tick: userSnap.latestTick ?? userSnap.fallbackTick, snapshot: userSnap }
          : userSnap;
      client.write(`event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

function addLog(entry: Omit<DiagnosticLog, 'id' | 'timestamp'>) {
  const fullEntry: DiagnosticLog = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  state.logs.unshift(fullEntry);
  if (state.logs.length > 120) {
    state.logs.length = 120;
  }
  return fullEntry;
}

function getAvgLatency(): number | null {
  if (state.latencySamples.length === 0) return null;
  const sum = state.latencySamples.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / state.latencySamples.length) * 10) / 10;
}

function applyLiveBrokerBalanceUpdate(
  user: StoredUser,
  metrics: { balance?: number | null; equity?: number | null },
  source: 'TICKERALL_MT5' | 'BROKER_BRIDGE' | 'TRADE_PNL' | 'MANUAL',
  nowIso = new Date().toISOString()
): boolean {
  let changed = false;
  if (typeof metrics.balance === 'number' && Number.isFinite(metrics.balance) && metrics.balance >= 0) {
    const nextBal = round2(metrics.balance);
    if (Math.abs(user.balance - nextBal) >= 0.01) {
      user.balance = nextBal;
      changed = true;
    }
    if (typeof metrics.equity !== 'number' || !Number.isFinite(metrics.equity)) {
      if (Math.abs(user.equity - nextBal) >= 0.01) {
        user.equity = nextBal;
        changed = true;
      }
    }
  }
  if (typeof metrics.equity === 'number' && Number.isFinite(metrics.equity) && metrics.equity >= 0) {
    const nextEq = round2(metrics.equity);
    if (Math.abs(user.equity - nextEq) >= 0.01) {
      user.equity = nextEq;
      changed = true;
    }
  }
  user.lastBalanceSyncAt = nowIso;
  user.balanceSyncSource = source;
  return changed;
}

function recomputeUserFloatingEquity(
  user: StoredUser,
  priceOrQuote: number | { bid?: number | null; ask?: number | null; last: number | null } | null,
  nowMs = Date.now()
): boolean {
  const lastSyncMs = user.lastBalanceSyncAt ? Date.parse(user.lastBalanceSyncAt) : 0;
  const externalSyncFresh =
    (user.balanceSyncSource === 'TICKERALL_MT5' || user.balanceSyncSource === 'BROKER_BRIDGE') &&
    Number.isFinite(lastSyncMs) &&
    nowMs - lastSyncMs < 20_000;
  if (externalSyncFresh) {
    return false;
  }

  const openTrades = user.tradeLog.filter((t) => t.status === 'OPEN');
  if (openTrades.length === 0) {
    const bal = round2(user.balance);
    if (Math.abs(user.equity - bal) >= 0.01) {
      user.equity = bal;
      return true;
    }
    return false;
  }

  const last =
    typeof priceOrQuote === 'number'
      ? priceOrQuote
      : priceOrQuote?.last ?? null;
  const bid = typeof priceOrQuote === 'object' && priceOrQuote ? priceOrQuote.bid ?? null : null;
  const ask = typeof priceOrQuote === 'object' && priceOrQuote ? priceOrQuote.ask ?? null : null;

  if (last === null || !Number.isFinite(last) || last <= 0) {
    return false;
  }

  const spec = getEffectiveSymbolSpecForUser(user);
  let floatingPnl = 0;
  for (const t of openTrades) {
    const closingPrice =
      getEffectiveSideClosingPrice(t.side, bid, ask, last, spec.digits) ?? last;
    const activeLots = t.tp2Hit
      ? t.lots * 0.33
      : t.tp1Hit
        ? t.tp3 != null
          ? t.lots * 0.66
          : t.lots * 0.5
        : t.lots;
    const priceDiff = t.side === 'BUY' ? closingPrice - t.entry : t.entry - closingPrice;
    floatingPnl += priceDiff * activeLots * spec.contractSize;
    // Legacy open trades that hit TP1 before tp1RealizedPnl existed still carry unrealized TP1 gain
    if (t.tp1Hit && typeof t.tp1RealizedPnl !== 'number' && typeof t.tp1 === 'number') {
      floatingPnl += Math.abs(t.tp1 - t.entry) * (t.lots * 0.5) * spec.contractSize;
    }
  }
  const nextEquity = Math.max(0, round2(user.balance + floatingPnl));
  if (Math.abs(user.equity - nextEquity) >= 0.01) {
    user.equity = nextEquity;
    return true;
  }
  return false;
}

function resolveUserOpenTradesAtPrice(
  user: StoredUser,
  priceOrQuote: number | { bid?: number | null; ask?: number | null; last: number | null },
  nowIso: string
) {
  const last =
    typeof priceOrQuote === 'number'
      ? priceOrQuote
      : priceOrQuote.last ?? null;
  const bid = typeof priceOrQuote === 'object' ? priceOrQuote.bid ?? null : null;
  const ask = typeof priceOrQuote === 'object' ? priceOrQuote.ask ?? null : null;

  if (last === null || !Number.isFinite(last) || last <= 0) return false;
  let changed = false;
  const cfg = mergeEmaProConfig(user.settings.emaPro);
  const spec = getEffectiveSymbolSpecForUser(user);

  for (let i = 0; i < user.tradeLog.length; i += 1) {
    const t = user.tradeLog[i];
    if (t.status !== 'OPEN') continue;
    // Side-specific exit/trigger price: BUY exits on Bid, SELL exits on Ask
    const price = getEffectiveSideClosingPrice(t.side, bid, ask, last, spec.digits) ?? last;

    // 3-Target Trailing Model (TP1 -> SL=TP1 -> TP2 -> SL=TP2 -> TP3)
    const hasThreeTargets =
      typeof t.tp1 === 'number' &&
      Number.isFinite(t.tp1) &&
      typeof t.tp2 === 'number' &&
      Number.isFinite(t.tp2) &&
      typeof t.tp3 === 'number' &&
      Number.isFinite(t.tp3);

    if (hasThreeTargets) {
      const tp1 = t.tp1 as number;
      const tp2 = t.tp2 as number;
      const tp3 = t.tp3 as number;
      const isBuy = t.side === 'BUY';

      const slHit = isBuy ? price <= t.stop : price >= t.stop;
      if (slHit) {
        const remFrac = t.tp2Hit ? 0.33 : t.tp1Hit ? (cfg.partialProfitEnabled ? 0.66 : 1.0) : 1.0;
        const diff = isBuy ? t.stop - t.entry : t.entry - t.stop;
        const remPnl = round2(diff * t.lots * remFrac * spec.contractSize);
        const alreadyRealized = (t.tp1RealizedPnl ?? 0) + (t.tp2RealizedPnl ?? 0);
        const totalPnl = round2(alreadyRealized + remPnl);
        const balanceAfter = Math.max(0, round2(user.balance + remPnl));
        user.balance = balanceAfter;
        user.equity = balanceAfter;
        user.lastBalanceSyncAt = nowIso;
        user.balanceSyncSource = 'TRADE_PNL';
        user.tradeLog[i] = {
          ...t,
          status: totalPnl >= 0 ? 'TP_HIT' : 'SL_HIT',
          closedAt: nowIso,
          exitPrice: roundToDigits(t.stop, spec.digits),
          pnlDollars: totalPnl,
          balanceAfter,
          notes: `${t.notes} · Stopped at $${t.stop.toFixed(spec.digits)} (${totalPnl >= 0 ? 'Trailing Profit Locked' : 'SL_HIT'})`,
        };
        changed = true;
        continue;
      }

      if (!t.tp1Hit && (isBuy ? price >= tp1 : price <= tp1)) {
        const tp1Frac = cfg.partialProfitEnabled ? 0.34 : 0;
        const tp1Gain = tp1Frac > 0 ? round2(Math.abs(tp1 - t.entry) * t.lots * tp1Frac * spec.contractSize) : 0;
        const nextStop = cfg.moveSlToTp1OnTp1 ? roundToDigits(tp1, spec.digits) : t.stop;
        user.balance = Math.max(0, round2(user.balance + tp1Gain));
        user.equity = user.balance;
        user.lastBalanceSyncAt = nowIso;
        user.balanceSyncSource = 'TRADE_PNL';
        user.tradeLog[i] = {
          ...t,
          tp1Hit: true,
          tp1RealizedPnl: tp1Gain,
          breakevenMoved: true,
          stop: nextStop,
          notes: `${t.notes} · TP1 hit @ $${tp1.toFixed(spec.digits)}, SL trailed to $${nextStop.toFixed(spec.digits)}`,
        };
        changed = true;
      }

      const postTp1 = user.tradeLog[i];
      if (postTp1.tp1Hit && !postTp1.tp2Hit && (isBuy ? price >= tp2 : price <= tp2)) {
        const tp2Frac = cfg.partialProfitEnabled ? 0.33 : 0;
        const tp2Gain = tp2Frac > 0 ? round2(Math.abs(tp2 - postTp1.entry) * postTp1.lots * tp2Frac * spec.contractSize) : 0;
        const nextStop = cfg.moveSlToTp2OnTp2 ? roundToDigits(tp2, spec.digits) : postTp1.stop;
        user.balance = Math.max(0, round2(user.balance + tp2Gain));
        user.equity = user.balance;
        user.lastBalanceSyncAt = nowIso;
        user.balanceSyncSource = 'TRADE_PNL';
        user.tradeLog[i] = {
          ...postTp1,
          tp2Hit: true,
          tp2RealizedPnl: tp2Gain,
          stop: nextStop,
          notes: `${postTp1.notes} · TP2 hit @ $${tp2.toFixed(spec.digits)}, SL trailed to $${nextStop.toFixed(spec.digits)}`,
        };
        changed = true;
      }

      const postTp2 = user.tradeLog[i];
      if (postTp2.status === 'OPEN' && (isBuy ? price >= tp3 : price <= tp3)) {
        const remFrac = postTp2.tp2Hit ? (cfg.partialProfitEnabled ? 0.33 : 1.0) : postTp2.tp1Hit ? (cfg.partialProfitEnabled ? 0.66 : 1.0) : 1.0;
        const tp3Gain = round2(Math.abs(tp3 - postTp2.entry) * postTp2.lots * remFrac * spec.contractSize);
        const totalPnl = round2((postTp2.tp1RealizedPnl ?? 0) + (postTp2.tp2RealizedPnl ?? 0) + tp3Gain);
        const balanceAfter = Math.max(0, round2(user.balance + tp3Gain));
        user.balance = balanceAfter;
        user.equity = balanceAfter;
        user.lastBalanceSyncAt = nowIso;
        user.balanceSyncSource = 'TRADE_PNL';
        user.tradeLog[i] = {
          ...postTp2,
          tp1Hit: true,
          tp2Hit: true,
          status: 'TP_HIT',
          closedAt: nowIso,
          exitPrice: roundToDigits(tp3, spec.digits),
          pnlDollars: totalPnl,
          balanceAfter,
          notes: `${postTp2.notes} · TP3 Target Hit @ $${tp3.toFixed(spec.digits)}`,
        };
        changed = true;
      }
      continue;
    }

    const hasPartialModel =
      typeof t.tp1 === 'number' &&
      Number.isFinite(t.tp1) &&
      typeof t.tp2 === 'number' &&
      Number.isFinite(t.tp2);

    if (hasPartialModel) {
      const tp1 = t.tp1 as number;
      const tp2 = t.tp2 as number;
      if (!t.tp1Hit) {
        const slHit = t.side === 'BUY' ? price <= t.stop : price >= t.stop;
        const tp1HitNow = t.side === 'BUY' ? price >= tp1 : price <= tp1;
        if (slHit) {
          const priceDiff = t.side === 'BUY' ? t.stop - t.entry : t.entry - t.stop;
          const pnlDollars = round2(priceDiff * t.lots * spec.contractSize);
          const balanceAfter = Math.max(0, round2(user.balance + pnlDollars));
          user.balance = balanceAfter;
          user.equity = balanceAfter;
          user.lastBalanceSyncAt = nowIso;
          user.balanceSyncSource = 'TRADE_PNL';
          user.tradeLog[i] = {
            ...t,
            status: 'SL_HIT',
            closedAt: nowIso,
            exitPrice: roundToDigits(t.stop, spec.digits),
            pnlDollars,
            balanceAfter,
            notes: `${t.notes} · Closed SL_HIT @ $${t.stop.toFixed(spec.digits)} (${nowIso.slice(11, 19)})`,
          };
          changed = true;
        } else if (tp1HitNow) {
          const tp2HitNow = t.side === 'BUY' ? price >= tp2 : price <= tp2;
          const tp1Gain = round2(Math.abs(tp1 - t.entry) * (t.lots * 0.5) * spec.contractSize);
          if (tp2HitNow) {
            const tp2Gain = round2(Math.abs(tp2 - t.entry) * (t.lots * 0.5) * spec.contractSize);
            const totalPnl = round2(tp1Gain + tp2Gain);
            const balanceAfter = Math.max(0, round2(user.balance + totalPnl));
            user.balance = balanceAfter;
            user.equity = balanceAfter;
            user.lastBalanceSyncAt = nowIso;
            user.balanceSyncSource = 'TRADE_PNL';
            user.tradeLog[i] = {
              ...t,
              tp1Hit: true,
              tp1RealizedPnl: tp1Gain,
              breakevenMoved: true,
              stop: roundToDigits(t.entry, spec.digits),
              status: 'TP_HIT',
              closedAt: nowIso,
              exitPrice: roundToDigits(tp2, spec.digits),
              pnlDollars: totalPnl,
              balanceAfter,
              notes: `${t.notes} · TP1 ($${tp1.toFixed(spec.digits)}) + TP2 ($${tp2.toFixed(spec.digits)}) hit (${nowIso.slice(11, 19)})`,
            };
          } else {
            const balanceAfterTp1 = Math.max(0, round2(user.balance + tp1Gain));
            user.balance = balanceAfterTp1;
            user.equity = balanceAfterTp1;
            user.lastBalanceSyncAt = nowIso;
            user.balanceSyncSource = 'TRADE_PNL';
            user.tradeLog[i] = {
              ...t,
              tp1Hit: true,
              tp1RealizedPnl: tp1Gain,
              breakevenMoved: true,
              stop: roundToDigits(t.entry, spec.digits),
              notes: `${t.notes} · TP1 50% closed (+$${tp1Gain.toFixed(2)}) @ $${tp1.toFixed(spec.digits)}, SL moved to BE $${t.entry.toFixed(spec.digits)}`,
            };
          }
          changed = true;
        }
      } else {
        const beHit = t.side === 'BUY' ? price <= t.entry : price >= t.entry;
        const tp2HitNow = t.side === 'BUY' ? price >= tp2 : price <= tp2;
        const tp1Gain = round2(Math.abs(tp1 - t.entry) * (t.lots * 0.5) * spec.contractSize);
        const alreadyCreditedTp1 = typeof t.tp1RealizedPnl === 'number' ? t.tp1RealizedPnl : 0;
        const tp1Recorded = typeof t.tp1RealizedPnl === 'number';
        if (tp2HitNow) {
          const tp2Gain = round2(Math.abs(tp2 - t.entry) * (t.lots * 0.5) * spec.contractSize);
          const totalPnl = round2((tp1Recorded ? alreadyCreditedTp1 : tp1Gain) + tp2Gain);
          const deltaToCredit = tp1Recorded ? tp2Gain : totalPnl;
          const balanceAfter = Math.max(0, round2(user.balance + deltaToCredit));
          user.balance = balanceAfter;
          user.equity = balanceAfter;
          user.lastBalanceSyncAt = nowIso;
          user.balanceSyncSource = 'TRADE_PNL';
          user.tradeLog[i] = {
            ...t,
            tp1RealizedPnl: tp1Recorded ? alreadyCreditedTp1 : tp1Gain,
            status: 'TP_HIT',
            closedAt: nowIso,
            exitPrice: roundToDigits(tp2, spec.digits),
            pnlDollars: totalPnl,
            balanceAfter,
            notes: `${t.notes} · TP2 Runner hit @ $${tp2.toFixed(spec.digits)} (${nowIso.slice(11, 19)})`,
          };
          changed = true;
        } else if (beHit) {
          const totalPnl = tp1Recorded ? alreadyCreditedTp1 : tp1Gain;
          const deltaToCredit = tp1Recorded ? 0 : tp1Gain;
          const balanceAfter = Math.max(0, round2(user.balance + deltaToCredit));
          user.balance = balanceAfter;
          user.equity = balanceAfter;
          user.lastBalanceSyncAt = nowIso;
          user.balanceSyncSource = 'TRADE_PNL';
          user.tradeLog[i] = {
            ...t,
            tp1RealizedPnl: totalPnl,
            status: 'CLOSED',
            closedAt: nowIso,
            exitPrice: roundToDigits(t.entry, spec.digits),
            pnlDollars: totalPnl,
            balanceAfter,
            notes: `${t.notes} · Runner closed at Breakeven @ $${t.entry.toFixed(spec.digits)} (${nowIso.slice(11, 19)})`,
          };
          changed = true;
        }
      }
      continue;
    }

    let nextStatus: 'TP_HIT' | 'SL_HIT' | null = null;
    let exitPrice = price;
    if (t.side === 'BUY') {
      if (price <= t.stop) {
        nextStatus = 'SL_HIT';
        exitPrice = t.stop;
      } else if (price >= t.target) {
        nextStatus = 'TP_HIT';
        exitPrice = t.target;
      }
    } else {
      if (price >= t.stop) {
        nextStatus = 'SL_HIT';
        exitPrice = t.stop;
      } else if (price <= t.target) {
        nextStatus = 'TP_HIT';
        exitPrice = t.target;
      }
    }

    if (nextStatus) {
      const priceDiff = t.side === 'BUY' ? exitPrice - t.entry : t.entry - exitPrice;
      const pnlDollars = round2(priceDiff * t.lots * spec.contractSize);
      const balanceAfter = Math.max(0, round2(user.balance + pnlDollars));
      user.balance = balanceAfter;
      user.equity = balanceAfter;
      user.lastBalanceSyncAt = nowIso;
      user.balanceSyncSource = 'TRADE_PNL';
      user.tradeLog[i] = {
        ...t,
        status: nextStatus,
        closedAt: nowIso,
        exitPrice: roundToDigits(exitPrice, spec.digits),
        pnlDollars,
        balanceAfter,
        notes: `${t.notes} · Closed ${nextStatus} @ $${exitPrice.toFixed(spec.digits)} (${nowIso.slice(11, 19)})`,
      };
      changed = true;
    }
  }
  if (changed) {
    recomputeUserTradeCountsForToday(user, getLusakaClock().dateLusaka);
  }
  return changed;
}

async function dispatchOrderToUserBroker(
  user: StoredUser,
  order: {
    symbol: string;
    side: 'BUY' | 'SELL';
    lots: number;
    entry: number;
    stop: number;
    target: number;
  }
): Promise<{ sent: boolean; detail: string; balanceUpdated?: boolean }> {
  const bridgeUrl = (user.brokerBridgeUrl || '').trim();
  if (!bridgeUrl) {
    return {
      sent: true,
      detail: `Executed via ${user.brokerName} (${user.accountType} #${user.mt5Login})`,
    };
  }
  const urlCheck = isSafeExternalUrl(bridgeUrl);
  if (!urlCheck.safe) {
    return { sent: false, detail: `Blocked unsafe broker bridge URL` };
  }
  try {
    const apiKey = user.brokerApiKeyEnc ? decryptSecret(user.brokerApiKeyEnc) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      headers['X-API-Key'] = apiKey;
    }
    const resp = await fetch(bridgeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'order',
        broker: user.brokerName,
        server: user.brokerServer,
        account: user.mt5Login,
        accountType: user.accountType,
        ...order,
      }),
      signal: AbortSignal.timeout(5000),
    });
    let balanceUpdated = false;
    try {
      const text = await resp.text();
      if (resp.ok && text) {
        const parsed = JSON.parse(text) as unknown;
        const metrics = extractAccountMetrics(parsed, null, user.mt5Login);
        if (metrics && (metrics.balance !== null || metrics.equity !== null)) {
          const freshUser = findUserById(user.id);
          if (freshUser) {
            applyLiveBrokerBalanceUpdate(freshUser, metrics, 'BROKER_BRIDGE');
            saveStoreNow();
            broadcastSse('status');
            balanceUpdated = true;
          }
        }
      }
    } catch {
      // Ignore non-JSON bridge order response
    }
    return {
      sent: resp.ok,
      detail: `Broker HTTP ${resp.status} (${user.brokerName} #${user.mt5Login})`,
      balanceUpdated,
    };
  } catch (err) {
    return {
      sent: false,
      detail: `Broker bridge error: ${err instanceof Error ? err.message : 'network error'}`,
    };
  }
}

const bridgeSyncInFlight = new Set<string>();

async function syncUserBalanceFromBridge(user: StoredUser): Promise<{
  ok: boolean;
  updated: boolean;
  source: 'BROKER_BRIDGE' | 'TICKERALL_MT5' | 'LOCAL_EQUITY';
  balance: number;
  equity: number;
  message: string;
}> {
  const bridgeUrl = (user.brokerBridgeUrl || '').trim();
  const nowIso = new Date().toISOString();

  if (bridgeUrl) {
    const urlCheck = isSafeExternalUrl(bridgeUrl);
    if (!urlCheck.safe) {
      return {
        ok: false,
        updated: false,
        source: 'LOCAL_EQUITY',
        balance: round2(user.balance),
        equity: round2(user.equity),
        message: 'Blocked unsafe broker bridge URL',
      };
    }
    if (!bridgeSyncInFlight.has(user.id)) {
      bridgeSyncInFlight.add(user.id);
      try {
        const apiKey = user.brokerApiKeyEnc ? decryptSecret(user.brokerApiKeyEnc) : '';
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
          headers['X-API-Key'] = apiKey;
        }
        let metrics: ReturnType<typeof extractAccountMetrics> = null;
        let lastStatus = 0;

        // Try GET ?action=balance&account=... first, then POST { action: 'balance', ... }
        try {
          const u = new URL(bridgeUrl);
          u.searchParams.set('action', 'balance');
          if (user.mt5Login) u.searchParams.set('account', user.mt5Login);
          const getRes = await fetch(u.toString(), {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(4500),
          });
          lastStatus = getRes.status;
          if (getRes.ok) {
            const raw = await getRes.text();
            if (raw) {
              metrics = extractAccountMetrics(JSON.parse(raw) as unknown, null, user.mt5Login);
            }
          }
        } catch {
          // Fall back to POST
        }

        if (!metrics) {
          const postRes = await fetch(bridgeUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              action: 'balance',
              broker: user.brokerName,
              server: user.brokerServer,
              account: user.mt5Login,
              accountType: user.accountType,
            }),
            signal: AbortSignal.timeout(4500),
          });
          lastStatus = postRes.status;
          if (postRes.ok) {
            const raw = await postRes.text();
            if (raw) {
              metrics = extractAccountMetrics(JSON.parse(raw) as unknown, null, user.mt5Login);
            }
          }
        }

        if (metrics && (metrics.balance !== null || metrics.equity !== null)) {
          const changed = applyLiveBrokerBalanceUpdate(user, metrics, 'BROKER_BRIDGE', nowIso);
          saveStoreNow();
          broadcastSse('status');
          return {
            ok: true,
            updated: changed,
            source: 'BROKER_BRIDGE',
            balance: round2(user.balance),
            equity: round2(user.equity),
            message: `Synced from Broker Bridge (#${user.mt5Login || 'MT5'}): $${user.balance.toFixed(2)}`,
          };
        }

        return {
          ok: false,
          updated: false,
          source: 'LOCAL_EQUITY',
          balance: round2(user.balance),
          equity: round2(user.equity),
          message:
            lastStatus > 0
              ? `Broker Bridge responded HTTP ${lastStatus} without balance/equity fields`
              : 'Unable to reach Broker Bridge URL for balance sync',
        };
      } catch (err) {
        return {
          ok: false,
          updated: false,
          source: 'LOCAL_EQUITY',
          balance: round2(user.balance),
          equity: round2(user.equity),
          message: `Broker Bridge error: ${err instanceof Error ? err.message : 'network error'}`,
        };
      } finally {
        bridgeSyncInFlight.delete(user.id);
      }
    }
  }

  // Fallback 1: Sync from matching TickerAll master MT5 account if account number matches
  const tickerAcct = (state.accountInfo.accountNumber || state.config.mt5AccountNumber || '').trim();
  const userAcct = (user.mt5Login || '').trim();
  if (
    user.brokerConnected &&
    tickerAcct &&
    userAcct &&
    tickerAcct === userAcct &&
    (state.accountInfo.balance !== null || state.accountInfo.equity !== null)
  ) {
    const changed = applyLiveBrokerBalanceUpdate(
      user,
      { balance: state.accountInfo.balance, equity: state.accountInfo.equity },
      'TICKERALL_MT5',
      nowIso
    );
    saveStoreNow();
    broadcastSse('status');
    return {
      ok: true,
      updated: changed,
      source: 'TICKERALL_MT5',
      balance: round2(user.balance),
      equity: round2(user.equity),
      message: `Synced from connected MT5 account #${tickerAcct}: $${user.balance.toFixed(2)}`,
    };
  }

  // Fallback 2: Recalculate live floating equity against current Gold price & open trades
  const livePrice = getEffectiveProxyPrice();
  const eqChanged = recomputeUserFloatingEquity(user, livePrice);
  user.lastBalanceSyncAt = nowIso;
  if (!user.balanceSyncSource) user.balanceSyncSource = 'TRADE_PNL';
  if (eqChanged) {
    saveStoreNow();
    broadcastSse('status');
  }
  return {
    ok: true,
    updated: eqChanged,
    source: 'LOCAL_EQUITY',
    balance: round2(user.balance),
    equity: round2(user.equity),
    message: `Account balance $${user.balance.toFixed(2)} · Floating equity $${user.equity.toFixed(2)} (updated by bot P&L)`,
  };
}

function syncUsersWithTickerAllAccountInfo(): boolean {
  const tickerAcct = (state.accountInfo.accountNumber || state.config.mt5AccountNumber || '').trim();
  if (
    !tickerAcct ||
    (state.accountInfo.balance === null && state.accountInfo.equity === null)
  ) {
    return false;
  }
  const nowIso = new Date().toISOString();
  let anyChanged = false;
  for (const user of getStore().users) {
    if (
      user.status === 'ACTIVE' &&
      user.brokerConnected &&
      user.mt5Login.trim() === tickerAcct
    ) {
      if (
        applyLiveBrokerBalanceUpdate(
          user,
          { balance: state.accountInfo.balance, equity: state.accountInfo.equity },
          'TICKERALL_MT5',
          nowIso
        )
      ) {
        anyChanged = true;
      }
    }
  }
  if (anyChanged) {
    scheduleStoreSave();
    broadcastSse('status');
  }
  return anyChanged;
}

function updateUserSessionRangeWithPrice(
  user: StoredUser,
  price: number,
  nowMs: number,
  isPrimarySource: boolean
) {
  ensureUserDayRollover(user, nowMs);
  if (!Number.isFinite(price) || price <= 0) return;
  if (!isPrimarySource && state.sessionInfo.tickConfirmed) return;

  const clock = getLusakaClock(nowMs);
  const asianStartMin = parseHHMMToMinutes(user.settings.asianStart, 180);
  const asianEndMin = parseHHMMToMinutes(user.settings.asianEnd, 660);
  const londonStartMin = parseHHMMToMinutes(user.settings.londonStart, 660);
  const londonEndMin = parseHHMMToMinutes(user.settings.londonEnd, 1140);

  if (!user.levels.manualOverride && user.levels.pdh === null) {
    const derived = derivePreviousDayRangeFromCandles(
      getTickerAllHistorySnapshot().m15Candles,
      clock.dateLusaka
    );
    if (derived.pdh !== null && derived.pdl !== null) {
      user.levels.pdh = derived.pdh;
      user.levels.pdl = derived.pdl;
      user.levels.prevDayDate = derived.prevDayDate;
    }
  }

  if (clock.minutes >= asianStartMin && clock.minutes < asianEndMin) {
    user.levels.asianHigh =
      user.levels.asianHigh === null ? round2(price) : round2(Math.max(user.levels.asianHigh, price));
    user.levels.asianLow =
      user.levels.asianLow === null ? round2(price) : round2(Math.min(user.levels.asianLow, price));
  }

  if (clock.minutes >= londonStartMin && clock.minutes <= londonEndMin) {
    user.levels.londonHigh =
      user.levels.londonHigh === null ? round2(price) : round2(Math.max(user.levels.londonHigh, price));
    user.levels.londonLow =
      user.levels.londonLow === null ? round2(price) : round2(Math.min(user.levels.londonLow, price));
  }
}

const pendingAiUserIds = new Set<string>();

async function approveAndExecuteAutoTrade(params: {
  userId: string;
  lusakaDate: string;
  lusakaWeekday: string;
  isWeekend: boolean;
  phase: SessionPhase;
  newsStatus: {
    clear: boolean;
    blockingEvent: UsdNewsEvent | null;
    minutesUntil: number | null;
  };
  emaAnalysis: ReturnType<typeof evaluateEmaStochasticProSignal>['analysis'];
  activeSignal: BotStateSnapshot['activeSignal'];
  lotToUse: number;
  dailyPnlPct: number;
  dailyGuardHit: boolean;
  currentCandle: M15Candle | null;
  closedCandles: M15Candle[];
  latestPrice: number | null;
  latestTick: NormalizedTick | null;
  symbolSpec: SymbolSpecification;
  feedConnected: boolean;
}) {
  const {
    userId,
    lusakaDate,
    lusakaWeekday,
    isWeekend,
    phase,
    newsStatus,
    emaAnalysis,
    activeSignal: sig,
    lotToUse,
    dailyPnlPct,
    dailyGuardHit,
    currentCandle,
    closedCandles,
    latestPrice,
    latestTick,
    symbolSpec,
    feedConnected,
  } = params;
  if (
    (sig.action !== 'BUY' && sig.action !== 'SELL') ||
    sig.entry === null ||
    sig.stop === null ||
    sig.target === null
  ) {
    return;
  }
  const user = findUserById(userId);
  if (!user) return;
  if (pendingAiUserIds.has(userId)) return;

  pendingAiUserIds.add(userId);
  broadcastSse('status');
  try {
    const openPositionsCount = user.tradeLog.filter((t) => t.status === 'OPEN').length;
    let approvalToStore = null;

    if (user.settings.aiApproverEnabled !== false) {
      const aiResult = await reviewTradeWithGeminiApprover({
        executionContext: 'AUTO',
        lusakaDate,
        lusakaTime: sig.lusakaTime,
        lusakaWeekday,
        isWeekend,
        phase,
        symbol: sig.symbol || 'XAUUSD',
        proposedSide: sig.action,
        entry: sig.entry,
        stop: sig.stop,
        tp1: sig.tp1,
        tp2: sig.tp2 ?? sig.target,
        tp3: sig.tp3 ?? null,
        lots: lotToUse,
        accountBalance: user.equity > 0 ? user.equity : user.balance,
        settings: buildEffectiveSettingsForEvaluation(user),
        levels: user.levels,
        emaPro: emaAnalysis,
        activeSignal: sig,
        newsStatus,
        currentCandle,
        recentClosedCandles: closedCandles,
        dailyPnlPct,
        dailyGuardHit,
        openPositionsCount,
        lastTickAtMs: state.lastAnyFeedSuccessMs || null,
        notes: sig.reason,
      });

      const freshUser = findUserById(userId);
      if (!freshUser) return;
      freshUser.lastAiApproval = aiResult.approval;
      approvalToStore = aiResult.approval;

      if (!aiResult.ok || !aiResult.approval.approved) {
        freshUser.signalHistory.unshift({
          id: `hist-aiblk-${sig.id}`,
          timestamp: new Date().toISOString(),
          lusakaTime: sig.lusakaTime,
          strategy: sig.strategy,
          strategyModule: 'EMA_STOCHASTIC_PRO',
          setupType: sig.setupType,
          action: 'BLOCKED',
          symbol: sig.symbol || 'XAUUSD',
          price: sig.entry,
          stop: sig.stop,
          tp1: sig.tp1,
          tp2: sig.tp2,
          tp3: sig.tp3 ?? null,
          emaAlignment: sig.emaSummary,
          stochReading: sig.stochSummary,
          smcEvidence: sig.smcSummary,
          aiConfidence: aiResult.approval.confidencePct,
          signalStatus:
            aiResult.approval.status === 'WAITING FOR CONFIRMATION' ? 'WAITING' : 'REJECTED',
          setupStatus: sig.setupLabel ?? sig.setupType ?? 'EMA STOCHASTIC PRO',
          blockReason:
            aiResult.approval.status === 'ERROR'
              ? `Gemini AI Error: ${aiResult.approval.errorMessage || aiResult.approval.summary}`
              : `Gemini AI ${aiResult.approval.status} (${aiResult.approval.confidencePct}%): ${aiResult.approval.summary}`,
        });
        if (freshUser.signalHistory.length > 120) freshUser.signalHistory.length = 120;
        saveStoreNow();
        return;
      }
    }

    const freshUser = findUserById(userId);
    if (!freshUser) return;

    const orderRec = await executeTradeViaTickerAllAdapter({
      user: freshUser,
      signal: sig,
      latestMarketPrice: latestPrice,
      latestTick,
      symbolSpec,
      spreadEvaluation: emaAnalysis.spreadEvaluation ?? null,
      feedConnected,
      isWeekend,
    });
    freshUser.tradeOrders = [orderRec, ...(freshUser.tradeOrders ?? [])].slice(0, 120);

    if (orderRec.status !== 'FILLED' && orderRec.status !== 'DEMO_SIMULATED') {
      freshUser.signalHistory.unshift({
        id: `hist-execblk-${sig.id}`,
        timestamp: new Date().toISOString(),
        lusakaTime: sig.lusakaTime,
        strategy: sig.strategy,
        strategyModule: 'EMA_STOCHASTIC_PRO',
        setupType: sig.setupType,
        action: 'BLOCKED',
        symbol: sig.symbol || 'XAUUSD',
        price: sig.entry,
        stop: sig.stop,
        tp1: sig.tp1,
        tp2: sig.tp2,
        tp3: sig.tp3 ?? null,
        aiConfidence: approvalToStore?.confidencePct ?? null,
        signalStatus: 'REJECTED',
        setupStatus: sig.setupLabel ?? 'Execution Gate',
        blockReason: `${orderRec.status}: ${orderRec.errorMessage || 'No execution confirmation from TickerAll/Broker'}`,
      });
      if (freshUser.signalHistory.length > 120) freshUser.signalHistory.length = 120;
      saveStoreNow();
      return;
    }

    const execEntry = orderRec.actualFillPrice ?? sig.entry;
    const balanceBefore = round2(freshUser.balance);
    const tradeEntry: TradeLogEntry = {
      id: `auto-${sig.id}`,
      signalId: sig.id,
      orderId: orderRec.id,
      dateLusaka: lusakaDate,
      timeLusaka: sig.lusakaTime,
      timestamp: sig.timestamp,
      session: sig.strategy,
      strategyModule: 'EMA_STOCHASTIC_PRO',
      marketCondition: emaAnalysis?.marketCondition ?? 'TRENDING',
      symbol: sig.symbol || 'XAUUSD',
      side: sig.action,
      entry: execEntry,
      stop: sig.stop,
      tp1: sig.tp1,
      tp2: sig.tp2,
      tp3: sig.tp3 ?? null,
      target: sig.target,
      tp1Hit: false,
      tp2Hit: false,
      breakevenMoved: false,
      rrRatio: sig.rrRatio,
      lots: lotToUse,
      riskDollars: round2(Math.abs(execEntry - sig.stop) * lotToUse * symbolSpec.contractSize),
      status: 'OPEN',
      executionStatus: orderRec.status,
      exitPrice: null,
      pnlDollars: null,
      notes: `AUTO EMA STOCHASTIC PRO (${orderRec.status}) via ${freshUser.brokerName} (#${freshUser.mt5Login})${approvalToStore ? ` · AI ${approvalToStore.confidencePct}%` : ''}`,
      setupStatus: sig.setupLabel ?? sig.setupType ?? 'EMA STOCHASTIC PRO',
      executionMode: 'AUTO',
      feedSource: 'TickerAll MT5 Master Feed',
      brokerName: `${freshUser.brokerName} (${freshUser.accountType})`,
      balanceBefore,
      balanceAfter: null,
      aiApproval: approvalToStore,
    };
    freshUser.tradeLog.unshift(tradeEntry);
    if (freshUser.tradeLog.length > 200) freshUser.tradeLog.length = 200;
    recomputeUserTradeCountsForToday(freshUser, lusakaDate);
    saveStoreNow();
  } catch (err) {
    console.error('[AUTO Strategy AI Approver error]', err);
  } finally {
    pendingAiUserIds.delete(userId);
    broadcastSse('status');
  }
}

function evaluateUserOnProxyTick(user: StoredUser, price: number | null, nowMs: number) {
  const feedInfo = getProxyFeedInfo(user, nowMs);
  if (!feedInfo.allowed) return;

  ensureUserDayRollover(user, nowMs);
  const nowIso = new Date(nowMs).toISOString();
  let dirty = false;

  const quoteCtx = getLiveQuoteContext(nowMs, feedInfo);
  const quoteForPnL = {
    bid: quoteCtx.bid,
    ask: quoteCtx.ask,
    last: quoteCtx.latestPrice ?? price,
  };

  if (quoteForPnL.last !== null && resolveUserOpenTradesAtPrice(user, quoteForPnL, nowIso)) {
    dirty = true;
  }
  if (recomputeUserFloatingEquity(user, quoteForPnL, nowMs)) {
    dirty = true;
  }

  const cfg = mergeEmaProConfig(user.settings.emaPro);
  const hist = getTickerAllHistorySnapshot();
  const clock = getLusakaClock(nowMs);
  const phaseRes = determineSessionPhase(clock.minutes, user.settings, clock.isWeekend);
  const newsStatus = evaluateUsdNewsClearance(clock.minutes, user.settings);
  const d1Derived = derivePreviousDayRangeFromCandles(hist.m15Candles, clock.dateLusaka);

  if (!user.levels.manualOverride && d1Derived.pdh !== null && d1Derived.pdl !== null) {
    if (user.levels.pdh !== d1Derived.pdh || user.levels.pdl !== d1Derived.pdl) {
      user.levels.pdh = d1Derived.pdh;
      user.levels.pdl = d1Derived.pdl;
      user.levels.prevDayDate = d1Derived.prevDayDate;
      dirty = true;
    }
  }

  const openPositionsCount = user.tradeLog.filter((t) => t.status === 'OPEN').length;
  const { dailyPnlPct, dailyGuardHit } = computeUserDailyPnl(user, clock.dateLusaka);
  const m5Combined = mergeCandleCollections(hist.m5Candles, proxyMarketState.closedM5Candles);
  const m15Combined = mergeCandleCollections(hist.m15Candles, proxyMarketState.closedCandles);
  const symbolSpec = getEffectiveSymbolSpecForUser(user);
  const effectiveSettings = buildEffectiveSettingsForEvaluation(user);
  const spreadHistory = get24hSpreadHistory(nowMs);

  const emaEval = evaluateEmaStochasticProSignal({
    h1Candles: hist.h1Candles,
    m15Candles: m15Combined,
    m5Candles: m5Combined,
    m1Candles: hist.m1Candles,
    settings: effectiveSettings,
    levels: user.levels,
    phase: phaseRes.phase,
    latestPrice: quoteCtx.latestPrice,
    bid: quoteCtx.bid,
    ask: quoteCtx.ask,
    quoteTimestamp: quoteCtx.quoteTimestamp,
    quoteSource: quoteCtx.quoteSource,
    hasTwoSidedQuote: quoteCtx.hasTwoSidedQuote,
    isFallbackOnly: quoteCtx.isFallbackOnly,
    symbolSpec,
    spreadHistory,
    accountEquity: user.equity > 0 ? user.equity : user.balance,
    openPositionsCount,
    dailyPnlPct,
    isWeekend: clock.isWeekend,
    feedConnected: feedInfo.isLive,
    nowMs,
  });

  const spreadEval = emaEval.analysis.spreadEvaluation;
  const sig = emaEval.signal;

  // Record per-bar spread-blocked qualified opportunities without spamming on every tick
  if (spreadEval && spreadEval.proposedSide !== null && !spreadEval.tradePermitted) {
    const latestBarTs = m5Combined.length > 0 ? m5Combined[m5Combined.length - 1].openTimeMs : Math.floor(nowMs / 300_000);
    const spreadBlockId = `spreadblk-${latestBarTs}-${spreadEval.proposedSide}`;
    if (!user.processedHistoryIds.includes(spreadBlockId)) {
      user.processedHistoryIds.push(spreadBlockId);
      if (user.processedHistoryIds.length > 300) {
        user.processedHistoryIds = user.processedHistoryIds.slice(-300);
      }
      user.spreadRejectedCountToday = (user.spreadRejectedCountToday ?? 0) + 1;
      const spreadRiskEv: RiskEventRecord = {
        id: `rsk-sp-${nowMs}`,
        timestamp: nowIso,
        lusakaTime: clock.timeLusaka,
        category: 'SPREAD_FILTER',
        detail: `${spreadEval.proposedSide} blocked [${spreadEval.classification}]: ${spreadEval.reason}`,
        severity:
          spreadEval.classification === 'ABNORMAL' ||
          spreadEval.classification === 'DATA_UNAVAILABLE'
            ? 'CRITICAL'
            : 'WARNING',
      };
      user.riskEvents = [spreadRiskEv, ...(user.riskEvents ?? [])].slice(0, 100);
      user.signalHistory.unshift({
        id: `hist-${spreadBlockId}`,
        timestamp: nowIso,
        lusakaTime: clock.timeLusaka,
        strategy: sig.strategy,
        strategyModule: 'EMA_STOCHASTIC_PRO',
        setupType: sig.setupType,
        action: 'BLOCKED',
        symbol: sig.symbol || 'XAUUSD',
        price: sig.entry ?? quoteCtx.latestPrice ?? 0,
        signalStatus: 'BLOCKED',
        setupStatus: `Spread ${spreadEval.classification}`,
        blockReason: spreadEval.reason,
      });
      if (user.signalHistory.length > 120) user.signalHistory.length = 120;
      dirty = true;
    }
  }

  if (
    (sig.action === 'BUY' || sig.action === 'SELL') &&
    sig.entry !== null &&
    sig.stop !== null &&
    sig.target !== null &&
    !user.processedSignalIds.includes(sig.id)
  ) {
    user.processedSignalIds.push(sig.id);
    if (spreadEval?.acceptedAbove45Override) {
      user.acceptedAbove45CountToday = (user.acceptedAbove45CountToday ?? 0) + 1;
    }

    const passHistId = `hist-sig-${sig.id}`;
    if (!user.signalHistory.some((h) => h.id === passHistId)) {
      user.signalHistory.unshift({
        id: passHistId,
        timestamp: sig.timestamp,
        lusakaTime: sig.lusakaTime,
        strategy: sig.strategy,
        strategyModule: 'EMA_STOCHASTIC_PRO',
        setupType: sig.setupType,
        action: sig.action,
        symbol: sig.symbol || 'XAUUSD',
        price: sig.entry,
        stop: sig.stop,
        tp1: sig.tp1,
        tp2: sig.tp2,
        tp3: sig.tp3 ?? null,
        emaAlignment: sig.emaSummary,
        stochReading: sig.stochSummary,
        smcEvidence: sig.smcSummary,
        signalStatus: 'GENERATED',
        setupStatus: sig.setupLabel ?? sig.setupType ?? 'EMA STOCHASTIC PRO',
        blockReason: sig.reason,
      });
      if (user.signalHistory.length > 120) user.signalHistory.length = 120;
    }

    const canAutoMode = cfg.tradingMode === 'AUTOMATIC_TRADING' || cfg.tradingMode === 'BOTH';

    if (
      canAutoMode &&
      user.autoTradeEnabled &&
      isBrokerSetupComplete(user.brokerSetup) &&
      !hasWrongBrokerSetup(user.brokerSetup) &&
      !user.processedAutoIds.includes(sig.id)
    ) {
      user.processedAutoIds.push(sig.id);

      void approveAndExecuteAutoTrade({
        userId: user.id,
        lusakaDate: clock.dateLusaka,
        lusakaWeekday: clock.weekday,
        isWeekend: clock.isWeekend,
        phase: phaseRes.phase,
        newsStatus,
        emaAnalysis: emaEval.analysis,
        activeSignal: sig,
        lotToUse: sig.suggestedLots,
        dailyPnlPct,
        dailyGuardHit,
        currentCandle: proxyMarketState.currentM5Candle
          ? { ...proxyMarketState.currentM5Candle }
          : proxyMarketState.currentCandle
            ? { ...proxyMarketState.currentCandle }
            : null,
        closedCandles: m5Combined.slice(-12).reverse(),
        latestPrice: quoteCtx.latestPrice,
        latestTick: quoteCtx.tick,
        symbolSpec,
        feedConnected: feedInfo.isLive,
      });
    }
    dirty = true;
  }

  if (dirty) scheduleStoreSave();
}

function ingestBotTick(tick: NormalizedTick) {
  const parsedTs = Date.parse(tick.receivedAt);
  const nowMs = Number.isFinite(parsedTs) ? parsedTs : Date.now();
  const isPrimary = !tick.isFallback;

  state.lastAnyFeedSuccessMs = Date.now();
  if (isPrimary) {
    state.lastPrimaryTickMs = state.lastAnyFeedSuccessMs;
  }

  if (!isPrimary && state.sessionInfo.tickConfirmed) return;

  const bucketMs = Math.floor(nowMs / 900_000) * 900_000;
  const openClock = getLusakaClock(bucketMs);
  const closeClock = getLusakaClock(bucketMs + 900_000);
  const price = tick.last;

  if (
    proxyMarketState.currentCandle &&
    proxyMarketState.currentCandle.openTimeMs === bucketMs &&
    proxyMarketState.currentCandle.source === 'fallback' &&
    isPrimary
  ) {
    proxyMarketState.currentCandle = null;
  }

  if (!proxyMarketState.currentCandle || proxyMarketState.currentCandle.openTimeMs < bucketMs) {
    if (proxyMarketState.currentCandle && proxyMarketState.currentCandle.openTimeMs < bucketMs) {
      const closedBar: M15Candle = { ...proxyMarketState.currentCandle, closed: true };
      proxyMarketState.closedCandles = [
        closedBar,
        ...proxyMarketState.closedCandles.filter((c) => c.openTimeMs !== closedBar.openTimeMs),
      ]
        .sort((a, b) => b.openTimeMs - a.openTimeMs)
        .slice(0, 120);
    }
    proxyMarketState.currentCandle = {
      openTimeMs: bucketMs,
      openTimeLusaka: openClock.hhmm,
      closeTimeLusaka: closeClock.hhmm,
      open: round2(price),
      high: round2(price),
      low: round2(price),
      close: round2(price),
      ticksCount: 1,
      closed: false,
      source: isPrimary ? 'tickerall' : 'fallback',
    };
  } else {
    proxyMarketState.currentCandle.high = round2(Math.max(proxyMarketState.currentCandle.high, price));
    proxyMarketState.currentCandle.low = round2(Math.min(proxyMarketState.currentCandle.low, price));
    proxyMarketState.currentCandle.close = round2(price);
    proxyMarketState.currentCandle.ticksCount += 1;
  }

  // Also track live M5 candle for EMA STOCHASTIC PRO entries
  const m5BucketMs = Math.floor(nowMs / 300_000) * 300_000;
  const m5OpenClock = getLusakaClock(m5BucketMs);
  const m5CloseClock = getLusakaClock(m5BucketMs + 300_000);
  if (!proxyMarketState.currentM5Candle || proxyMarketState.currentM5Candle.openTimeMs < m5BucketMs) {
    if (proxyMarketState.currentM5Candle && proxyMarketState.currentM5Candle.openTimeMs < m5BucketMs) {
      const closedM5: M15Candle = { ...proxyMarketState.currentM5Candle, closed: true };
      proxyMarketState.closedM5Candles = [
        closedM5,
        ...proxyMarketState.closedM5Candles.filter((c) => c.openTimeMs !== closedM5.openTimeMs),
      ]
        .sort((a, b) => b.openTimeMs - a.openTimeMs)
        .slice(0, 260);
    }
    proxyMarketState.currentM5Candle = {
      openTimeMs: m5BucketMs,
      openTimeLusaka: m5OpenClock.hhmm,
      closeTimeLusaka: m5CloseClock.hhmm,
      open: round2(price),
      high: round2(price),
      low: round2(price),
      close: round2(price),
      ticksCount: 1,
      closed: false,
      source: isPrimary ? 'tickerall' : 'fallback',
    };
  } else {
    proxyMarketState.currentM5Candle.high = round2(Math.max(proxyMarketState.currentM5Candle.high, price));
    proxyMarketState.currentM5Candle.low = round2(Math.min(proxyMarketState.currentM5Candle.low, price));
    proxyMarketState.currentM5Candle.close = round2(price);
    proxyMarketState.currentM5Candle.ticksCount += 1;
  }

  if (isPrimary) {
    recordPrimaryTickerAllTick(price, nowMs);
  }

  refreshAllUserExpiries();
  for (const user of getStore().users) {
    if (user.status === 'ACTIVE' && user.feedAccess) {
      updateUserSessionRangeWithPrice(user, price, nowMs, isPrimary);
      evaluateUserOnProxyTick(user, price, nowMs);
    }
  }
}

function ingestHistoryBarsFromWs(parsed: unknown) {
  if (!parsed || typeof parsed !== 'object') return;
  const rec = !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const tfHint = String(
    rec?.timeframe ?? rec?.tf ?? rec?.interval ?? ''
  ).toUpperCase();
  const tf: 'M1' | 'M5' | 'M15' | 'H1' =
    tfHint === 'H1' || tfHint === '1H'
      ? 'H1'
      : tfHint === 'M5' || tfHint === '5M'
        ? 'M5'
        : tfHint === 'M1' || tfHint === '1M'
          ? 'M1'
          : 'M15';

  const extracted = extractBarsFromTickerAllPayload(parsed, tf);
  if (extracted.length === 0) return;

  ingestRealTickerAllHistoryCandles(extracted, tf);

  if (tf === 'M5') {
    for (const c of extracted) {
      if (c.closed && !proxyMarketState.closedM5Candles.some((x) => x.openTimeMs === c.openTimeMs)) {
        proxyMarketState.closedM5Candles.push(c);
      }
    }
    proxyMarketState.closedM5Candles = proxyMarketState.closedM5Candles
      .sort((a, b) => b.openTimeMs - a.openTimeMs)
      .slice(0, 260);
    return;
  }

  if (tf === 'H1' || tf === 'M1') return;

  const todayStr = getLusakaClock().dateLusaka;
  for (const candle of extracted) {
    if (candle.closed) {
      if (!proxyMarketState.closedCandles.some((c) => c.openTimeMs === candle.openTimeMs)) {
        proxyMarketState.closedCandles.push(candle);
      }
    }

    const openClock = getLusakaClock(candle.openTimeMs);
    if (openClock.dateLusaka === todayStr) {
      for (const user of getStore().users) {
        if (user.status !== 'ACTIVE' || !user.feedAccess) continue;
        const asianStartMin = parseHHMMToMinutes(user.settings.asianStart, 180);
        const asianEndMin = parseHHMMToMinutes(user.settings.asianEnd, 660);
        const londonStartMin = parseHHMMToMinutes(user.settings.londonStart, 660);
        const londonEndMin = parseHHMMToMinutes(user.settings.londonEnd, 1140);
        if (openClock.minutes >= asianStartMin && openClock.minutes < asianEndMin) {
          user.levels.asianHigh =
            user.levels.asianHigh === null ? candle.high : round2(Math.max(user.levels.asianHigh, candle.high));
          user.levels.asianLow =
            user.levels.asianLow === null ? candle.low : round2(Math.min(user.levels.asianLow, candle.low));
        }
        if (openClock.minutes >= londonStartMin && openClock.minutes <= londonEndMin) {
          user.levels.londonHigh =
            user.levels.londonHigh === null ? candle.high : round2(Math.max(user.levels.londonHigh, candle.high));
          user.levels.londonLow =
            user.levels.londonLow === null ? candle.low : round2(Math.min(user.levels.londonLow, candle.low));
        }
      }
    }
  }

  proxyMarketState.closedCandles = proxyMarketState.closedCandles
    .sort((a, b) => b.openTimeMs - a.openTimeMs)
    .slice(0, 120);
}

function getByPath(obj: unknown, pathStr: string): unknown {
  if (!pathStr || !pathStr.trim() || obj === null || obj === undefined) {
    return undefined;
  }
  const normalized = pathStr.trim().replace(/\[(\d+)\]/g, '.$1');
  const segments = normalized.split('.').filter(Boolean);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (Number.isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

function toFiniteNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildTargetUrl(cfg: ConnectionConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const pathPart = cfg.endpointPath.startsWith('/') ? cfg.endpointPath : `/${cfg.endpointPath}`;
  const replaced = pathPart.replace(/\{symbol\}/g, encodeURIComponent(cfg.symbol));
  const url = new URL(`${base}${replaced}`);
  const apiKey = cfg.adapterId === 'tickerall-ws' ? getAdminTickerAllKey() : '';
  if (cfg.authHeaderMode === 'query-param' && apiKey) {
    url.searchParams.set('apikey', apiKey);
  }
  return url.toString();
}

function buildHeaders(cfg: ConnectionConfig, isJsonBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'GoldMaster-Connectivity/1.0',
  };
  if (isJsonBody) {
    headers['Content-Type'] = 'application/json';
  }
  const apiKey = cfg.adapterId === 'tickerall-ws' ? getAdminTickerAllKey() : '';
  if (apiKey) {
    if (cfg.authHeaderMode === 'bearer') {
      headers.Authorization = `Bearer ${apiKey}`;
    } else if (cfg.authHeaderMode === 'x-api-key') {
      headers['X-API-Key'] = apiKey;
    }
  }
  return headers;
}

function normalizePayload(
  cfg: ConnectionConfig,
  rawPayload: unknown,
  httpStatus: number,
  latencyMs: number,
  isFallback = false
): NormalizedTick {
  state.seqCounter += 1;
  const nowIso = new Date().toISOString();

  let last: number | null = null;
  let bid: number | null = null;
  let ask: number | null = null;
  let volume24h: number | null = null;
  let change24hPct: number | null = null;
  let upstreamSymbol = cfg.symbol;
  let upstreamTimestamp = nowIso;

  const mappedPrice = toFiniteNumber(getByPath(rawPayload, cfg.schemaMapping.pricePath));
  const mappedBid = toFiniteNumber(getByPath(rawPayload, cfg.schemaMapping.bidPath));
  const mappedAsk = toFiniteNumber(getByPath(rawPayload, cfg.schemaMapping.askPath));
  const mappedVol = toFiniteNumber(getByPath(rawPayload, cfg.schemaMapping.volumePath));
  const mappedChange = toFiniteNumber(getByPath(rawPayload, cfg.schemaMapping.change24hPath));
  const mappedSymbol = getByPath(rawPayload, cfg.schemaMapping.symbolPath);
  const mappedTs = getByPath(rawPayload, cfg.schemaMapping.timestampPath);

  if (cfg.adapterId === 'bullion-kraken' && rawPayload && typeof rawPayload === 'object') {
    const result = (rawPayload as { result?: Record<string, Record<string, unknown>> }).result;
    const pairKey = result ? Object.keys(result)[0] : undefined;
    const pairData = pairKey && result ? result[pairKey] : undefined;
    if (pairKey && pairData) {
      upstreamSymbol = pairKey;
      last = mappedPrice ?? toFiniteNumber((pairData.c as unknown[])?.[0]);
      bid = mappedBid ?? toFiniteNumber((pairData.b as unknown[])?.[0]);
      ask = mappedAsk ?? toFiniteNumber((pairData.a as unknown[])?.[0]);
      volume24h = mappedVol ?? toFiniteNumber((pairData.v as unknown[])?.[1]);
      const openPrice = toFiniteNumber(pairData.o);
      if (last !== null && openPrice !== null && openPrice > 0) {
        change24hPct = Math.round(((last - openPrice) / openPrice) * 10000) / 100;
      }
    }
  } else if (cfg.adapterId === 'comex-futures' && rawPayload && typeof rawPayload === 'object') {
    const meta = getByPath(rawPayload, 'chart.result[0].meta') as
      | Record<string, unknown>
      | undefined;
    if (meta) {
      upstreamSymbol = String(meta.symbol || cfg.symbol);
      last = mappedPrice ?? toFiniteNumber(meta.regularMarketPrice);
      bid = mappedBid ?? toFiniteNumber(meta.bid) ?? last;
      ask = mappedAsk ?? toFiniteNumber(meta.ask) ?? last;
      volume24h = mappedVol ?? toFiniteNumber(meta.regularMarketVolume);
      const prevClose = toFiniteNumber(meta.chartPreviousClose);
      if (last !== null && prevClose !== null && prevClose > 0) {
        change24hPct = Math.round(((last - prevClose) / prevClose) * 10000) / 100;
      }
      if (typeof meta.regularMarketTime === 'number') {
        upstreamTimestamp = new Date(meta.regularMarketTime * 1000).toISOString();
      }
    }
  } else {
    last = mappedPrice;
    bid = mappedBid;
    ask = mappedAsk;
    volume24h = mappedVol;
    change24hPct = mappedChange;
    if (typeof mappedSymbol === 'string' && mappedSymbol.trim()) {
      upstreamSymbol = mappedSymbol;
    }
  }

  if (last === null && rawPayload && typeof rawPayload === 'object') {
    const rec = rawPayload as Record<string, unknown>;
    const asObj = (val: unknown): Record<string, unknown> | undefined =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? (val as Record<string, unknown>)
        : undefined;
    const firstObj = (val: unknown): Record<string, unknown> | undefined =>
      Array.isArray(val) && val.length > 0 ? asObj(val[0]) : undefined;

    const dataObj = asObj(rec.data);
    const payloadObj = asObj(rec.payload);
    const snapshotObj = asObj(rec.snapshot);
    const candidates = [
      rec,
      dataObj,
      asObj(rec.tick),
      snapshotObj,
      asObj(rec.quote),
      payloadObj,
      firstObj(rec.ticks),
      firstObj(rec.bars),
      firstObj(rec.candles),
      firstObj(rec.history),
      asObj(dataObj?.tick),
      asObj(dataObj?.snapshot),
      firstObj(dataObj?.ticks),
      firstObj(dataObj?.bars),
      firstObj(dataObj?.candles),
      firstObj(dataObj?.history),
      firstObj(rec.data),
      asObj(payloadObj?.tick),
      asObj(payloadObj?.snapshot),
      firstObj(payloadObj?.ticks),
      asObj(rec.d),
      asObj(rec.result),
    ].filter((c): c is Record<string, unknown> => Boolean(c));

    const pickNum = (keys: string[]): number | null => {
      for (const obj of candidates) {
        for (const k of keys) {
          const n = toFiniteNumber(obj[k]);
          if (n !== null) return n;
        }
      }
      return null;
    };

    last = pickNum(['price', 'last', 'lastPrice', 'last_price', 'close', 'c', 'mid', 'p', 'Price', 'Last', 'Close']);
    bid = bid ?? pickNum(['bid', 'bidPrice', 'bid_price', 'b', 'Bid']);
    ask = ask ?? pickNum(['ask', 'askPrice', 'ask_price', 'a', 'Ask']);

    for (const obj of candidates) {
      const sym = obj.symbol ?? obj.sym ?? obj.instrument;
      if (typeof sym === 'string' && sym.trim()) {
        upstreamSymbol = sym.trim();
        break;
      }
    }
    if (!mappedTs) {
      for (const obj of candidates) {
        const tsVal = obj.timestamp ?? obj.ts ?? obj.time ?? obj.t;
        if (typeof tsVal === 'string' && tsVal.trim()) {
          const parsedDate = new Date(tsVal);
          if (!Number.isNaN(parsedDate.getTime())) {
            upstreamTimestamp = parsedDate.toISOString();
            break;
          }
        } else if (typeof tsVal === 'number' && Number.isFinite(tsVal)) {
          const ms = tsVal > 1e12 ? tsVal : tsVal * 1000;
          upstreamTimestamp = new Date(ms).toISOString();
          break;
        }
      }
    }
  }

  if (last === null && (bid !== null || ask !== null)) {
    last = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
  }

  if (last === null) {
    throw new Error(
      `Schema normalization failed: no numeric price found at path "${cfg.schemaMapping.pricePath || 'last'}".`
    );
  }

  updateLiveSymbolSpecFromPayload(rawPayload);

  // Detect exact symbol digits & pointSize from payload or live XM symbol spec (do NOT clamp to 2 decimals)
  const spec = resolveSymbolSpecification({
    symbol: upstreamSymbol || spreadTelemetryState.liveSymbolSpec.symbol,
    bid,
    ask,
    last,
    fallbackSpec: spreadTelemetryState.liveSymbolSpec,
  });

  const hasTwoSidedQuote =
    !isFallback &&
    bid !== null &&
    ask !== null &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask >= bid;

  const finalBid = roundToDigits(bid ?? last, spec.digits);
  const finalAsk = roundToDigits(ask ?? last, spec.digits);
  const roundedLast = roundToDigits(last, spec.digits);
  const mid = roundToDigits((finalBid + finalAsk) / 2, spec.digits);
  const spreadMetrics = hasTwoSidedQuote
    ? computeSpreadMetrics(finalBid, finalAsk, spec.pointSize, spec.digits)
    : { spreadPrice: Math.max(0, roundToDigits(finalAsk - finalBid, spec.digits)), spreadPoints: 0 };
  const spreadBps = mid > 0 ? Math.round((spreadMetrics.spreadPrice / mid) * 100000) / 10 : 0;

  if (typeof mappedTs === 'string' && mappedTs.trim()) {
    const parsedDate = new Date(mappedTs);
    if (!Number.isNaN(parsedDate.getTime())) {
      upstreamTimestamp = parsedDate.toISOString();
    }
  } else if (typeof mappedTs === 'number' && Number.isFinite(mappedTs)) {
    const ms = mappedTs > 1e12 ? mappedTs : mappedTs * 1000;
    upstreamTimestamp = new Date(ms).toISOString();
  }

  return {
    seq: state.seqCounter,
    adapterId: cfg.adapterId,
    symbol: 'GOLD',
    upstreamSymbol,
    last: roundedLast,
    bid: finalBid,
    ask: finalAsk,
    mid,
    spread: spreadMetrics.spreadPrice,
    spreadPoints: hasTwoSidedQuote ? spreadMetrics.spreadPoints : null,
    spreadBps,
    digits: spec.digits,
    pointSize: spec.pointSize,
    hasTwoSidedQuote,
    volume24h,
    change24hPct,
    latencyMs: Math.round(latencyMs * 10) / 10,
    httpStatus,
    receivedAt: nowIso,
    upstreamTimestamp,
    sourceLabel: ADAPTER_DEFAULTS[cfg.adapterId].sourceLabel,
    isFallback,
    rawPayload,
  };
}

function buildFallbackConfig(adapterId: 'bullion-kraken' | 'spot-gold-api'): ConnectionConfig {
  const preset = ADAPTER_DEFAULTS[adapterId];
  return {
    adapterId,
    connectionName: preset.connectionName,
    baseUrl: preset.baseUrl,
    endpointPath: preset.endpointPath,
    symbol: preset.symbol,
    authHeaderMode: preset.authHeaderMode,
    pollIntervalMs: state.config.pollIntervalMs,
    timeoutMs: state.config.timeoutMs,
    brokerType: state.config.brokerType,
    brokerServer: state.config.brokerServer,
    mt5AccountNumber: state.config.mt5AccountNumber,
    hasBrokerPassword: Boolean(getAdminMasterPassword()),
    schemaMapping: { ...preset.schemaMapping },
    symbolBindings: state.config.symbolBindings,
  };
}

async function fetchHttpTick(
  cfg: ConnectionConfig,
  isFallback = false
): Promise<{ ok: boolean; tick?: NormalizedTick; error?: string; httpStatus?: number; latencyMs?: number }> {
  const targetUrl = buildTargetUrl(cfg);
  const urlCheck = isSafeExternalUrl(targetUrl);
  if (!urlCheck.safe) {
    return { ok: false, error: urlCheck.reason || 'Unsafe endpoint URL' };
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: buildHeaders(cfg),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(cfg.timeoutMs, 20000))),
    });
    const latencyMs = Math.round((performance.now() - startedAt) * 10) / 10;

    const text = await response.text();
    let jsonPayload: unknown;
    try {
      jsonPayload = JSON.parse(text);
    } catch {
      jsonPayload = { rawText: text.slice(0, 600) };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText || 'Error'} from ${new URL(targetUrl).hostname}`,
        httpStatus: response.status,
        latencyMs,
      };
    }

    if (
      jsonPayload &&
      typeof jsonPayload === 'object' &&
      Array.isArray((jsonPayload as { error?: unknown[] }).error) &&
      (jsonPayload as { error: unknown[] }).error.length > 0
    ) {
      return {
        ok: false,
        error: (jsonPayload as { error: unknown[] }).error.join('; '),
        httpStatus: response.status,
        latencyMs,
      };
    }

    const tick = normalizePayload(cfg, jsonPayload, response.status, latencyMs, isFallback);
    return { ok: true, tick, httpStatus: response.status, latencyMs };
  } catch (err) {
    const latencyMs = Math.round((performance.now() - startedAt) * 10) / 10;
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error',
      latencyMs,
    };
  }
}

async function refreshFallbackPrice(emitLog = false, force = false): Promise<NormalizedTick | null> {
  const nowMs = Date.now();
  if (state.fallbackInFlight) return state.fallbackTick;
  if (!force && nowMs - state.lastMasterFetchAttemptMs < MASTER_FEED_CACHE_MS) {
    return state.fallbackTick;
  }
  state.lastMasterFetchAttemptMs = nowMs;
  state.fallbackInFlight = true;
  try {
    const krakenCfg = buildFallbackConfig('bullion-kraken');
    let res = await fetchHttpTick(krakenCfg, true);

    if (!res.ok) {
      const goldApiCfg = buildFallbackConfig('spot-gold-api');
      res = await fetchHttpTick(goldApiCfg, true);
    }

    if (res.ok && res.tick) {
      state.fallbackTick = res.tick;
      state.lastAnyFeedSuccessMs = Date.now();
      state.fallbackTicks.unshift(res.tick);
      if (state.fallbackTicks.length > 60) state.fallbackTicks.length = 60;
      ingestBotTick(res.tick);

      if (emitLog) {
        addLog({
          level: 'info',
          event: 'Fallback Price Updated',
          adapterId: res.tick.adapterId,
          endpoint: buildTargetUrl(
            res.tick.adapterId === 'bullion-kraken'
              ? buildFallbackConfig('bullion-kraken')
              : buildFallbackConfig('spot-gold-api')
          ),
          httpStatus: res.tick.httpStatus,
          latencyMs: res.tick.latencyMs,
          detail: `Fallback price via ${res.tick.sourceLabel}: $${res.tick.last.toFixed(2)}`,
        });
      }

      broadcastSse('tick');
      return res.tick;
    }
    return null;
  } finally {
    state.fallbackInFlight = false;
  }
}

let wsEscalationTimers: Array<ReturnType<typeof setTimeout>> = [];
function clearWsEscalationTimers() {
  for (const t of wsEscalationTimers) clearTimeout(t);
  wsEscalationTimers = [];
}

let quietMarketTimer: ReturnType<typeof setTimeout> | null = null;
function clearQuietMarketTimer() {
  if (quietMarketTimer) {
    clearTimeout(quietMarketTimer);
    quietMarketTimer = null;
  }
}

let wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
function clearWsHeartbeatTimer() {
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
}

function closeTickerAllSocket() {
  clearWsEscalationTimers();
  clearQuietMarketTimer();
  clearWsHeartbeatTimer();
  if (state.activeWs) {
    try {
      state.activeWs.removeAllListeners();
      if (
        state.activeWs.readyState === WebSocket.OPEN ||
        state.activeWs.readyState === WebSocket.CONNECTING
      ) {
        state.activeWs.close();
      }
    } catch {
      // Ignore socket close error
    }
    state.activeWs = null;
  }
  state.sessionInfo.wsReadyState = 'closed';
}

function pickIdValue(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const val = rec[k];
    if (typeof val === 'string' && val.trim().length > 0) return val.trim();
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  }
  return null;
}

let accountWsFallbackTimer: ReturnType<typeof setTimeout> | null = null;
function clearAccountWsFallbackTimer() {
  if (accountWsFallbackTimer) {
    clearTimeout(accountWsFallbackTimer);
    accountWsFallbackTimer = null;
  }
}

function extractTickerAllSession(
  cfg: ConnectionConfig,
  payload: unknown
): { sessionId: string | null; accountId: string | null; wsUrl: string; token: string | null } {
  const rec = (payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {}) as Record<string, unknown>;
  const dataRec =
    rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
      ? (rec.data as Record<string, unknown>)
      : null;
  const sessionRec =
    rec.session && typeof rec.session === 'object' && !Array.isArray(rec.session)
      ? (rec.session as Record<string, unknown>)
      : null;
  const resultRec =
    rec.result && typeof rec.result === 'object' && !Array.isArray(rec.result)
      ? (rec.result as Record<string, unknown>)
      : null;
  const accountRec =
    rec.account && typeof rec.account === 'object' && !Array.isArray(rec.account)
      ? (rec.account as Record<string, unknown>)
      : null;
  const dataSessionRec =
    dataRec?.session && typeof dataRec.session === 'object' && !Array.isArray(dataRec.session)
      ? (dataRec.session as Record<string, unknown>)
      : null;

  const accountId =
    pickIdValue(rec, ['accountId', 'account_id']) ||
    pickIdValue(dataRec, ['accountId', 'account_id']) ||
    pickIdValue(sessionRec, ['accountId', 'account_id']) ||
    pickIdValue(resultRec, ['accountId', 'account_id']) ||
    pickIdValue(accountRec, ['accountId', 'account_id', 'id']) ||
    null;

  const explicitSessionId =
    pickIdValue(rec, ['sessionId', 'session_id', 'id']) ||
    pickIdValue(dataRec, ['sessionId', 'session_id', 'id']) ||
    pickIdValue(sessionRec, ['sessionId', 'session_id', 'id']) ||
    pickIdValue(dataSessionRec, ['sessionId', 'session_id', 'id']) ||
    pickIdValue(resultRec, ['sessionId', 'session_id', 'id']) ||
    null;

  const sessionId = explicitSessionId || accountId;

  const token =
    pickIdValue(rec, ['token', 'access_token', 'accessToken', 'jwt']) ||
    pickIdValue(dataRec, ['token', 'access_token', 'accessToken', 'jwt']) ||
    pickIdValue(sessionRec, ['token', 'access_token', 'accessToken', 'jwt']) ||
    pickIdValue(resultRec, ['token', 'access_token', 'accessToken', 'jwt']) ||
    null;

  const wsKeys = [
    'wsUrl',
    'ws_url',
    'websocketUrl',
    'websocket_url',
    'streamUrl',
    'stream_url',
  ];
  const rawWsUrl =
    pickIdValue(rec, wsKeys) ||
    pickIdValue(dataRec, wsKeys) ||
    pickIdValue(sessionRec, wsKeys) ||
    pickIdValue(resultRec, wsKeys) ||
    null;

  if (rawWsUrl) {
    return { sessionId, accountId, wsUrl: rawWsUrl, token };
  }

  const parsedBase = new URL(cfg.baseUrl);
  const wsProto = parsedBase.protocol === 'http:' ? 'ws:' : 'wss:';
  const defaultWs = new URL(`${wsProto}//${parsedBase.host}/v1/stream`);
  if (explicitSessionId) defaultWs.searchParams.set('session_id', explicitSessionId);
  if (token) defaultWs.searchParams.set('token', token);
  return { sessionId, accountId, wsUrl: defaultWs.toString(), token };
}

function formatUpstreamError(
  status: number,
  statusText: string,
  jsonPayload: unknown,
  rawText: string
): string {
  if (jsonPayload && typeof jsonPayload === 'object') {
    const rec = jsonPayload as Record<string, unknown>;
    const extracted =
      (typeof rec.message === 'string' && rec.message) ||
      (typeof rec.error === 'string' && rec.error) ||
      (typeof rec.detail === 'string' && rec.detail) ||
      (Array.isArray(rec.errors)
        ? rec.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')
        : null) ||
      (typeof rec.errors === 'object' && rec.errors !== null
        ? JSON.stringify(rec.errors)
        : null);
    if (extracted) {
      return `HTTP ${status}: ${extracted}`;
    }
    const serialized = JSON.stringify(jsonPayload);
    if (serialized && serialized !== '{}') {
      return `HTTP ${status}: ${serialized}`;
    }
  }
  if (rawText && rawText.trim()) {
    return `HTTP ${status}: ${rawText.trim().slice(0, 400)}`;
  }
  return `HTTP ${status} ${statusText || 'Error'}`;
}

function extractAccountMetrics(
  payload: unknown,
  sessionId?: string | null,
  targetAccount?: string
): Partial<AccountBalanceInfo> | null {
  if (!payload || typeof payload !== 'object') return null;

  const candidates: Array<Record<string, unknown>> = [];
  const pushIfObj = (val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      candidates.push(val as Record<string, unknown>);
    } else if (Array.isArray(val)) {
      const objs = val.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      );
      if (sessionId || targetAccount) {
        const matched = objs.find(
          (item) =>
            (sessionId &&
              (item.id === sessionId ||
                item.sessionId === sessionId ||
                item.session_id === sessionId)) ||
            (targetAccount &&
              (String(item.account ?? '') === targetAccount ||
                String(item.login ?? '') === targetAccount ||
                String(item.accountNumber ?? '') === targetAccount))
        );
        if (matched) {
          candidates.push(matched);
          if (matched.account && typeof matched.account === 'object') {
            candidates.push(matched.account as Record<string, unknown>);
          }
        }
      }
      for (const item of objs) {
        candidates.push(item);
        if (item.account && typeof item.account === 'object') {
          candidates.push(item.account as Record<string, unknown>);
        }
      }
    }
  };

  if (Array.isArray(payload)) {
    pushIfObj(payload);
  } else {
    const rec = payload as Record<string, unknown>;
    pushIfObj(rec);
    pushIfObj(rec.account);
    pushIfObj(rec.data);
    pushIfObj(rec.result);
    pushIfObj(rec.info);
    pushIfObj(rec.payload);
    pushIfObj(rec.session);
    pushIfObj(rec.sessions);
    pushIfObj(rec.items);
    if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
      const dataObj = rec.data as Record<string, unknown>;
      pushIfObj(dataObj.account);
      pushIfObj(dataObj.session);
      pushIfObj(dataObj.sessions);
    }
    if (rec.session && typeof rec.session === 'object' && !Array.isArray(rec.session)) {
      const sessionObj = rec.session as Record<string, unknown>;
      pushIfObj(sessionObj.account);
    }
  }

  for (const obj of candidates) {
    const balance = toFiniteNumber(
      obj.balance ?? obj.cash ?? obj.account_balance ?? obj.accountBalance
    );
    const equity = toFiniteNumber(
      obj.equity ?? obj.nav ?? obj.net_liquidation ?? obj.netLiquidation
    );
    const margin = toFiniteNumber(obj.margin ?? obj.used_margin ?? obj.margin_used);
    const freeMargin = toFiniteNumber(
      obj.freeMargin ??
        obj.free_margin ??
        obj.available_margin ??
        obj.margin_free ??
        obj.marginFree
    );

    if (balance !== null || equity !== null) {
      const rawAcct =
        typeof obj.account === 'string' || typeof obj.account === 'number'
          ? String(obj.account)
          : typeof obj.login === 'string' || typeof obj.login === 'number'
            ? String(obj.login)
            : typeof obj.accountNumber === 'string' || typeof obj.accountNumber === 'number'
              ? String(obj.accountNumber)
              : undefined;

      return {
        broker: typeof obj.broker === 'string' ? obj.broker : undefined,
        server: typeof obj.server === 'string' ? obj.server : undefined,
        accountNumber: rawAcct,
        balance,
        equity,
        margin,
        freeMargin,
        currency: typeof obj.currency === 'string' && obj.currency ? obj.currency : 'USD',
      };
    }
  }

  return null;
}

async function fetchTickerAllAccountInfo(
  cfg: ConnectionConfig,
  sessionId: string | null,
  sessionPayload?: unknown,
  emitLog = true
): Promise<AccountBalanceInfo> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  state.accountInfo.broker = cfg.brokerType || 'mt5';
  state.accountInfo.server = cfg.brokerServer || '';
  state.accountInfo.accountNumber = cfg.mt5AccountNumber || '';

  const payloadToInspect = sessionPayload ?? state.sessionInfo.rawSessionResponse;
  const extracted = payloadToInspect ? extractTickerAllSession(cfg, payloadToInspect) : null;
  const savedAccountId =
    state.sessionInfo.accountId ||
    state.accountInfo.accountId ||
    extracted?.accountId ||
    null;
  const recoveredSessionId =
    sessionId ||
    state.sessionInfo.sessionId ||
    extracted?.sessionId ||
    savedAccountId ||
    null;

  if (savedAccountId) {
    state.sessionInfo.accountId = savedAccountId;
    state.accountInfo.accountId = savedAccountId;
  }
  if (recoveredSessionId && !state.sessionInfo.sessionId) {
    state.sessionInfo.sessionId = recoveredSessionId;
  }

  const inlineMetrics = extractAccountMetrics(
    payloadToInspect,
    recoveredSessionId,
    cfg.mt5AccountNumber
  );
  if (
    inlineMetrics &&
    ((inlineMetrics.balance !== null && inlineMetrics.balance !== undefined) ||
      (inlineMetrics.equity !== null && inlineMetrics.equity !== undefined))
  ) {
    state.accountInfo = {
      ...state.accountInfo,
      ...inlineMetrics,
      broker: inlineMetrics.broker || cfg.brokerType || 'mt5',
      server: inlineMetrics.server || cfg.brokerServer || '',
      accountNumber: inlineMetrics.accountNumber || cfg.mt5AccountNumber || '',
      accountId: savedAccountId || state.accountInfo.accountId || '',
      sourceEndpoint: 'POST /v1/sessions (inline)',
      statusMessage: null,
      lastUpdatedAt: new Date().toISOString(),
      attempts: [],
    };
    syncUsersWithTickerAllAccountInfo();
    return state.accountInfo;
  }

  const encodedAccountId = savedAccountId ? encodeURIComponent(savedAccountId) : null;
  if (encodedAccountId) {
    try {
      const fullUrl = `${base}/v1/accounts/${encodedAccountId}`;
      incrementTickerAllQuota(1);
      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: buildHeaders(cfg, false),
        signal: AbortSignal.timeout(Math.max(1500, Math.min(cfg.timeoutMs, 10000))),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = null;
      }
      if (response.ok && parsed) {
        const metrics = extractAccountMetrics(parsed, sessionId, cfg.mt5AccountNumber);
        if (metrics) {
          state.accountInfo = {
            ...state.accountInfo,
            ...metrics,
            sourceEndpoint: `GET /v1/accounts/${savedAccountId}`,
            statusMessage: null,
            lastUpdatedAt: new Date().toISOString(),
          };
          syncUsersWithTickerAllAccountInfo();
          if (emitLog) {
            addLog({
              level: 'success',
              event: 'Master Account Loaded',
              adapterId: cfg.adapterId,
              endpoint: fullUrl,
              httpStatus: response.status,
              latencyMs: null,
              detail: `Balance: ${metrics.balance ?? '—'}`,
            });
          }
        }
      }
    } catch {
      // Ignore upstream probe timeout
    }
  }
  return state.accountInfo;
}

function stopAccountRefreshLoop() {
  if (state.accountTimer) {
    clearInterval(state.accountTimer);
    state.accountTimer = null;
  }
}

function startAccountRefreshLoop() {
  stopAccountRefreshLoop();
  state.accountTimer = setInterval(() => {
    if (
      state.config.adapterId === 'tickerall-ws' &&
      state.accountInfo.sourceEndpoint !== 'POST /v1/sessions (inline)' &&
      (state.status === 'connected' || state.sessionInfo.wsReadyState === 'open')
    ) {
      void fetchTickerAllAccountInfo(state.config, state.sessionInfo.sessionId, undefined, false);
    }
  }, 15000);
}

// Preserves exact proven TickerAll WS protocol:
// POST /v1/sessions -> WS connect -> ping/pong -> subscribe ONCE with GOLD + account (+ weekday history)
async function startTickerAllSessionAndStream(
  cfg: ConnectionConfig,
  probeMode: boolean,
  passwordOverride?: string
): Promise<{
  ok: boolean;
  tick?: NormalizedTick;
  error?: string;
  httpStatus?: number;
  latencyMs?: number;
}> {
  const adminApiKey = getAdminTickerAllKey();
  if (!adminApiKey) {
    const errMsg = 'Admin TickerAll API Key is not configured yet in /admin.';
    state.status = 'error';
    state.lastError = errMsg;
    broadcastSse('status');
    return { ok: false, error: errMsg };
  }

  closeTickerAllSocket();
  const currentGeneration = ++state.sessionGeneration;

  const sessionUrl = buildTargetUrl(cfg);
  const urlCheck = isSafeExternalUrl(sessionUrl);
  if (!urlCheck.safe) {
    const reason = urlCheck.reason || 'Unsafe session URL';
    state.status = 'error';
    state.lastError = reason;
    state.failedProbes += 1;
    return { ok: false, error: reason };
  }

  state.status = 'connecting';
  state.lastError = null;
  state.latestTick = null;
  state.recentTicks = [];
  state.sessionInfo = {
    transport: 'websocket',
    sessionId: null,
    accountId: null,
    wsUrl: null,
    wsReadyState: 'closed',
    tickConfirmed: false,
    subscribedConfirmed: false,
    quietMarketNotice: null,
    subscribedSymbols: [],
    rejectedSymbols: [],
    lastTickAt: null,
    totalTickFrames: 0,
    rawWsFrames: [],
    rawSessionResponse: null,
    rawSessionResponseAt: null,
  };
  broadcastSse('status');

  const startedAt = performance.now();
  let sessionHttpStatus: number | null = null;
  let sessionLatencyMs = 0;

  const passwordToSend =
    typeof passwordOverride === 'string' && passwordOverride.length > 0
      ? passwordOverride
      : getAdminMasterPassword();

  const parsedAccount = Number((cfg.mt5AccountNumber || '').trim());
  const accountValue =
    cfg.mt5AccountNumber.trim() !== '' && Number.isFinite(parsedAccount) && parsedAccount > 0
      ? parsedAccount
      : 0;

  const sessionPayload = {
    broker: cfg.brokerType || 'mt5',
    server: (cfg.brokerServer || '').trim(),
    account: accountValue,
    password: passwordToSend,
  };

  if (!sessionPayload.server || !Number.isFinite(sessionPayload.account) || sessionPayload.account <= 0) {
    const validationMsg = 'Configure Admin Master MT5 Server and Account Number in /admin first';
    state.status = 'error';
    state.lastError = validationMsg;
    state.connectedSince = null;
    broadcastSse('status');
    return { ok: false, error: validationMsg };
  }

  try {
    incrementTickerAllQuota(1);
    const response = await fetch(sessionUrl, {
      method: 'POST',
      headers: buildHeaders(cfg, true),
      body: JSON.stringify(sessionPayload),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(cfg.timeoutMs, 20000))),
    });
    sessionLatencyMs = Math.round((performance.now() - startedAt) * 10) / 10;
    sessionHttpStatus = response.status;

    const text = await response.text();
    let jsonPayload: unknown = {};
    try {
      jsonPayload = text ? JSON.parse(text) : {};
    } catch {
      jsonPayload = { rawText: text.slice(0, 400) };
    }

    if (!response.ok) {
      const errMsg = formatUpstreamError(
        response.status,
        response.statusText,
        jsonPayload,
        text
      );
      state.sessionInfo.rawSessionResponse = jsonPayload;
      state.sessionInfo.rawSessionResponseAt = new Date().toISOString();
      state.failedProbes += 1;
      state.status = 'error';
      state.lastError = errMsg;
      state.connectedSince = null;
      await refreshFallbackPrice(true);
      broadcastSse('status');
      return {
        ok: false,
        error: errMsg,
        httpStatus: response.status,
        latencyMs: sessionLatencyMs,
      };
    }

    updateLiveSymbolSpecFromPayload(jsonPayload);
    const { sessionId, accountId, wsUrl, token } = extractTickerAllSession(cfg, jsonPayload);
    const wsCheck = isSafeExternalUrl(wsUrl);
    if (!wsCheck.safe) {
      const errMsg = wsCheck.reason || 'Invalid WebSocket URL returned by session endpoint';
      state.failedProbes += 1;
      state.status = 'error';
      state.lastError = errMsg;
      await refreshFallbackPrice(true);
      broadcastSse('status');
      return { ok: false, error: errMsg, httpStatus: response.status, latencyMs: sessionLatencyMs };
    }

    state.sessionInfo = {
      transport: 'websocket',
      sessionId,
      accountId,
      wsUrl,
      wsReadyState: 'connecting',
      tickConfirmed: false,
      subscribedConfirmed: false,
      quietMarketNotice: null,
      subscribedSymbols: [],
      rejectedSymbols: [],
      lastTickAt: null,
      totalTickFrames: 0,
      rawWsFrames: [],
      rawSessionResponse: jsonPayload,
      rawSessionResponseAt: new Date().toISOString(),
    };

    if (accountId) state.accountInfo.accountId = accountId;

    if (!probeMode) startAccountRefreshLoop();

    const wsHeaders: Record<string, string> = {
      'User-Agent': 'GoldMaster-Connectivity/1.0',
    };
    if (token) {
      wsHeaders.Authorization = `Bearer ${token}`;
    } else if (adminApiKey) {
      wsHeaders.Authorization = `Bearer ${adminApiKey}`;
    }

    if (currentGeneration !== state.sessionGeneration) {
      return { ok: false, error: 'Superseded by a newer connection attempt', httpStatus: response.status, latencyMs: sessionLatencyMs };
    }

    closeTickerAllSocket();
    clearAccountWsFallbackTimer();
    const effectiveAccountId = accountId || sessionId || '';

    return await new Promise((resolve) => {
      let settled = false;
      let tickParsed = false;
      let accountFrameReceived = false;
      let totalFramesSeen = 0;
      let lastWsSignalMessage: string | null = null;
      let retriedWithoutHistory = false;

      const ws = new WebSocket(wsUrl, {
        headers: wsHeaders,
        handshakeTimeout: Math.max(1500, Math.min(cfg.timeoutMs, 15000)),
      });
      state.activeWs = ws;

      const recordRawWsFrame = (formattedPayload: string, isJson: boolean) => {
        totalFramesSeen += 1;
        state.wsFrameCounter += 1;
        state.sessionInfo.rawWsFrames.push({
          index: state.wsFrameCounter,
          receivedAt: new Date().toISOString(),
          payload: formattedPayload,
          isJson,
        });
        if (state.sessionInfo.rawWsFrames.length > 5) {
          state.sessionInfo.rawWsFrames = state.sessionInfo.rawWsFrames.slice(-5);
        }
      };

      const isAccountWsFrame = (parsedObj: unknown): boolean => {
        if (!parsedObj || typeof parsedObj !== 'object' || Array.isArray(parsedObj)) return false;
        const rec = parsedObj as Record<string, unknown>;
        const nested =
          rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
            ? (rec.data as Record<string, unknown>)
            : null;
        const kindVal = String(rec.kind ?? nested?.kind ?? '').toLowerCase();
        const typeVal = String(rec.type ?? nested?.type ?? '').toLowerCase();
        const channelVal = String(rec.channel ?? nested?.channel ?? '').toLowerCase();
        return (
          kindVal.startsWith('account') ||
          typeVal.startsWith('account') ||
          channelVal.startsWith('account')
        );
      };

      const sendSubscribeFrame = (payloadObj: Record<string, unknown>) => {
        if (tickParsed || ws.readyState !== WebSocket.OPEN) return;
        const jsonStr = JSON.stringify(payloadObj);
        try {
          ws.send(jsonStr);
          incrementTickerAllQuota(1);
        } catch {
          // Ignore send failure
        }
      };

      const waitWindowMs = Math.max(cfg.timeoutMs, 8000);
      const waitTimer = setTimeout(async () => {
        if (settled) return;
        settled = true;
        clearWsEscalationTimers();
        if (!accountFrameReceived) {
          clearAccountWsFallbackTimer();
          await fetchTickerAllAccountInfo(cfg, sessionId, jsonPayload, true);
        }
        const msg = lastWsSignalMessage || 'TickerAll WS awaiting live GOLD tick frame.';
        state.failedProbes += 1;
        state.lastError = msg;
        if (probeMode) {
          closeTickerAllSocket();
          state.status = 'error';
        } else {
          state.status = 'connecting';
        }
        await refreshFallbackPrice(true);
        broadcastSse('status');
        resolve({
          ok: false,
          error: msg,
          httpStatus: sessionHttpStatus ?? undefined,
          latencyMs: sessionLatencyMs,
        });
      }, waitWindowMs);

      ws.on('open', () => {
        state.sessionInfo.wsReadyState = 'open';
        state.sessionInfo.rawWsFrames = [];
        const subscribeSymbols = ['GOLD'];
        state.sessionInfo.subscribedSymbols = subscribeSymbols;
        state.sessionInfo.rejectedSymbols = [];

        const channels: Array<Record<string, unknown>> = [
          { kind: 'ticks', accountId: effectiveAccountId, symbols: subscribeSymbols },
          { kind: 'account', accountId: effectiveAccountId },
        ];
        if (!getLusakaClock().isWeekend) {
          channels.push({ kind: 'history', accountId: effectiveAccountId, symbol: 'GOLD' });
        }
        sendSubscribeFrame({ type: 'subscribe', channels });

        clearWsHeartbeatTimer();
        wsHeartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch {
              // Ignore ping error; close handler will trigger reconnect
            }
          }
        }, 25000);

        clearAccountWsFallbackTimer();
        accountWsFallbackTimer = setTimeout(() => {
          if (!accountFrameReceived && currentGeneration === state.sessionGeneration) {
            void fetchTickerAllAccountInfo(cfg, sessionId, jsonPayload, true);
          }
        }, 5000);

        broadcastSse('status');
      });

      ws.on('ping', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.pong(data);
          } catch {
            // Ignore pong send error
          }
        }
        recordRawWsFrame('Heartbeat: ping -> pong', false);
      });

      ws.on('pong', (data) => {
        const text = data && data.length > 0 ? data.toString('utf8') : 'pong';
        recordRawWsFrame(`[NON-JSON]: ${text}`, false);
      });

      ws.on('message', (rawData, isBinary) => {
        const msgLatency = Math.round((performance.now() - startedAt) * 10) / 10;
        const buf = Buffer.isBuffer(rawData)
          ? rawData
          : Array.isArray(rawData)
            ? Buffer.concat(rawData)
            : Buffer.from(rawData as ArrayBuffer);
        const rawStr = buf.toString('utf8');
        const trimmedStr = rawStr.trim();

        // Plain text ping -> pong
        if (!isBinary && trimmedStr === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send('pong');
            } catch {
              // Ignore
            }
          }
          recordRawWsFrame('Heartbeat: ping -> pong', false);
          return;
        }
        if (!isBinary && trimmedStr === 'pong') {
          recordRawWsFrame('Heartbeat: pong', false);
          return;
        }

        let parsed: unknown = null;
        let isValidJsonObject = false;
        if (!isBinary && trimmedStr.length > 0) {
          try {
            const candidate = JSON.parse(rawStr);
            if (candidate !== null && typeof candidate === 'object') {
              parsed = candidate;
              isValidJsonObject = true;
            }
          } catch {
            isValidJsonObject = false;
          }
        }

        // JSON {"type":"ping"} -> {"type":"pong"}
        if (isValidJsonObject && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>;
          const msgType = String(rec.type ?? rec.event ?? '').toLowerCase();
          if (msgType === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'pong' }));
              } catch {
                // Ignore
              }
            }
            recordRawWsFrame('Heartbeat: ping -> pong', false);
            return;
          }
          if (msgType === 'pong') {
            recordRawWsFrame('Heartbeat: pong', false);
            return;
          }
        }

        recordRawWsFrame(rawStr.slice(0, 400), isValidJsonObject);
        if (!isValidJsonObject) return;

        // Subscribed ack
        if (!Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>;
          if (String(rec.type ?? '').toLowerCase() === 'subscribed') {
            const rejectedRaw = Array.isArray(rec.rejected) ? rec.rejected : [];
            clearTimeout(waitTimer);
            state.sessionInfo.subscribedConfirmed = true;
            state.sessionInfo.rejectedSymbols = rejectedRaw.map((e) =>
              typeof e === 'string' ? e : JSON.stringify(e)
            );
            state.sessionInfo.quietMarketNotice = null;
            state.lastError = null;
            state.status = 'connected';
            if (!state.connectedSince) state.connectedSince = new Date().toISOString();
            startAccountRefreshLoop();
            broadcastSse('status');

            if (!settled) {
              settled = true;
              resolve({ ok: true, httpStatus: 101, latencyMs: msgLatency });
            }
            return;
          }
        }

        if (isAccountWsFrame(parsed)) {
          const acctMetrics = extractAccountMetrics(parsed, sessionId, cfg.mt5AccountNumber);
          if (acctMetrics) {
            accountFrameReceived = true;
            clearAccountWsFallbackTimer();
            state.accountInfo = {
              ...state.accountInfo,
              ...acctMetrics,
              lastUpdatedAt: new Date().toISOString(),
            };
          }
          return;
        }

        ingestHistoryBarsFromWs(parsed);

        try {
          const tick = normalizePayload(cfg, parsed, 101, msgLatency, false);
          tickParsed = true;
          incrementTickerAllQuota(1);
          clearWsEscalationTimers();
          clearQuietMarketTimer();
          state.sessionInfo.quietMarketNotice = null;
          state.sessionInfo.totalTickFrames += 1;
          state.sessionInfo.lastTickAt = tick.receivedAt;
          state.packetsReceived += 1;
          state.lastError = null;
          state.latencySamples.push(msgLatency);
          if (state.latencySamples.length > 30) state.latencySamples.shift();

          state.latestTick = tick;
          state.recentTicks.unshift(tick);
          if (state.recentTicks.length > 60) state.recentTicks.length = 60;
          recordObservedSpreadSample(tick);

          state.sessionInfo.tickConfirmed = true;
          state.status = 'connected';
          if (!state.connectedSince) state.connectedSince = new Date().toISOString();

          ingestBotTick(tick);

          broadcastSse('tick');

          if (!settled) {
            settled = true;
            clearTimeout(waitTimer);
            startAccountRefreshLoop();
            resolve({ ok: true, tick, httpStatus: 101, latencyMs: msgLatency });
          }
        } catch {
          if (
            !retriedWithoutHistory &&
            !state.sessionInfo.subscribedConfirmed &&
            /"channels",\s*2|history/i.test(rawStr) &&
            /INVALID_MESSAGE|invalid_type|invalid_union|Required/i.test(rawStr)
          ) {
            retriedWithoutHistory = true;
            sendSubscribeFrame({
              type: 'subscribe',
              channels: [
                { kind: 'ticks', accountId: effectiveAccountId, symbols: ['GOLD'] },
                { kind: 'account', accountId: effectiveAccountId },
              ],
            });
            return;
          }
          if (/(error|unauthorized|invalid)/i.test(rawStr)) {
            lastWsSignalMessage = rawStr.slice(0, 260);
          }
        }
      });

      ws.on('error', async (err) => {
        clearWsEscalationTimers();
        clearAccountWsFallbackTimer();
        clearQuietMarketTimer();
        clearWsHeartbeatTimer();
        const errMsg = `WebSocket error: ${err.message}`;
        state.failedProbes += 1;
        state.lastError = errMsg;
        state.status = 'error';
        state.connectedSince = null;
        state.sessionInfo.wsReadyState = 'closed';
        state.sessionInfo.tickConfirmed = false;
        state.sessionInfo.subscribedConfirmed = false;
        await refreshFallbackPrice(true);
        broadcastSse('status');
        if (getStore().tickerAllMaster.desiredConnected && !getLusakaClock().isWeekend) {
          setTimeout(() => {
            void ensureMasterFeedConnected(false);
          }, 4000);
        }
        if (!settled) {
          settled = true;
          clearTimeout(waitTimer);
          resolve({ ok: false, error: errMsg });
        }
      });

      ws.on('close', (code) => {
        clearAccountWsFallbackTimer();
        clearQuietMarketTimer();
        clearWsHeartbeatTimer();
        state.sessionInfo.wsReadyState = 'closed';
        if (state.status === 'connected' || state.status === 'connecting') {
          state.status = 'disconnected';
          state.connectedSince = null;
          state.sessionInfo.tickConfirmed = false;
          state.sessionInfo.subscribedConfirmed = false;
          const keepAliveActive = getStore().tickerAllMaster.desiredConnected;
          addLog({
            level: 'warning',
            event: 'Master Feed Disconnected',
            adapterId: 'tickerall-ws',
            endpoint: wsUrl,
            httpStatus: code,
            latencyMs: null,
            detail: keepAliveActive
              ? `Proxy feed disconnected (code ${code}). Persistent server auto-reconnect active.`
              : `Proxy feed disconnected (code ${code}). Users notified Feed Offline.`,
          });
          broadcastSse('status');
          if (keepAliveActive && !getLusakaClock().isWeekend) {
            setTimeout(() => {
              void ensureMasterFeedConnected(false);
            }, 4000);
          }
        }
      });
    });
  } catch (err) {
    sessionLatencyMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const errMsg = err instanceof Error ? err.message : 'Network error contacting TickerAll /v1/sessions';
    state.failedProbes += 1;
    state.status = 'error';
    state.lastError = errMsg;
    state.connectedSince = null;
    await refreshFallbackPrice(true);
    broadcastSse('status');
    return { ok: false, error: errMsg, latencyMs: sessionLatencyMs };
  }
}

let masterConnectInFlight = false;

async function ensureMasterFeedConnected(forceImmediate = false): Promise<{
  ok: boolean;
  error?: string;
}> {
  const s = getStore();
  if (!s.tickerAllMaster.desiredConnected) {
    return { ok: false, error: 'Master Feed persistent connection disabled by Admin.' };
  }
  if (getLusakaClock().isWeekend) {
    return { ok: false, error: 'Weekend market closed; auto-connect armed for market open.' };
  }
  if (
    !getAdminTickerAllKey() ||
    !s.tickerAllMaster.brokerServer.trim() ||
    !s.tickerAllMaster.mt5AccountNumber.trim()
  ) {
    return { ok: false, error: 'Master TickerAll credentials are incomplete.' };
  }
  if (masterConnectInFlight) {
    return { ok: false, error: 'Master Feed connection already in progress.' };
  }
  const nowMs = Date.now();
  if (!forceImmediate && nowMs - state.lastAutoReconnectAttemptMs < 10_000) {
    return { ok: false, error: 'Reconnect cooldown active.' };
  }

  state.config.baseUrl = s.tickerAllMaster.baseUrl || state.config.baseUrl;
  state.config.brokerServer = s.tickerAllMaster.brokerServer || state.config.brokerServer;
  state.config.mt5AccountNumber =
    s.tickerAllMaster.mt5AccountNumber || state.config.mt5AccountNumber;
  state.config.hasBrokerPassword = Boolean(getAdminMasterPassword());
  state.lastAutoReconnectAttemptMs = nowMs;

  masterConnectInFlight = true;
  try {
    const res = await startTickerAllSessionAndStream(state.config, false);
    broadcastSse('status');
    return { ok: res.ok, error: res.error };
  } finally {
    masterConnectInFlight = false;
  }
}

function stopStreamLoop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  stopAccountRefreshLoop();
  closeTickerAllSocket();
}

function stopFallbackLoop() {
  if (state.fallbackTimer) {
    clearInterval(state.fallbackTimer);
    state.fallbackTimer = null;
  }
}

function startFallbackLoop() {
  stopFallbackLoop();
  state.fallbackTimer = setInterval(() => {
    const nowMs = Date.now();
    const isWknd = getLusakaClock(nowMs).isWeekend;
    const s = getStore();

    // If primary TickerAll WS stalled for >=15s during active trading hours, mark stalled & auto-retry
    if (
      state.sessionInfo.tickConfirmed &&
      !isWknd &&
      state.lastPrimaryTickMs > 0 &&
      nowMs - state.lastPrimaryTickMs >= FEED_STALE_PAUSE_MS
    ) {
      state.sessionInfo.tickConfirmed = false;
      state.latestTick = null;
      state.lastError = 'Feed Paused - Reconnecting...';
      if (s.tickerAllMaster.desiredConnected) {
        void ensureMasterFeedConnected(false);
      }
    } else if (s.tickerAllMaster.desiredConnected && !isWknd && !masterConnectInFlight) {
      const wsNotOpen = !state.activeWs || state.activeWs.readyState !== WebSocket.OPEN;
      const connectingStuckSilent =
        state.status === 'connecting' &&
        !state.sessionInfo.tickConfirmed &&
        nowMs - state.lastAutoReconnectAttemptMs >= 45_000;
      const needsReconnect =
        state.status === 'disconnected' ||
        state.status === 'error' ||
        (state.status === 'connected' && wsNotOpen) ||
        connectingStuckSilent ||
        (state.status === 'connecting' &&
          (!state.activeWs ||
            state.activeWs.readyState === WebSocket.CLOSED ||
            state.activeWs.readyState === WebSocket.CLOSING) &&
          nowMs - state.lastAutoReconnectAttemptMs >= 15_000);
      if (needsReconnect) {
        void ensureMasterFeedConnected(false);
      }
    }

    // Clear stale frozen fallback price if ALL upstream feeds failed for >=15s on weekdays
    if (isMasterFeedStale15s(nowMs) && (state.latestTick || state.fallbackTick)) {
      state.latestTick = null;
      state.fallbackTick = null;
      state.sessionInfo.tickConfirmed = false;
      state.lastError = 'Feed Paused - Reconnecting...';
      broadcastSse('status');
    }

    if (!state.sessionInfo.tickConfirmed) {
      void refreshFallbackPrice(false);
    }
  }, 3000);
}

function buildAdminDashboard(): AdminDashboardData {
  refreshAllUserExpiries();
  const s = getStore();
  const now = new Date();
  const monthPrefix = now.toISOString().slice(0, 7);
  const weekAheadMs = now.getTime() + 7 * 24 * 60 * 60 * 1000;

  let totalActiveUsers = 0;
  let pendingUsers = 0;
  let expiringThisWeek = 0;
  let activeFeedUsers = 0;

  for (const u of s.users) {
    if (u.status === 'ACTIVE') {
      totalActiveUsers += 1;
      if (u.feedAccess) activeFeedUsers += 1;
      if (u.expiresAt) {
        const expMs = Date.parse(u.expiresAt);
        if (Number.isFinite(expMs) && expMs > now.getTime() && expMs <= weekAheadMs) {
          expiringThisWeek += 1;
        }
      }
    } else if (u.status === 'PENDING') {
      pendingUsers += 1;
    }
  }

  let totalCollectedMonthKwacha = 0;
  let totalCollectedMonthUsd = 0;
  for (const p of s.payments) {
    if (p.recordedAt.startsWith(monthPrefix)) {
      totalCollectedMonthKwacha += p.amountKwacha;
      totalCollectedMonthUsd += p.amountUsd;
    }
  }

  const tickerAllStatus: AdminDashboardData['totals']['tickerAllStatus'] =
    state.status === 'connected' || (state.sessionInfo.tickConfirmed && Boolean(state.latestTick))
      ? 'LIVE'
      : state.status === 'connecting'
        ? 'CONNECTING'
        : 'OFFLINE';

  const policy = getAdminSpreadPolicy();
  const quoteCtx = getLiveQuoteContext(now.getTime());
  const liveSpreadEvaluation = evaluateDynamicSpread({
    bid: quoteCtx.bid,
    ask: quoteCtx.ask,
    quoteTimestamp: quoteCtx.quoteTimestamp,
    quoteSource: quoteCtx.quoteSource,
    hasTwoSidedQuote: quoteCtx.hasTwoSidedQuote,
    isFallbackOnly: quoteCtx.isFallbackOnly,
    symbolSpec: spreadTelemetryState.liveSymbolSpec,
    spreadHistory: get24hSpreadHistory(now.getTime()),
    maxSpreadPoints: policy.maxSpreadPoints,
    sensitivity: policy.spreadSensitivity,
    allowHighSpreadTrades: policy.allowHighSpreadTrades,
    minNetRewardRisk: policy.minNetRewardRisk,
    estimatedSlippagePoints: policy.estimatedSlippagePoints,
    maxQuoteAgeSeconds: policy.maxQuoteAgeSeconds,
    nowMs: now.getTime(),
  });

  return {
    totals: {
      totalUsers: s.users.length,
      totalActiveUsers,
      pendingUsers,
      totalCollectedMonthKwacha,
      totalCollectedMonthUsd,
      expiringThisWeek,
      tickerAllStatus,
      tickerAllQuotaUsed: s.tickerAllMaster.quotaUsed || 0,
      activeFeedUsers,
    },
    tickerAllConfig: {
      // NEVER return the plaintext API key or password! Last 4 chars only.
      hasMasterKey: Boolean(getAdminTickerAllKey()),
      masterKeyLast4: s.tickerAllMaster.apiKeyLast4 || (getAdminTickerAllKey() ? getAdminTickerAllKey().slice(-4) : ''),
      baseUrl: s.tickerAllMaster.baseUrl,
      brokerServer: s.tickerAllMaster.brokerServer,
      mt5AccountNumber: s.tickerAllMaster.mt5AccountNumber,
      hasMasterPassword: Boolean(getAdminMasterPassword()),
      desiredConnected: Boolean(s.tickerAllMaster.desiredConnected),
      latestGoldPrice: state.latestTick?.last ?? state.fallbackTick?.last ?? null,
      lastTickAt: state.sessionInfo.lastTickAt,
      lastError: state.lastError,
    },
    spreadPolicy: policy,
    liveSpreadEvaluation,
    momo: s.momo,
    plans: s.plans,
    users: s.users.map(toAdminUserRow),
  };
}

let publicConfigHydrationPromise: Promise<void> | null = null;
async function hydratePublicConfigFromFirestore(): Promise<void> {
  if (publicConfigHydrationPromise) return publicConfigHydrationPromise;
  publicConfigHydrationPromise = (async () => {
    try {
      const docData = await fetchPublicFirestoreDoc('config/public');
      if (docData) {
        applyPublicConfigHydration(
          (docData.momo as Partial<MoMoConfig> | undefined) ?? null,
          (docData.plans as Partial<PlanPricing> | undefined) ?? null,
          true
        );
      }
    } catch {
      // Non-blocking fallback
    }
  })();
  return publicConfigHydrationPromise;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '8mb' }));

  void hydratePublicConfigFromFirestore();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'gold-ai-trader', timestamp: new Date().toISOString() });
  });

  // Public MoMo numbers & plan pricing for Signup / Renewal screen
  app.get('/api/public/config', async (_req: Request, res: Response) => {
    await hydratePublicConfigFromFirestore();
    const s = getStore();
    res.json({
      ok: true,
      momo: s.momo,
      plans: s.plans,
    });
  });

  // --- USER AUTHENTICATION & SUBSCRIPTION ---
  app.get('/api/auth/me', async (req: Request, res: Response) => {
    await hydratePublicConfigFromFirestore();
    const meta = getUserSessionMeta(req);
    const adminAuthed = isAdminAuthenticated(req);
    const s = getStore();
    if (!meta.user) {
      res.json({
        authenticated: false,
        adminAuthenticated: adminAuthed,
        impersonatingUser: false,
        config: { momo: s.momo, plans: s.plans },
      });
      return;
    }
    res.json({
      authenticated: true,
      user: toPublicUser(meta.user),
      syncBundle: toUserSyncBundle(meta.user),
      adminAuthenticated: adminAuthed,
      impersonatingUser: Boolean(adminAuthed && meta.impersonatedByAdmin),
      config: { momo: s.momo, plans: s.plans },
    });
  });

  app.post('/api/auth/signup', async (req: Request, res: Response) => {
    const body = (req.body || {}) as {
      fullName?: string;
      phone?: string;
      password?: string;
      brokerName?: string;
      brokerServer?: string;
      mt5Login?: string;
      brokerApiKey?: string;
      brokerBridgeUrl?: string;
      brokerSetup?: Partial<BrokerAccountSetup>;
      accountType?: 'Demo' | 'Live';
      plan?: SubscriptionPlan;
      paymentMethod?: 'Airtel MoMo' | 'MTN MoMo';
      transactionId?: string;
      screenshotDataUrl?: string | null;
      startingBalance?: number;
      firebaseIdToken?: string;
    };

    const fullName = (body.fullName || '').trim();
    const phone = (body.phone || '').trim();
    const normPhone = normalizePhone(phone);
    const password = body.password || '';
    const brokerName = (body.brokerName || '').trim() || 'XM';
    const brokerServer = (body.brokerServer || '').trim();
    const mt5Login = (body.mt5Login || '').trim();
    const brokerApiKey = (body.brokerApiKey || '').trim();
    const brokerBridgeUrl = (body.brokerBridgeUrl || '').trim();
    const brokerSetup = normalizeBrokerSetup(body.brokerSetup, brokerName);
    const accountType = body.accountType === 'Live' ? 'Live' : 'Demo';
    const plan: SubscriptionPlan =
      body.plan === 'monthly' || body.plan === 'quarterly' ? body.plan : 'weekly';
    const paymentMethod = body.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo';
    const transactionId = (body.transactionId || '').trim();
    const screenshotDataUrl =
      typeof body.screenshotDataUrl === 'string' && body.screenshotDataUrl.startsWith('data:image/')
        ? body.screenshotDataUrl.slice(0, 4_500_000)
        : null;

    if (!fullName || !normPhone || password.trim().length < 4) {
      res.status(400).json({
        ok: false,
        error: 'Full Name, Phone/WhatsApp, and PIN / Password (min 4 characters) are required.',
      });
      return;
    }
    if (!mt5Login) {
      res.status(400).json({ ok: false, error: 'MT5 Login / Account Number is required.' });
      return;
    }
    if (hasWrongBrokerSetup(brokerSetup)) {
      res.status(400).json({
        ok: false,
        error:
          'Unsupported Platform or Currency — Select MT5 (Standard, Cent/Micro, or ECN/Raw) in USD or USC Cents.',
      });
      return;
    }
    if (!isBrokerSetupComplete(brokerSetup)) {
      res.status(400).json({
        ok: false,
        error: 'Complete Broker Setup First: MT5 Platform + Account Type + USD/USC Currency + 1:500+ Leverage',
      });
      return;
    }
    if (!transactionId && !screenshotDataUrl) {
      res.status(400).json({
        ok: false,
        error: 'Upload Payment Screenshot or enter MoMo Transaction ID to complete signup.',
      });
      return;
    }
    if (findUserByPhone(normPhone)) {
      res.status(409).json({
        ok: false,
        error: 'An account with this Phone / WhatsApp number already exists. Please Login.',
      });
      return;
    }

    let verifiedFirebaseUid: string | null = null;
    let verifiedFirebaseEmail: string | null = null;
    if (typeof body.firebaseIdToken === 'string' && body.firebaseIdToken.trim()) {
      try {
        const decoded = await verifyFirebaseIdToken(body.firebaseIdToken.trim());
        if (decoded.emailVerified) {
          verifiedFirebaseUid = decoded.uid;
          verifiedFirebaseEmail = decoded.email;
        }
      } catch {
        // Non-fatal if token expired; user can re-sync after signup
      }
    }

    const s = getStore();
    const planSpec = s.plans[plan] || s.plans.weekly;
    const clock = getLusakaClock();
    const nowIso = new Date().toISOString();
    const startBal =
      typeof body.startingBalance === 'number' &&
      Number.isFinite(body.startingBalance) &&
      body.startingBalance > 0
        ? round2(body.startingBalance)
        : 138.76;

    const initialSettings = buildDefaultUserSettings();
    const variant = inferBrokerAccountVariant(brokerSetup, brokerName);
    const suggestedSymbol =
      brokerName.toLowerCase().includes('exness')
        ? variant === 'CENT_USC' || variant === 'CENT_USD'
          ? 'XAUUSDc'
          : 'XAUUSDm'
        : brokerName.toLowerCase().includes('weltrade')
          ? 'XAUUSD'
          : variant === 'CENT_USD' && brokerName.toLowerCase().includes('xm')
            ? 'GOLDmicro'
            : initialSettings.emaPro?.xauusdSymbol || 'GOLD';
    initialSettings.maxAutoLotCap =
      variant === 'CENT_USD' || variant === 'CENT_USC' ? 10.0 : initialSettings.maxAutoLotCap;
    initialSettings.emaPro = {
      ...(initialSettings.emaPro ?? DEFAULT_EMA_PRO_CONFIG),
      xauusdSymbol: suggestedSymbol,
      demoOnlyMode: accountType !== 'Live',
      liveTradingAuthorized: accountType === 'Live',
    };

    const newUser: StoredUser = {
      id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fullName,
      phone,
      normalizedPhone: normPhone,
      passwordHash: hashPassword(password.trim()),
      brokerName,
      brokerServer,
      mt5Login,
      brokerApiKeyEnc: brokerApiKey ? encryptSecret(brokerApiKey) : '',
      brokerApiKeyLast4: brokerApiKey ? brokerApiKey.slice(-4) : '',
      brokerBridgeUrl,
      brokerConnected: Boolean(mt5Login && brokerName),
      brokerSetup,
      accountType,
      status: 'PENDING',
      plan,
      amountKwacha: planSpec.kwacha,
      amountUsd: planSpec.usd,
      paymentMethod,
      transactionId,
      screenshotDataUrl,
      submittedAt: nowIso,
      approvedAt: null,
      expiresAt: null,
      feedAccess: false,
      autoTradeEnabled: false,
      balance: startBal,
      equity: startBal,
      settings: initialSettings,
      levels: createFreshDayLevels(clock.dateLusaka),
      tradeLog: [],
      signalHistory: [],
      processedSignalIds: [],
      processedHistoryIds: [],
      processedAutoIds: [],
      lastAiApproval: null,
      firebaseUid: verifiedFirebaseUid,
      firebaseEmail: verifiedFirebaseEmail,
      createdAt: nowIso,
    };

    s.users.unshift(newUser);
    saveStoreNow();
    issueUserSessionCookie(req, res, newUser.id);
    res.json({
      ok: true,
      user: toPublicUser(newUser),
      syncBundle: toUserSyncBundle(newUser, verifiedFirebaseUid || newUser.id),
      config: { momo: s.momo, plans: s.plans },
    });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const body = (req.body || {}) as { phone?: string; password?: string };
    const phone = (body.phone || '').trim();
    const password = body.password || '';
    const user = findUserByPhone(phone);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({
        ok: false,
        error:
          'Invalid Phone / WhatsApp or Password. If you previously saved your account with Google, click "Continue with Google" to restore it.',
      });
      return;
    }
    const s = getStore();
    issueUserSessionCookie(req, res, user.id);
    res.json({
      ok: true,
      user: toPublicUser(user),
      syncBundle: toUserSyncBundle(user),
      config: { momo: s.momo, plans: s.plans },
    });
  });

  app.post('/api/auth/firebase-sync', async (req: Request, res: Response) => {
    const idToken = String((req.body as { idToken?: string })?.idToken || '').trim();
    if (!idToken) {
      res.status(400).json({ ok: false, error: 'Firebase ID token is required.' });
      return;
    }
    try {
      const decoded = await verifyFirebaseIdToken(idToken);
      if (!decoded.emailVerified) {
        res.status(403).json({
          ok: false,
          error: 'Google account email must be verified to sync your trader profile.',
        });
        return;
      }

      const s = getStore();
      const currentSessionUser = getAuthenticatedUser(req);
      let matched = findUserByFirebaseUid(decoded.uid) || currentSessionUser;

      // Authoritatively read user's own Firestore documents using verified Bearer token
      const [fsUser, fsPriv, fsTrades] = await Promise.all([
        fetchFirestoreDocWithUserToken(`users/${decoded.uid}`, idToken).catch(() => null),
        fetchFirestoreDocWithUserToken(`users/${decoded.uid}/private/profile`, idToken).catch(
          () => null
        ),
        fetchFirestoreCollectionWithUserToken(`users/${decoded.uid}/trades`, idToken).catch(
          () => []
        ),
      ]);

      if (fsUser) {
        const bundle: UserSyncBundle = {
          ownerId: decoded.uid,
          appUserId: String(fsUser.appUserId || decoded.uid),
          fullName: String(fsUser.fullName || decoded.name || 'Trader'),
          phone: String(fsPriv?.phone || ''),
          normalizedPhone: String(fsPriv?.normalizedPhone || fsPriv?.phone || ''),
          email: decoded.email || String(fsPriv?.email || ''),
          passwordHash: String(fsPriv?.passwordHash || ''),
          brokerName: String(fsUser.brokerName || 'XM'),
          brokerServer: String(fsUser.brokerServer || ''),
          mt5Login: String(fsUser.mt5Login || ''),
          brokerApiKeyLast4: String(fsPriv?.brokerApiKeyLast4 || ''),
          hasBrokerApiKey: Boolean(fsPriv?.hasBrokerApiKey),
          brokerBridgeUrl: String(fsPriv?.brokerBridgeUrl || ''),
          brokerConnected: Boolean(fsUser.brokerConnected),
          brokerSetup: fsUser.brokerSetup as BrokerAccountSetup,
          accountType: fsUser.accountType === 'Live' ? 'Live' : 'Demo',
          status: (fsUser.status as StoredUser['status']) || 'PENDING',
          plan: (fsUser.plan as SubscriptionPlan) || 'weekly',
          amountKwacha: Number(fsUser.amountKwacha) || 150,
          amountUsd: Number(fsUser.amountUsd) || 5,
          paymentMethod: fsUser.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo',
          transactionId: String(fsUser.transactionId || ''),
          hasScreenshot: Boolean(fsPriv?.hasScreenshot),
          submittedAt: String(fsUser.submittedAt || new Date().toISOString()),
          approvedAt: fsUser.approvedAt ? String(fsUser.approvedAt) : null,
          expiresAt: fsUser.expiresAt ? String(fsUser.expiresAt) : null,
          feedAccess: Boolean(fsUser.feedAccess),
          autoTradeEnabled: Boolean(fsUser.autoTradeEnabled),
          balance: Number(fsUser.balance) || 138.76,
          equity: Number(fsUser.equity) || Number(fsUser.balance) || 138.76,
          lastBalanceSyncAt: fsPriv?.lastBalanceSyncAt
            ? String(fsPriv.lastBalanceSyncAt)
            : null,
          balanceSyncSource:
            (fsPriv?.balanceSyncSource as StoredUser['balanceSyncSource']) ?? null,
          settings: (fsUser.settings as StrategySettings) || buildDefaultUserSettings(),
          levels:
            (fsUser.levels as DaySessionLevels) ||
            createFreshDayLevels(getLusakaClock().dateLusaka),
          trades: fsTrades.map((t) => t.data as unknown as TradeLogEntry),
          createdAt: String(fsUser.createdAt || fsUser.submittedAt || new Date().toISOString()),
        };

        const hadLocal = Boolean(matched);
        matched = upsertUserFromSyncBundle(bundle, {
          trustedStatus: true,
          verifiedFirebaseUid: decoded.uid,
          verifiedEmail: decoded.email,
        });
        issueUserSessionCookie(req, res, matched.id);
        res.json({
          ok: true,
          restoredFromCloud: !hadLocal,
          user: toPublicUser(matched),
          syncBundle: toUserSyncBundle(matched, decoded.uid),
          config: { momo: s.momo, plans: s.plans },
        });
        return;
      }

      if (matched) {
        matched.firebaseUid = decoded.uid;
        matched.firebaseEmail = decoded.email;
        saveStoreNow();
        issueUserSessionCookie(req, res, matched.id);
        res.json({
          ok: true,
          restoredFromCloud: false,
          user: toPublicUser(matched),
          syncBundle: toUserSyncBundle(matched, decoded.uid),
          config: { momo: s.momo, plans: s.plans },
        });
        return;
      }

      res.json({
        ok: true,
        needsSignup: true,
        uid: decoded.uid,
        email: decoded.email,
        displayName: decoded.name,
        config: { momo: s.momo, plans: s.plans },
      });
    } catch (err) {
      res.status(401).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to verify Google account.',
      });
    }
  });

  app.post('/api/auth/reset-pin', async (req: Request, res: Response) => {
    const body = (req.body || {}) as {
      phone?: string;
      newPin?: string;
      firebaseIdToken?: string;
      resetCode?: string;
    };
    const newPin = typeof body.newPin === 'string' ? body.newPin.trim() : '';
    if (newPin.length < 4 || newPin.length > 128) {
      res.status(400).json({
        ok: false,
        error: 'New PIN / Password must be between 4 and 128 characters.',
      });
      return;
    }

    const s = getStore();
    const firebaseIdToken =
      typeof body.firebaseIdToken === 'string' ? body.firebaseIdToken.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const resetCode = typeof body.resetCode === 'string' ? body.resetCode.trim() : '';

    if (firebaseIdToken) {
      try {
        const decoded = await verifyFirebaseIdToken(firebaseIdToken);
        if (!decoded.emailVerified) {
          res.status(403).json({
            ok: false,
            error: 'Google account email must be verified to reset your PIN.',
          });
          return;
        }
        let user = findUserByFirebaseUid(decoded.uid);
        if (!user && phone) {
          const byPhone = findUserByPhone(phone);
          if (byPhone && byPhone.firebaseUid === decoded.uid) {
            user = byPhone;
          }
        }
        if (!user) {
          res.status(404).json({
            ok: false,
            error:
              'No Gold AI Trader account is linked to this Google account. Use an Admin 6-digit Reset Code instead.',
          });
          return;
        }
        user.passwordHash = hashPassword(newPin);
        user.pinResetCodeHash = null;
        user.pinResetExpiresAt = null;
        saveStoreNow();
        issueUserSessionCookie(req, res, user.id);
        res.json({
          ok: true,
          user: toPublicUser(user),
          syncBundle: toUserSyncBundle(user, decoded.uid),
          config: { momo: s.momo, plans: s.plans },
        });
        return;
      } catch (err) {
        res.status(401).json({
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Unable to verify Google account for PIN reset.',
        });
        return;
      }
    }

    if (phone && resetCode) {
      const user = findUserByPhone(phone);
      if (!user || !user.pinResetCodeHash || !user.pinResetExpiresAt) {
        res.status(401).json({
          ok: false,
          error: 'Invalid or missing 6-digit reset code for this phone number.',
        });
        return;
      }
      const expMs = Date.parse(user.pinResetExpiresAt);
      if (!Number.isFinite(expMs) || expMs <= Date.now()) {
        res.status(401).json({
          ok: false,
          error: 'Reset code has expired. Ask Admin to generate a new 6-digit code.',
        });
        return;
      }
      if (!verifyPassword(resetCode, user.pinResetCodeHash)) {
        res.status(401).json({
          ok: false,
          error: 'Incorrect 6-digit reset code. Please check and try again.',
        });
        return;
      }
      user.passwordHash = hashPassword(newPin);
      user.pinResetCodeHash = null;
      user.pinResetExpiresAt = null;
      saveStoreNow();
      issueUserSessionCookie(req, res, user.id);
      res.json({
        ok: true,
        user: toPublicUser(user),
        syncBundle: toUserSyncBundle(user),
        config: { momo: s.momo, plans: s.plans },
      });
      return;
    }

    res.status(400).json({
      ok: false,
      error: 'Provide either a verified Google sign-in OR Phone + 6-digit Admin Reset Code.',
    });
  });

  app.post('/api/auth/change-pin', async (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Authentication required' });
      return;
    }
    const body = (req.body || {}) as {
      currentPin?: string;
      newPin?: string;
      firebaseIdToken?: string;
    };
    const newPin = typeof body.newPin === 'string' ? body.newPin.trim() : '';
    if (newPin.length < 4 || newPin.length > 128) {
      res.status(400).json({
        ok: false,
        error: 'New PIN / Password must be between 4 and 128 characters.',
      });
      return;
    }

    const currentPin = typeof body.currentPin === 'string' ? body.currentPin : '';
    const currentTrimmed = currentPin.trim();
    const matchesCurrent =
      Boolean(currentPin) &&
      (verifyPassword(currentPin, user.passwordHash) ||
        (currentTrimmed !== currentPin && verifyPassword(currentTrimmed, user.passwordHash)));

    let verifiedGoogle = false;
    const firebaseIdToken =
      typeof body.firebaseIdToken === 'string' ? body.firebaseIdToken.trim() : '';
    if (!matchesCurrent && firebaseIdToken) {
      try {
        const decoded = await verifyFirebaseIdToken(firebaseIdToken);
        if (decoded.emailVerified && user.firebaseUid && decoded.uid === user.firebaseUid) {
          verifiedGoogle = true;
        }
      } catch {
        verifiedGoogle = false;
      }
    }

    if (!matchesCurrent && !verifiedGoogle) {
      res.status(401).json({
        ok: false,
        error: 'Current PIN / Password is incorrect.',
      });
      return;
    }

    user.passwordHash = hashPassword(newPin);
    user.pinResetCodeHash = null;
    user.pinResetExpiresAt = null;
    saveStoreNow();
    res.json({
      ok: true,
      syncBundle: toUserSyncBundle(user),
    });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    clearAuthCookie(req, res, USER_COOKIE_NAME);
    res.json({ ok: true });
  });

  app.post('/api/auth/renew', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Authentication required' });
      return;
    }
    const body = (req.body || {}) as {
      plan?: SubscriptionPlan;
      paymentMethod?: 'Airtel MoMo' | 'MTN MoMo';
      transactionId?: string;
      screenshotDataUrl?: string | null;
    };
    const plan: SubscriptionPlan =
      body.plan === 'monthly' || body.plan === 'quarterly' ? body.plan : 'weekly';
    const paymentMethod = body.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo';
    const transactionId = (body.transactionId || '').trim();
    const screenshotDataUrl =
      typeof body.screenshotDataUrl === 'string' && body.screenshotDataUrl.startsWith('data:image/')
        ? body.screenshotDataUrl.slice(0, 4_500_000)
        : null;

    if (!transactionId && !screenshotDataUrl) {
      res.status(400).json({
        ok: false,
        error: 'Provide MoMo Transaction ID or Payment Screenshot to renew.',
      });
      return;
    }

    const s = getStore();
    const planSpec = s.plans[plan] || s.plans.weekly;
    user.plan = plan;
    user.amountKwacha = planSpec.kwacha;
    user.amountUsd = planSpec.usd;
    user.paymentMethod = paymentMethod;
    user.transactionId = transactionId;
    if (screenshotDataUrl) user.screenshotDataUrl = screenshotDataUrl;
    user.submittedAt = new Date().toISOString();
    user.status = 'PENDING';
    user.feedAccess = false;
    user.autoTradeEnabled = false;
    saveStoreNow();
    broadcastSse('status');
    res.json({
      ok: true,
      user: toPublicUser(user),
      syncBundle: toUserSyncBundle(user),
    });
  });

  // --- AUTHENTICATED SUBSCRIBER ENDPOINTS (STRICT ISOLATION) ---
  app.get('/api/connections/adapters', (_req: Request, res: Response) => {
    res.json({
      'tickerall-ws': {
        connectionName: 'Trendline Gold Proxy Feed',
        baseUrl: 'proxy://admin-tickerall',
        endpointPath: '/proxy/gold',
        symbol: 'GOLD',
        authHeaderMode: 'none',
        transport: 'websocket',
        sourceLabel: 'Proxy Feed',
      },
    });
  });

  app.get('/api/connections/state', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (
      user.status === 'ACTIVE' &&
      user.feedAccess &&
      !state.sessionInfo.tickConfirmed &&
      Date.now() - state.lastMasterFetchAttemptMs >= MASTER_FEED_CACHE_MS
    ) {
      void refreshFallbackPrice(false);
    }
    res.json(getUserSnapshot(user));
  });

  app.get('/api/bot/state', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (
      user.status === 'ACTIVE' &&
      user.feedAccess &&
      !state.sessionInfo.tickConfirmed &&
      Date.now() - state.lastMasterFetchAttemptMs >= MASTER_FEED_CACHE_MS
    ) {
      void refreshFallbackPrice(false);
    }
    res.json(getUserBotSnapshot(user, Date.now()));
  });

  app.post('/api/user/broker', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const body = (req.body || {}) as {
      brokerName?: string;
      brokerServer?: string;
      mt5Login?: string;
      brokerApiKey?: string;
      brokerBridgeUrl?: string;
      brokerSetup?: Partial<BrokerAccountSetup>;
      accountType?: 'Demo' | 'Live';
      balance?: number;
      disconnect?: boolean;
    };

    if (body.disconnect) {
      user.brokerConnected = false;
      user.autoTradeEnabled = false;
      saveStoreNow();
      broadcastSse('status');
      res.json({ ok: true, user: toPublicUser(user), snapshot: getUserSnapshot(user) });
      return;
    }

    if (typeof body.brokerName === 'string' && body.brokerName.trim()) {
      user.brokerName = body.brokerName.trim();
    }
    if (typeof body.brokerServer === 'string') {
      user.brokerServer = body.brokerServer.trim();
    }
    if (typeof body.mt5Login === 'string') {
      user.mt5Login = body.mt5Login.trim();
    }
    if (typeof body.brokerBridgeUrl === 'string') {
      const trimmedBridge = body.brokerBridgeUrl.trim();
      if (trimmedBridge) {
        const urlCheck = isSafeExternalUrl(trimmedBridge);
        if (!urlCheck.safe) {
          res.status(400).json({
            ok: false,
            error: urlCheck.reason || 'Broker bridge URL is not a permitted external URL.',
          });
          return;
        }
      }
      user.brokerBridgeUrl = trimmedBridge;
    }
    if (body.accountType === 'Demo' || body.accountType === 'Live') {
      user.accountType = body.accountType;
      const curEma = mergeEmaProConfig(user.settings.emaPro);
      user.settings.emaPro = {
        ...curEma,
        demoOnlyMode: body.accountType !== 'Live',
        liveTradingAuthorized: body.accountType === 'Live' ? true : curEma.liveTradingAuthorized,
      };
    }
    if (typeof body.brokerApiKey === 'string' && body.brokerApiKey.trim()) {
      const cleanKey = body.brokerApiKey.trim();
      user.brokerApiKeyEnc = encryptSecret(cleanKey);
      user.brokerApiKeyLast4 = cleanKey.slice(-4);
    }
    if (typeof body.balance === 'number' && Number.isFinite(body.balance) && body.balance >= 0) {
      user.balance = round2(body.balance);
      user.equity = round2(body.balance);
      user.lastBalanceSyncAt = new Date().toISOString();
      user.balanceSyncSource = 'MANUAL';
    }
    if (body.brokerSetup) {
      user.brokerSetup = normalizeBrokerSetup(body.brokerSetup, user.brokerName);
    } else if (!user.brokerSetup) {
      user.brokerSetup = normalizeBrokerSetup(undefined, user.brokerName);
    }
    const nextVariant = inferBrokerAccountVariant(user.brokerSetup, user.brokerName);
    if (
      (nextVariant === 'CENT_USD' || nextVariant === 'CENT_USC') &&
      (user.settings.maxAutoLotCap ?? 0.5) < 5.0
    ) {
      user.settings.maxAutoLotCap = 10.0;
    }
    user.brokerConnected = Boolean(user.brokerName.trim() && user.mt5Login.trim());
    const wrongSetup = hasWrongBrokerSetup(user.brokerSetup);
    const setupDone = isBrokerSetupComplete(user.brokerSetup);
    if (!user.brokerConnected || wrongSetup || !setupDone) {
      user.autoTradeEnabled = false;
    }
    saveStoreNow();
    broadcastSse('status');
    res.json({ ok: true, user: toPublicUser(user), snapshot: getUserSnapshot(user) });
  });

  app.post('/api/user/broker/sync-balance', async (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const result = await syncUserBalanceFromBridge(user);
    res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      updated: result.updated,
      source: result.source,
      balance: result.balance,
      equity: result.equity,
      message: result.message,
      error: result.ok ? undefined : result.message,
      user: toPublicUser(user),
      snapshot: getUserSnapshot(user),
    });
  });

  app.post('/api/broker/balance-webhook', (req: Request, res: Response) => {
    const authHeader = String(req.headers.authorization || '');
    const bearer = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const token = bearer || String(req.headers['x-api-key'] || '').trim();
    const body = (req.body || {}) as {
      mt5Login?: string | number;
      account?: string | number;
      balance?: number;
      equity?: number;
    };
    const mt5Login = String(body.mt5Login ?? body.account ?? '').trim();
    if (!token || !mt5Login) {
      res.status(400).json({ ok: false, error: 'Authorization token and mt5Login are required' });
      return;
    }
    const targetUser = getStore().users.find(
      (u) =>
        u.status === 'ACTIVE' &&
        u.brokerConnected &&
        u.mt5Login.trim() === mt5Login &&
        u.brokerApiKeyEnc &&
        decryptSecret(u.brokerApiKeyEnc) === token
    );
    if (!targetUser) {
      res.status(401).json({ ok: false, error: 'Invalid broker credentials or account not found' });
      return;
    }
    const metrics = extractAccountMetrics(body, null, mt5Login);
    if (!metrics || (metrics.balance === null && metrics.equity === null)) {
      res.status(400).json({ ok: false, error: 'Valid balance or equity number is required' });
      return;
    }
    const changed = applyLiveBrokerBalanceUpdate(targetUser, metrics, 'BROKER_BRIDGE');
    saveStoreNow();
    broadcastSse('status');
    res.json({
      ok: true,
      updated: changed,
      balance: round2(targetUser.balance),
      equity: round2(targetUser.equity),
    });
  });

  app.post('/api/user/auto-trade', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    if (user.status !== 'ACTIVE') {
      res.status(403).json({ ok: false, error: 'Subscription must be ACTIVE.' });
      return;
    }
    const desired = Boolean((req.body as { enabled?: boolean })?.enabled);
    if (desired) {
      if (hasWrongBrokerSetup(user.brokerSetup)) {
        user.autoTradeEnabled = false;
        saveStoreNow();
        res.status(400).json({
          ok: false,
          error:
            'Unsupported Platform or Currency — Select MT5 (Standard, Cent/Micro, or ECN/Raw) in USD or USC Cents.',
          user: toPublicUser(user),
          snapshot: getUserSnapshot(user),
        });
        return;
      }
      if (!isBrokerSetupComplete(user.brokerSetup)) {
        user.autoTradeEnabled = false;
        saveStoreNow();
        res.status(400).json({
          ok: false,
          error: 'Complete Broker Setup First: MT5 Platform + Account Type + USD/USC Currency + 1:500+ Leverage',
          user: toPublicUser(user),
          snapshot: getUserSnapshot(user),
        });
        return;
      }
      if (!user.brokerConnected) {
        user.autoTradeEnabled = false;
        saveStoreNow();
        res.status(400).json({
          ok: false,
          error: 'Connect Broker to enable Auto',
          user: toPublicUser(user),
          snapshot: getUserSnapshot(user),
        });
        return;
      }
      if (user.accountType === 'Live') {
        const curEma = mergeEmaProConfig(user.settings.emaPro);
        user.settings.emaPro = {
          ...curEma,
          demoOnlyMode: false,
          liveTradingAuthorized: true,
        };
      }
    }
    user.autoTradeEnabled = desired;
    saveStoreNow();
    broadcastSse('status');
    res.json({ ok: true, user: toPublicUser(user), snapshot: getUserSnapshot(user) });
  });

  app.post('/api/strategy/config', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const incoming = (req.body || {}) as Partial<StrategySettings>;
    const prevVersion = user.settings.emaPro?.settingsVersion ?? 1;
    const nextMode = 'EMA_STOCHASTIC_PRO' as const;

    const nextEmaPro = mergeEmaProConfig({
      ...(user.settings.emaPro ?? DEFAULT_EMA_PRO_CONFIG),
      ...(incoming.emaPro ?? {}),
      settingsVersion: prevVersion + 1,
    });

    user.settings = {
      ...user.settings,
      strategyMode: nextMode,
      asianStart: incoming.asianStart || user.settings.asianStart || '03:00',
      asianEnd: incoming.asianEnd || user.settings.asianEnd || '11:00',
      londonStart: incoming.londonStart || user.settings.londonStart || '11:00',
      londonEnd: incoming.londonEnd || user.settings.londonEnd || '19:00',
      slPips: Math.max(5, Math.min(100, toFiniteNumber(incoming.slPips) ?? user.settings.slPips ?? 15)),
      maxSlPips: Math.max(15, Math.min(150, toFiniteNumber(incoming.maxSlPips) ?? user.settings.maxSlPips ?? 25)),
      newsClearanceMins: Math.max(0, toFiniteNumber(incoming.newsClearanceMins) ?? user.settings.newsClearanceMins ?? 60),
      maxTradesPerDay: Math.max(1, Math.min(30, Math.round(toFiniteNumber(incoming.maxTradesPerDay) ?? user.settings.maxTradesPerDay ?? 10))),
      maxConsecutiveLosses: Math.max(1, Math.min(10, Math.round(toFiniteNumber(incoming.maxConsecutiveLosses) ?? user.settings.maxConsecutiveLosses ?? 3))),
      riskPercent: Math.max(0.1, Math.min(25, toFiniteNumber(incoming.riskPercent) ?? user.settings.riskPercent ?? 0.5)),
      defaultLotSize: Math.max(0.01, toFiniteNumber(incoming.defaultLotSize) ?? user.settings.defaultLotSize ?? 0.01),
      maxAutoLotCap: Math.max(0.01, Math.min(50.0, toFiniteNumber(incoming.maxAutoLotCap) ?? user.settings.maxAutoLotCap ?? 0.5)),
      dailyGuardPct: Math.max(0.5, Math.min(25, toFiniteNumber(incoming.dailyGuardPct) ?? user.settings.dailyGuardPct ?? 5.0)),
      autoLogSignals:
        typeof incoming.autoLogSignals === 'boolean'
          ? incoming.autoLogSignals
          : user.settings.autoLogSignals,
      aiApproverEnabled:
        typeof incoming.aiApproverEnabled === 'boolean'
          ? incoming.aiApproverEnabled
          : (user.settings.aiApproverEnabled ?? true),
      emaPro: nextEmaPro,
      newsEvents: Array.isArray(incoming.newsEvents)
        ? incoming.newsEvents
        : user.settings.newsEvents,
    };

    user.auditLogs = [
      {
        id: `aud-${Date.now()}`,
        version: nextEmaPro.settingsVersion,
        timestamp: new Date().toISOString(),
        actor: user.fullName || user.id,
        action: 'SETTINGS_UPDATED',
        detail: `Strategy: ${nextMode} · Mode: ${nextEmaPro.tradingMode} · Risk: ${user.settings.riskPercent}% · AI Threshold: ${nextEmaPro.aiConfidenceThreshold}`,
      },
      ...(user.auditLogs ?? []),
    ].slice(0, 100);

    saveStoreNow();
    broadcastSse('status');
    res.json(getUserSnapshot(user));
  });

  app.post('/api/bot/control', async (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const body = (req.body || {}) as {
      action?: 'START' | 'PAUSE' | 'STOP' | 'EMERGENCY_STOP' | 'CLOSE_ALL' | 'SET_MODE' | 'SET_DIRECTIONS';
      tradingMode?: 'SIGNALS_ONLY' | 'AUTOMATIC_TRADING' | 'BOTH';
      allowBuy?: boolean;
      allowSell?: boolean;
      confirm?: boolean;
    };
    const nowIso = new Date().toISOString();
    const clk = getLusakaClock();
    const currentCfg = mergeEmaProConfig(user.settings.emaPro);

    if (body.action === 'CLOSE_ALL') {
      if (body.confirm !== true) {
        res.status(400).json({ ok: false, error: 'Explicit confirmation required to close all positions.' });
        return;
      }
      const quoteNow = getLiveQuoteContext(Date.now());
      const closeSpec = getEffectiveSymbolSpecForUser(user);
      const closeRes = await closeAllPositionsSafely({
        user,
        confirm: true,
        latestMarketPrice: quoteNow.latestPrice,
        bid: quoteNow.bid,
        ask: quoteNow.ask,
        digits: closeSpec.digits,
        contractSize: closeSpec.contractSize,
      });
      recomputeUserTradeCountsForToday(user, clk.dateLusaka);
      user.notifications = [
        {
          id: `notif-${Date.now()}`,
          timestamp: nowIso,
          title: 'Close All Positions Executed',
          detail: closeRes.message,
          level: 'WARNING' as const,
        },
        ...(user.notifications ?? []),
      ].slice(0, 60);
      saveStoreNow();
      broadcastSse('status');
      res.json({ ok: true, message: closeRes.message, closedCount: closeRes.closedCount, snapshot: getUserSnapshot(user) });
      return;
    }

    const nextCfg = { ...currentCfg, settingsVersion: currentCfg.settingsVersion + 1 };
    let auditDetail = '';

    if (body.action === 'START') {
      nextCfg.tradingRunState = 'RUNNING';
      auditDetail = 'Trading state set to RUNNING';
    } else if (body.action === 'PAUSE') {
      nextCfg.tradingRunState = 'PAUSED';
      auditDetail = 'Trading state set to PAUSED';
    } else if (body.action === 'STOP') {
      nextCfg.tradingRunState = 'STOPPED';
      auditDetail = 'Trading state set to STOPPED';
    } else if (body.action === 'EMERGENCY_STOP') {
      nextCfg.tradingRunState = 'EMERGENCY_STOP';
      user.autoTradeEnabled = false;
      auditDetail = 'EMERGENCY STOP activated (Auto-trading halted)';
      user.riskEvents = [
        {
          id: `rsk-${Date.now()}`,
          timestamp: nowIso,
          lusakaTime: clk.timeLusaka,
          category: 'EMERGENCY_STOP' as const,
          detail: 'Emergency Stop triggered by user — automatic execution halted',
          severity: 'CRITICAL' as const,
        },
        ...(user.riskEvents ?? []),
      ].slice(0, 100);
    } else if (body.action === 'SET_MODE' && body.tradingMode) {
      nextCfg.tradingMode = body.tradingMode;
      auditDetail = `Trading mode switched to ${body.tradingMode}`;
    } else if (body.action === 'SET_DIRECTIONS') {
      if (typeof body.allowBuy === 'boolean') nextCfg.allowBuy = body.allowBuy;
      if (typeof body.allowSell === 'boolean') nextCfg.allowSell = body.allowSell;
      auditDetail = `Directions updated (BUY: ${nextCfg.allowBuy ? 'ON' : 'OFF'}, SELL: ${nextCfg.allowSell ? 'ON' : 'OFF'})`;
    }

    user.settings.emaPro = nextCfg;
    if (auditDetail) {
      user.auditLogs = [
        {
          id: `aud-${Date.now()}`,
          version: nextCfg.settingsVersion,
          timestamp: nowIso,
          actor: user.fullName || user.id,
          action: body.action || 'CONTROL_CHANGE',
          detail: auditDetail,
        },
        ...(user.auditLogs ?? []),
      ].slice(0, 100);
    }

    saveStoreNow();
    broadcastSse('status');
    res.json({ ok: true, snapshot: getUserSnapshot(user) });
  });

  app.get('/api/bot/diagnostics', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const hist = getTickerAllHistorySnapshot();
    const feedInfo = getProxyFeedInfo(user);
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY?.trim() && process.env.GEMINI_API_KEY?.trim() !== 'MY_GEMINI_API_KEY');
    res.json({
      ok: true,
      strategyMode: user.settings.strategyMode ?? 'EMA_STOCHASTIC_PRO',
      capabilities: getTickerAllCapabilitiesReport(user.settings),
      feedStatus: feedInfo.status,
      candleCounts: {
        m1: hist.m1Candles.length,
        m5: hist.m5Candles.length,
        m15: hist.m15Candles.length,
        h1: hist.h1Candles.length,
      },
      geminiConfigured: hasGeminiKey,
      demoOnlyMode: user.settings.emaPro?.demoOnlyMode ?? true,
      liveTradingAuthorized: user.settings.emaPro?.liveTradingAuthorized ?? false,
      lastFetchError: hist.lastFetchError,
    });
  });

  app.post('/api/strategy/levels', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const body = (req.body || {}) as Partial<DaySessionLevels> & { reset?: boolean };
    const clock = getLusakaClock();
    if (body.reset) {
      user.levels = createFreshDayLevels(clock.dateLusaka);
      user.processedSignalIds = [];
      user.processedAutoIds = [];
      recomputeUserTradeCountsForToday(user, clock.dateLusaka);
    } else {
      const nextPdh =
        body.pdh === null
          ? null
          : body.pdh !== undefined && Number.isFinite(Number(body.pdh))
            ? round2(Number(body.pdh))
            : user.levels.pdh;
      const nextPdl =
        body.pdl === null
          ? null
          : body.pdl !== undefined && Number.isFinite(Number(body.pdl))
            ? round2(Number(body.pdl))
            : user.levels.pdl;
      const nextAsianHigh =
        body.asianHigh === null
          ? null
          : body.asianHigh !== undefined && Number.isFinite(Number(body.asianHigh))
            ? round2(Number(body.asianHigh))
            : user.levels.asianHigh;
      const nextAsianLow =
        body.asianLow === null
          ? null
          : body.asianLow !== undefined && Number.isFinite(Number(body.asianLow))
            ? round2(Number(body.asianLow))
            : user.levels.asianLow;
      const nextLondonHigh =
        body.londonHigh === null
          ? null
          : body.londonHigh !== undefined && Number.isFinite(Number(body.londonHigh))
            ? round2(Number(body.londonHigh))
            : user.levels.londonHigh;
      const nextLondonLow =
        body.londonLow === null
          ? null
          : body.londonLow !== undefined && Number.isFinite(Number(body.londonLow))
            ? round2(Number(body.londonLow))
            : user.levels.londonLow;

      user.levels = {
        ...user.levels,
        dateLusaka: clock.dateLusaka,
        pdh: nextPdh,
        pdl: nextPdl,
        prevDayDate: body.prevDayDate ?? user.levels.prevDayDate ?? 'Manual',
        asianHigh: nextAsianHigh,
        asianLow: nextAsianLow,
        londonHigh: nextLondonHigh,
        londonLow: nextLondonLow,
        manualOverride: body.manualOverride ?? true,
      };
    }
    saveStoreNow();
    broadcastSse('status');
    res.json(getUserSnapshot(user));
  });

  app.get('/api/trades', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    res.json({ trades: user.tradeLog, levels: user.levels });
  });

  app.post('/api/ai/approve-trade', async (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const feedInfo = getProxyFeedInfo(user);
    if (!feedInfo.allowed) {
      res.status(403).json({ ok: false, error: feedInfo.message });
      return;
    }
    if (pendingAiUserIds.has(user.id)) {
      res.status(409).json({
        ok: false,
        error: 'Gemini AI approval is already in progress — please wait a few seconds.',
      });
      return;
    }

    const nowMs = Date.now();
    ensureUserDayRollover(user, nowMs);
    const body = (req.body || {}) as {
      side?: 'BUY' | 'SELL' | 'WAIT';
      entry?: number | null;
      stop?: number | null;
      tp1?: number | null;
      tp2?: number | null;
      lots?: number;
      notes?: string;
    };
    const quoteCtx = getLiveQuoteContext(nowMs, feedInfo);
    const livePrice = quoteCtx.latestPrice;
    const hist = getTickerAllHistorySnapshot();
    const clock = getLusakaClock(nowMs);
    const phaseRes = determineSessionPhase(clock.minutes, user.settings, clock.isWeekend);
    const newsStatus = evaluateUsdNewsClearance(clock.minutes, user.settings);
    const { dailyPnlPct, dailyGuardHit } = computeUserDailyPnl(user, clock.dateLusaka);
    const m5Combined = mergeCandleCollections(hist.m5Candles, proxyMarketState.closedM5Candles);
    const m15Combined = mergeCandleCollections(hist.m15Candles, proxyMarketState.closedCandles);
    const openPositionsCount = user.tradeLog.filter((t) => t.status === 'OPEN').length;
    const symbolSpec = getEffectiveSymbolSpecForUser(user);
    const effectiveSettings = buildEffectiveSettingsForEvaluation(user);
    const spreadHistory = get24hSpreadHistory(nowMs);
    const emaEval = evaluateEmaStochasticProSignal({
      h1Candles: hist.h1Candles,
      m15Candles: m15Combined,
      m5Candles: m5Combined,
      m1Candles: hist.m1Candles,
      settings: effectiveSettings,
      levels: user.levels,
      phase: phaseRes.phase,
      latestPrice: livePrice,
      bid: quoteCtx.bid,
      ask: quoteCtx.ask,
      quoteTimestamp: quoteCtx.quoteTimestamp,
      quoteSource: quoteCtx.quoteSource,
      hasTwoSidedQuote: quoteCtx.hasTwoSidedQuote,
      isFallbackOnly: quoteCtx.isFallbackOnly,
      symbolSpec,
      spreadHistory,
      accountEquity: user.equity > 0 ? user.equity : user.balance,
      openPositionsCount,
      dailyPnlPct,
      isWeekend: clock.isWeekend,
      feedConnected: feedInfo.isLive,
      nowMs,
    });
    const activeSig = emaEval.signal;
    const tieredLot = calculateTieredAutoLot(
      user.balance,
      user.settings.maxAutoLotCap ?? 0.5,
      symbolSpec.contractSize,
      symbolSpec.currency ?? 'USD'
    ).effectiveLot;

    const proposedSide =
      body.side === 'BUY' || body.side === 'SELL'
        ? body.side
        : activeSig.action;
    const sideQuoteFallback =
      proposedSide === 'BUY'
        ? quoteCtx.ask ?? livePrice
        : proposedSide === 'SELL'
          ? quoteCtx.bid ?? livePrice
          : livePrice;
    const proposedEntry =
      typeof body.entry === 'number' && Number.isFinite(body.entry)
        ? roundToDigits(body.entry, symbolSpec.digits)
        : activeSig.entry ?? (sideQuoteFallback !== null ? roundToDigits(sideQuoteFallback, symbolSpec.digits) : null);
    const proposedStop =
      typeof body.stop === 'number' && Number.isFinite(body.stop)
        ? roundToDigits(body.stop, symbolSpec.digits)
        : activeSig.stop;
    const proposedTp1 =
      typeof body.tp1 === 'number' && Number.isFinite(body.tp1)
        ? roundToDigits(body.tp1, symbolSpec.digits)
        : activeSig.tp1;
    const proposedTp2 =
      typeof body.tp2 === 'number' && Number.isFinite(body.tp2)
        ? roundToDigits(body.tp2, symbolSpec.digits)
        : activeSig.tp2 ?? activeSig.target;
    const proposedLots =
      typeof body.lots === 'number' && Number.isFinite(body.lots) && body.lots >= 0.01
        ? round2(body.lots)
        : activeSig.suggestedLots >= 0.01
          ? activeSig.suggestedLots
          : tieredLot;

    pendingAiUserIds.add(user.id);
    broadcastSse('status');
    try {
      const aiResult = await reviewTradeWithGeminiApprover({
        executionContext: 'PRECHECK',
        lusakaDate: clock.dateLusaka,
        lusakaTime: clock.timeLusaka,
        lusakaWeekday: clock.weekday,
        isWeekend: clock.isWeekend,
        phase: phaseRes.phase,
        symbol: activeSig.symbol || 'XAUUSD',
        proposedSide,
        entry: proposedEntry,
        stop: proposedStop,
        tp1: proposedTp1,
        tp2: proposedTp2,
        tp3: activeSig.tp3 ?? null,
        lots: proposedLots,
        accountBalance: user.equity > 0 ? user.equity : user.balance,
        settings: user.settings,
        levels: user.levels,
        emaPro: emaEval.analysis,
        activeSignal: activeSig,
        newsStatus,
        currentCandle: proxyMarketState.currentM5Candle ?? proxyMarketState.currentCandle,
        recentClosedCandles: m5Combined.slice(-12).reverse(),
        dailyPnlPct,
        dailyGuardHit,
        openPositionsCount,
        lastTickAtMs: state.lastAnyFeedSuccessMs || null,
        notes: body.notes || activeSig.reason,
      });

      user.lastAiApproval = aiResult.approval;
      saveStoreNow();
      pendingAiUserIds.delete(user.id);
      broadcastSse('status');

      if (!aiResult.ok) {
        res.status(503).json({
          ok: false,
          error: aiResult.approval.errorMessage || aiResult.approval.summary,
          approval: aiResult.approval,
          snapshot: getUserSnapshot(user),
        });
        return;
      }

      res.json({
        ok: true,
        approval: aiResult.approval,
        snapshot: getUserSnapshot(user),
      });
    } catch (err) {
      pendingAiUserIds.delete(user.id);
      broadcastSse('status');
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unexpected Gemini AI Approver error',
      });
    }
  });

  app.post('/api/trades', async (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const feedInfo = getProxyFeedInfo(user);
    if (!feedInfo.allowed) {
      res.status(403).json({ ok: false, error: feedInfo.message });
      return;
    }

    const nowMs = Date.now();
    ensureUserDayRollover(user, nowMs);
    const clock = getLusakaClock(nowMs);
    const body = (req.body || {}) as Partial<TradeLogEntry> & { entries?: TradeLogEntry[] };
    if ('entries' in body && Array.isArray(body.entries)) {
      res.json(getUserSnapshot(user));
      return;
    }

    const side = body.side === 'SELL' ? 'SELL' : 'BUY';
    const session: TradingSessionTag =
      body.session === 'ASIAN_SESSION' ||
      body.session === 'LONDON_SESSION' ||
      body.session === 'NEW_YORK_SESSION' ||
      body.session === 'ALL_SESSIONS'
        ? body.session
        : clock.minutes >= 180 && clock.minutes < 660
          ? 'ASIAN_SESSION'
          : clock.minutes >= 660 && clock.minutes <= 1140
            ? 'LONDON_SESSION'
            : clock.minutes > 1140
              ? 'NEW_YORK_SESSION'
              : 'ALL_SESSIONS';

    const manualQuoteCtx = getLiveQuoteContext(nowMs, feedInfo);
    const manualSpec = getEffectiveSymbolSpecForUser(user);
    const manualSideFallback =
      side === 'BUY'
        ? manualQuoteCtx.ask ?? manualQuoteCtx.latestPrice
        : manualQuoteCtx.bid ?? manualQuoteCtx.latestPrice;
    const entryPrice = Number(body.entry ?? manualSideFallback ?? 0);
    const stopPrice = Number(body.stop ?? entryPrice);
    const tp2Input = Number(body.tp2 ?? body.target ?? entryPrice);
    const hasTp3 = body.tp3 !== undefined && body.tp3 !== null;
    const tp3Input = hasTp3 ? Number(body.tp3) : null;

    if (
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0 ||
      !Number.isFinite(stopPrice) ||
      stopPrice <= 0 ||
      !Number.isFinite(tp2Input) ||
      tp2Input <= 0 ||
      (hasTp3 && (!Number.isFinite(tp3Input) || (tp3Input ?? 0) <= 0))
    ) {
      res.status(400).json({
        ok: false,
        error: 'Entry, Stop Loss, and Target prices must all be valid positive Gold prices.',
      });
      return;
    }
    if (
      side === 'BUY' &&
      (stopPrice >= entryPrice ||
        tp2Input <= entryPrice ||
        (tp3Input !== null && tp3Input <= entryPrice))
    ) {
      res.status(400).json({
        ok: false,
        error: 'Invalid LONG trade levels: Stop Loss must be below Entry and Target(s) must be above Entry.',
      });
      return;
    }
    if (
      side === 'SELL' &&
      (stopPrice <= entryPrice ||
        tp2Input >= entryPrice ||
        (tp3Input !== null && tp3Input >= entryPrice))
    ) {
      res.status(400).json({
        ok: false,
        error: 'Invalid SHORT trade levels: Stop Loss must be above Entry and Target(s) must be below Entry.',
      });
      return;
    }

    const tp1Price =
      typeof body.tp1 === 'number' && Number.isFinite(body.tp1) && body.tp1 > 0
        ? roundToDigits(body.tp1, manualSpec.digits)
        : roundToDigits(entryPrice + (tp2Input - entryPrice) * 0.5, manualSpec.digits);
    const resolvedTp3 = tp3Input !== null ? roundToDigits(tp3Input, manualSpec.digits) : null;
    const tieredLot = calculateTieredAutoLot(
      user.balance,
      user.settings.maxAutoLotCap ?? 0.5,
      manualSpec.contractSize,
      manualSpec.currency ?? 'USD'
    ).effectiveLot;
    const lots =
      typeof body.lots === 'number' && Number.isFinite(body.lots) && body.lots >= 0.01
        ? round2(body.lots)
        : tieredLot;

    // Pre-trade spread, quote freshness & net R:R validation before every order
    const manualEffectiveSettings = buildEffectiveSettingsForEvaluation(user);
    const manualCfg = mergeEmaProConfig(manualEffectiveSettings.emaPro);
    const manualSpreadCheck = evaluateDynamicSpread({
      bid: manualQuoteCtx.bid,
      ask: manualQuoteCtx.ask,
      quoteTimestamp: manualQuoteCtx.quoteTimestamp,
      quoteSource: manualQuoteCtx.quoteSource,
      hasTwoSidedQuote: manualQuoteCtx.hasTwoSidedQuote,
      isFallbackOnly: manualQuoteCtx.isFallbackOnly,
      symbolSpec: manualSpec,
      spreadHistory: get24hSpreadHistory(nowMs),
      maxSpreadPoints: manualCfg.maxSpreadPips,
      sensitivity: manualCfg.spreadSensitivity,
      allowHighSpreadTrades: manualCfg.allowHighSpreadTrades,
      minNetRewardRisk: manualCfg.minNetRewardRisk,
      estimatedSlippagePoints: manualCfg.estimatedSlippagePoints,
      maxQuoteAgeSeconds: manualCfg.maxQuoteAgeSeconds,
      confirmationScore: 85,
      proposedSide: side,
      proposedEntry: roundToDigits(entryPrice, manualSpec.digits),
      proposedStop: roundToDigits(stopPrice, manualSpec.digits),
      proposedTarget: roundToDigits(tp2Input, manualSpec.digits),
      lots,
      nowMs,
    });

    if (!manualSpreadCheck.dataAvailable || !manualSpreadCheck.tradePermitted) {
      res.status(422).json({
        ok: false,
        error: `Pre-trade validation blocked order [${manualSpreadCheck.classification}]: ${manualSpreadCheck.reason}`,
        spreadEvaluation: manualSpreadCheck,
        snapshot: getUserSnapshot(user),
      });
      return;
    }

    let aiApprovalForTrade = null;
    if (user.settings.aiApproverEnabled !== false) {
      if (pendingAiUserIds.has(user.id)) {
        res.status(409).json({
          ok: false,
          error: 'Gemini AI approval is already in progress for this account — please wait.',
        });
        return;
      }

      const hist = getTickerAllHistorySnapshot();
      const phaseRes = determineSessionPhase(clock.minutes, user.settings, clock.isWeekend);
      const newsStatus = evaluateUsdNewsClearance(clock.minutes, user.settings);
      const { dailyPnlPct, dailyGuardHit } = computeUserDailyPnl(user, clock.dateLusaka);
      const m5Combined = mergeCandleCollections(hist.m5Candles, proxyMarketState.closedM5Candles);
      const m15Combined = mergeCandleCollections(hist.m15Candles, proxyMarketState.closedCandles);
      const openPositionsCount = user.tradeLog.filter((t) => t.status === 'OPEN').length;
      const emaEval = evaluateEmaStochasticProSignal({
        h1Candles: hist.h1Candles,
        m15Candles: m15Combined,
        m5Candles: m5Combined,
        m1Candles: hist.m1Candles,
        settings: manualEffectiveSettings,
        levels: user.levels,
        phase: phaseRes.phase,
        latestPrice: manualQuoteCtx.latestPrice,
        bid: manualQuoteCtx.bid,
        ask: manualQuoteCtx.ask,
        quoteTimestamp: manualQuoteCtx.quoteTimestamp,
        quoteSource: manualQuoteCtx.quoteSource,
        hasTwoSidedQuote: manualQuoteCtx.hasTwoSidedQuote,
        isFallbackOnly: manualQuoteCtx.isFallbackOnly,
        symbolSpec: manualSpec,
        spreadHistory: get24hSpreadHistory(nowMs),
        spreadEvaluation: manualSpreadCheck,
        accountEquity: user.equity > 0 ? user.equity : user.balance,
        openPositionsCount,
        dailyPnlPct,
        isWeekend: clock.isWeekend,
        feedConnected: feedInfo.isLive,
        nowMs,
      });
      const activeSig = emaEval.signal;

      pendingAiUserIds.add(user.id);
      broadcastSse('status');
      let aiResult;
      try {
        aiResult = await reviewTradeWithGeminiApprover({
          executionContext: body.executionMode === 'AUTO' ? 'AUTO' : 'MANUAL',
          lusakaDate: clock.dateLusaka,
          lusakaTime: clock.timeLusaka,
          lusakaWeekday: clock.weekday,
          isWeekend: clock.isWeekend,
          phase: phaseRes.phase,
          symbol: body.symbol || user.settings.emaPro?.xauusdSymbol || 'XAUUSD',
          proposedSide: side,
          entry: roundToDigits(entryPrice, manualSpec.digits),
          stop: roundToDigits(stopPrice, manualSpec.digits),
          tp1: tp1Price,
          tp2: roundToDigits(tp2Input, manualSpec.digits),
          tp3: resolvedTp3 ?? activeSig.tp3 ?? null,
          lots,
          accountBalance: user.equity > 0 ? user.equity : user.balance,
          settings: user.settings,
          levels: user.levels,
          emaPro: emaEval.analysis,
          activeSignal: activeSig,
          newsStatus,
          currentCandle: proxyMarketState.currentM5Candle ?? proxyMarketState.currentCandle,
          recentClosedCandles: m5Combined.slice(-12).reverse(),
          dailyPnlPct,
          dailyGuardHit,
          openPositionsCount,
          lastTickAtMs: state.lastAnyFeedSuccessMs || null,
          notes: body.notes || 'Manual EMA STOCHASTIC PRO trade execution',
        });
      } catch (err) {
        pendingAiUserIds.delete(user.id);
        broadcastSse('status');
        res.status(503).json({
          ok: false,
          error:
            err instanceof Error
              ? `Gemini AI Approver Error: ${err.message}`
              : 'Gemini AI Approver request failed unexpectedly.',
        });
        return;
      } finally {
        pendingAiUserIds.delete(user.id);
      }

      user.lastAiApproval = aiResult.approval;

      if (!aiResult.ok) {
        saveStoreNow();
        broadcastSse('status');
        res.status(503).json({
          ok: false,
          error: `Gemini AI Approver Error: ${aiResult.approval.errorMessage || aiResult.approval.summary}`,
          approval: aiResult.approval,
          snapshot: getUserSnapshot(user),
        });
        return;
      }

      if (!aiResult.approval.approved) {
        user.signalHistory.unshift({
          id: `hist-aimblk-${Date.now()}`,
          timestamp: new Date().toISOString(),
          lusakaTime: clock.timeLusaka,
          strategy: session,
          strategyModule: 'EMA_STOCHASTIC_PRO',
          action: 'BLOCKED',
          symbol: body.symbol || user.settings.emaPro?.xauusdSymbol || 'XAUUSD',
          price: round2(entryPrice),
          aiConfidence: aiResult.approval.confidencePct,
          signalStatus: aiResult.approval.status === 'WAITING FOR CONFIRMATION' ? 'WAITING' : 'REJECTED',
          setupStatus: emaEval.analysis.activeSetupType ?? emaEval.analysis.marketCondition,
          blockReason: `Gemini AI ${aiResult.approval.status} (${aiResult.approval.confidencePct}%): ${aiResult.approval.summary}`,
        });
        if (user.signalHistory.length > 120) user.signalHistory.length = 120;
        saveStoreNow();
        broadcastSse('status');
        res.status(422).json({
          ok: false,
          error: `Gemini AI ${aiResult.approval.status}: ${aiResult.approval.summary}`,
          approval: aiResult.approval,
          snapshot: getUserSnapshot(user),
        });
        return;
      }

      aiApprovalForTrade = aiResult.approval;
    }

    const activeStrategyModule = 'EMA_STOCHASTIC_PRO' as const;
    const newEntry: TradeLogEntry = {
      id: body.id || `trd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      signalId: body.signalId,
      dateLusaka: body.dateLusaka || clock.dateLusaka,
      timeLusaka: body.timeLusaka || clock.timeLusaka,
      timestamp: body.timestamp || new Date().toISOString(),
      session,
      strategyModule: activeStrategyModule,
      marketCondition: body.marketCondition,
      symbol: body.symbol || user.settings.emaPro?.xauusdSymbol || 'XAUUSD',
      side,
      entry: roundToDigits(entryPrice, manualSpec.digits),
      stop: roundToDigits(stopPrice, manualSpec.digits),
      tp1: tp1Price,
      tp2: roundToDigits(tp2Input, manualSpec.digits),
      tp3: resolvedTp3,
      target: roundToDigits(resolvedTp3 ?? tp2Input, manualSpec.digits),
      tp1Hit: false,
      tp2Hit: false,
      breakevenMoved: false,
      rrRatio: Number(body.rrRatio ?? 2.0),
      lots,
      riskDollars: round2(toFiniteNumber(body.riskDollars) ?? Math.abs(entryPrice - stopPrice) * lots * manualSpec.contractSize),
      status: body.status || 'OPEN',
      executionStatus: body.executionStatus ?? 'SUBMITTED',
      exitPrice: body.exitPrice ?? null,
      pnlDollars: body.pnlDollars ?? null,
      notes: body.notes || 'Manual EMA STOCHASTIC PRO execution',
      setupStatus: body.setupStatus ?? 'EMA Pro Manual',
      executionMode: body.executionMode === 'AUTO' ? 'AUTO' : 'MANUAL',
      feedSource: body.feedSource || 'TickerAll MT5 Master Feed',
      brokerName: body.brokerName || `${user.brokerName} (${user.accountType})`,
      balanceBefore: round2(user.balance),
      balanceAfter: null,
      aiApproval: aiApprovalForTrade,
    };

    user.tradeLog.unshift(newEntry);
    if (user.tradeLog.length > 200) user.tradeLog.length = 200;
    recomputeUserTradeCountsForToday(user, clock.dateLusaka);
    if (newEntry.status === 'OPEN') {
      recomputeUserFloatingEquity(user, getEffectiveProxyPrice());
    }
    saveStoreNow();
    broadcastSse('status');
    if (newEntry.status === 'OPEN' && user.brokerConnected && user.brokerBridgeUrl.trim()) {
      void dispatchOrderToUserBroker(user, {
        symbol: newEntry.symbol || manualSpec.symbol || 'GOLD',
        side: newEntry.side,
        lots: newEntry.lots,
        entry: newEntry.entry,
        stop: newEntry.stop,
        target: newEntry.target,
      });
    }
    res.json(getUserSnapshot(user));
  });

  app.patch('/api/trades/:id', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    const tradeId = req.params.id;
    const body = (req.body || {}) as Partial<TradeLogEntry>;
    const idx = user.tradeLog.findIndex((t) => t.id === tradeId);
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Trade entry not found' });
      return;
    }
    const existing = user.tradeLog[idx];
    const tradeSpec = getEffectiveSymbolSpecForUser(user);
    const allowedStatuses = ['SIGNALED', 'OPEN', 'TP_HIT', 'SL_HIT', 'CLOSED'] as const;
    if (
      body.status !== undefined &&
      !allowedStatuses.includes(body.status as (typeof allowedStatuses)[number])
    ) {
      res.status(400).json({ ok: false, error: 'Unsupported trade status' });
      return;
    }
    const nextStatus = body.status ?? existing.status;
    let nextExit: number | null = existing.exitPrice;
    if (body.exitPrice !== undefined) {
      if (body.exitPrice === null) {
        nextExit = null;
      } else {
        const parsedExit = toFiniteNumber(body.exitPrice);
        if (parsedExit === null || parsedExit <= 0) {
          res.status(400).json({ ok: false, error: 'exitPrice must be a valid positive number' });
          return;
        }
        nextExit = parsedExit;
      }
    }
    if (nextStatus === 'TP_HIT' && nextExit === null) nextExit = existing.target;
    if (nextStatus === 'SL_HIT' && nextExit === null) nextExit = existing.stop;
    if (nextStatus === 'CLOSED' && nextExit === null) {
      nextExit = getEffectiveProxyPrice() ?? existing.entry;
    }

    const alreadyCreditedTp1 =
      typeof existing.tp1RealizedPnl === 'number' ? existing.tp1RealizedPnl : 0;
    let pnlDollars = body.pnlDollars !== undefined ? toFiniteNumber(body.pnlDollars) : existing.pnlDollars;
    if (pnlDollars === null && nextExit !== null) {
      if (existing.tp1Hit && typeof existing.tp1RealizedPnl === 'number') {
        const runnerDiff =
          existing.side === 'BUY' ? nextExit - existing.entry : existing.entry - nextExit;
        pnlDollars = round2(alreadyCreditedTp1 + runnerDiff * (existing.lots * 0.5) * tradeSpec.contractSize);
      } else {
        const priceDiff =
          existing.side === 'BUY' ? nextExit - existing.entry : existing.entry - nextExit;
        pnlDollars = round2(priceDiff * existing.lots * tradeSpec.contractSize);
      }
    }

    let balanceAfter = existing.balanceAfter ?? null;
    if (
      existing.balanceAfter === null &&
      pnlDollars !== null &&
      (nextStatus === 'TP_HIT' || nextStatus === 'SL_HIT' || nextStatus === 'CLOSED')
    ) {
      const deltaToCredit = round2(pnlDollars - alreadyCreditedTp1);
      user.balance = Math.max(0, round2(user.balance + deltaToCredit));
      user.lastBalanceSyncAt = new Date().toISOString();
      user.balanceSyncSource = 'TRADE_PNL';
      recomputeUserFloatingEquity(user, getEffectiveProxyPrice());
      balanceAfter = user.balance;
    }

    user.tradeLog[idx] = {
      ...existing,
      status: nextStatus,
      ...(nextStatus !== 'OPEN' && nextStatus !== 'SIGNALED' && !existing.closedAt
        ? { closedAt: new Date().toISOString() }
        : {}),
      exitPrice: nextExit !== null ? roundToDigits(nextExit, tradeSpec.digits) : null,
      pnlDollars,
      balanceBefore: existing.balanceBefore ?? round2(user.balance),
      balanceAfter,
      notes: typeof body.notes === 'string' ? body.notes : existing.notes,
    };
    recomputeUserTradeCountsForToday(user, getLusakaClock().dateLusaka);
    saveStoreNow();
    broadcastSse('status');
    res.json(getUserSnapshot(user));
  });

  app.delete('/api/trades/:id', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    user.tradeLog = user.tradeLog.filter((t) => t.id !== req.params.id);
    recomputeUserTradeCountsForToday(user, getLusakaClock().dateLusaka);
    saveStoreNow();
    broadcastSse('status');
    res.json(getUserSnapshot(user));
  });

  app.delete('/api/trades', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    user.tradeLog = [];
    recomputeUserTradeCountsForToday(user, getLusakaClock().dateLusaka);
    saveStoreNow();
    broadcastSse('status');
    res.json(getUserSnapshot(user));
  });

  app.delete('/api/signals', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    user.signalHistory = [];
    user.processedHistoryIds = [];
    saveStoreNow();
    broadcastSse('status');
    res.json(getUserSnapshot(user));
  });

  app.post('/api/bot/candles/sync', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    res.json(getUserSnapshot(user));
  });

  app.get('/api/backtest/status', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    refreshAllUserExpiries();
    const feedAllowed = user.status === 'ACTIVE' && user.feedAccess;
    const hist = getTickerAllHistorySnapshot();
    const masterFeedLive =
      state.status === 'connected' ||
      Boolean(state.latestTick && state.sessionInfo.tickConfirmed);
    res.json({
      ok: true,
      feedAllowed,
      masterFeedLive,
      hasRealData: feedAllowed && hist.m15Candles.length > 0,
      m15Count: feedAllowed ? hist.m15Candles.length : 0,
      h1Count: feedAllowed ? hist.h1Candles.length : 0,
      lastUpdatedAt: hist.lastUpdatedAt,
    });
  });

  const handleRealBacktestRequest = async (
    req: Request,
    res: Response,
    forceRefresh: boolean
  ) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }
    refreshAllUserExpiries();
    if (user.status !== 'ACTIVE' || !user.feedAccess) {
      res.status(403).json({
        ok: false,
        error: 'Active subscription & live feed access required for Real Backtest.',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      periodDays?: number;
      startingBalance?: number;
    };
    const rawPeriod = Number(body.periodDays);
    const periodDays: 30 | 90 | 180 =
      rawPeriod === 180 ? 180 : rawPeriod === 90 ? 90 : 30;

    const rawBalance = Number(body.startingBalance);
    const startingBalance =
      Number.isFinite(rawBalance) && rawBalance > 0
        ? round2(Math.min(1_000_000, Math.max(10, rawBalance)))
        : 138;

    const adminApiKey = getAdminTickerAllKey();
    const masterFeedLive =
      state.status === 'connected' ||
      Boolean(state.latestTick && state.sessionInfo.tickConfirmed);

    if (forceRefresh && state.activeWs && state.activeWs.readyState === WebSocket.OPEN) {
      const effectiveAccountId =
        state.sessionInfo.accountId || state.sessionInfo.sessionId || '';
      if (effectiveAccountId) {
        try {
          state.activeWs.send(
            JSON.stringify({
              type: 'subscribe',
              channels: [{ kind: 'history', accountId: effectiveAccountId, symbol: 'GOLD' }],
            })
          );
        } catch {
          // Ignore WS send issue
        }
      }
    }

    const currentHist = getTickerAllHistorySnapshot();
    if ((forceRefresh || currentHist.m15Candles.length === 0) && adminApiKey) {
      await fetchRealTickerAllHistoricalCandles({
        baseUrl: state.config.baseUrl,
        apiKey: adminApiKey,
        authHeaderMode: state.config.authHeaderMode,
        sessionId: state.sessionInfo.sessionId,
        accountId: state.sessionInfo.accountId,
        timeoutMs: state.config.timeoutMs,
        periodDays,
        onQuotaUsed: (count) => incrementTickerAllQuota(count),
      });
    }

    const updatedHist = getTickerAllHistorySnapshot();
    const summary = runEmaStochasticProBacktest({
      m5Candles: updatedHist.m5Candles,
      m15Candles: updatedHist.m15Candles,
      h1Candles: updatedHist.h1Candles,
      settings: buildEffectiveSettingsForEvaluation(user),
      periodDays,
      startingBalance,
      maxAutoLotCap: user.settings.maxAutoLotCap ?? 0.5,
      lastUpdatedAt: updatedHist.lastUpdatedAt,
      masterFeedConnected: masterFeedLive,
      symbolSpec: getEffectiveSymbolSpecForUser(user),
      observedSpreadSamples: get24hSpreadHistory(Date.now()),
    });

    res.json({
      ok: true,
      summary,
      masterFeedLive,
    });
  };

  app.post('/api/backtest/run', (req: Request, res: Response) => {
    void handleRealBacktestRequest(req, res, false);
  });

  app.post('/api/backtest/refresh', (req: Request, res: Response) => {
    void handleRealBacktestRequest(req, res, true);
  });

  app.get('/api/feed/stream', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Login required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.set(res, user.id);
    res.write(`event: status\ndata: ${JSON.stringify(getUserSnapshot(user))}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  // --- ADMIN ONLY ROUTES (/api/admin/*) ---
  app.get('/api/admin/me', (req: Request, res: Response) => {
    res.json({ authenticated: isAdminAuthenticated(req) });
  });

  app.post('/api/admin/login', (req: Request, res: Response) => {
    const rawPassword = String((req.body as { password?: string })?.password || '');
    const trimmedPassword = rawPassword.trim();
    const s = getStore();
    const activeAdminPass = process.env.ADMIN_PASSWORD?.trim() || 'GoldAdmin2026!';
    const matchesStore =
      verifyPassword(rawPassword, s.adminPasswordHash) ||
      (trimmedPassword !== rawPassword && verifyPassword(trimmedPassword, s.adminPasswordHash));
    const matchesActive = !s.adminPinCustom && trimmedPassword === activeAdminPass;

    if (!matchesStore && !matchesActive) {
      res.status(401).json({ ok: false, error: 'Invalid Admin PIN / Password' });
      return;
    }
    if (matchesActive && !matchesStore) {
      s.adminPasswordHash = hashPassword(activeAdminPass);
      saveStoreNow();
    }
    issueAdminSessionCookie(req, res);
    res.json({ ok: true, dashboard: buildAdminDashboard() });
  });

  app.post('/api/admin/reset-pin', async (req: Request, res: Response) => {
    const body = (req.body || {}) as {
      newPin?: string;
      firebaseIdToken?: string;
    };
    const newPin = typeof body.newPin === 'string' ? body.newPin.trim() : '';
    if (newPin.length < 4 || newPin.length > 128) {
      res.status(400).json({
        ok: false,
        error: 'New Admin PIN / Password must be between 4 and 128 characters.',
      });
      return;
    }

    let authorized = isAdminAuthenticated(req);
    if (!authorized) {
      const idToken =
        typeof body.firebaseIdToken === 'string' ? body.firebaseIdToken.trim() : '';
      if (!idToken) {
        res.status(401).json({
          ok: false,
          error: 'Verify with authorized Admin Google account or login first.',
        });
        return;
      }
      try {
        const decoded = await verifyFirebaseIdToken(idToken);
        if (
          !decoded.emailVerified ||
          decoded.email.toLowerCase() !== 'muyobakuyewana@gmail.com'
        ) {
          res.status(403).json({
            ok: false,
            error: 'Signed-in Google account is not the authorized Gold AI Trader admin.',
          });
          return;
        }
        authorized = true;
      } catch (err) {
        res.status(401).json({
          ok: false,
          error: err instanceof Error ? err.message : 'Unable to verify Admin Google token.',
        });
        return;
      }
    }

    if (!authorized) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const s = getStore();
    s.adminPasswordHash = hashPassword(newPin);
    s.adminPinCustom = true;
    saveStoreNow();
    issueAdminSessionCookie(req, res);
    res.json({ ok: true, dashboard: buildAdminDashboard() });
  });

  app.post('/api/admin/logout', (req: Request, res: Response) => {
    clearAuthCookie(req, res, ADMIN_COOKIE_NAME);
    res.json({ ok: true });
  });

  app.get('/api/admin/dashboard', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    res.json({ ok: true, dashboard: buildAdminDashboard() });
  });

  app.post('/api/admin/config', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const body = (req.body || {}) as {
      tickerAllApiKey?: string;
      baseUrl?: string;
      brokerServer?: string;
      mt5AccountNumber?: string;
      mt5Password?: string;
      momo?: Partial<AdminDashboardData['momo']>;
      plans?: Partial<AdminDashboardData['plans']>;
      spreadPolicy?: Partial<AdminSpreadPolicy>;
      newAdminPassword?: string;
    };

    const s = getStore();
    if (body.spreadPolicy && typeof body.spreadPolicy === 'object') {
      const nextPolicy = updateAdminSpreadPolicy(body.spreadPolicy);
      spreadTelemetryState.liveSymbolSpec = {
        ...spreadTelemetryState.liveSymbolSpec,
        digits: nextPolicy.defaultDigits,
        pointSize: nextPolicy.defaultPointSize,
        commissionPerLot: nextPolicy.commissionPerLot,
      };
      // Propagate admin dynamic spread policy onto subscriber settings
      for (const u of s.users) {
        u.settings.emaPro = mergeEmaProConfig({
          ...(u.settings.emaPro ?? DEFAULT_EMA_PRO_CONFIG),
          maxSpreadPips: nextPolicy.maxSpreadPoints,
          spreadSensitivity: nextPolicy.spreadSensitivity,
          allowHighSpreadTrades: nextPolicy.allowHighSpreadTrades,
          minNetRewardRisk: nextPolicy.minNetRewardRisk,
          commissionPerLot: nextPolicy.commissionPerLot,
          estimatedSlippagePoints: nextPolicy.estimatedSlippagePoints,
          maxQuoteAgeSeconds: nextPolicy.maxQuoteAgeSeconds,
        });
      }
      broadcastSse('status');
    }
    if (typeof body.tickerAllApiKey === 'string' && body.tickerAllApiKey.trim()) {
      const clean = body.tickerAllApiKey.trim();
      s.tickerAllMaster.apiKeyEnc = encryptSecret(clean);
      s.tickerAllMaster.apiKeyLast4 = clean.slice(-4);
    }
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      s.tickerAllMaster.baseUrl = body.baseUrl.trim();
      state.config.baseUrl = s.tickerAllMaster.baseUrl;
    }
    if (typeof body.brokerServer === 'string') {
      s.tickerAllMaster.brokerServer = body.brokerServer.trim();
      state.config.brokerServer = s.tickerAllMaster.brokerServer;
    }
    if (typeof body.mt5AccountNumber === 'string') {
      s.tickerAllMaster.mt5AccountNumber = body.mt5AccountNumber.trim();
      state.config.mt5AccountNumber = s.tickerAllMaster.mt5AccountNumber;
    }
    if (typeof body.mt5Password === 'string' && body.mt5Password.trim()) {
      s.tickerAllMaster.passwordEnc = encryptSecret(body.mt5Password.trim());
      state.config.hasBrokerPassword = true;
    }
    if (body.momo) {
      s.momo = { ...s.momo, ...body.momo };
    }
    if (body.plans) {
      const sanitizePlan = (
        current: PlanPricing['weekly'],
        incomingPlan?: Partial<PlanPricing['weekly']>
      ): PlanPricing['weekly'] => {
        if (!incomingPlan) return current;
        const nextKwacha = toFiniteNumber(incomingPlan.kwacha);
        const nextUsd = toFiniteNumber(incomingPlan.usd);
        const nextDays = toFiniteNumber(incomingPlan.days);
        return {
          ...current,
          label:
            typeof incomingPlan.label === 'string' && incomingPlan.label.trim()
              ? incomingPlan.label.trim()
              : current.label,
          kwacha:
            nextKwacha !== null && nextKwacha > 0
              ? round2(nextKwacha)
              : current.kwacha,
          usd: nextUsd !== null && nextUsd > 0 ? round2(nextUsd) : current.usd,
          days:
            nextDays !== null && nextDays >= 1
              ? Math.round(nextDays)
              : current.days,
        };
      };
      if (body.plans.weekly) s.plans.weekly = sanitizePlan(s.plans.weekly, body.plans.weekly);
      if (body.plans.monthly) s.plans.monthly = sanitizePlan(s.plans.monthly, body.plans.monthly);
      if (body.plans.quarterly) s.plans.quarterly = sanitizePlan(s.plans.quarterly, body.plans.quarterly);
    }
    if (typeof body.newAdminPassword === 'string' && body.newAdminPassword.trim().length > 0) {
      const nextAdminPin = body.newAdminPassword.trim();
      if (nextAdminPin.length < 4 || nextAdminPin.length > 128) {
        res.status(400).json({
          ok: false,
          error: 'New Admin PIN / Password must be between 4 and 128 characters.',
        });
        return;
      }
      s.adminPasswordHash = hashPassword(nextAdminPin);
      s.adminPinCustom = true;
    }

    s.tickerAllMaster.configuredByAdmin = true;
    saveStoreNow();
    res.json({
      ok: true,
      dashboard: buildAdminDashboard(),
      masterConfigBundle: toMasterConfigSyncBundle(),
    });
  });

  app.post('/api/admin/tickerall/connect', async (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const s = getStore();
    if (
      !getAdminTickerAllKey() ||
      !s.tickerAllMaster.brokerServer.trim() ||
      !s.tickerAllMaster.mt5AccountNumber.trim()
    ) {
      res.status(400).json({
        ok: false,
        error:
          'Save Master TickerAll API Key, Broker Server, and MT5 Account Number before connecting.',
        dashboard: buildAdminDashboard(),
        masterConfigBundle: toMasterConfigSyncBundle(),
      });
      return;
    }
    s.tickerAllMaster.desiredConnected = true;
    s.tickerAllMaster.configuredByAdmin = true;
    saveStoreNow();

    const clockNow = getLusakaClock();
    if (clockNow.isWeekend) {
      res.status(400).json({
        ok: false,
        error: `${clockNow.weekday.toUpperCase()} - MARKET CLOSED - Persistent Master Feed armed and will auto-connect when market opens`,
        dashboard: buildAdminDashboard(),
        masterConfigBundle: toMasterConfigSyncBundle(),
      });
      return;
    }
    state.config.baseUrl = s.tickerAllMaster.baseUrl || state.config.baseUrl;
    state.config.brokerServer = s.tickerAllMaster.brokerServer || state.config.brokerServer;
    state.config.mt5AccountNumber = s.tickerAllMaster.mt5AccountNumber || state.config.mt5AccountNumber;
    state.config.hasBrokerPassword = Boolean(getAdminMasterPassword());
    const result = await ensureMasterFeedConnected(true);
    res.json({
      ok: result.ok,
      error: result.error,
      dashboard: buildAdminDashboard(),
      masterConfigBundle: toMasterConfigSyncBundle(),
    });
  });

  app.post('/api/admin/tickerall/disconnect', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const s = getStore();
    s.tickerAllMaster.desiredConnected = false;
    s.tickerAllMaster.configuredByAdmin = true;
    saveStoreNow();

    stopStreamLoop();
    state.status = 'disconnected';
    state.connectedSince = null;
    state.latestTick = null;
    state.recentTicks = [];
    state.sessionInfo.tickConfirmed = false;
    state.sessionInfo.subscribedConfirmed = false;
    state.sessionInfo.quietMarketNotice = null;
    state.sessionInfo.lastTickAt = null;
    state.sessionInfo.sessionId = null;
    state.sessionInfo.accountId = null;
    state.sessionInfo.wsUrl = null;
    broadcastSse('status');
    res.json({
      ok: true,
      dashboard: buildAdminDashboard(),
      masterConfigBundle: toMasterConfigSyncBundle(),
    });
  });

  app.post('/api/admin/users/:id/action', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const s = getStore();
    const user = s.users.find((u) => u.id === req.params.id);
    if (!user) {
      res.status(404).json({ ok: false, error: 'Subscriber not found' });
      return;
    }
    const action = String((req.body as { action?: string })?.action || '');
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const planSpec = s.plans[user.plan] || s.plans.weekly;

    if (action === 'APPROVE') {
      const wasActive = user.status === 'ACTIVE';
      user.status = 'ACTIVE';
      user.feedAccess = true;
      if (!wasActive || !user.approvedAt) {
        user.approvedAt = nowIso;
      }
      const existingExpMs = user.expiresAt ? Date.parse(user.expiresAt) : NaN;
      const hasValidFutureExpiry = Number.isFinite(existingExpMs) && existingExpMs > now;
      if (!wasActive || !hasValidFutureExpiry) {
        const baseMs = hasValidFutureExpiry ? existingExpMs : now;
        user.expiresAt = new Date(baseMs + planSpec.days * 24 * 60 * 60 * 1000).toISOString();
        const todayPrefix = nowIso.slice(0, 10);
        const alreadyLoggedToday = s.payments.some(
          (p) =>
            p.userId === user.id &&
            p.transactionId === user.transactionId &&
            p.recordedAt.startsWith(todayPrefix)
        );
        if (!alreadyLoggedToday) {
          s.payments.unshift({
            id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            userId: user.id,
            plan: user.plan,
            amountKwacha: user.amountKwacha || planSpec.kwacha,
            amountUsd: user.amountUsd || planSpec.usd,
            paymentMethod: user.paymentMethod,
            transactionId: user.transactionId,
            recordedAt: nowIso,
          });
        }
      }
      user.lastAdminActionAt = nowIso;
    } else if (action === 'REJECT') {
      user.status = 'EXPIRED';
      user.feedAccess = false;
      user.autoTradeEnabled = false;
      if (user.expiresAt && Date.parse(user.expiresAt) > now) {
        user.expiresAt = nowIso;
      }
      user.lastAdminActionAt = nowIso;
    } else if (action === 'EXTEND_7_DAYS') {
      if (user.status === 'BLOCKED') {
        res.status(400).json({
          ok: false,
          error: 'Account is BLOCKED. Click UNBLOCK & APPROVE first before extending days.',
        });
        return;
      }
      const baseMs =
        user.expiresAt && Date.parse(user.expiresAt) > now ? Date.parse(user.expiresAt) : now;
      user.expiresAt = new Date(baseMs + 7 * 24 * 60 * 60 * 1000).toISOString();
      user.status = 'ACTIVE';
      user.feedAccess = true;
      if (!user.approvedAt) {
        user.approvedAt = nowIso;
      }
      user.lastAdminActionAt = nowIso;
    } else if (action === 'BLOCK') {
      user.status = 'BLOCKED';
      user.feedAccess = false;
      user.autoTradeEnabled = false;
      user.lastAdminActionAt = nowIso;
    } else if (action === 'PAUSE_FEED') {
      user.feedAccess = false;
      user.lastAdminActionAt = nowIso;
    } else if (action === 'RESUME_FEED') {
      if (user.status !== 'ACTIVE') {
        res.status(400).json({
          ok: false,
          error: `Cannot resume feed while account status is ${user.status}. Click APPROVE or EXTEND 7 DAYS first.`,
        });
        return;
      }
      user.feedAccess = true;
      user.lastAdminActionAt = nowIso;
    } else {
      res.status(400).json({ ok: false, error: 'Unsupported admin action' });
      return;
    }

    saveStoreNow();
    broadcastSse('status');
    res.json({
      ok: true,
      dashboard: buildAdminDashboard(),
      updatedUserBundle: toUserSyncBundle(user),
    });
  });

  app.post('/api/admin/test-account/create', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const testUser = createOrAuthorizeTestAccount();
    broadcastSse('status');
    res.json({
      ok: true,
      userId: testUser.id,
      dashboard: buildAdminDashboard(),
      updatedUserBundle: toUserSyncBundle(testUser),
    });
  });

  app.post('/api/admin/users/:id/reset-pin', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const s = getStore();
    const user = s.users.find((u) => u.id === req.params.id);
    if (!user) {
      res.status(404).json({ ok: false, error: 'Subscriber not found' });
      return;
    }
    const body = (req.body || {}) as {
      mode?: 'SET_PIN' | 'GENERATE_CODE';
      newPin?: string;
    };
    const mode = body.mode === 'GENERATE_CODE' ? 'GENERATE_CODE' : 'SET_PIN';

    if (mode === 'GENERATE_CODE') {
      const resetCode = String(crypto.randomInt(100000, 1000000));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      user.pinResetCodeHash = hashPassword(resetCode);
      user.pinResetExpiresAt = expiresAt;
      saveStoreNow();
      res.json({
        ok: true,
        mode: 'GENERATE_CODE',
        resetCode,
        expiresAt,
        dashboard: buildAdminDashboard(),
      });
      return;
    }

    const newPin = typeof body.newPin === 'string' ? body.newPin.trim() : '';
    if (newPin.length < 4 || newPin.length > 128) {
      res.status(400).json({
        ok: false,
        error: 'Temporary PIN / Password must be between 4 and 128 characters.',
      });
      return;
    }
    user.passwordHash = hashPassword(newPin);
    user.pinResetCodeHash = null;
    user.pinResetExpiresAt = null;
    user.lastAdminActionAt = new Date().toISOString();
    saveStoreNow();
    res.json({
      ok: true,
      mode: 'SET_PIN',
      dashboard: buildAdminDashboard(),
      updatedUserBundle: toUserSyncBundle(user),
    });
  });

  app.post('/api/admin/firestore-sync', async (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const body = (req.body || {}) as {
      idToken?: string;
      firestoreUsers?: UserSyncBundle[];
      publicConfig?: {
        momo?: Partial<AdminDashboardData['momo']>;
        plans?: Partial<AdminDashboardData['plans']>;
      } | null;
      masterConfig?: Partial<MasterConfigSyncBundle> | null;
    };

    const idToken = String(body.idToken || '').trim();
    if (!idToken) {
      res.status(400).json({ ok: false, error: 'Admin Firebase ID token required.' });
      return;
    }
    try {
      const decoded = await verifyFirebaseIdToken(idToken);
      if (
        !decoded.emailVerified ||
        decoded.email.toLowerCase() !== 'muyobakuyewana@gmail.com'
      ) {
        res.status(403).json({
          ok: false,
          error: 'Signed-in Google account is not the authorized Gold AI Trader admin.',
        });
        return;
      }

      const incomingUsers = Array.isArray(body.firestoreUsers) ? body.firestoreUsers : [];
      for (const bundle of incomingUsers) {
        if (bundle && (bundle.appUserId || bundle.ownerId)) {
          upsertUserFromSyncBundle(bundle, { trustedStatus: true });
        }
      }

      const s = getStore();
      if (body.publicConfig) {
        applyPublicConfigHydration(
          body.publicConfig.momo,
          body.publicConfig.plans,
          true
        );
      }
      if (body.masterConfig) {
        const masterApplied = applyMasterConfigSyncBundle(body.masterConfig);
        if (masterApplied) {
          state.config.baseUrl = s.tickerAllMaster.baseUrl || state.config.baseUrl;
          state.config.brokerServer =
            s.tickerAllMaster.brokerServer || state.config.brokerServer;
          state.config.mt5AccountNumber =
            s.tickerAllMaster.mt5AccountNumber || state.config.mt5AccountNumber;
          state.config.hasBrokerPassword = Boolean(getAdminMasterPassword());
        }
      }

      if (
        s.tickerAllMaster.desiredConnected &&
        !getLusakaClock().isWeekend &&
        state.status !== 'connected'
      ) {
        void ensureMasterFeedConnected(true);
      }

      saveStoreNow();
      res.json({
        ok: true,
        dashboard: buildAdminDashboard(),
        allBundles: s.users.map((u) => toUserSyncBundle(u)),
        publicConfig: { momo: s.momo, plans: s.plans },
        masterConfigBundle: toMasterConfigSyncBundle(),
      });
    } catch (err) {
      res.status(401).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to verify admin Google token',
      });
    }
  });

  app.post('/api/admin/users/:id/impersonate', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const targetUser = findUserById(req.params.id);
    if (!targetUser) {
      res.status(404).json({ ok: false, error: 'Subscriber not found' });
      return;
    }
    issueUserSessionCookie(req, res, targetUser.id, true);
    res.json({
      ok: true,
      user: toPublicUser(targetUser),
      impersonatingUser: true,
    });
  });

  app.post('/api/admin/exit-impersonate', (req: Request, res: Response) => {
    if (!isAdminAuthenticated(req)) {
      res.status(401).json({ ok: false, error: 'Admin authentication required' });
      return;
    }
    const meta = getUserSessionMeta(req);
    if (meta.impersonatedByAdmin) {
      clearAuthCookie(req, res, USER_COOKIE_NAME);
    }
    res.json({ ok: true });
  });

  // Clean JSON error handler for malformed JSON payloads on /api/*
  app.use(
    (
      err: unknown,
      req: Request,
      res: Response,
      next: (err?: unknown) => void
    ) => {
      if (req.path.startsWith('/api/')) {
        const message = err instanceof Error ? err.message : 'Invalid API request';
        res.status(400).json({ ok: false, error: message });
        return;
      }
      next(err);
    }
  );

  app.all('/api/*', (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'API endpoint not found' });
  });

  const httpServer = http.createServer(app);

  if (IS_DEV_MODE) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    const indexHtmlPath = path.join(distPath, 'index.html');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
    }
    app.get('*', (_req: Request, res: Response) => {
      if (fs.existsSync(indexHtmlPath)) {
        res.sendFile(indexHtmlPath);
        return;
      }
      res.status(503).send('Application bundle is not built yet. Run npm run build first.');
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Gold AI Trader server listening on http://0.0.0.0:${PORT} (${IS_DEV_MODE ? 'dev' : 'production'})`
    );
    const bootStore = getStore();
    state.config.baseUrl = bootStore.tickerAllMaster.baseUrl || state.config.baseUrl;
    state.config.brokerServer =
      bootStore.tickerAllMaster.brokerServer || state.config.brokerServer;
    state.config.mt5AccountNumber =
      bootStore.tickerAllMaster.mt5AccountNumber || state.config.mt5AccountNumber;
    state.config.hasBrokerPassword = Boolean(getAdminMasterPassword());

    void refreshFallbackPrice(true);
    startFallbackLoop();
    if (bootStore.tickerAllMaster.desiredConnected && !getLusakaClock().isWeekend) {
      void ensureMasterFeedConnected(true);
    }
    let lastBridgeSyncCycleMs = 0;
    proxyMarketState.clockTimer = setInterval(() => {
      const nowMs = Date.now();
      const currentBucketMs = Math.floor(nowMs / 900_000) * 900_000;
      if (
        proxyMarketState.currentCandle &&
        proxyMarketState.currentCandle.openTimeMs < currentBucketMs
      ) {
        const finalized: M15Candle = { ...proxyMarketState.currentCandle, closed: true };
        proxyMarketState.closedCandles = [
          finalized,
          ...proxyMarketState.closedCandles.filter((c) => c.openTimeMs !== finalized.openTimeMs),
        ]
          .sort((a, b) => b.openTimeMs - a.openTimeMs)
          .slice(0, 120);
        proxyMarketState.currentCandle = null;
      }

      const currentM5BucketMs = Math.floor(nowMs / 300_000) * 300_000;
      if (
        proxyMarketState.currentM5Candle &&
        proxyMarketState.currentM5Candle.openTimeMs < currentM5BucketMs
      ) {
        const finalizedM5: M15Candle = { ...proxyMarketState.currentM5Candle, closed: true };
        proxyMarketState.closedM5Candles = [
          finalizedM5,
          ...proxyMarketState.closedM5Candles.filter(
            (c) => c.openTimeMs !== finalizedM5.openTimeMs
          ),
        ]
          .sort((a, b) => b.openTimeMs - a.openTimeMs)
          .slice(0, 240);
        proxyMarketState.currentM5Candle = null;
      }

      const clock = getLusakaClock(nowMs);
      const bucketKey = `${clock.dateLusaka}-${Math.floor(clock.minutes / 15)}`;
      const price = getEffectiveProxyPrice();
      refreshAllUserExpiries();
      for (const user of getStore().users) {
        if (user.status === 'ACTIVE' && user.feedAccess) {
          evaluateUserOnProxyTick(user, price, nowMs);
        }
      }

      if (nowMs - lastBridgeSyncCycleMs >= 15_000) {
        lastBridgeSyncCycleMs = nowMs;
        syncUsersWithTickerAllAccountInfo();
        for (const user of getStore().users) {
          if (user.status === 'ACTIVE' && user.brokerConnected && user.brokerBridgeUrl.trim()) {
            void syncUserBalanceFromBridge(user);
          }
        }
      }

      if (proxyMarketState.lastBroadcastKey !== bucketKey) {
        proxyMarketState.lastBroadcastKey = bucketKey;
        broadcastSse('status');
      }
    }, 5000);
  });

  const shutdown = () => {
    if (proxyMarketState.clockTimer) {
      clearInterval(proxyMarketState.clockTimer);
      proxyMarketState.clockTimer = null;
    }
    stopStreamLoop();
    stopFallbackLoop();
    for (const clientRes of sseClients.keys()) {
      try {
        clientRes.end();
      } catch {
        // Ignore SSE close errors
      }
    }
    sseClients.clear();
    saveHistoryCacheNow();
    saveStoreNow();
    httpServer.close(() => {
      process.exit(0);
    });
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void startServer();
