export type AdapterId =
  | 'tickerall-ws'
  | 'bullion-kraken'
  | 'bullion-coinbase'
  | 'comex-futures'
  | 'spot-gold-api';

export type AuthHeaderMode = 'bearer' | 'x-api-key' | 'query-param' | 'none';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'error';

export type TransportMode = 'websocket' | 'http-poll';

export interface SchemaMapping {
  symbolPath: string;
  pricePath: string;
  bidPath: string;
  askPath: string;
  volumePath: string;
  change24hPath: string;
  timestampPath: string;
}

export interface SymbolBinding {
  internalSymbol: string;
  upstreamSymbol: string;
  contractUnit: string;
  tickSize: number;
  enabled: boolean;
}

export type BrokerType = 'mt5' | 'mt4' | 'ctrader' | 'dxtrade';

export interface ConnectionConfig {
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

export interface NormalizedTick {
  seq: number;
  adapterId: AdapterId;
  symbol: string;
  upstreamSymbol: string;
  last: number;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  spreadBps: number;
  digits?: number;
  pointSize?: number;
  spreadPoints?: number | null;
  hasTwoSidedQuote?: boolean;
  volume24h: number | null;
  change24hPct: number | null;
  latencyMs: number;
  httpStatus: number;
  receivedAt: string;
  upstreamTimestamp: string;
  sourceLabel: string;
  isFallback?: boolean;
  rawPayload: unknown;
}

export interface DiagnosticLog {
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

export interface EnvStatus {
  hasTickerAllApiKey: boolean;
  configuredTickerAllBaseUrl: string | null;
  runtimeEnvironment: string;
}

export interface RawWsFrame {
  index: number;
  receivedAt: string;
  payload: string;
  isJson?: boolean;
}

export interface SessionInfo {
  transport: TransportMode;
  sessionId: string | null;
  accountId: string | null;
  wsUrl: string | null;
  wsReadyState: 'closed' | 'connecting' | 'open';
  tickConfirmed: boolean;
  subscribedConfirmed?: boolean;
  quietMarketNotice?: string | null;
  subscribedSymbols?: string[];
  rejectedSymbols?: string[];
  lastTickAt?: string | null;
  totalTickFrames?: number;
  rawWsFrames: RawWsFrame[];
  rawSessionResponse: unknown | null;
  rawSessionResponseAt: string | null;
}

export interface AccountProbeAttempt {
  method: 'GET' | 'POST';
  endpoint: string;
  httpStatus: number | null;
  statusLabel: string;
  worked: boolean;
  detail?: string;
}

export interface AccountBalanceInfo {
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

export interface ConnectionSnapshot {
  status: ConnectionState;
  lastError: string | null;
  connectedSince: string | null;
  packetsReceived: number;
  failedProbes: number;
  avgLatencyMs: number | null;
  config: ConnectionConfig;
  envStatus: EnvStatus;
  sessionInfo: SessionInfo;
  accountInfo: AccountBalanceInfo;
  latestTick: NormalizedTick | null;
  fallbackTick: NormalizedTick | null;
  isFallbackPriceActive: boolean;
  recentTicks: NormalizedTick[];
  logs: DiagnosticLog[];
  bot?: BotStateSnapshot;
  userProfile?: UserPublicProfile;
}

export interface MappingEvaluation {
  field: keyof SchemaMapping;
  label: string;
  path: string;
  rawValue: unknown;
  parsedValue: string | number | null;
  valid: boolean;
  required: boolean;
}

export type SessionPhase =
  | 'ASIAN_SESSION'
  | 'LONDON_SESSION'
  | 'NEW_YORK_SESSION'
  | 'ALL_SESSIONS'
  | 'OFF_SESSION'
  | 'MARKET_CLOSED';

export type TradingSessionTag =
  | 'ASIAN_SESSION'
  | 'LONDON_SESSION'
  | 'NEW_YORK_SESSION'
  | 'ALL_SESSIONS';

export type SignalAction = 'BUY' | 'SELL' | 'WAIT';

export type StrategyModuleId = 'EMA_STOCHASTIC_PRO';

export type SetupType =
  | 'CONTINUATION_BUY'
  | 'CONTINUATION_SELL'
  | 'REVERSAL_BUY'
  | 'REVERSAL_SELL';

export type TradingMode = 'SIGNALS_ONLY' | 'AUTOMATIC_TRADING' | 'BOTH';

export type TradingRunState = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'EMERGENCY_STOP';

export type SpreadClassification =
  | 'NORMAL'
  | 'ELEVATED'
  | 'HIGH'
  | 'EXCESSIVE'
  | 'ABNORMAL';

export type SpreadSensitivity = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

export type BrokerPreset = 'XM' | 'Exness' | 'Weltrade' | 'Other';

export type BrokerAccountVariant = 'STANDARD' | 'CENT_USD' | 'CENT_USC' | 'ECN_RAW';

export interface SymbolSpecification {
  symbol: string;
  digits: number;
  pointSize: number;
  tickSize: number;
  contractSize: number;
  commissionPerLot: number;
  currency?: 'USD' | 'USC';
  accountVariant?: BrokerAccountVariant;
  source: string;
  verifiedFromBroker: boolean;
}

export interface SpreadSampleRecord {
  timestampMs: number;
  bid: number;
  ask: number;
  spreadPrice: number;
  spreadPoints: number;
  pointSize?: number;
  hasTwoSidedQuote?: boolean;
  source: string;
  symbol: string;
}

export interface SpreadWindowStats {
  windowLabel: '1H' | '24H';
  sampleCount: number;
  sufficientData: boolean;
  minSamplesRequired: number;
  medianPoints: number | null;
  p75Points: number | null;
  p90Points: number | null;
  minPoints: number | null;
  maxPoints: number | null;
  avgPoints: number | null;
}

export interface TransactionCostBreakdown {
  spreadPrice: number;
  spreadPoints: number;
  spreadCostDollars: number;
  commissionDollars: number;
  estimatedSlippagePoints: number;
  estimatedSlippageDollars: number;
  totalEstimatedCostDollars: number;
  totalCostPoints: number;
  grossRewardDollars: number | null;
  netRewardDollars: number | null;
  netRiskDollars: number | null;
  grossRr: number | null;
  netRr: number | null;
}

export interface DynamicSpreadEvaluation {
  dataAvailable: boolean;
  quoteFresh: boolean;
  hasTwoSidedQuote: boolean;
  quoteAgeMs: number | null;
  quoteTimestamp: string | null;
  quoteSource: string;
  symbol: string;
  digits: number;
  pointSize: number;
  bid: number | null;
  ask: number | null;
  spreadPrice: number | null;
  spreadPoints: number | null;
  classification: SpreadClassification | 'DATA_UNAVAILABLE';
  decision:
    | 'ALLOW'
    | 'ALLOW_STRONG_ONLY'
    | 'ALLOW_ADMIN_HIGH'
    | 'REJECT_EXCESSIVE'
    | 'PAUSE_ABNORMAL'
    | 'BLOCK_DATA_UNAVAILABLE';
  tradePermitted: boolean;
  requiresStrongConfirmation: boolean;
  reason: string;
  configuredMaxSpreadPoints: number;
  sensitivity: SpreadSensitivity;
  allowHighSpreadTrades: boolean;
  acceptedAbove45Override: boolean;
  proposedSide?: 'BUY' | 'SELL' | null;
  stats1h: SpreadWindowStats;
  stats24h: SpreadWindowStats;
  costBreakdown: TransactionCostBreakdown | null;
  thresholdsPoints: {
    normalMax: number;
    elevatedMax: number;
    highMax: number;
    abnormalMin: number;
  };
}

export interface AdminSpreadPolicy {
  maxSpreadPoints: number;
  spreadSensitivity: SpreadSensitivity;
  allowHighSpreadTrades: boolean;
  commissionPerLot: number;
  estimatedSlippagePoints: number;
  maxQuoteAgeSeconds: number;
  minNetRewardRisk: number;
  defaultSymbol: string;
  defaultDigits: number;
  defaultPointSize: number;
}

export interface SpreadFilterComparisonRow {
  label: string;
  qualifiedOpportunities: number;
  rejectedBySpread: number;
  tradesAccepted: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netProfitDollars: number;
  totalCostsDollars: number;
  maxDrawdownPct: number;
  profitFactor: number;
  avgSpreadAtEntryPoints: number;
  acceptedAbove45Points: number;
}

export interface SpreadFilterComparisonReport {
  dataMode: 'HISTORICAL_OHLC_WITH_MODELED_SPREAD' | 'TICK_OBSERVED';
  disclaimer: string;
  generatedAt?: string;
  periodDays?: number;
  candlesTested?: number;
  legacyRigid45: SpreadFilterComparisonRow;
  dynamicAllSession: SpreadFilterComparisonRow;
}

export type AiApprovalDecision =
  | 'APPROVED'
  | 'REJECTED'
  | 'WAITING FOR CONFIRMATION'
  | 'ERROR';

export interface UsdNewsEvent {
  id: string;
  title: string;
  timeLusaka: string;
  impact: 'HIGH' | 'MEDIUM';
  enabled: boolean;
}

export interface EmaStochasticProConfig {
  emaFast: number; // 9
  emaMid: number; // 21
  emaIntermediate: number; // 50
  emaMajor: number; // 200
  stochK: number; // 14
  stochD: number; // 3
  stochSlowing: number; // 3
  stochOverbought: number; // 80
  stochOversold: number; // 20
  stochMidpoint: number; // 50
  atrPeriod: number; // 14
  atrSlMultiplier: number; // 1.5
  smcLookbackBars: number; // 80
  swingStrength: number; // 2
  m1RefinementEnabled: boolean;
  aiConfidenceThreshold: number; // 75
  maxRiskPercent: number; // 1.0
  maxSimultaneousPositions: number; // 2
  maxTradesPerSession: number; // 5
  minRewardRisk: number; // 2.0
  tp1Rr: number; // 1.0
  tp2Rr: number; // 2.0
  tp3Rr: number; // 3.0
  partialProfitEnabled: boolean;
  moveSlToTp1OnTp1: boolean;
  moveSlToTp2OnTp2: boolean;
  maxSpreadPips: number; // Dynamic max acceptable spread ceiling in points (default 80)
  spreadSensitivity: SpreadSensitivity; // CONSERVATIVE | BALANCED | AGGRESSIVE
  allowHighSpreadTrades: boolean; // Admin-enabled allowance for HIGH spread class
  minNetRewardRisk: number; // Minimum net R:R after spread + commission + slippage
  commissionPerLot: number; // Round-turn commission per 1.00 lot in USD
  estimatedSlippagePoints: number; // Estimated slippage in symbol points
  maxQuoteAgeSeconds: number; // Max live quote age before DATA_UNAVAILABLE
  signalExpiryMinutes: number; // 15
  maxEntryDeviationPips: number; // 15 ($1.50)
  xauusdSymbol: string; // 'GOLD' or 'XAUUSD' / broker suffix
  demoOnlyMode: boolean; // true by default
  liveTradingAuthorized: boolean; // false by default
  allowBuy: boolean;
  allowSell: boolean;
  tradingMode: TradingMode;
  tradingRunState: TradingRunState;
  settingsVersion: number;
}

export interface StrategySettings {
  strategyMode?: StrategyModuleId;
  asianStart: string; // '03:00' Lusaka
  asianEnd: string; // '11:00' Lusaka
  londonStart: string; // '11:00' Lusaka
  londonEnd: string; // '19:00' Lusaka
  slPips: number; // 15 pips ($1.50 on GOLD)
  maxSlPips: number; // 25 pips ($2.50) max total SL
  newsClearanceMins: number; // 60 minutes BEFORE & AFTER
  maxTradesPerDay: number; // 10 max trades per day (balanced risk limit)
  maxConsecutiveLosses: number; // 3 losses pause
  riskPercent: number; // 0.5% initial risk per trade
  defaultLotSize: number;
  autoLogSignals: boolean;
  aiApproverEnabled?: boolean;
  maxAutoLotCap: number;
  dailyGuardPct: number; // 5.0% max daily loss
  newsEvents: UsdNewsEvent[];
  emaPro?: EmaStochasticProConfig;
}

export interface M15Candle {
  openTimeMs: number;
  openTimeLusaka: string;
  closeTimeLusaka: string;
  open: number;
  high: number;
  low: number;
  close: number;
  ticksCount: number;
  closed: boolean;
  source: 'tickerall' | 'fallback' | 'history';
}

export interface TimeframeIndicatorSnapshot {
  timeframe: 'H1' | 'M15' | 'M5' | 'M1';
  barsCount: number;
  lastClose: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  ema50Slope?: 'RISING' | 'FALLING' | 'FLAT';
  emaBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'CHOP';
  isCompressedOrChoppy: boolean;
  stochK: number | null;
  stochD: number | null;
  stochCross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NONE';
  stochZone: 'OVERSOLD' | 'OVERBOUGHT' | 'NEUTRAL';
  atr: number | null;
}

export interface SmcSwingPoint {
  index: number;
  openTimeMs: number;
  timeLusaka: string;
  type: 'HIGH' | 'LOW';
  price: number;
}

export interface SmcStructureEvent {
  type: 'BOS_BULL' | 'BOS_BEAR' | 'CHOCH_BULL' | 'CHOCH_BEAR';
  price: number;
  timeLusaka: string;
  openTimeMs: number;
}

export interface SmcFvgZone {
  direction: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  timeLusaka: string;
  openTimeMs: number;
  mitigated: boolean;
}

export interface SmcOrderBlock {
  direction: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  openTimeMs: number;
  timeLusaka: string;
  mitigated: boolean;
}

export interface SmcLiquiditySweep {
  direction: 'BULLISH' | 'BEARISH';
  sweptLevel: number;
  sweepExtreme: number;
  closePrice: number;
  timeLusaka: string;
  openTimeMs: number;
  label: string;
}

export interface SmcAnalysis {
  trendStructure: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastBos: SmcStructureEvent | null;
  lastChoch: SmcStructureEvent | null;
  lastSweep: SmcLiquiditySweep | null;
  equalHighs: number[];
  equalLows: number[];
  swingHighs: SmcSwingPoint[];
  swingLows: SmcSwingPoint[];
  activeBullishObs: SmcOrderBlock[];
  activeBearishObs: SmcOrderBlock[];
  activeBullishFvgs: SmcFvgZone[];
  activeBearishFvgs: SmcFvgZone[];
  dealingRangeHigh: number | null;
  dealingRangeLow: number | null;
  equilibriumPrice: number | null;
  priceZone: 'DISCOUNT' | 'PREMIUM' | 'EQUILIBRIUM' | 'UNKNOWN';
  bullishSetupPresent: boolean;
  bearishSetupPresent: boolean;
  evidenceSummary: string[];
}

export interface EmaStochasticProSnapshot {
  h1: TimeframeIndicatorSnapshot;
  m15: TimeframeIndicatorSnapshot;
  m5: TimeframeIndicatorSnapshot;
  m1: TimeframeIndicatorSnapshot;
  smc: SmcAnalysis;
  m15Smc?: SmcAnalysis;
  activeSetupType?: SetupType | null;
  stochNote?: string;
  confirmationScore?: number;
  overallTrend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
  marketCondition: 'TRENDING' | 'CHOPPY_SIDEWAYS' | 'HIGH_VOLATILITY' | 'LOW_DATA';
  spreadPips: number | null;
  spreadAllowed: boolean;
  spreadEvaluation?: DynamicSpreadEvaluation;
  symbolSpec?: SymbolSpecification;
  atrPips: number | null;
  pullbackToEma: 'EMA_9' | 'EMA_21' | 'NONE';
  confirmationCandle: 'BULLISH_CLOSE' | 'BEARISH_CLOSE' | 'NONE';
  signalExpiresAt: string | null;
  newsFeedStatus: 'CALENDAR_CONFIGURED' | 'NEWS_DATA_UNAVAILABLE';
}

export interface SignalHistoryEntry {
  id: string;
  timestamp: string;
  lusakaTime: string;
  strategy: TradingSessionTag;
  strategyModule?: StrategyModuleId;
  setupType?: SetupType;
  action: 'BUY' | 'SELL' | 'BLOCKED';
  symbol: string;
  price: number | null;
  stop?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  tp3?: number | null;
  emaAlignment?: string;
  stochReading?: string;
  smcEvidence?: string;
  aiConfidence?: number | null;
  signalStatus?: 'GENERATED' | 'APPROVED' | 'REJECTED' | 'WAITING' | 'EXECUTED' | 'EXPIRED' | 'BLOCKED';
  setupStatus: string;
  blockReason: string;
}

export interface StrategyConditionItem {
  label: string;
  passed: boolean;
  detail: string;
}

export interface TradeSignal {
  id: string;
  timestamp: string;
  lusakaTime: string;
  strategy: TradingSessionTag;
  strategyModule?: StrategyModuleId;
  setupType?: SetupType;
  action: SignalAction;
  symbol: string;
  entry: number | null;
  stop: number | null;
  tp1: number | null; // 1:1 R:R partial
  tp2: number | null; // 1:2 R:R minimum target
  tp3?: number | null; // 1:3 R:R runner target
  target: number | null; // Primary final target for broker dispatch
  rrRatio: number;
  netRrRatio?: number | null;
  estimatedCostDollars?: number | null;
  riskDollars: number;
  suggestedLots: number;
  reason: string;
  setupLabel?: string;
  blockReason?: string | null;
  expiresAt?: string | null;
  emaSummary?: string;
  stochSummary?: string;
  smcSummary?: string;
  conditions: StrategyConditionItem[];
}

export interface AiTradeApproval {
  id: string;
  model: string;
  timestamp: string;
  lusakaTime: string;
  side: 'BUY' | 'SELL' | 'WAIT';
  symbol: string;
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3?: number | null;
  slDistancePips: number | null;
  status: 'APPROVED' | 'REJECTED' | 'WAITING FOR CONFIRMATION' | 'ERROR';
  approved: boolean;
  confidencePct: number;
  summary: string;
  ruleAudit: string[];
  errorMessage?: string | null;
}

export interface TradeLogEntry {
  id: string;
  signalId?: string;
  orderId?: string | null;
  dateLusaka: string;
  timeLusaka: string;
  timestamp: string;
  closedAt?: string | null;
  session: TradingSessionTag;
  strategyModule?: StrategyModuleId;
  marketCondition?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stop: number;
  tp1?: number | null;
  tp2?: number | null;
  tp3?: number | null;
  target: number;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  tp1RealizedPnl?: number | null;
  tp2RealizedPnl?: number | null;
  breakevenMoved?: boolean;
  rrRatio: number;
  lots: number;
  riskDollars: number;
  status: 'SIGNALED' | 'OPEN' | 'TP_HIT' | 'SL_HIT' | 'CLOSED';
  executionStatus?: 'SIGNAL_ONLY' | 'SUBMITTED' | 'FILLED' | 'REJECTED' | 'DEMO_SIMULATED' | 'EXECUTION_UNAVAILABLE';
  exitPrice: number | null;
  pnlDollars: number | null;
  commissionDollars?: number | null;
  swapDollars?: number | null;
  slippagePips?: number | null;
  notes: string;
  setupStatus?: string;
  executionMode?: 'AUTO' | 'MANUAL';
  feedSource?: string;
  brokerName?: string;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  aiApproval?: AiTradeApproval | null;
}

export interface TradeOrderRecord {
  id: string;
  signalId: string;
  idempotencyKey: string;
  timestamp: string;
  lusakaTime: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  requestedEntry: number;
  actualFillPrice: number | null;
  lots: number;
  stop: number;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  status: 'SUBMITTED' | 'ACCEPTED' | 'FILLED' | 'REJECTED' | 'EXECUTION_UNAVAILABLE' | 'DEMO_SIMULATED';
  brokerOrderId: string | null;
  environment: 'DEMO' | 'LIVE';
  adapterUsed: 'TICKERALL_API' | 'BROKER_BRIDGE' | 'DEMO_PAPER' | 'NONE';
  errorMessage: string | null;
}

export interface RiskEventRecord {
  id: string;
  timestamp: string;
  lusakaTime: string;
  category:
    | 'DAILY_LOSS_LIMIT'
    | 'CONSECUTIVE_LOSSES'
    | 'MAX_TRADES'
    | 'MAX_POSITIONS'
    | 'SPREAD_FILTER'
    | 'NEWS_BLACKOUT'
    | 'EMERGENCY_STOP'
    | 'STALE_DATA'
    | 'DISCONNECTED';
  detail: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export interface AuditLogRecord {
  id: string;
  version: number;
  timestamp: string;
  actor: string;
  action: string;
  detail: string;
}

export interface PerformanceMetricsSummary {
  totalSignals: number;
  approvedSignals: number;
  rejectedSignals: number;
  waitingSignals: number;
  executedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number;
  averageRr: number;
  maxDrawdownPct: number;
  avgTradeDurationMins: number;
  totalCommission: number;
  totalSwap: number;
  signalOnlyStats: {
    count: number;
    wins: number;
    losses: number;
    winRatePct: number;
    theoreticalNetDollars: number;
  };
  actualExecutionStats: {
    count: number;
    wins: number;
    losses: number;
    winRatePct: number;
    netDollars: number;
  };
  bySession: Record<
    TradingSessionTag,
    { trades: number; wins: number; netProfit: number }
  >;
  byMarketCondition: Array<{
    condition: string;
    trades: number;
    wins: number;
    netProfit: number;
  }>;
}

export interface DaySessionLevels {
  dateLusaka: string;
  pdh: number | null;
  pdl: number | null;
  prevDayDate: string | null;
  asianHigh: number | null;
  asianLow: number | null;
  londonHigh: number | null;
  londonLow: number | null;
  asianTradesToday: number;
  londonTradesToday: number;
  totalTradesToday: number;
  consecutiveLossesToday: number;
  manualOverride: boolean;
}

export interface BacktestEquityPoint {
  index: number;
  timestampMs: number;
  dateLusaka: string;
  timeLusaka: string;
  balance: number;
  pnlDollars: number;
  label: string;
}

export interface BacktestTradeResult {
  id: string;
  openTimeMs?: number;
  dateLusaka: string;
  timeLusaka: string;
  session: TradingSessionTag;
  side: 'BUY' | 'SELL';
  status: 'EXECUTED' | 'BLOCKED';
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3?: number;
  target: number;
  tp1Hit: boolean;
  tp2Hit?: boolean;
  exit: number;
  outcome: 'WIN' | 'LOSS' | 'OPEN' | 'BLOCKED';
  pnlR: number;
  lotsUsed: number;
  balanceBefore: number;
  balanceAfter: number;
  pnlDollars: number;
  commissionDollars?: number;
  slippageDollars?: number;
  setupStatus: string;
  setupType?: SetupType;
  reason: string;
  blockReason: string;
  wouldHaveBeenOutcome: 'WIN' | 'LOSS' | 'OPEN' | null;
  wouldHaveBeenR: number | null;
  counterfactualNote: string | null;
}

export interface BacktestSplitMetric {
  label: 'Train (60%)' | 'Validation (20%)' | 'Out-of-Sample (20%)';
  candlesCount: number;
  trades: number;
  winRatePct: number;
  netProfitDollars: number;
  profitFactor: number;
  maxDrawdownPct: number;
}

export interface BacktestSummary {
  hasRealData: boolean;
  strategyModule?: StrategyModuleId;
  errorCode?: 'NO_MASTER_FEED' | 'PERIOD_UNAVAILABLE' | null;
  errorMessage?: string | null;
  dataSource: string;
  lastUpdatedAt: string | null;
  periodDays: 30 | 90 | 180;
  periodLabel: string;
  candlesTested: number;
  m15CandlesCount: number;
  m5CandlesCount?: number;
  h1CandlesCount: number;
  d1DaysCount: number;
  daysTested: number;
  weeksTested: number;
  totalTrades: number;
  wins: number;
  losses: number;
  tp1PartialsHit: number;
  winRatePct: number;
  netR: number;
  profitFactor?: number;
  avgRr?: number;
  startingBalance: number;
  endingBalance: number;
  balanceGrowthPct: number;
  totalProfitDollars: number;
  totalLossDollars: number;
  netProfitDollars: number;
  largestWinDollars: number;
  largestLossDollars: number;
  maxDrawdownPct: number;
  maxAutoLotCap: number;
  skippedSetupsCount: number;
  splits?: BacktestSplitMetric[];
  assumptions?: {
    spreadPips: number;
    commissionPerLot: number;
    slippagePips: number;
  };
  spreadComparison?: SpreadFilterComparisonReport;
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTradeResult[];
  blockedEntries: BacktestTradeResult[];
  allEntries: BacktestTradeResult[];
}

export interface AutoLotTierInfo {
  balance: number;
  tierLot: number;
  effectiveLot: number;
  maxAutoLotCap: number;
  nextTierBalance: number | null;
  nextTierLot: number | null;
  progressPct: number;
  tierLabel: string;
}

export interface ProxyFeedStatusInfo {
  status: 'LIVE' | 'OFFLINE' | 'LOCKED' | 'RECONNECTING';
  label: string;
  isLive: boolean;
  reconnecting?: boolean;
  lastUpdatedAt?: string | null;
  message: string;
}

export interface BotStateSnapshot {
  strategyModule: StrategyModuleId;
  lusakaDate: string;
  lusakaTime: string;
  lusakaMinutes: number;
  lusakaWeekday: string;
  isWeekend: boolean;
  m15HistoryCount: number;
  m5HistoryCount?: number;
  m1HistoryCount?: number;
  h1HistoryCount?: number;
  phase: SessionPhase;
  phaseLabel: string;
  activeStrategyName: string;
  brokerFeedLabel: string;
  newsStatus: {
    clear: boolean;
    blockingEvent: UsdNewsEvent | null;
    minutesUntil: number | null;
    feedAvailable?: boolean;
  };
  settings: StrategySettings;
  levels: DaySessionLevels;
  currentCandle: M15Candle | null;
  currentM5Candle?: M15Candle | null;
  closedCandles: M15Candle[];
  closedM5Candles?: M15Candle[];
  closedH1Candles?: M15Candle[];
  emaPro?: EmaStochasticProSnapshot;
  spreadEvaluation?: DynamicSpreadEvaluation;
  spreadRejectedCount?: number;
  acceptedAbove45Count?: number;
  symbolSpec?: SymbolSpecification;
  latestQuote?: {
    bid: number | null;
    ask: number | null;
    last: number | null;
    spreadPrice: number | null;
    spreadPoints: number | null;
    timestamp: string | null;
    source: string;
    ageMs: number | null;
    hasTwoSidedQuote: boolean;
    isFallbackOnly?: boolean;
  };
  activeSignal: TradeSignal;
  recentSignals: TradeSignal[];
  signalHistory: SignalHistoryEntry[];
  tradeLog: TradeLogEntry[];
  tradeOrders?: TradeOrderRecord[];
  riskEvents?: RiskEventRecord[];
  auditLogs?: AuditLogRecord[];
  notifications?: Array<{ id: string; timestamp: string; title: string; detail: string; level: 'INFO' | 'WARNING' | 'CRITICAL' }>;
  performance?: PerformanceMetricsSummary;
  dailyPnlDollars?: number;
  dailyPnlPct?: number;
  dailyDrawdownPct?: number;
  dailyGuardHit?: boolean;
  consecutiveLossesToday?: number;
  autoLotInfo?: AutoLotTierInfo;
  feedInfo?: ProxyFeedStatusInfo;
  lastAiApproval?: AiTradeApproval | null;
  pendingAiApproval?: boolean;
}

export type SubscriptionPlan = 'weekly' | 'monthly' | 'quarterly';
export type UserStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'BLOCKED';

export interface PlanPricing {
  weekly: { label: string; kwacha: number; usd: number; days: number };
  monthly: { label: string; kwacha: number; usd: number; days: number };
  quarterly: { label: string; kwacha: number; usd: number; days: number };
}

export interface MoMoConfig {
  airtelNumber: string;
  mtnNumber: string;
  recipientName: string;
  whatsappRenewNumber: string;
}

export interface PublicBusinessConfig {
  momo: MoMoConfig;
  plans: PlanPricing;
}

export interface BrokerAccountSetup {
  platformMt5: boolean;
  accountStandard: boolean;
  currencyUsd: boolean;
  leverageValid: boolean;
  hasWrongMt4OrCtrader: boolean;
  hasWrongCentOrEcn: boolean;
  hasWrongZmwOrEur: boolean;
  selectedBrokerPreset?: BrokerPreset;
  accountVariant?: BrokerAccountVariant;
  confirmedAt?: string | null;
}

export interface UserPublicProfile {
  id: string;
  fullName: string;
  phone: string;
  brokerName: string;
  brokerServer: string;
  mt5Login: string;
  brokerApiKeyLast4: string;
  hasBrokerApiKey: boolean;
  brokerBridgeUrl: string;
  brokerConnected: boolean;
  brokerSetup: BrokerAccountSetup;
  brokerSetupComplete: boolean;
  brokerSetupWrongAccount: boolean;
  accountType: 'Demo' | 'Live';
  status: UserStatus;
  plan: SubscriptionPlan;
  planLabel: string;
  amountLabel: string;
  paymentMethod: 'Airtel MoMo' | 'MTN MoMo';
  transactionId: string;
  hasScreenshot: boolean;
  submittedAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  daysLeft: number;
  feedAccess: boolean;
  autoTradeEnabled: boolean;
  balance: number;
  equity: number;
  lastBalanceSyncAt?: string | null;
  balanceSyncSource?: 'TICKERALL_MT5' | 'BROKER_BRIDGE' | 'TRADE_PNL' | 'MANUAL' | null;
  firebaseLinked?: boolean;
  firebaseEmail?: string | null;
  createdAt: string;
}

export interface UserSyncBundle {
  appUserId: string;
  ownerId: string;
  fullName: string;
  phone: string;
  normalizedPhone: string;
  email: string;
  passwordHash: string;
  brokerName: string;
  brokerServer: string;
  mt5Login: string;
  brokerApiKeyLast4: string;
  hasBrokerApiKey: boolean;
  brokerBridgeUrl: string;
  brokerConnected: boolean;
  brokerSetup: BrokerAccountSetup;
  accountType: 'Demo' | 'Live';
  status: UserStatus;
  plan: SubscriptionPlan;
  amountKwacha: number;
  amountUsd: number;
  paymentMethod: 'Airtel MoMo' | 'MTN MoMo';
  transactionId: string;
  hasScreenshot: boolean;
  submittedAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  feedAccess: boolean;
  autoTradeEnabled: boolean;
  balance: number;
  equity: number;
  lastBalanceSyncAt?: string | null;
  balanceSyncSource?: 'TICKERALL_MT5' | 'BROKER_BRIDGE' | 'TRADE_PNL' | 'MANUAL' | null;
  settings: StrategySettings;
  levels: DaySessionLevels;
  trades: TradeLogEntry[];
  createdAt: string;
  firestoreUpdatedAt?: string | null;
}

export interface AdminUserRow extends UserPublicProfile {
  screenshotDataUrl: string | null;
  totalTrades: number;
  openTradesCount: number;
}

export interface AdminDashboardData {
  totals: {
    totalUsers: number;
    totalActiveUsers: number;
    pendingUsers: number;
    totalCollectedMonthKwacha: number;
    totalCollectedMonthUsd: number;
    expiringThisWeek: number;
    tickerAllStatus: 'LIVE' | 'OFFLINE' | 'CONNECTING';
    tickerAllQuotaUsed: number;
    activeFeedUsers: number;
  };
  tickerAllConfig: {
    hasMasterKey: boolean;
    masterKeyLast4: string;
    baseUrl: string;
    brokerServer: string;
    mt5AccountNumber: string;
    hasMasterPassword: boolean;
    desiredConnected: boolean;
    latestGoldPrice: number | null;
    lastTickAt: string | null;
    lastError: string | null;
  };
  spreadPolicy?: AdminSpreadPolicy;
  liveSpreadEvaluation?: DynamicSpreadEvaluation | null;
  momo: MoMoConfig;
  plans: PlanPricing;
  users: AdminUserRow[];
}

export interface MasterConfigSyncBundle {
  baseUrl: string;
  brokerServer: string;
  mt5AccountNumber: string;
  apiKeyLast4: string;
  hasMasterKey: boolean;
  hasMasterPassword: boolean;
  apiKeyEnc: string;
  passwordEnc: string;
  quotaUsed: number;
  desiredConnected: boolean;
}




