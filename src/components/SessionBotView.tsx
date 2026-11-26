import { useEffect, useState } from 'react';
import {
  Clock,
  TrendingUp,
  TrendingDown,
  PauseCircle,
  CheckCircle2,
  XCircle,
  SlidersHorizontal,
  ShieldAlert,
  ArrowUpRight,
  ArrowDownRight,
  PlusCircle,
  CandlestickChart,
  Lock,
  Power,
  Bot,
  RefreshCw,
  Play,
  Pause,
  Square,
  OctagonAlert,
  Layers,
  Activity,
  Radio,
  ArrowRight,
} from 'lucide-react';
import type {
  AiTradeApproval,
  ConnectionSnapshot,
  SignalSourceMode,
  StrategySettings,
  TimeframeIndicatorSnapshot,
  TradeLogEntry,
  TradingMode,
  UserPublicProfile,
} from '../types/connectivity';
import { LivePriceChart } from './LivePriceChart';
import { M15StrategyChart } from './M15StrategyChart';
import { BacktestPanel } from './BacktestPanel';
import { getLusakaClock } from '../utils/strategyEngine';
import { mergeEmaProConfig } from '../utils/emaStochasticPro';
import { roundToDigits } from '../utils/dynamicSpread';

interface BotControlPayload {
  action:
    | 'START'
    | 'PAUSE'
    | 'STOP'
    | 'EMERGENCY_STOP'
    | 'CLOSE_ALL'
    | 'SET_MODE'
    | 'SET_DIRECTIONS';
  tradingMode?: TradingMode;
  allowBuy?: boolean;
  allowSell?: boolean;
  confirm?: boolean;
}

interface SessionBotViewProps {
  snapshot: ConnectionSnapshot;
  user?: UserPublicProfile | null;
  nowMs?: number;
  lastUpdatedMs?: number | null;
  feedPausedReconnecting?: boolean;
  isProbing: boolean;
  onRunProbe: () => void;
  onLogTrade: (
    entry: Partial<TradeLogEntry>
  ) => Promise<{ ok: boolean; error?: string; approval?: AiTradeApproval }>;
  onRunAiApprover?: () => Promise<{
    ok: boolean;
    error?: string;
    approval?: AiTradeApproval;
  }>;
  onSaveSettings: (
    settings: StrategySettings
  ) => Promise<{ ok: boolean; error?: string } | void>;
  onToggleAutoTrade?: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  onSyncBrokerBalance?: () => Promise<{ ok: boolean; message?: string; error?: string }>;
  onBotControl?: (
    payload: BotControlPayload
  ) => Promise<{ ok: boolean; message?: string; error?: string }>;
  onSwitchSignalSource?: (
    source: SignalSourceMode
  ) => Promise<{ ok: boolean; error?: string }>;
  onNavigateTab: (
    tab: 'bot' | 'trades' | 'telegram' | 'settings' | 'connections' | 'gate'
  ) => void;
}

export function SessionBotView({
  snapshot,
  user,
  nowMs: propNowMs,
  lastUpdatedMs = null,
  feedPausedReconnecting = false,
  isProbing,
  onRunProbe,
  onLogTrade,
  onRunAiApprover,
  onToggleAutoTrade,
  onSyncBrokerBalance,
  onBotControl,
  onSwitchSignalSource,
  onNavigateTab,
}: SessionBotViewProps) {
  const [autoToggleBusy, setAutoToggleBusy] = useState(false);
  const [autoToggleError, setAutoToggleError] = useState<string | null>(null);
  const [aiCheckBusy, setAiCheckBusy] = useState(false);
  const [syncBalanceBusy, setSyncBalanceBusy] = useState(false);
  const [tradeActionBusy, setTradeActionBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [candleTableTf, setCandleTableTf] = useState<'M5' | 'M15'>('M5');
  const [tradeActionNotice, setTradeActionNotice] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [localNowMs, setLocalNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (propNowMs !== undefined) return;
    const t = window.setInterval(() => setLocalNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [propNowMs]);

  const effectiveNowMs = propNowMs ?? localNowMs;
  const liveClock = getLusakaClock(effectiveNowMs);
  const lastUpdatedClock = getLusakaClock(lastUpdatedMs ?? effectiveNowMs);
  const secondsSinceUpdate =
    lastUpdatedMs !== null ? Math.max(0, Math.floor((effectiveNowMs - lastUpdatedMs) / 1000)) : 0;

  const bot = snapshot.bot;
  const activeTick = feedPausedReconnecting
    ? null
    : snapshot.latestTick ?? snapshot.fallbackTick;
  const livePrice = activeTick?.last ?? null;
  const balance = user?.balance ?? snapshot.accountInfo.balance ?? 138.76;
  const equity = user?.equity ?? snapshot.accountInfo.equity ?? balance;
  const freeMargin = snapshot.accountInfo.freeMargin;

  if (!bot) {
    return (
      <div className="border border-white/8 bg-[#111722] rounded-lg p-6 text-sm text-slate-300">
        Initializing GOLD AI TRADER Bot state...
      </div>
    );
  }

  const {
    settings,
    levels,
    activeSignal,
    currentCandle,
    currentM5Candle = null,
    closedCandles,
    closedM5Candles = [],
    emaPro = null,
    newsStatus,
    isWeekend,
    m15HistoryCount,
    m5HistoryCount = closedM5Candles.length,
    dailyPnlDollars = 0,
    dailyPnlPct = 0,
    dailyDrawdownPct = 0,
    dailyGuardHit = false,
    consecutiveLossesToday = levels.consecutiveLossesToday ?? 0,
    autoLotInfo,
    feedInfo,
    brokerFeedLabel = 'MT5 / TickerAll',
    lastAiApproval = null,
    pendingAiApproval = false,
    spreadEvaluation = emaPro?.spreadEvaluation ?? null,
    spreadRejectedCount = 0,
    acceptedAbove45Count = 0,
    symbolSpec = emaPro?.symbolSpec ?? null,
    latestQuote = null,
  } = bot;

  const strategyModule = 'EMA_STOCHASTIC_PRO' as const;
  const emaCfg = mergeEmaProConfig(settings.emaPro);
  const aiApproverEnabled = settings.aiApproverEnabled !== false;
  const openPositions = bot.tradeLog.filter((t) => t.status === 'OPEN');
  const priceDigits = symbolSpec?.digits ?? activeTick?.digits ?? 2;
  const pointSize = symbolSpec?.pointSize ?? activeTick?.pointSize ?? (priceDigits === 3 ? 0.001 : 0.01);
  const liveBid = latestQuote?.bid ?? (activeTick?.hasTwoSidedQuote !== false ? activeTick?.bid ?? null : null);
  const liveAsk = latestQuote?.ask ?? (activeTick?.hasTwoSidedQuote !== false ? activeTick?.ask ?? null : null);
  const quoteDataAvailable = Boolean(
    !feedPausedReconnecting &&
      spreadEvaluation?.dataAvailable &&
      spreadEvaluation?.hasTwoSidedQuote &&
      liveBid !== null &&
      liveAsk !== null
  );

  const slDollars = Math.round((settings.slPips || 15) * 0.1 * 100) / 100;

  const signalBorderClass =
    activeSignal.action === 'BUY'
      ? 'border-emerald-500/40 bg-emerald-950/20'
      : activeSignal.action === 'SELL'
        ? 'border-red-500/40 bg-red-950/20'
        : 'border-white/10 bg-[#111722]';

  const brokerConnected = Boolean(user?.brokerConnected);
  const brokerSetupComplete = Boolean(user?.brokerSetupComplete);
  const brokerSetupWrong = Boolean(user?.brokerSetupWrongAccount);
  const canEnableAuto = Boolean(
    brokerConnected && brokerSetupComplete && !brokerSetupWrong
  );
  const autoTradeEnabled = Boolean(
    user?.autoTradeEnabled && canEnableAuto && !isWeekend
  );

  const checkGoldBias = isWeekend
    ? 'NO TRADE'
    : activeSignal.action === 'BUY'
      ? 'LONG'
      : activeSignal.action === 'SELL'
        ? 'SHORT'
        : 'NO TRADE';

  const checkGoldReason = isWeekend
    ? 'Weekend market closed — EMA STOCHASTIC PRO trades Monday to Friday only.'
    : activeSignal.reason;

  const tgState = bot.telegram;
  const activeSignalSource: SignalSourceMode = tgState?.signalSource ?? 'BOTH';
  const tgStatusLabel =
    tgState?.status === 'LISTENING'
      ? 'Listening'
      : tgState?.status === 'CONNECTED'
        ? 'Connected'
        : 'Disconnected';

  const triggerSwitchSignalSource = async (nextSource: SignalSourceMode) => {
    if (!onSwitchSignalSource || sourceBusy) return;
    setSourceBusy(true);
    setTradeActionNotice(null);
    try {
      const res = await onSwitchSignalSource(nextSource);
      if (!res.ok) {
        setTradeActionNotice({
          ok: false,
          text: res.error || 'Failed to switch signal source.',
        });
      } else {
        const label =
          nextSource === 'TELEGRAM'
            ? 'Telegram Signals Only (Built-in EMA auto-entries paused)'
            : nextSource === 'STRATEGY'
              ? 'Built-in EMA Strategy Only'
              : 'Both Built-in EMA Strategy + Telegram Signals';
        setTradeActionNotice({ ok: true, text: `Signal source switched to ${label}.` });
      }
    } finally {
      setSourceBusy(false);
    }
  };

  const triggerBotControl = async (payload: BotControlPayload) => {
    if (!onBotControl || controlBusy) return;
    setControlBusy(true);
    setTradeActionNotice(null);
    try {
      const res = await onBotControl(payload);
      if (payload.action === 'CLOSE_ALL') {
        setConfirmCloseAll(false);
      }
      if (!res.ok && res.error) {
        setTradeActionNotice({ ok: false, text: res.error });
      } else if (res.message) {
        setTradeActionNotice({ ok: true, text: res.message });
      }
    } finally {
      setControlBusy(false);
    }
  };

  const handleLogActiveSignal = async () => {
    if (isWeekend || tradeActionBusy) return;
    if (activeSignal.action === 'WAIT' || activeSignal.entry === null) return;
    setTradeActionNotice(null);
    setTradeActionBusy(true);
    try {
      const tp2Val = activeSignal.tp2 ?? activeSignal.target ?? activeSignal.entry;
      const tp1Val =
        activeSignal.tp1 ?? Math.round(((activeSignal.entry + tp2Val) / 2) * 100) / 100;
      const result = await onLogTrade({
        signalId: activeSignal.id,
        strategyModule,
        marketCondition: emaPro?.marketCondition ?? undefined,
        session: activeSignal.strategy,
        symbol: activeSignal.symbol,
        side: activeSignal.action,
        entry: activeSignal.entry,
        stop: activeSignal.stop ?? activeSignal.entry,
        tp1: tp1Val,
        tp2: tp2Val,
        tp3: activeSignal.tp3 ?? undefined,
        target: activeSignal.tp3 ?? tp2Val,
        rrRatio: activeSignal.rrRatio,
        lots: autoLotInfo?.effectiveLot ?? activeSignal.suggestedLots,
        riskDollars: activeSignal.riskDollars,
        status: 'OPEN',
        executionMode: 'MANUAL',
        notes: activeSignal.reason,
        setupStatus: activeSignal.setupLabel ?? activeSignal.emaSummary ?? 'EMA STOCHASTIC PRO',
      });
      if (!result.ok) {
        setTradeActionNotice({
          ok: false,
          text: result.error || 'Trade blocked by Gemini AI Approver.',
        });
      } else {
        setTradeActionNotice({
          ok: true,
          text: result.approval
            ? `Gemini AI Approved (${result.approval.confidencePct}%) · ${activeSignal.action} logged.`
            : `${activeSignal.action} trade logged.`,
        });
      }
    } finally {
      setTradeActionBusy(false);
    }
  };

  const handleQuickManualOrder = async (side: 'BUY' | 'SELL') => {
    if (isWeekend || !quoteDataAvailable || tradeActionBusy) return;
    const sideEntryRaw = side === 'BUY' ? liveAsk : liveBid;
    if (sideEntryRaw === null || !Number.isFinite(sideEntryRaw) || sideEntryRaw <= 0) return;
    setTradeActionNotice(null);
    setTradeActionBusy(true);
    try {
      const entry = roundToDigits(sideEntryRaw, priceDigits);
      const atrDist = emaPro?.m5?.atr
        ? Math.max(0.8, roundToDigits(emaPro.m5.atr * emaCfg.atrSlMultiplier, priceDigits))
        : slDollars;
      const stopDist = atrDist;
      const stop = roundToDigits(side === 'BUY' ? entry - stopDist : entry + stopDist, priceDigits);

      const tp1 = roundToDigits(
        side === 'BUY' ? entry + stopDist * emaCfg.tp1Rr : entry - stopDist * emaCfg.tp1Rr,
        priceDigits
      );
      const tp2 = roundToDigits(
        side === 'BUY' ? entry + stopDist * emaCfg.tp2Rr : entry - stopDist * emaCfg.tp2Rr,
        priceDigits
      );
      const tp3 = roundToDigits(
        side === 'BUY' ? entry + stopDist * emaCfg.tp3Rr : entry - stopDist * emaCfg.tp3Rr,
        priceDigits
      );

      const rrRatio = Math.round((Math.abs(tp3 - entry) / Math.max(0.1, stopDist)) * 100) / 100;
      const lotsToUse = autoLotInfo?.effectiveLot ?? settings.defaultLotSize;
      const activeSessionTag =
        bot.phase === 'ASIAN_SESSION' ||
        bot.phase === 'LONDON_SESSION' ||
        bot.phase === 'NEW_YORK_SESSION' ||
        bot.phase === 'ALL_SESSIONS'
          ? bot.phase
          : 'ALL_SESSIONS';
      const result = await onLogTrade({
        strategyModule,
        marketCondition: emaPro?.marketCondition ?? undefined,
        session: activeSessionTag,
        symbol: symbolSpec?.symbol || snapshot.config.symbol || emaCfg.xauusdSymbol || 'XAUUSD',
        side,
        entry,
        stop,
        tp1,
        tp2,
        tp3,
        target: tp3,
        rrRatio,
        lots: lotsToUse,
        riskDollars: Math.round(stopDist * lotsToUse * (symbolSpec?.contractSize ?? 100) * 100) / 100,
        status: 'OPEN',
        executionMode: 'MANUAL',
        notes: `Manual EMA STOCHASTIC PRO ${side} @ ${side === 'BUY' ? 'Ask' : 'Bid'} $${entry.toFixed(priceDigits)}`,
        setupStatus: `EMA ${emaPro?.overallTrend ?? 'PRO'}`,
      });
      if (!result.ok) {
        setTradeActionNotice({
          ok: false,
          text: result.error || `Manual ${side} blocked by pre-trade or Gemini AI validation.`,
        });
      } else {
        setTradeActionNotice({
          ok: true,
          text: result.approval
            ? `Gemini AI Approved (${result.approval.confidencePct}%) · ${side} logged @ $${entry.toFixed(priceDigits)}.`
            : `Manual ${side} executed @ $${entry.toFixed(priceDigits)}.`,
        });
      }
    } finally {
      setTradeActionBusy(false);
    }
  };

  const handleAskGeminiApprover = async () => {
    if (!onRunAiApprover || aiCheckBusy) return;
    setTradeActionNotice(null);
    setAiCheckBusy(true);
    try {
      const res = await onRunAiApprover();
      if (!res.ok) {
        setTradeActionNotice({
          ok: false,
          text: res.error || 'Gemini AI Approver failed to reach model.',
        });
      } else if (res.approval) {
        setTradeActionNotice({
          ok: res.approval.approved,
          text: `Gemini (${res.approval.status} · ${res.approval.confidencePct}%): ${res.approval.summary}`,
        });
      }
    } finally {
      setAiCheckBusy(false);
    }
  };

  const handleAutoTradeSwitch = async () => {
    if (isWeekend) return;
    if (brokerSetupWrong) {
      setAutoToggleError(
        'Unsupported Platform or Currency - Use an MT5 USD or USC Cent account'
      );
      return;
    }
    if (!brokerSetupComplete) {
      setAutoToggleError('Complete Broker Setup First: MT5 Platform + Account Variant + USD/USC + Leverage ≥ 1:200');
      return;
    }
    if (!brokerConnected) {
      setAutoToggleError('Connect Broker to enable Auto');
      return;
    }
    if (!onToggleAutoTrade) return;
    setAutoToggleError(null);
    setAutoToggleBusy(true);
    try {
      const res = await onToggleAutoTrade(!autoTradeEnabled);
      if (!res.ok && res.error) {
        setAutoToggleError(res.error);
      }
    } finally {
      setAutoToggleBusy(false);
    }
  };

  const activeCandleTf = candleTableTf;
  const activeClosedCandles = activeCandleTf === 'M5' ? closedM5Candles : closedCandles;
  const activeCurrentCandle = activeCandleTf === 'M5' ? currentM5Candle : currentCandle;
  const candleList = [
    ...(activeCurrentCandle ? [activeCurrentCandle] : []),
    ...activeClosedCandles.slice(0, 11),
  ];
  const historyBarsCount = Math.max(m5HistoryCount, m15HistoryCount ?? closedCandles.length);

  const todaysTrades = bot.tradeLog.filter((t) => t.dateLusaka === bot.lusakaDate);
  const todaysClosedTrades = todaysTrades.filter(
    (t) => t.status === 'TP_HIT' || t.status === 'SL_HIT' || t.status === 'CLOSED'
  );
  const todaysWins = todaysClosedTrades.filter((t) => (t.pnlDollars ?? 0) > 0).length;
  const todaysLosses = todaysClosedTrades.filter((t) => (t.pnlDollars ?? 0) < 0).length;
  const todaysOpenCount = todaysTrades.filter(
    (t) => t.status === 'OPEN' || t.status === 'SIGNALED'
  ).length;
  const todaysWinRate =
    todaysClosedTrades.length > 0
      ? Math.round((todaysWins / todaysClosedTrades.length) * 100)
      : null;

  const allClosedTrades = bot.tradeLog.filter(
    (t) => t.status === 'TP_HIT' || t.status === 'SL_HIT' || t.status === 'CLOSED'
  );
  const allWins = allClosedTrades.filter((t) => (t.pnlDollars ?? 0) > 0).length;
  const overallWinRate =
    allClosedTrades.length > 0 ? Math.round((allWins / allClosedTrades.length) * 100) : null;
  const overallNetPnl = bot.tradeLog.reduce((sum, t) => sum + (t.pnlDollars ?? 0), 0);

  // Setups Identified calculation (EMA STOCHASTIC PRO setups keyed by M5 bar timestamp)
  const setupMap = new Map<string, { confirmed: boolean; blocked: boolean; isToday: boolean }>();
  for (const sig of bot.signalHistory ?? []) {
    if (sig.id.startsWith('hist-aimblk-')) continue;
    const match = sig.id.match(/emapro-(\d+)|hist-(?:sig|aiblk|execblk)-emapro-(\d+)/);
    const barTs = match ? match[1] || match[2] : null;
    const key = barTs ? `emapro-${barTs}` : sig.id;
    const parsedTs = Date.parse(sig.timestamp);
    const sigDate = Number.isFinite(parsedTs)
      ? getLusakaClock(parsedTs).dateLusaka
      : bot.lusakaDate;
    const isToday = sigDate === bot.lusakaDate;
    const isConfirmed = sig.action === 'BUY' || sig.action === 'SELL';
    const existing = setupMap.get(key) ?? { confirmed: false, blocked: false, isToday: false };
    setupMap.set(key, {
      confirmed: existing.confirmed || isConfirmed,
      blocked: existing.blocked || (!isConfirmed && sig.action === 'BLOCKED'),
      isToday: existing.isToday || isToday,
    });
  }
  if ((activeSignal.action === 'BUY' || activeSignal.action === 'SELL') && closedM5Candles[0]) {
    const liveKey = `emapro-${closedM5Candles[0].openTimeMs}`;
    const existing = setupMap.get(liveKey) ?? { confirmed: false, blocked: false, isToday: true };
    setupMap.set(liveKey, {
      confirmed: true,
      blocked: existing.blocked,
      isToday: true,
    });
  }
  const setupsTotal = setupMap.size;
  let setupsToday = 0;
  let confirmedCount = 0;
  let blockedCount = 0;
  for (const item of setupMap.values()) {
    if (item.isToday) setupsToday += 1;
    if (item.confirmed) confirmedCount += 1;
    else if (item.blocked) blockedCount += 1;
  }

  const tfRows: Array<TimeframeIndicatorSnapshot | null> = emaPro
    ? [emaPro.h1, emaPro.m15, emaPro.m5, ...(emaCfg.m1RefinementEnabled ? [emaPro.m1] : [])]
    : [];

  return (
    <div className="space-y-6">
      {/* Live Auto-Refresh Telemetry Banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-md border border-white/8 bg-[#0E131D] text-xs font-mono tabular-nums">
        <div className="flex items-center gap-2 text-slate-200">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              feedPausedReconnecting ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
            }`}
          />
          <span>
            Last Updated: {lastUpdatedClock.timeLusaka} - Auto-refresh every 3s ({secondsSinceUpdate}s)
          </span>
        </div>
        <span className={feedPausedReconnecting ? 'text-amber-300 font-semibold' : 'text-slate-400'}>
          {feedPausedReconnecting
            ? 'Feed Paused - Reconnecting...'
            : `EMA STOCHASTIC PRO · ${brokerFeedLabel} Sync · ${emaCfg.xauusdSymbol}`}
        </span>
      </div>

      {/* Trading Mode & Execution Control Bar */}
      <section
        aria-label="Trading Mode and Control Bar"
        className="border border-white/10 bg-[#111722] rounded-lg p-4 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2.5 py-1 rounded border border-[#D4A853]/40 bg-[#D4A853]/12 font-mono font-bold text-[#E5B85C]">
              EMA STOCHASTIC PRO
            </span>
            <span
              className={`px-2 py-1 rounded border font-mono font-semibold ${
                emaCfg.demoOnlyMode && !emaCfg.liveTradingAuthorized
                  ? 'border-sky-500/35 bg-sky-500/10 text-sky-300'
                  : 'border-amber-500/40 bg-amber-500/15 text-amber-200'
              }`}
            >
              {emaCfg.demoOnlyMode && !emaCfg.liveTradingAuthorized
                ? 'Demo Paper Only (Safe Lock)'
                : 'Live Execution Authorized'}
            </span>
            <span
              className={`px-2 py-1 rounded border font-mono font-semibold ${
                emaCfg.tradingRunState === 'RUNNING'
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                  : emaCfg.tradingRunState === 'PAUSED'
                    ? 'border-amber-500/35 bg-amber-500/10 text-amber-300'
                    : 'border-red-500/40 bg-red-950/30 text-red-300'
              }`}
            >
              State: {emaCfg.tradingRunState}
            </span>
          </div>

          {/* Selectable Modes: SIGNALS_ONLY / AUTOMATIC_TRADING / BOTH */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'SIGNALS_ONLY', label: 'Signals Only' },
                { id: 'AUTOMATIC_TRADING', label: 'Automatic Trading' },
                { id: 'BOTH', label: 'Both' },
              ] as Array<{ id: TradingMode; label: string }>
            ).map((modeOpt) => {
              const active = emaCfg.tradingMode === modeOpt.id;
              return (
                <button
                  key={modeOpt.id}
                  type="button"
                  disabled={!onBotControl || controlBusy}
                  onClick={() =>
                    void triggerBotControl({ action: 'SET_MODE', tradingMode: modeOpt.id })
                  }
                  className={`px-2.5 py-1 rounded border text-[11px] font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? 'border-[#D4A853] bg-[#D4A853]/20 text-[#E5B85C]'
                      : 'border-white/12 bg-[#0B0F17] text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {modeOpt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-white/8">
          {/* Control Actions: Start, Pause, Stop, Emergency Stop */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={!onBotControl || controlBusy || emaCfg.tradingRunState === 'RUNNING'}
              onClick={() => void triggerBotControl({ action: 'START' })}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-emerald-500/35 bg-emerald-500/12 text-emerald-200 text-[11px] font-semibold hover:bg-emerald-500/20 disabled:opacity-40"
            >
              <Play className="w-3 h-3" />
              Start
            </button>
            <button
              type="button"
              disabled={!onBotControl || controlBusy || emaCfg.tradingRunState === 'PAUSED'}
              onClick={() => void triggerBotControl({ action: 'PAUSE' })}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-amber-500/35 bg-amber-500/12 text-amber-200 text-[11px] font-semibold hover:bg-amber-500/20 disabled:opacity-40"
            >
              <Pause className="w-3 h-3" />
              Pause
            </button>
            <button
              type="button"
              disabled={!onBotControl || controlBusy || emaCfg.tradingRunState === 'STOPPED'}
              onClick={() => void triggerBotControl({ action: 'STOP' })}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-white/15 bg-[#0B0F17] text-slate-200 text-[11px] font-semibold hover:bg-white/10 disabled:opacity-40"
            >
              <Square className="w-3 h-3" />
              Stop
            </button>
            <button
              type="button"
              disabled={!onBotControl || controlBusy}
              onClick={() => void triggerBotControl({ action: 'EMERGENCY_STOP' })}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-red-500/45 bg-red-950/35 text-red-200 text-[11px] font-semibold hover:bg-red-900/40 disabled:opacity-40"
            >
              <OctagonAlert className="w-3 h-3" />
              Emergency Stop
            </button>
          </div>

          {/* Direction Toggles + Close All Positions (with inline confirmation) */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!onBotControl || controlBusy}
              onClick={() =>
                void triggerBotControl({
                  action: 'SET_DIRECTIONS',
                  allowBuy: !emaCfg.allowBuy,
                })
              }
              className={`px-2.5 py-1.5 rounded border text-[11px] font-mono font-semibold transition-colors ${
                emaCfg.allowBuy
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : 'border-white/10 bg-[#0B0F17] text-slate-500'
              }`}
            >
              BUY {emaCfg.allowBuy ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              disabled={!onBotControl || controlBusy}
              onClick={() =>
                void triggerBotControl({
                  action: 'SET_DIRECTIONS',
                  allowSell: !emaCfg.allowSell,
                })
              }
              className={`px-2.5 py-1.5 rounded border text-[11px] font-mono font-semibold transition-colors ${
                emaCfg.allowSell
                  ? 'border-red-500/40 bg-red-500/15 text-red-300'
                  : 'border-white/10 bg-[#0B0F17] text-slate-500'
              }`}
            >
              SELL {emaCfg.allowSell ? 'ON' : 'OFF'}
            </button>

            {confirmCloseAll ? (
              <div className="inline-flex items-center gap-1.5 bg-red-950/50 border border-red-500/50 rounded px-2 py-1">
                <span className="text-[11px] text-red-200 font-semibold">
                  Close {openPositions.length} open?
                </span>
                <button
                  type="button"
                  disabled={controlBusy}
                  onClick={() =>
                    void triggerBotControl({ action: 'CLOSE_ALL', confirm: true })
                  }
                  className="px-2 py-0.5 rounded bg-red-500 text-white text-[11px] font-bold hover:bg-red-400"
                >
                  Confirm Close All
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCloseAll(false)}
                  className="px-2 py-0.5 rounded border border-white/15 text-[11px] text-slate-300 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!onBotControl || controlBusy || openPositions.length === 0}
                onClick={() => setConfirmCloseAll(true)}
                className="px-2.5 py-1.5 rounded border border-red-500/35 bg-red-950/25 text-red-300 text-[11px] font-semibold hover:bg-red-950/45 disabled:opacity-35"
              >
                Close All Positions ({openPositions.length})
              </button>
            )}
          </div>
        </div>

        {/* Signal Source Switcher: Built-in Strategy vs Telegram Channel Signals */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-white/8 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-slate-400 whitespace-nowrap">
              Signal Source:
            </span>
            <div className="inline-flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'STRATEGY', label: 'Built-in EMA' },
                  { id: 'TELEGRAM', label: 'Telegram Only' },
                  { id: 'BOTH', label: 'Both' },
                ] as Array<{ id: SignalSourceMode; label: string }>
              ).map((opt) => {
                const active = activeSignalSource === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={!onSwitchSignalSource || sourceBusy}
                    onClick={() => void triggerSwitchSignalSource(opt.id)}
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors disabled:opacity-50 ${
                      active
                        ? 'border-[#D4A853] bg-[#D4A853]/20 text-[#E5B85C]'
                        : 'border-white/12 bg-[#0B0F17] text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              Telegram: {tgStatusLabel}
              {tgState?.resolvedChannelTitle ? ` · ${tgState.resolvedChannelTitle}` : ''}
            </span>
          </div>

          <button
            type="button"
            onClick={() => onNavigateTab('telegram')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-sky-500/40 bg-sky-500/12 text-sky-200 text-[11px] font-semibold hover:bg-sky-500/20 whitespace-nowrap shrink-0 transition-colors"
          >
            <Radio className="w-3.5 h-3.5" />
            <span>
              {tgState?.status === 'LISTENING'
                ? 'Telegram Signals (Live)'
                : 'Switch / Setup Telegram'}
            </span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        {activeSignalSource === 'TELEGRAM' && tgState?.status !== 'LISTENING' && (
          <div className="pt-2 border-t border-white/8 flex flex-wrap items-center justify-between gap-2 text-[11px] text-amber-200">
            <span>
              Telegram Only is active, so built-in EMA auto-entries are paused. Connect and start listening on your Telegram channel to receive live trades.
            </span>
            <button
              type="button"
              onClick={() => onNavigateTab('telegram')}
              className="underline font-semibold text-[#E5B85C] hover:text-white whitespace-nowrap shrink-0"
            >
              Open Telegram Setup
            </button>
          </div>
        )}
      </section>

      {feedPausedReconnecting && !isWeekend ? (
        <div
          role="alert"
          className="border border-amber-500/45 bg-amber-950/30 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
        >
          <div className="flex items-center gap-2 text-amber-200 font-semibold">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            Feed Paused - Reconnecting...
          </div>
          <span className="font-mono text-amber-300/90">
            Auto-retrying Master Feed every 3s (frozen prices cleared)
          </span>
        </div>
      ) : feedInfo && !feedInfo.isLive && !isWeekend ? (
        <div className="border border-red-500/40 bg-red-950/25 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-red-200 font-semibold">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            {feedInfo.status === 'OFFLINE'
              ? 'Feed Offline - Contact Admin'
              : feedInfo.message}
          </div>
          <span className="font-mono text-red-300/80">
            Proxy Stream: {feedInfo.label}
          </span>
        </div>
      ) : null}

      {/* Top Lusaka Session & Market Telemetry Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="uppercase tracking-wider font-medium">Lusaka Time (CAT)</span>
            <Clock className="w-3.5 h-3.5 text-[#D4A853]" />
          </div>
          <div className="mt-2 font-mono tabular-nums text-2xl font-bold text-slate-50">
            {liveClock.timeLusaka}
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="font-mono text-slate-400">{liveClock.dateLusaka}</span>
            <span
              className={`px-1.5 py-0.5 rounded border font-medium ${
                isWeekend
                  ? 'border-red-500/35 bg-red-950/30 text-red-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              {isWeekend ? 'MARKET CLOSED' : `${bot.phaseLabel} · ALL-SESSION`}
            </span>
          </div>
        </div>

        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="uppercase tracking-wider font-medium">
              {symbolSpec?.symbol || emaCfg.xauusdSymbol} · {brokerFeedLabel}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded border text-[11px] font-medium ${
                feedPausedReconnecting || !quoteDataAvailable
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
                  : feedInfo?.isLive
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              }`}
            >
              {feedPausedReconnecting
                ? 'Feed Paused'
                : !quoteDataAvailable && !isWeekend
                  ? 'DATA UNAVAILABLE'
                  : feedInfo?.label ?? (snapshot.sessionInfo.tickConfirmed ? 'Feed: Live' : 'Feed Offline')}
            </span>
          </div>
          <div className="mt-2 font-mono tabular-nums text-2xl font-bold text-[#E5B85C]">
            {feedPausedReconnecting
              ? 'Reconnecting...'
              : livePrice !== null
                ? `$${livePrice.toFixed(priceDigits)}`
                : 'DATA UNAVAILABLE'}
          </div>
          <div className="mt-1 flex items-center justify-between text-xs font-mono tabular-nums text-slate-400">
            <span>Bid {liveBid !== null ? `$${liveBid.toFixed(priceDigits)}` : 'N/A'}</span>
            <span>Ask {liveAsk !== null ? `$${liveAsk.toFixed(priceDigits)}` : 'N/A'}</span>
          </div>
        </div>

        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="uppercase tracking-wider font-medium">
              Account &amp; {settings.riskPercent.toFixed(1)}% Risk Lot
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {onSyncBrokerBalance && brokerConnected && (
                <button
                  type="button"
                  disabled={syncBalanceBusy}
                  onClick={async () => {
                    setSyncBalanceBusy(true);
                    try {
                      const res = await onSyncBrokerBalance();
                      if (res.message || res.error) {
                        setTradeActionNotice({
                          ok: res.ok,
                          text: res.message || res.error || '',
                        });
                      }
                    } finally {
                      setSyncBalanceBusy(false);
                    }
                  }}
                  title="Sync live broker account balance & floating equity"
                  className="inline-flex items-center gap-1 text-[11px] text-emerald-300 hover:underline disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${syncBalanceBusy ? 'animate-spin' : ''}`} />
                  {syncBalanceBusy ? 'Syncing' : 'Sync'}
                </button>
              )}
              <button
                type="button"
                onClick={() => onNavigateTab('connections')}
                className="text-[11px] text-[#E5B85C] hover:underline whitespace-nowrap shrink-0"
              >
                {brokerConnected ? user?.brokerName : 'Connect Broker'}
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-baseline justify-between font-mono tabular-nums">
            <span className="text-2xl font-bold text-slate-50">${balance.toFixed(2)}</span>
            <span className="text-sm font-bold text-[#E5B85C]">
              Lot {(autoLotInfo?.effectiveLot ?? settings.defaultLotSize).toFixed(2)}
            </span>
          </div>
          <div className="mt-2 space-y-1">
            {autoLotInfo && (
              <div className="w-full h-1.5 rounded bg-[#0B0F17] overflow-hidden border border-white/10">
                <div
                  className="h-full bg-[#D4A853]"
                  style={{ width: `${Math.min(100, Math.max(4, autoLotInfo.progressPct))}%` }}
                />
              </div>
            )}
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
              <span
                className={
                  equity > balance + 0.005
                    ? 'text-emerald-300'
                    : equity < balance - 0.005
                      ? 'text-red-300'
                      : 'text-slate-300'
                }
              >
                Eq ${equity.toFixed(2)} · Margin {freeMargin !== null && freeMargin !== undefined ? `$${freeMargin.toFixed(2)}` : 'N/A'}
              </span>
              <span>
                Open {openPositions.length}/{emaCfg.maxSimultaneousPositions}
              </span>
            </div>
          </div>
        </div>

        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="uppercase tracking-wider font-medium">
              Daily Guard · Max {settings.maxConsecutiveLosses} Loss Streak
            </span>
            <ShieldAlert
              className={`w-3.5 h-3.5 ${
                dailyGuardHit || !newsStatus.clear ? 'text-red-400' : 'text-emerald-400'
              }`}
            />
          </div>
          <div className="mt-2 flex items-baseline justify-between font-mono tabular-nums">
            <span
              className={`text-xl font-bold ${
                dailyGuardHit
                  ? 'text-red-400'
                  : dailyPnlDollars >= 0
                    ? 'text-emerald-400'
                    : 'text-amber-300'
              }`}
            >
              {dailyPnlDollars >= 0 ? `+$${dailyPnlDollars.toFixed(2)}` : `-$${Math.abs(dailyPnlDollars).toFixed(2)}`}{' '}
              <span className="text-xs">({dailyPnlPct.toFixed(2)}%)</span>
            </span>
            <span className="text-sm font-bold text-slate-100">
              {levels.totalTradesToday}/{settings.maxTradesPerDay} Trades
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs font-mono">
            <span className={consecutiveLossesToday >= settings.maxConsecutiveLosses ? 'text-red-400 font-semibold' : 'text-slate-400'}>
              Loss Streak: {consecutiveLossesToday}/{settings.maxConsecutiveLosses}
            </span>
            <span
              className={
                dailyGuardHit
                  ? 'text-red-400 font-semibold'
                  : newsStatus.clear
                    ? 'text-emerald-400 font-medium'
                    : 'text-red-400 font-medium'
              }
            >
              {dailyGuardHit
                ? 'Stopped for Day'
                : newsStatus.clear
                  ? `DD ${dailyDrawdownPct.toFixed(1)}% · News Clear`
                  : `News: ${newsStatus.blockingEvent?.timeLusaka}`}
            </span>
          </div>
        </div>
      </div>

      {/* Live MT5 Spread & Quote Health Panel */}
      <section
        aria-label="Live Dynamic Spread Filter and Quote Health"
        className={`border rounded-lg p-4 space-y-3 ${
          !quoteDataAvailable || spreadEvaluation?.classification === 'ABNORMAL' || spreadEvaluation?.classification === 'EXCESSIVE'
            ? 'border-red-500/45 bg-red-950/20'
            : spreadEvaluation?.classification === 'HIGH'
              ? 'border-amber-500/40 bg-amber-950/15'
              : 'border-white/10 bg-[#111722]'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2.5 border-b border-white/8">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              All-Session Dynamic Spread Filter · {symbolSpec?.symbol || emaCfg.xauusdSymbol}
            </span>
            <span
              className={`px-2 py-0.5 rounded border text-[11px] font-mono font-bold ${
                !quoteDataAvailable || spreadEvaluation?.classification === 'DATA_UNAVAILABLE'
                  ? 'border-red-500/50 bg-red-500/20 text-red-200'
                  : spreadEvaluation?.classification === 'NORMAL'
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : spreadEvaluation?.classification === 'ELEVATED'
                      ? 'border-sky-500/40 bg-sky-500/15 text-sky-200'
                      : spreadEvaluation?.classification === 'HIGH'
                        ? 'border-amber-500/45 bg-amber-500/20 text-amber-200'
                        : 'border-red-500/50 bg-red-500/20 text-red-200'
              }`}
            >
              {!quoteDataAvailable
                ? 'DATA UNAVAILABLE'
                : spreadEvaluation?.classification ?? 'DATA UNAVAILABLE'}
            </span>
            <span className="px-2 py-0.5 rounded border border-white/10 bg-[#0B0F17] text-[11px] font-mono text-slate-300">
              {priceDigits} Digits · Point {pointSize} · {symbolSpec?.verifiedFromBroker ? 'Broker Spec' : 'Default Spec'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono tabular-nums text-slate-300">
            <span>
              Max Ceiling: <strong className="text-[#E5B85C]">{spreadEvaluation?.configuredMaxSpreadPoints ?? emaCfg.maxSpreadPips} pts</strong> ({spreadEvaluation?.sensitivity ?? emaCfg.spreadSensitivity})
            </span>
            <span>
              Source: <strong className="text-slate-100">{spreadEvaluation?.quoteSource || latestQuote?.source || 'Unavailable'}</strong>
            </span>
            <span>
              Quote Time:{' '}
              <strong className="text-slate-100">
                {(() => {
                  const parsedTs = spreadEvaluation?.quoteTimestamp
                    ? Date.parse(spreadEvaluation.quoteTimestamp)
                    : NaN;
                  return Number.isFinite(parsedTs)
                    ? getLusakaClock(parsedTs).timeLusaka
                    : 'N/A';
                })()}
              </strong>
              {spreadEvaluation?.quoteAgeMs != null
                ? ` (${Math.round(spreadEvaluation.quoteAgeMs / 1000)}s old)`
                : ''}
            </span>
          </div>
        </div>

        {!quoteDataAvailable && !isWeekend && (
          <div
            role="alert"
            className="px-3 py-2 rounded border border-red-500/45 bg-red-950/35 text-xs text-red-200 font-medium"
          >
            DATA UNAVAILABLE — Live two-sided MT5 Bid/Ask quote is missing, stale, or fallback-only. Automatic and manual order submissions are safely blocked until live quotes resume.
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs font-mono tabular-nums">
          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] font-sans text-slate-400">Live Spread</div>
            <div className="mt-0.5 text-sm font-bold text-[#E5B85C]">
              {quoteDataAvailable && spreadEvaluation?.spreadPoints != null
                ? `${spreadEvaluation.spreadPoints.toFixed(1)} pts`
                : 'DATA UNAVAILABLE'}
            </div>
            <div className="text-[10px] text-slate-400">
              {quoteDataAvailable && spreadEvaluation?.spreadPrice != null
                ? `$${spreadEvaluation.spreadPrice.toFixed(priceDigits)} (Ask-Bid)`
                : 'No live Ask-Bid'}
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] font-sans text-slate-400">Prev 1H Observed</div>
            <div className="mt-0.5 text-sm font-bold text-slate-100">
              {spreadEvaluation?.stats1h?.medianPoints != null
                ? `Med ${spreadEvaluation.stats1h.medianPoints.toFixed(1)}p`
                : 'Accumulating'}
            </div>
            <div className="text-[10px] text-slate-400">
              {spreadEvaluation?.stats1h?.sufficientData
                ? `p75 ${spreadEvaluation.stats1h.p75Points?.toFixed(1)} · p90 ${spreadEvaluation.stats1h.p90Points?.toFixed(1)} (${spreadEvaluation.stats1h.sampleCount})`
                : `Samples: ${spreadEvaluation?.stats1h?.sampleCount ?? 0}/${spreadEvaluation?.stats1h?.minSamplesRequired ?? 20} (need more)`}
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] font-sans text-slate-400">Prev 24H Observed</div>
            <div className="mt-0.5 text-sm font-bold text-slate-100">
              {spreadEvaluation?.stats24h?.medianPoints != null
                ? `Med ${spreadEvaluation.stats24h.medianPoints.toFixed(1)}p`
                : 'Accumulating'}
            </div>
            <div className="text-[10px] text-slate-400">
              {spreadEvaluation?.stats24h?.sufficientData
                ? `p75 ${spreadEvaluation.stats24h.p75Points?.toFixed(1)} · p90 ${spreadEvaluation.stats24h.p90Points?.toFixed(1)} (${spreadEvaluation.stats24h.sampleCount})`
                : `Samples: ${spreadEvaluation?.stats24h?.sampleCount ?? 0}/${spreadEvaluation?.stats24h?.minSamplesRequired ?? 60} (need more)`}
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] font-sans text-slate-400">Thresholds (Pts)</div>
            <div className="mt-0.5 text-xs font-semibold text-slate-100">
              N≤{spreadEvaluation?.thresholdsPoints.normalMax ?? 45} · E≤{spreadEvaluation?.thresholdsPoints.elevatedMax ?? 65}
            </div>
            <div className="text-[10px] text-slate-400">
              H≤{spreadEvaluation?.thresholdsPoints.highMax ?? emaCfg.maxSpreadPips} · Abn≥{spreadEvaluation?.thresholdsPoints.abnormalMin ?? 120}
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] font-sans text-slate-400">Est. Cost &amp; Net R:R</div>
            <div className="mt-0.5 text-xs font-semibold text-slate-100">
              {spreadEvaluation?.costBreakdown
                ? `$${spreadEvaluation.costBreakdown.totalEstimatedCostDollars.toFixed(2)} (${spreadEvaluation.costBreakdown.totalCostPoints.toFixed(1)}p)`
                : 'Pending Signal'}
            </div>
            <div className="text-[10px] text-slate-400">
              {activeSignal.netRrRatio != null
                ? `Net 1:${activeSignal.netRrRatio.toFixed(2)} (Min ${emaCfg.minNetRewardRisk.toFixed(1)})`
                : `Min Net R:R 1:${emaCfg.minNetRewardRisk.toFixed(1)}`}
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] font-sans text-slate-400">Today Filter Counters</div>
            <div className="mt-0.5 text-xs font-semibold text-emerald-300">
              &gt;45p Protected: {acceptedAbove45Count}
            </div>
            <div className="text-[10px] text-amber-300">
              Spread Rejected: {spreadRejectedCount}
            </div>
          </div>
        </div>

        {spreadEvaluation?.reason && (
          <p className="text-[11px] font-mono text-slate-300">
            Decision ({spreadEvaluation.decision}): {spreadEvaluation.reason}
          </p>
        )}
      </section>

      {/* Trading Performance Overview */}
      <section
        aria-label="Trading Performance Overview"
        className="border border-white/10 bg-[#111722] rounded-lg p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-white/8">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Trading Performance Overview
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              EMA STOCHASTIC PRO execution summary · {bot.lusakaDate} Lusaka · Mode: {emaCfg.tradingMode.replace(/_/g, ' ')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('trades')}
            className="px-3 py-1.5 rounded-md border border-white/12 bg-[#0E131D] text-xs font-medium text-slate-200 hover:bg-white/5 transition-colors whitespace-nowrap shrink-0"
          >
            View Trade Log ({bot.tradeLog.length})
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-y-4 lg:gap-y-0 lg:divide-x divide-white/8">
          <div className="lg:pr-5">
            <div className="text-xs text-slate-400 font-medium">Total Trades Today</div>
            <div className="mt-1.5 font-mono tabular-nums text-2xl font-bold text-slate-50">
              {levels.totalTradesToday}{' '}
              <span className="text-sm font-normal text-slate-400">
                / {settings.maxTradesPerDay} limit
              </span>
            </div>
            <div className="mt-1.5 text-xs font-mono tabular-nums text-slate-400">
              Asian {levels.asianTradesToday}/{emaCfg.maxTradesPerSession} · London{' '}
              {levels.londonTradesToday}/{emaCfg.maxTradesPerSession} · Open {todaysOpenCount}
            </div>
          </div>

          <div className="lg:px-5">
            <div className="text-xs text-slate-400 font-medium">Current Daily P&amp;L</div>
            <div
              className={`mt-1.5 font-mono tabular-nums text-2xl font-bold ${
                dailyGuardHit || dailyPnlDollars < 0
                  ? 'text-red-400'
                  : dailyPnlDollars > 0
                    ? 'text-emerald-400'
                    : 'text-slate-100'
              }`}
            >
              {dailyPnlDollars >= 0
                ? `+$${dailyPnlDollars.toFixed(2)}`
                : `-$${Math.abs(dailyPnlDollars).toFixed(2)}`}{' '}
              <span className="text-xs font-semibold">
                ({dailyPnlPct >= 0 ? '+' : ''}
                {dailyPnlPct.toFixed(2)}%)
              </span>
            </div>
            <div className="mt-1.5 text-xs font-mono tabular-nums text-slate-400">
              DD {dailyDrawdownPct.toFixed(2)}% / {(settings.dailyGuardPct ?? 5).toFixed(1)}% cap · Net{' '}
              {overallNetPnl >= 0
                ? `+$${overallNetPnl.toFixed(2)}`
                : `-$${Math.abs(overallNetPnl).toFixed(2)}`}
            </div>
          </div>

          <div className="lg:px-5">
            <div className="text-xs text-slate-400 font-medium">
              EMA/SMC Setups Identified
            </div>
            <div className="mt-1.5 font-mono tabular-nums text-2xl font-bold text-[#E5B85C]">
              {setupsTotal}{' '}
              <span className="text-sm font-normal text-slate-400">
                ({setupsToday} today)
              </span>
            </div>
            <div className="mt-1.5 text-xs font-mono tabular-nums text-slate-400">
              {confirmedCount} confirmed · {blockedCount} filtered ·{' '}
              {emaPro?.activeSetupType
                ? emaPro.activeSetupType.replace(/_/g, ' ')
                : `Trend ${emaPro?.overallTrend ?? 'SIDEWAYS'}`}
            </div>
          </div>

          <div className="lg:pl-5">
            <div className="text-xs text-slate-400 font-medium">
              {todaysWinRate !== null ? "Today's Win Rate · AI Gate" : 'Closed Win Rate · AI Gate'}
            </div>
            <div className="mt-1.5 font-mono tabular-nums text-2xl font-bold text-slate-50">
              {todaysWinRate !== null
                ? `${todaysWinRate}%`
                : overallWinRate !== null
                  ? `${overallWinRate}%`
                  : '—'}{' '}
              <span className="text-sm font-normal text-slate-400">
                {todaysWinRate !== null
                  ? `${todaysWins}W / ${todaysLosses}L today`
                  : allClosedTrades.length > 0
                    ? `${allWins}W / ${Math.max(0, allClosedTrades.length - allWins)}L all`
                    : 'no closed yet'}
              </span>
            </div>
            <div className="mt-1.5 text-xs font-mono tabular-nums text-slate-400">
              AI: {lastAiApproval ? `${lastAiApproval.status} (${lastAiApproval.confidencePct}%)` : 'Standby'} · Streak{' '}
              {consecutiveLossesToday}/{settings.maxConsecutiveLosses}
            </div>
          </div>
        </div>
      </section>

      {/* Check Gold Now — Active Strategy Readout */}
      <div className="border border-white/10 bg-[#111722] rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-white/8">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Check Gold Now — EMA STOCHASTIC PRO Status
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              H1 Direction · M15 Structure · M5 Entry{emaCfg.m1RefinementEnabled ? ' · M1 Refinement' : ''} · SMC + AI Threshold {emaCfg.aiConfidenceThreshold}% · {liveClock.timeLusaka} Lusaka
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(activeSignal.setupLabel || emaPro?.activeSetupType) && (
              <span className="px-2 py-1 rounded border border-[#D4A853]/40 bg-[#D4A853]/12 text-[11px] font-mono font-semibold text-[#E5B85C]">
                {activeSignal.setupLabel ?? emaPro?.activeSetupType?.replace(/_/g, ' ')}
              </span>
            )}
            {emaPro && (
              <span className="px-2 py-1 rounded border border-white/12 bg-[#0B0F17] text-[11px] font-mono text-slate-300">
                Trend: {emaPro.overallTrend} · {emaPro.marketCondition}
              </span>
            )}
            <span
              className={`px-2.5 py-1 rounded border text-xs font-mono font-bold ${
                checkGoldBias === 'LONG'
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : checkGoldBias === 'SHORT'
                    ? 'border-red-500/40 bg-red-500/15 text-red-300'
                    : 'border-white/15 bg-[#0B0F17] text-slate-200'
              }`}
            >
              Bias: {checkGoldBias}
            </span>
          </div>
        </div>

        <p className="mt-3 text-xs text-slate-200 leading-relaxed">{checkGoldReason}</p>
        {emaPro?.stochNote && (
          <p className="mt-1.5 text-[11px] font-mono text-sky-300/90">
            Stochastic Timing: {emaPro.stochNote}
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs font-mono tabular-nums">
          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] text-slate-400">Entry (M5 Close)</div>
            <div className="mt-0.5 font-semibold text-slate-100">
              {typeof activeSignal.entry === 'number' && Number.isFinite(activeSignal.entry)
                ? `$${activeSignal.entry.toFixed(priceDigits)}`
                : 'NO TRADE'}
            </div>
          </div>
          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] text-slate-400">SL (Swing + ATR)</div>
            <div className="mt-0.5 font-semibold text-red-300">
              {typeof activeSignal.stop === 'number' && Number.isFinite(activeSignal.stop)
                ? `$${activeSignal.stop.toFixed(priceDigits)}`
                : '—'}
            </div>
          </div>
          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] text-slate-400">TP1 (1:{emaCfg.tp1Rr} -&gt; Trail)</div>
            <div className="mt-0.5 font-semibold text-emerald-300">
              {typeof activeSignal.tp1 === 'number' && Number.isFinite(activeSignal.tp1)
                ? `$${activeSignal.tp1.toFixed(priceDigits)}`
                : '—'}
            </div>
          </div>
          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] text-slate-400">TP2 (1:{emaCfg.tp2Rr} -&gt; Trail)</div>
            <div className="mt-0.5 font-semibold text-[#E5B85C]">
              {typeof activeSignal.tp2 === 'number' && Number.isFinite(activeSignal.tp2)
                ? `$${activeSignal.tp2.toFixed(priceDigits)}`
                : '—'}
            </div>
          </div>
          <div className="bg-[#0B0F17] border border-white/8 rounded px-3 py-2">
            <div className="text-[11px] text-slate-400">TP3 (1:{emaCfg.tp3Rr} Runner)</div>
            <div className="mt-0.5 font-semibold text-sky-300">
              {typeof activeSignal.tp3 === 'number' && Number.isFinite(activeSignal.tp3)
                ? `$${activeSignal.tp3.toFixed(priceDigits)}`
                : '—'}
            </div>
          </div>
        </div>

        {/* Second-Layer Gemini AI Trade Approver Readout */}
        <div className="mt-4 pt-3.5 border-t border-white/8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-[#E5B85C]" />
              <span className="text-xs font-semibold text-slate-100">
                Gemini AI Confirmation Gate (Threshold {emaCfg.aiConfidenceThreshold}/100)
              </span>
              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-mono font-semibold ${
                  !aiApproverEnabled
                    ? 'border-slate-500/40 bg-slate-800/60 text-slate-300'
                    : pendingAiApproval || aiCheckBusy
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
                      : lastAiApproval?.status === 'APPROVED'
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                        : lastAiApproval?.status === 'REJECTED'
                          ? 'border-red-500/40 bg-red-500/15 text-red-300'
                          : lastAiApproval?.status === 'WAITING FOR CONFIRMATION'
                            ? 'border-sky-500/40 bg-sky-500/15 text-sky-200'
                            : lastAiApproval?.status === 'ERROR'
                              ? 'border-amber-500/40 bg-amber-950/40 text-amber-200'
                              : 'border-[#D4A853]/35 bg-[#D4A853]/10 text-[#E5B85C]'
                }`}
              >
                {!aiApproverEnabled
                  ? 'GATE OFF'
                  : pendingAiApproval || aiCheckBusy
                    ? 'VERIFYING...'
                    : lastAiApproval
                      ? `${lastAiApproval.status}${lastAiApproval.status !== 'ERROR' ? ` · ${lastAiApproval.confidencePct}%` : ''}`
                      : 'ACTIVE GATE'}
              </span>
            </div>

            {onRunAiApprover && (
              <button
                type="button"
                disabled={aiCheckBusy || pendingAiApproval}
                onClick={() => void handleAskGeminiApprover()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#D4A853]/45 bg-[#D4A853]/12 text-xs font-semibold text-[#E5B85C] hover:bg-[#D4A853]/22 disabled:opacity-45 transition-colors whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${aiCheckBusy || pendingAiApproval ? 'animate-spin' : ''}`} />
                {aiCheckBusy || pendingAiApproval ? 'Checking with Gemini...' : 'Ask Gemini AI Approver'}
              </button>
            )}
          </div>

          {lastAiApproval ? (
            <div className="mt-2.5 bg-[#0B0F17] border border-white/8 rounded-md p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                <span>
                  Verdict @ {lastAiApproval.lusakaTime} Lusaka · Side {lastAiApproval.side}
                  {lastAiApproval.slDistancePips !== null
                    ? ` · SL ${lastAiApproval.slDistancePips.toFixed(1)}p`
                    : ''}
                </span>
                <span>Model: {lastAiApproval.model}</span>
              </div>
              <p className="text-slate-200 leading-relaxed">{lastAiApproval.summary}</p>
              {lastAiApproval.ruleAudit.length > 0 && (
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1 text-[11px] font-mono text-slate-400">
                  {lastAiApproval.ruleAudit.map((item, i) => (
                    <li key={`${lastAiApproval.id}-audit-${i}`} className="truncate" title={item}>
                      • {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-slate-400">
              {aiApproverEnabled
                ? `AI trade approval gate evaluates trend, EMA alignment, Stochastic momentum, SMC setups, ATR/spread, risk, and R:R before approving any signal (threshold ${emaCfg.aiConfidenceThreshold}%).`
                : 'Gemini AI Approver is currently turned off in Settings.'}
            </p>
          )}
        </div>
      </div>

      {isWeekend && (
        <BacktestPanel
          settings={settings}
          isWeekend={isWeekend}
          m15HistoryCount={historyBarsCount}
          startingBalance={balance}
          masterFeedLive={Boolean(feedInfo?.isLive)}
        />
      )}

      {/* Main Signal Card + Rule Evaluation Checklist */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className={`lg:col-span-5 border rounded-lg p-5 flex flex-col justify-between ${signalBorderClass}`}>
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {isWeekend ? 'MARKET CLOSED' : bot.activeStrategyName}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {!canEnableAuto ? (
                  <>
                    <button
                      type="button"
                      disabled={isWeekend}
                      onClick={() => void handleAutoTradeSwitch()}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                      title="AUTO TRADE locked OFF until Broker Account Setup is complete"
                    >
                      <Lock className="w-3 h-3" />
                      AUTO TRADE OFF (Locked)
                    </button>
                    <button
                      type="button"
                      onClick={() => onNavigateTab('connections')}
                      className="px-2.5 py-1 rounded border border-[#D4A853]/40 bg-[#D4A853]/10 text-[11px] font-semibold text-[#E5B85C] hover:bg-[#D4A853]/20 whitespace-nowrap shrink-0"
                    >
                      Broker Setup
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={isWeekend || autoToggleBusy}
                    onClick={() => void handleAutoTradeSwitch()}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded border text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0 ${
                      autoTradeEnabled
                        ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                        : 'border-white/15 bg-[#0B0F17] text-slate-300 hover:border-[#D4A853]/50'
                    }`}
                  >
                    <Power className="w-3 h-3" />
                    {isWeekend
                      ? 'AUTO TRADE (CLOSED)'
                      : autoTradeEnabled
                        ? 'AUTO TRADE ON'
                        : 'AUTO TRADE OFF'}
                  </button>
                )}
              </div>
            </div>
            {autoToggleError && (
              <div
                role="alert"
                className={`mt-2 px-3 py-2 rounded border text-[11px] font-semibold ${
                  autoToggleError.startsWith('Wrong Account Type')
                    ? 'border-red-500/50 bg-red-950/35 text-red-200'
                    : 'border-amber-500/40 bg-amber-950/30 text-amber-200'
                }`}
              >
                {autoToggleError}
              </div>
            )}
            <div className="mt-2 px-3 py-2 rounded border border-[#D4A853]/25 bg-[#D4A853]/8 text-[11px] text-[#E5B85C]">
              <strong>Bridge:</strong> {user?.brokerName || 'MT5'} ({user?.accountType || 'Demo'}) via TickerAll Master Feed + Optional Broker Bridge Webhook
            </div>

            <div className="mt-4 flex items-center gap-3">
              {activeSignal.action === 'BUY' ? (
                <div className="p-2.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                  <TrendingUp className="w-6 h-6" />
                </div>
              ) : activeSignal.action === 'SELL' ? (
                <div className="p-2.5 rounded-md bg-red-500/15 border border-red-500/30 text-red-300">
                  <TrendingDown className="w-6 h-6" />
                </div>
              ) : (
                <div className="p-2.5 rounded-md bg-white/[0.04] border border-white/10 text-slate-300">
                  <PauseCircle className="w-6 h-6" />
                </div>
              )}
              <div>
                <div className="text-xl font-display font-bold tracking-tight text-slate-50">
                  {isWeekend
                    ? 'MARKET CLOSED'
                    : activeSignal.action === 'BUY'
                      ? `LONG EMA PRO - ${activeSignal.symbol} @ $${activeSignal.entry?.toFixed(priceDigits) ?? '—'}`
                      : activeSignal.action === 'SELL'
                        ? `SHORT EMA PRO - ${activeSignal.symbol} @ $${activeSignal.entry?.toFixed(priceDigits) ?? '—'}`
                        : activeSignal.blockReason
                          ? activeSignal.blockReason.toUpperCase()
                          : 'SCANNING EMA + STOCH + SMC (ALL SESSIONS)'}
                </div>
                <p className="mt-0.5 text-xs text-slate-300 font-mono">
                  {activeSignal.action !== 'WAIT' &&
                  typeof activeSignal.entry === 'number' &&
                  Number.isFinite(activeSignal.entry)
                    ? `${activeSignal.action === 'BUY' ? 'LONG' : 'SHORT'} @ $${activeSignal.entry.toFixed(priceDigits)} | SL ${typeof activeSignal.stop === 'number' && Number.isFinite(activeSignal.stop) ? `$${activeSignal.stop.toFixed(priceDigits)}` : '—'} | TP1 ${typeof activeSignal.tp1 === 'number' && Number.isFinite(activeSignal.tp1) ? `$${activeSignal.tp1.toFixed(priceDigits)}` : '—'} | TP2 ${typeof activeSignal.tp2 === 'number' && Number.isFinite(activeSignal.tp2) ? `$${activeSignal.tp2.toFixed(priceDigits)}` : '—'}${typeof activeSignal.tp3 === 'number' && Number.isFinite(activeSignal.tp3) ? ` | TP3 $${activeSignal.tp3.toFixed(priceDigits)}` : ''}`
                    : activeSignal.reason}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-2.5 border-t border-white/8 pt-4">
              <div className="bg-[#0B0F17]/70 border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Entry</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-bold text-slate-100">
                  {typeof activeSignal.entry === 'number' && Number.isFinite(activeSignal.entry)
                    ? `$${activeSignal.entry.toFixed(priceDigits)}`
                    : '—'}
                </div>
              </div>
              <div className="bg-[#0B0F17]/70 border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Swing + ATR SL</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-bold text-red-300">
                  {typeof activeSignal.stop === 'number' && Number.isFinite(activeSignal.stop)
                    ? `$${activeSignal.stop.toFixed(priceDigits)}`
                    : '—'}
                </div>
              </div>
              <div className="bg-[#0B0F17]/70 border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">TP1 (1:{emaCfg.tp1Rr})</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-bold text-emerald-300">
                  {typeof activeSignal.tp1 === 'number' && Number.isFinite(activeSignal.tp1)
                    ? `$${activeSignal.tp1.toFixed(priceDigits)}`
                    : '—'}
                </div>
              </div>
              <div className="bg-[#0B0F17]/70 border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">TP2 (1:{emaCfg.tp2Rr})</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-bold text-[#E5B85C]">
                  {typeof activeSignal.tp2 === 'number' && Number.isFinite(activeSignal.tp2)
                    ? `$${activeSignal.tp2.toFixed(priceDigits)}`
                    : '—'}
                </div>
              </div>
              <div className="bg-[#0B0F17]/70 border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">TP3 (1:{emaCfg.tp3Rr})</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-bold text-sky-300">
                  {typeof activeSignal.tp3 === 'number' && Number.isFinite(activeSignal.tp3)
                    ? `$${activeSignal.tp3.toFixed(priceDigits)}`
                    : '—'}
                </div>
              </div>
              <div className="bg-[#0B0F17]/70 border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Signal Expiry</div>
                <div className="mt-1 font-mono tabular-nums text-xs font-bold text-slate-200">
                  {(() => {
                    const expTs = activeSignal.expiresAt
                      ? Date.parse(activeSignal.expiresAt)
                      : NaN;
                    return Number.isFinite(expTs)
                      ? getLusakaClock(expTs).timeLusaka
                      : `${emaCfg.signalExpiryMinutes}m window`;
                  })()}
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
              <div className="bg-[#0B0F17]/50 border border-white/6 rounded px-3 py-2 flex items-center justify-between">
                <span className="text-slate-400">
                  Risk Lot ({Number.isFinite(settings.riskPercent) ? settings.riskPercent.toFixed(1) : '0.5'}%)
                </span>
                <span className="text-[#E5B85C] font-semibold">
                  {(autoLotInfo?.effectiveLot ?? activeSignal.suggestedLots).toFixed(2)} (Cap {(Number.isFinite(settings.maxAutoLotCap) ? settings.maxAutoLotCap ?? 0.5 : 0.5).toFixed(2)})
                </span>
              </div>
              <div className="bg-[#0B0F17]/50 border border-white/6 rounded px-3 py-2 flex items-center justify-between">
                <span className="text-slate-400">Condition</span>
                <span className="font-semibold text-[#E5B85C]">
                  {emaPro?.marketCondition ?? 'LOW_DATA'}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-white/8 space-y-2.5">
            {tradeActionNotice && (
              <div
                role="alert"
                className={`px-3 py-2 rounded border text-xs ${
                  tradeActionNotice.ok
                    ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                    : 'border-red-500/45 bg-red-950/35 text-red-200'
                }`}
              >
                {tradeActionNotice.text}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={isWeekend || !quoteDataAvailable || tradeActionBusy || !emaCfg.allowBuy}
                onClick={() => handleQuickManualOrder('BUY')}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-35 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                {tradeActionBusy && aiApproverEnabled
                  ? 'AI Checking...'
                  : liveAsk !== null
                    ? `BUY @ Ask $${liveAsk.toFixed(priceDigits)}`
                    : `BUY ${emaCfg.xauusdSymbol}`}
              </button>
              <button
                type="button"
                disabled={isWeekend || !quoteDataAvailable || tradeActionBusy || !emaCfg.allowSell}
                onClick={() => handleQuickManualOrder('SELL')}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25 disabled:opacity-35 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                <ArrowDownRight className="w-3.5 h-3.5" />
                {tradeActionBusy && aiApproverEnabled
                  ? 'AI Checking...'
                  : liveBid !== null
                    ? `SELL @ Bid $${liveBid.toFixed(priceDigits)}`
                    : `SELL ${emaCfg.xauusdSymbol}`}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {activeSignal.action !== 'WAIT' && activeSignal.entry !== null ? (
                <button
                  type="button"
                  disabled={isWeekend || tradeActionBusy}
                  onClick={handleLogActiveSignal}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] disabled:opacity-35 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  {tradeActionBusy && aiApproverEnabled
                    ? 'Verifying with Gemini AI...'
                    : `Log ${activeSignal.action === 'BUY' ? 'LONG' : 'SHORT'} Trade Now`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigateTab('trades')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md border border-white/15 bg-[#0E131D] text-slate-200 hover:bg-white/5 transition-colors whitespace-nowrap"
                >
                  View Trade Log ({bot.tradeLog.length})
                </button>
              )}
              <button
                type="button"
                onClick={() => onNavigateTab('settings')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-white/15 bg-[#0E131D] text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
              >
                <SlidersHorizontal className="w-3 h-3" />
                Settings
              </button>
            </div>
          </div>
        </div>

        {/* Live Rule Evaluation Checklist */}
        <div className="lg:col-span-7 border border-white/8 bg-[#111722] rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-white/8">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                EMA STOCHASTIC PRO Confirmation Matrix (4 Independent Setups)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                H1 Direction, M15 Structure, M5 EMA9/21 Pullback, Stochastic (14,3,3) Cross, SMC Setup (M5 &amp; M15), Closed Candle, Spread/ATR &amp; Risk Checks.
              </p>
            </div>
            <span className="font-mono text-xs text-slate-400 whitespace-nowrap">
              {activeSignal.conditions.filter((c) => c.passed).length}/
              {activeSignal.conditions.length} Passed
            </span>
          </div>

          <div className="mt-4 space-y-2 max-h-[430px] overflow-y-auto pr-1">
            {activeSignal.conditions.map((cond, idx) => (
              <div
                key={`${cond.label}-${idx}`}
                className={`p-3 rounded-md border flex items-start gap-3 ${
                  cond.passed
                    ? 'border-emerald-500/25 bg-emerald-950/15'
                    : 'border-white/8 bg-[#0B0F17]/60'
                }`}
              >
                {cond.passed ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100">
                      {cond.label}
                    </span>
                    <span
                      className={`text-[11px] font-mono font-semibold ${
                        cond.passed ? 'text-emerald-400' : 'text-slate-400'
                      }`}
                    >
                      {cond.passed ? 'PASS' : 'WAIT'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400 font-mono break-words">
                    {cond.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Strategy-Specific Structure Panels */}
      {emaPro && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Multi-Timeframe EMA + Stochastic Matrix */}
          <div className="border border-white/8 bg-[#111722] rounded-lg p-5">
            <div className="flex items-center justify-between border-b border-white/8 pb-3">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#D4A853]" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    1. Multi-Timeframe EMA ({emaCfg.emaFast}/{emaCfg.emaMid}/{emaCfg.emaIntermediate}/{emaCfg.emaMajor}) &amp; Stochastic ({emaCfg.stochK},{emaCfg.stochD},{emaCfg.stochSlowing})
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Strictly calculated on closed candles · Chop filter prevents sideways whipsaws
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                Spread {emaPro.spreadPips !== null ? `${emaPro.spreadPips.toFixed(1)}p` : 'N/A'} / {emaCfg.maxSpreadPips}p
              </span>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[11px] font-mono tabular-nums">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-white/8">
                    <th className="py-2 pr-2">TF</th>
                    <th className="py-2 pr-2">EMA9 / 21</th>
                    <th className="py-2 pr-2">EMA50 / 200</th>
                    <th className="py-2 pr-2">Bias</th>
                    <th className="py-2 pr-2">Stoch %K/%D</th>
                    <th className="py-2 text-right">ATR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {tfRows.map((tf) => {
                    if (!tf) return null;
                    return (
                      <tr key={tf.timeframe} className="hover:bg-white/[0.02]">
                        <td className="py-2.5 pr-2 font-bold text-[#E5B85C]">
                          {tf.timeframe}
                          <span className="block text-[10px] font-normal text-slate-500">
                            {tf.barsCount} bars
                          </span>
                        </td>
                        <td className="py-2.5 pr-2 text-slate-200">
                          {typeof tf.ema9 === 'number' && Number.isFinite(tf.ema9) ? tf.ema9.toFixed(priceDigits) : '—'}
                          <span className="block text-slate-400">
                            {typeof tf.ema21 === 'number' && Number.isFinite(tf.ema21) ? tf.ema21.toFixed(priceDigits) : '—'}
                          </span>
                        </td>
                        <td className="py-2.5 pr-2 text-slate-200">
                          {typeof tf.ema50 === 'number' && Number.isFinite(tf.ema50) ? tf.ema50.toFixed(priceDigits) : '—'}
                          <span className="block text-slate-400">
                            {typeof tf.ema200 === 'number' && Number.isFinite(tf.ema200) ? tf.ema200.toFixed(priceDigits) : '—'}
                          </span>
                        </td>
                        <td className="py-2.5 pr-2">
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] ${
                              tf.emaBias === 'BULLISH'
                                ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                                : tf.emaBias === 'BEARISH'
                                  ? 'border-red-500/35 bg-red-500/10 text-red-300'
                                  : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
                            }`}
                          >
                            {tf.emaBias}
                          </span>
                          {tf.isCompressedOrChoppy && (
                            <span className="block text-[10px] text-amber-300 mt-0.5">
                              CHOP
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-2 text-slate-200">
                          {typeof tf.stochK === 'number' && Number.isFinite(tf.stochK) ? tf.stochK.toFixed(1) : '—'} /{' '}
                          {typeof tf.stochD === 'number' && Number.isFinite(tf.stochD) ? tf.stochD.toFixed(1) : '—'}
                          <span className="block text-[10px] text-slate-400">
                            {tf.stochZone}
                            {tf.stochCross !== 'NONE' ? ` · ${tf.stochCross === 'BULLISH_CROSS' ? '↑X' : '↓X'}` : ''}
                          </span>
                        </td>
                        <td className="py-2.5 text-right text-slate-300">
                          {typeof tf.atr === 'number' && Number.isFinite(tf.atr) ? `$${tf.atr.toFixed(priceDigits)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] font-mono">
              <div className="bg-[#0B0F17] border border-white/8 rounded px-2.5 py-2">
                <span className="text-slate-400 block">Pullback</span>
                <span className="text-slate-100 font-semibold">{emaPro.pullbackToEma}</span>
              </div>
              <div className="bg-[#0B0F17] border border-white/8 rounded px-2.5 py-2">
                <span className="text-slate-400 block">M5 Close</span>
                <span className="text-slate-100 font-semibold">{emaPro.confirmationCandle}</span>
              </div>
              <div className="bg-[#0B0F17] border border-white/8 rounded px-2.5 py-2">
                <span className="text-slate-400 block">News Feed</span>
                <span className={emaPro.newsFeedStatus === 'CALENDAR_CONFIGURED' ? 'text-emerald-300 font-semibold' : 'text-amber-300 font-semibold'}>
                  {emaPro.newsFeedStatus === 'CALENDAR_CONFIGURED' ? 'CONFIGURED' : 'NO FEED'}
                </span>
              </div>
            </div>
          </div>

          {/* Smart Money Concepts Panel */}
          <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between border-b border-white/8 pb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#D4A853]" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    2. Smart Money Concepts (Non-Repainting SMC)
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Lookback {emaCfg.smcLookbackBars} bars · Swing strength {emaCfg.swingStrength} · Confirmed closes only
                  </p>
                </div>
              </div>
              <span
                className={`px-2 py-0.5 rounded border text-[11px] font-mono font-semibold ${
                  emaPro.smc.trendStructure === 'BULLISH'
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                    : emaPro.smc.trendStructure === 'BEARISH'
                      ? 'border-red-500/35 bg-red-500/10 text-red-300'
                      : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
                }`}
              >
                {emaPro.smc.trendStructure}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono tabular-nums">
              <div className="bg-[#0B0F17] border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Last BOS</div>
                <div className="mt-1 font-semibold text-slate-100">
                  {emaPro.smc.lastBos
                    ? `${emaPro.smc.lastBos.type.replace('BOS_', '')} $${emaPro.smc.lastBos.price.toFixed(priceDigits)}`
                    : 'None'}
                </div>
              </div>
              <div className="bg-[#0B0F17] border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Last CHoCH</div>
                <div className="mt-1 font-semibold text-slate-100">
                  {emaPro.smc.lastChoch
                    ? `${emaPro.smc.lastChoch.type.replace('CHOCH_', '')} $${emaPro.smc.lastChoch.price.toFixed(priceDigits)}`
                    : 'None'}
                </div>
              </div>
              <div className="bg-[#0B0F17] border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Dealing Zone</div>
                <div className="mt-1 font-semibold text-[#E5B85C]">
                  {emaPro.smc.priceZone}
                </div>
              </div>
              <div className="bg-[#0B0F17] border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Liquidity Sweep</div>
                <div className="mt-1 font-semibold text-slate-100 truncate">
                  {emaPro.smc.lastSweep
                    ? `${emaPro.smc.lastSweep.direction} @ $${emaPro.smc.lastSweep.sweptLevel.toFixed(priceDigits)}`
                    : 'None detected'}
                </div>
              </div>
              <div className="bg-[#0B0F17] border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Active Order Blocks</div>
                <div className="mt-1 font-semibold text-slate-100">
                  Bull {emaPro.smc.activeBullishObs.length} · Bear {emaPro.smc.activeBearishObs.length}
                </div>
              </div>
              <div className="bg-[#0B0F17] border border-white/8 rounded p-2.5">
                <div className="text-[11px] text-slate-400">Active FVGs · M15 Trend</div>
                <div className="mt-1 font-semibold text-slate-100">
                  FVG {emaPro.smc.activeBullishFvgs.length + emaPro.smc.activeBearishFvgs.length} ·{' '}
                  {emaPro.m15Smc?.trendStructure ?? emaPro.m15.emaBias}
                </div>
              </div>
            </div>

            {emaPro.stochNote && (
              <div className="bg-[#0B0F17] border border-white/8 rounded px-2.5 py-2 text-[11px] font-mono text-slate-300">
                <span className="text-slate-400">Setup Timing: </span>
                <span className="text-slate-100">{emaPro.stochNote}</span>
              </div>
            )}

            {emaPro.smc.evidenceSummary.length > 0 && (
              <div className="bg-[#0E131D] border border-white/6 rounded p-2.5 text-[11px] font-mono text-slate-300 space-y-1">
                {emaPro.smc.evidenceSummary.slice(0, 4).map((ev, i) => (
                  <div key={`smc-ev-${i}`} className="truncate">
                    • {ev}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Strategy Chart (M5/M15 EMA Overlays + SMC + TP1/TP2/TP3) */}
      <M15StrategyChart
        symbol={snapshot.config.symbol || emaCfg.xauusdSymbol || 'GOLD'}
        priceDigits={priceDigits}
        closedCandles={closedCandles}
        currentCandle={currentCandle}
        closedM5Candles={closedM5Candles}
        currentM5Candle={currentM5Candle}
        emaPro={emaPro}
        emaConfig={emaCfg}
        activeSignal={activeSignal}
      />

      {!isWeekend && (
        <BacktestPanel
          settings={settings}
          isWeekend={isWeekend}
          m15HistoryCount={historyBarsCount}
          startingBalance={balance}
          masterFeedLive={Boolean(feedInfo?.isLive)}
        />
      )}

      {/* Price Chart + M5/M15 OHLC Candles Table */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-7">
          <LivePriceChart
            ticks={snapshot.recentTicks}
            symbol={snapshot.config.symbol || emaCfg.xauusdSymbol || 'GOLD'}
            onRunProbe={onRunProbe}
            isProbing={isProbing}
          />
        </div>

        <div className="xl:col-span-5 border border-white/8 bg-[#111722] rounded-lg p-4 flex flex-col">
          <div className="flex items-center justify-between pb-3 border-b border-white/8 gap-2">
            <div className="flex items-center gap-2">
              <CandlestickChart className="w-4 h-4 text-[#D4A853]" />
              <h3 className="text-sm font-semibold text-slate-100">
                {activeCandleTf} Candles (Lusaka)
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded border border-white/12 bg-[#0B0F17] p-0.5">
                {(['M5', 'M15'] as const).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setCandleTableTf(tf)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                      activeCandleTf === tf
                        ? 'bg-[#D4A853]/20 text-[#E5B85C]'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
              <span className="text-xs font-mono text-slate-400">
                Bars: {activeCandleTf === 'M5' ? m5HistoryCount : historyBarsCount}
              </span>
            </div>
          </div>

          {candleList.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-10 text-xs text-slate-400 text-center">
              Collecting live {snapshot.config.symbol || 'GOLD'} ticks to construct {activeCandleTf} candles...
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs font-mono tabular-nums">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-white/8">
                    <th className="pb-2 pr-2 font-medium">Window</th>
                    <th className="pb-2 pr-2 font-medium">O</th>
                    <th className="pb-2 pr-2 font-medium">H</th>
                    <th className="pb-2 pr-2 font-medium">L</th>
                    <th className="pb-2 pr-2 font-medium">C</th>
                    <th className="pb-2 font-medium text-right">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {candleList.map((c) => {
                    const bullish = c.close >= c.open;
                    return (
                      <tr key={c.openTimeMs} className="hover:bg-white/[0.02]">
                        <td className="py-2 pr-2 text-slate-300">
                          {c.openTimeLusaka}–{c.closeTimeLusaka}
                        </td>
                        <td className="py-2 pr-2 text-slate-300">{c.open.toFixed(priceDigits)}</td>
                        <td className="py-2 pr-2 text-slate-200">{c.high.toFixed(priceDigits)}</td>
                        <td className="py-2 pr-2 text-slate-200">{c.low.toFixed(priceDigits)}</td>
                        <td
                          className={`py-2 pr-2 font-semibold ${
                            bullish ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {c.close.toFixed(priceDigits)}
                        </td>
                        <td className="py-2 text-right">
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] ${
                              c.closed
                                ? 'border-white/10 text-slate-400'
                                : 'border-[#D4A853]/30 bg-[#D4A853]/10 text-[#E5B85C]'
                            }`}
                          >
                            {c.closed ? 'CLOSED' : 'OPEN'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
