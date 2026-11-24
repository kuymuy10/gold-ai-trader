import { useEffect, useState, useCallback } from 'react';
import {
  Lock,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Server,
  Bell,
  Activity,
} from 'lucide-react';
import type {
  ConnectionSnapshot,
  TradingMode,
  UserPublicProfile,
} from '../types/connectivity';
import { mergeEmaProConfig } from '../utils/emaStochasticPro';

interface BotDiagnosticsPayload {
  ok: boolean;
  strategyMode: 'EMA_STOCHASTIC_PRO';
  capabilities: {
    bridge: string;
    marketDataAuth: string;
    streamingFeed: string;
    historicalRest: string;
    tradeExecution: string;
    symbolMapping: string;
    idempotency: string;
  };
  feedStatus: string;
  candleCounts: {
    m1: number;
    m5: number;
    m15: number;
    h1: number;
  };
  geminiConfigured: boolean;
  demoOnlyMode: boolean;
  liveTradingAuthorized: boolean;
  lastFetchError: string | null;
}

interface ExecutionGateViewProps {
  snapshot: ConnectionSnapshot;
  user?: UserPublicProfile | null;
  onBotControl?: (payload: {
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
  }) => Promise<{ ok: boolean; message?: string; error?: string }>;
  onNavigateConnections: () => void;
}

export function ExecutionGateView({
  snapshot,
  user,
  onBotControl,
  onNavigateConnections,
}: ExecutionGateViewProps) {
  const [diagnostics, setDiagnostics] = useState<BotDiagnosticsPayload | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeNotice, setCloseNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const loadDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    setDiagError(null);
    try {
      const res = await fetch('/api/bot/diagnostics', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Diagnostics endpoint returned HTTP ${res.status}`);
      }
      const json = (await res.json()) as BotDiagnosticsPayload;
      if (json.ok) {
        setDiagnostics(json);
      }
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Unable to load diagnostics');
    } finally {
      setDiagLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const bot = snapshot.bot;
  const feedInfo = bot?.feedInfo;
  const settings = bot?.settings;
  const emaPro = bot?.emaPro;
  const emaCfg = mergeEmaProConfig(settings?.emaPro);

  const newsClear = Boolean(bot?.newsStatus?.clear);
  const dailyGuardHit = Boolean(bot?.dailyGuardHit);
  const tradesToday = bot?.levels.totalTradesToday ?? 0;
  const maxTrades = settings?.maxTradesPerDay ?? 10;
  const consecutiveLosses = bot?.consecutiveLossesToday ?? bot?.levels.consecutiveLossesToday ?? 0;
  const maxLosses = settings?.maxConsecutiveLosses ?? 3;
  const autoLot = bot?.autoLotInfo;
  const openPositions = (bot?.tradeLog ?? []).filter((t) => t.status === 'OPEN');
  const recentOrders = (bot?.tradeOrders ?? []).slice(0, 10);
  const recentNotifications = (bot?.notifications ?? []).slice(0, 8);

  const emaSpreadOk = emaPro ? emaPro.spreadAllowed : false;
  const emaMultiTfOk = Boolean(
    emaPro &&
      emaPro.h1.emaBias !== 'NEUTRAL' &&
      emaPro.h1.emaBias !== 'CHOP' &&
      emaPro.m15.emaBias === emaPro.h1.emaBias &&
      !emaPro.m5.isCompressedOrChoppy
  );
  const emaStochSmcOk = Boolean(
    emaPro &&
      ((emaPro.m5.stochCross === 'BULLISH_CROSS' && emaPro.smc.bullishSetupPresent) ||
        (emaPro.m5.stochCross === 'BEARISH_CROSS' && emaPro.smc.bearishSetupPresent) ||
        bot?.activeSignal?.action === 'BUY' ||
        bot?.activeSignal?.action === 'SELL')
  );

  const emaChecks = [
    {
      name: '1. TickerAll Master Feed & Subscriber Access',
      requirement: `Live ${emaCfg.xauusdSymbol} tick & candle stream via TickerAll Proxy (MT5)`,
      passed: Boolean(feedInfo?.isLive) && (user ? user.feedAccess && user.status === 'ACTIVE' : true),
      observed: feedInfo?.label ?? 'Feed Offline ●',
    },
    {
      name: `2. Multi-TF EMA (${emaCfg.emaFast}/${emaCfg.emaMid}/${emaCfg.emaIntermediate}/${emaCfg.emaMajor}) + Non-Chop Filter`,
      requirement: 'H1 major direction + M15 structure alignment + M5 non-compressed trend on closed candles',
      passed: emaMultiTfOk,
      observed: emaPro
        ? `H1 ${emaPro.h1.emaBias} · M15 ${emaPro.m15.emaBias} · M5 ${emaPro.m5.emaBias}${emaPro.m5.isCompressedOrChoppy ? ' (CHOP)' : ''}`
        : 'Awaiting MTF bars',
    },
    {
      name: `3. Stochastic (${emaCfg.stochK},${emaCfg.stochD},${emaCfg.stochSlowing}) & SMC Confirmation`,
      requirement: 'Stochastic zone/cross aligned with Sweep, BOS/CHoCH, Order Block, or FVG setup',
      passed: emaStochSmcOk,
      observed: emaPro
        ? `Stoch ${emaPro.m5.stochK?.toFixed(1) ?? '—'}/${emaPro.m5.stochD?.toFixed(1) ?? '—'} · SMC ${emaPro.smc.trendStructure}`
        : 'Scanning SMC',
    },
    {
      name: `4. Spread, ATR (${emaCfg.atrPeriod}) Volatility & News Filter`,
      requirement: `Spread ≤ ${emaCfg.maxSpreadPips}p, valid ATR buffer, and USD news clear (±${settings?.newsClearanceMins ?? 60}m)`,
      passed: emaSpreadOk && newsClear,
      observed: `Spread ${emaPro?.spreadPips !== null && emaPro?.spreadPips !== undefined ? `${emaPro.spreadPips.toFixed(1)}p` : 'N/A'} · ${newsClear ? 'News Clear' : `Blocked: ${bot?.newsStatus?.blockingEvent?.title ?? 'USD News'}`}`,
    },
    {
      name: `5. Risk Limits (${(settings?.riskPercent ?? 0.5).toFixed(1)}% Risk · ${maxLosses} Streak · ${emaCfg.maxTradesPerSession}/Sess · ${maxTrades}/Day)`,
      requirement: `Max ${emaCfg.maxSimultaneousPositions} simultaneous positions, daily DD ≤ ${(settings?.dailyGuardPct ?? 5).toFixed(1)}%, equity sizing active`,
      passed:
        consecutiveLosses < maxLosses &&
        tradesToday < maxTrades &&
        openPositions.length < emaCfg.maxSimultaneousPositions &&
        !dailyGuardHit &&
        Boolean(autoLot) &&
        (user ? user.equity > 0 : true),
      observed: `Trades ${tradesToday}/${maxTrades} · Open ${openPositions.length}/${emaCfg.maxSimultaneousPositions} · Streak ${consecutiveLosses}/${maxLosses}`,
    },
    {
      name: '6. Execution Mode, Run State & MT5 Broker Readiness',
      requirement: 'Run state RUNNING, mode AUTOMATIC_TRADING/BOTH, broker verified & AUTO switch ON',
      passed: Boolean(
        emaCfg.tradingRunState === 'RUNNING' &&
          emaCfg.tradingMode !== 'SIGNALS_ONLY' &&
          user?.brokerConnected &&
          user?.brokerSetupComplete &&
          !user?.brokerSetupWrongAccount &&
          user?.autoTradeEnabled &&
          (!emaCfg.demoOnlyMode || emaCfg.liveTradingAuthorized || user.accountType === 'Demo')
      ),
      observed: `${emaCfg.tradingRunState} · ${emaCfg.tradingMode} · ${
        emaCfg.demoOnlyMode && !emaCfg.liveTradingAuthorized && user?.accountType === 'Live'
          ? 'Demo Lock Blocks Live'
          : user?.autoTradeEnabled
            ? `AUTO ON (${user.brokerName})`
            : 'Manual / Signals Mode'
      }`,
    },
    {
      name: `7. Gemini AI Confirmation Gate (Threshold ≥ ${emaCfg.aiConfidenceThreshold}%)`,
      requirement: 'Independent Gemini audit of 14 market/risk criteria before execution (never overrides hard risk)',
      passed:
        settings?.aiApproverEnabled !== false
          ? bot?.lastAiApproval
            ? bot.lastAiApproval.status === 'APPROVED'
            : true
          : true,
      observed:
        settings?.aiApproverEnabled === false
          ? 'Bypassed (Disabled in Settings)'
          : bot?.lastAiApproval
            ? `${bot.lastAiApproval.status} (${bot.lastAiApproval.confidencePct}%) @ ${bot.lastAiApproval.lusakaTime}`
            : 'Armed (Evaluates Before Dispatch)',
    },
  ];

  const checks = emaChecks;
  const passedCount = checks.filter((c) => c.passed).length;

  const handleCloseAllConfirmed = async () => {
    if (!onBotControl || closeBusy) return;
    setCloseBusy(true);
    setCloseNotice(null);
    try {
      const res = await onBotControl({ action: 'CLOSE_ALL', confirm: true });
      setConfirmCloseAll(false);
      setCloseNotice({
        ok: res.ok,
        text: res.message || res.error || (res.ok ? 'All open positions closed.' : 'Unable to close positions.'),
      });
    } finally {
      setCloseBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Control & Environment Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Run State &amp; Mode</div>
          <div className="mt-1.5 font-mono text-sm font-bold text-[#E5B85C]">
            {emaCfg.tradingRunState}
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400">
            {emaCfg.tradingMode.replace(/_/g, ' ')}
          </div>
        </div>
        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Execution Safety Lock</div>
          <div
            className={`mt-1.5 font-mono text-sm font-bold ${
              emaCfg.demoOnlyMode && !emaCfg.liveTradingAuthorized
                ? 'text-sky-300'
                : 'text-amber-300'
            }`}
          >
            {emaCfg.demoOnlyMode && !emaCfg.liveTradingAuthorized
              ? 'DemoOnlyMode'
              : 'LiveAuthorized'}
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400">
            Account: {user?.accountType ?? 'Demo'}
          </div>
        </div>
        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Risk &amp; Exposure</div>
          <div className="mt-1.5 font-mono text-sm font-bold text-slate-100">
            {(settings?.riskPercent ?? 0.5).toFixed(1)}% / Max {emaCfg.maxRiskPercent.toFixed(1)}%
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400">
            Open {openPositions.length}/{emaCfg.maxSimultaneousPositions} · DD Guard {(settings?.dailyGuardPct ?? 5).toFixed(1)}%
          </div>
        </div>
        <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Candles Buffered</div>
          <div className="mt-1.5 font-mono text-sm font-bold text-emerald-300">
            M5 {diagnostics?.candleCounts.m5 ?? bot?.m5HistoryCount ?? 0} · M15 {diagnostics?.candleCounts.m15 ?? bot?.m15HistoryCount ?? 0}
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400">
            H1 {diagnostics?.candleCounts.h1 ?? bot?.h1HistoryCount ?? 0} · M1 {diagnostics?.candleCounts.m1 ?? bot?.m1HistoryCount ?? 0}
          </div>
        </div>
      </div>

      {/* 7-Step Execution Pre-Flight Checklist */}
      <section className="border border-white/8 bg-[#111722] rounded-lg p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-white/8">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-xs font-medium text-[#E5B85C]">
              <Lock className="w-3.5 h-3.5" />
              <span>
                EMA STOCHASTIC PRO Auto-Trade Safety Order · Per-User Broker Isolation
              </span>
            </div>
            <h2 className="mt-2 text-xl font-semibold text-slate-50">
              EMA STOCHASTIC PRO Pre-Flight Gate (7-Step Order)
            </h2>
            <p className="mt-1.5 text-sm text-slate-400">
              Gate Order: TickerAll MT5 Feed → H1/M15/M5 EMA Alignment &amp; Non-Chop → Stochastic (14,3,3) + SMC Setup → Spread ≤ {emaCfg.maxSpreadPips}p &amp; News → Equity Risk ({(settings?.riskPercent ?? 0.5).toFixed(1)}%, Max {emaCfg.maxSimultaneousPositions} Open, {maxLosses}-Loss Pause) → Execution Lock → Gemini AI Gate ({emaCfg.aiConfidenceThreshold}%).
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">Gates Satisfied</p>
            <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-50">
              {passedCount} / {checks.length}
            </p>
          </div>
        </div>

        <div className="mt-5 divide-y divide-white/8">
          {checks.map((check) => (
            <div
              key={check.name}
              className="py-3.5 flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex items-start gap-3">
                {check.passed ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="text-sm font-medium text-slate-100">{check.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{check.requirement}</p>
                </div>
              </div>
              <div className="text-right">
                <p
                  className={`text-xs font-medium ${
                    check.passed ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {check.passed ? 'Ready' : 'Blocked / Standby'}
                </p>
                <p className="text-xs font-mono tabular-nums text-slate-400 mt-0.5">
                  {check.observed}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-5 border-t border-white/8 flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-slate-400">
            Admin can pause feed access but can never turn your Auto Trade ON or access your broker funds.
          </p>
          <button
            type="button"
            onClick={onNavigateConnections}
            className="px-4 py-2 text-xs font-semibold rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] transition-colors whitespace-nowrap shrink-0"
          >
            Open Broker Connection
          </button>
        </div>
      </section>

      {/* TickerAll MT5 Capabilities & Diagnostics Card */}
      <section className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-3">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-[#D4A853]" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                TickerAll MT5 Integration Diagnostics
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Inspected live adapter interfaces, candle streams, idempotency, and Gemini API status
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={diagLoading}
            onClick={() => void loadDiagnostics()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/15 bg-[#0B0F17] text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${diagLoading ? 'animate-spin' : ''}`} />
            Refresh Diagnostics
          </button>
        </div>

        {diagError ? (
          <div className="p-3 rounded border border-red-500/35 bg-red-950/25 text-xs text-red-200">
            {diagError}
          </div>
        ) : diagnostics ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="bg-[#0B0F17] border border-white/8 rounded p-3 space-y-1.5">
              <div className="text-[11px] uppercase text-slate-400 font-semibold">Bridge &amp; Auth</div>
              <div className="font-mono text-slate-200">{diagnostics.capabilities.bridge}</div>
              <div className="font-mono text-[11px] text-slate-400">{diagnostics.capabilities.marketDataAuth}</div>
              <div className="font-mono text-[11px] text-slate-400">{diagnostics.capabilities.streamingFeed}</div>
            </div>
            <div className="bg-[#0B0F17] border border-white/8 rounded p-3 space-y-1.5">
              <div className="text-[11px] uppercase text-slate-400 font-semibold">Execution &amp; Mapping</div>
              <div className="font-mono text-[#E5B85C]">{diagnostics.capabilities.symbolMapping}</div>
              <div className="font-mono text-[11px] text-slate-300">{diagnostics.capabilities.tradeExecution}</div>
              <div className="font-mono text-[11px] text-slate-400">
                Idempotency: {diagnostics.capabilities.idempotency} · Gemini API: {diagnostics.geminiConfigured ? 'Configured' : 'Missing Key'}
              </div>
              {diagnostics.lastFetchError && (
                <div className="font-mono text-[11px] text-amber-300">
                  Last History Note: {diagnostics.lastFetchError}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-400">Loading TickerAll diagnostics...</div>
        )}
      </section>

      {/* Open Positions Table + Recent Orders + Notifications */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#D4A853]" />
              <h3 className="text-sm font-semibold text-slate-100">
                Open Positions ({openPositions.length}) &amp; Recent Orders ({recentOrders.length})
              </h3>
            </div>
            {onBotControl && openPositions.length > 0 && (
              confirmCloseAll ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={closeBusy}
                    onClick={() => void handleCloseAllConfirmed()}
                    className="px-2.5 py-1 rounded bg-red-500 text-white text-[11px] font-bold hover:bg-red-400"
                  >
                    Confirm Close All
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmCloseAll(false)}
                    className="px-2 py-1 rounded border border-white/15 text-[11px] text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmCloseAll(true)}
                  className="px-2.5 py-1 rounded border border-red-500/35 bg-red-950/30 text-red-200 text-[11px] font-semibold hover:bg-red-950/50"
                >
                  Close All Positions
                </button>
              )
            )}
          </div>

          {closeNotice && (
            <div
              className={`p-2.5 rounded border text-xs ${
                closeNotice.ok
                  ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-200'
                  : 'border-red-500/35 bg-red-950/25 text-red-200'
              }`}
            >
              {closeNotice.text}
            </div>
          )}

          {openPositions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] font-mono tabular-nums">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-white/8">
                    <th className="py-1.5 pr-2">Side</th>
                    <th className="py-1.5 pr-2">Lots</th>
                    <th className="py-1.5 pr-2">Entry</th>
                    <th className="py-1.5 pr-2">SL</th>
                    <th className="py-1.5">Targets</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {openPositions.map((pos) => (
                    <tr key={pos.id}>
                      <td className={`py-2 pr-2 font-bold ${pos.side === 'BUY' ? 'text-emerald-300' : 'text-red-300'}`}>
                        {pos.side}
                      </td>
                      <td className="py-2 pr-2 text-slate-200">{pos.lots.toFixed(2)}</td>
                      <td className="py-2 pr-2 text-slate-100">${pos.entry.toFixed(2)}</td>
                      <td className="py-2 pr-2 text-red-300">${pos.stop.toFixed(2)}</td>
                      <td className="py-2 text-slate-300">
                        TP1 {pos.tp1 ? `$${pos.tp1.toFixed(2)}` : '—'} · TP2 {pos.tp2 ? `$${pos.tp2.toFixed(2)}` : '—'}
                        {pos.tp3 != null ? ` · TP3 $${pos.tp3.toFixed(2)}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-slate-500 font-mono">No open positions currently held.</p>
          )}

          {recentOrders.length > 0 && (
            <div className="pt-2 border-t border-white/8 space-y-1.5 max-h-[200px] overflow-y-auto">
              <div className="text-[11px] font-semibold text-slate-400 uppercase">Recent TickerAll Orders</div>
              {recentOrders.map((ord) => (
                <div
                  key={ord.id}
                  className="px-2.5 py-1.5 rounded border border-white/6 bg-[#0B0F17] flex items-center justify-between text-[11px] font-mono"
                >
                  <span className="text-slate-200">
                    {ord.lusakaTime} · {ord.side} {ord.symbol} {ord.lots.toFixed(2)} @ ${ord.requestedEntry.toFixed(2)}
                  </span>
                  <span
                    className={
                      ord.status === 'FILLED' || ord.status === 'ACCEPTED' || ord.status === 'DEMO_SIMULATED'
                        ? 'text-emerald-300'
                        : 'text-amber-300'
                    }
                  >
                    {ord.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2 border-b border-white/8 pb-3">
            <Bell className="w-4 h-4 text-[#D4A853]" />
            <h3 className="text-sm font-semibold text-slate-100">
              System Notifications &amp; Alerts ({recentNotifications.length})
            </h3>
          </div>
          {recentNotifications.length === 0 ? (
            <p className="text-xs text-slate-500 font-mono py-4">
              No execution or risk alerts recorded yet.
            </p>
          ) : (
            <div className="space-y-2 max-h-[260px] overflow-y-auto">
              {recentNotifications.map((n) => (
                <div
                  key={n.id}
                  className={`p-2.5 rounded border text-xs ${
                    n.level === 'CRITICAL'
                      ? 'border-red-500/40 bg-red-950/25 text-red-200'
                      : n.level === 'WARNING'
                        ? 'border-amber-500/35 bg-amber-950/20 text-amber-200'
                        : 'border-white/8 bg-[#0B0F17] text-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] font-mono opacity-80">
                    <span className="font-semibold">{n.title}</span>
                    <span>{new Date(n.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">{n.detail}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
