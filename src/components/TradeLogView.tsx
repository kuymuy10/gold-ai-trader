import { useState } from 'react';
import {
  ClipboardList,
  Plus,
  Download,
  Trash2,
  Check,
  X,
  Activity,
  ShieldAlert,
  FileText,
} from 'lucide-react';
import type {
  AiTradeApproval,
  ConnectionSnapshot,
  TradeLogEntry,
  TradingSessionTag,
} from '../types/connectivity';
import { getEffectiveSideEntryPrice, roundToDigits } from '../utils/dynamicSpread';
import { inferSymbolDigits } from '../utils/telegramSignalParser';

function formatRowPrice(val: number, symbol: string | null | undefined, goldDigits: number): string {
  const sym = (symbol || 'XAUUSD').toUpperCase();
  const isGold = sym.includes('XAU') || sym.includes('GOLD');
  const digits = isGold ? goldDigits : inferSymbolDigits(sym);
  return isGold ? `$${val.toFixed(digits)}` : val.toFixed(digits);
}

interface TradeLogViewProps {
  snapshot: ConnectionSnapshot;
  onLogTrade: (
    entry: Partial<TradeLogEntry>
  ) => Promise<{ ok: boolean; error?: string; approval?: AiTradeApproval }>;
  onUpdateTradeStatus: (
    id: string,
    status: TradeLogEntry['status'],
    exitPrice?: number
  ) => Promise<void>;
  onDeleteTrade: (id: string) => Promise<void>;
  onClearTrades: () => Promise<void>;
  onClearSignals: () => Promise<void>;
}

function isNum(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function formatSessionLabel(session: string): string {
  switch (session) {
    case 'ASIAN_SESSION':
      return 'Asian (03–11)';
    case 'LONDON_SESSION':
      return 'London (11–19)';
    case 'NEW_YORK_SESSION':
      return 'New York (19–00)';
    case 'ALL_SESSIONS':
    default:
      return 'Off-Peak (00–03)';
  }
}

export function TradeLogView({
  snapshot,
  onLogTrade,
  onUpdateTradeStatus,
  onDeleteTrade,
  onClearTrades,
  onClearSignals,
}: TradeLogViewProps) {
  const bot = snapshot.bot;
  const strategyModule = 'EMA_STOCHASTIC_PRO' as const;
  const trades = bot?.tradeLog ?? [];
  const signalHistory = bot?.signalHistory ?? [];
  const tradeOrders = bot?.tradeOrders ?? [];
  const riskEvents = bot?.riskEvents ?? [];
  const auditLogs = bot?.auditLogs ?? [];
  const perf = bot?.performance;
  const levels = bot?.levels;
  const settings = bot?.settings;
  const isWeekend = Boolean(bot?.isWeekend);
  const priceDigits = snapshot.bot?.symbolSpec?.digits ?? snapshot.latestTick?.digits ?? 2;
  const liveBid = snapshot.latestTick?.hasTwoSidedQuote ? snapshot.latestTick.bid : null;
  const liveAsk = snapshot.latestTick?.hasTwoSidedQuote ? snapshot.latestTick.ask : null;
  const livePrice =
    snapshot.latestTick?.last ?? snapshot.fallbackTick?.last ?? 0;

  const [activeSectionTab, setActiveSectionTab] = useState<'trades' | 'signals' | 'orders' | 'risk'>('trades');
  const [session, setSession] = useState<TradingSessionTag>(
    bot?.phase === 'ASIAN_SESSION' ||
      bot?.phase === 'LONDON_SESSION' ||
      bot?.phase === 'NEW_YORK_SESSION' ||
      bot?.phase === 'ALL_SESSIONS'
      ? bot.phase
      : 'ALL_SESSIONS'
  );
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const defaultSideEntry =
    getEffectiveSideEntryPrice('BUY', liveBid, liveAsk, livePrice > 0 ? livePrice : null, priceDigits) ?? 0;
  const [entryInput, setEntryInput] = useState(
    defaultSideEntry > 0 ? defaultSideEntry.toFixed(priceDigits) : ''
  );
  const [stopInput, setStopInput] = useState('');
  const [tp1Input, setTp1Input] = useState('');
  const [tp2Input, setTp2Input] = useState('');
  const [tp3Input, setTp3Input] = useState('');
  const [lotsInput, setLotsInput] = useState(
    String(settings?.defaultLotSize ?? 0.01)
  );
  const [notesInput, setNotesInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitNotice, setSubmitNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const closedTrades = trades.filter(
    (t) =>
      t.status === 'TP_HIT' || t.status === 'SL_HIT' || t.status === 'CLOSED'
  );
  const wins = closedTrades.filter((t) => (t.pnlDollars ?? 0) > 0).length;
  const winRate =
    closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;
  const netPnl = trades.reduce((acc, t) => acc + (t.pnlDollars ?? 0), 0);

  const slOffset = (settings?.slPips ?? 15) * 0.1;

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitNotice(null);
    const sideDefaultEntry =
      getEffectiveSideEntryPrice(
        side,
        liveBid,
        liveAsk,
        livePrice > 0 ? livePrice : null,
        priceDigits
      ) ?? livePrice;
    const entryVal = Number(entryInput || sideDefaultEntry);
    if (!Number.isFinite(entryVal) || entryVal <= 0) {
      setSubmitNotice({
        ok: false,
        text: 'Enter a valid positive XAUUSD entry price (or wait for a live feed price).',
      });
      return;
    }

    const stopVal = stopInput.trim()
      ? Number(stopInput)
      : roundToDigits(side === 'BUY' ? entryVal - slOffset : entryVal + slOffset, priceDigits);
    const riskDist = Math.max(0.1, Math.abs(entryVal - stopVal));
    const defaultTp2 =
      side === 'BUY'
        ? entryVal + riskDist * (settings?.emaPro?.tp2Rr ?? 2)
        : entryVal - riskDist * (settings?.emaPro?.tp2Rr ?? 2);
    const tp2Val = tp2Input.trim() ? Number(tp2Input) : roundToDigits(defaultTp2, priceDigits);

    if (!Number.isFinite(stopVal) || stopVal <= 0 || !Number.isFinite(tp2Val) || tp2Val <= 0) {
      setSubmitNotice({
        ok: false,
        text: 'Stop Loss and Target prices must be valid positive numbers.',
      });
      return;
    }
    if (side === 'BUY' && (stopVal >= entryVal || tp2Val <= entryVal)) {
      setSubmitNotice({
        ok: false,
        text: 'For BUY: Stop Loss must be below Entry and TP2 must be above Entry.',
      });
      return;
    }
    if (side === 'SELL' && (stopVal <= entryVal || tp2Val >= entryVal)) {
      setSubmitNotice({
        ok: false,
        text: 'For SELL: Stop Loss must be above Entry and TP2 must be below Entry.',
      });
      return;
    }

    const tp1Val = tp1Input.trim()
      ? Number(tp1Input)
      : roundToDigits(side === 'BUY' ? entryVal + riskDist : entryVal - riskDist, priceDigits);
    const tp3Val = tp3Input.trim()
      ? Number(tp3Input)
      : roundToDigits(side === 'BUY' ? entryVal + riskDist * 3 : entryVal - riskDist * 3, priceDigits);
    const lotsVal = Math.max(0.01, Number(lotsInput || 0.01));

    setIsSubmitting(true);
    try {
      const targetPrice = tp3Val ?? tp2Val;
      const res = await onLogTrade({
        session,
        strategyModule,
        symbol: settings?.emaPro?.xauusdSymbol || snapshot.config.symbol || 'GOLD',
        side,
        entry: entryVal,
        stop: stopVal,
        tp1: tp1Val,
        tp2: tp2Val,
        tp3: tp3Val,
        target: targetPrice,
        rrRatio: Math.round((Math.abs(targetPrice - entryVal) / riskDist) * 100) / 100,
        lots: lotsVal,
        riskDollars:
          Math.round(
            riskDist * lotsVal * (snapshot.bot?.symbolSpec?.contractSize ?? 100) * 100
          ) / 100,
        status: 'OPEN',
        executionMode: 'MANUAL',
        notes:
          notesInput.trim() ||
          `Manual EMA STOCHASTIC PRO ${side} (3-TP trailing SL)`,
        setupStatus: 'EMA_PRO Manual',
      });
      if (!res.ok) {
        setSubmitNotice({
          ok: false,
          text: res.error || 'Trade blocked by Gemini AI Confirmation Gate.',
        });
      } else {
        setNotesInput('');
        setSubmitNotice({
          ok: true,
          text: res.approval
            ? `Gemini AI Approved (${res.approval.confidencePct}%) · Trade logged.`
            : 'Trade logged.',
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify({ trades, signalHistory, tradeOrders }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gold-ai-trader-report-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Performance Dashboard: Signal Performance vs Actual Execution Performance */}
      <section className="border border-white/10 bg-[#111722] rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/8">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#E5B85C]" />
            <div>
              <h1 className="text-sm font-semibold text-slate-100">
                Performance Dashboard (EMA STOCHASTIC PRO)
              </h1>
              <p className="text-xs text-slate-400">
                Signal Analytics vs Verified Execution Performance · {snapshot.bot?.symbolSpec?.contractSize ?? 100}{' '}
                {(snapshot.bot?.symbolSpec?.currency ?? 'USD') === 'USC' ? 'cent-oz' : 'oz'} / 1.00 lot{' '}
                {snapshot.bot?.symbolSpec?.symbol ?? 'XAUUSD'}
              </p>
            </div>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-400">
            Trades Today: {levels?.totalTradesToday ?? 0}/{settings?.maxTradesPerDay ?? 10} · Loss Streak:{' '}
            {levels?.consecutiveLossesToday ?? 0}/{settings?.maxConsecutiveLosses ?? 3}
          </div>
        </div>

        {/* Separated Signal Performance & Actual Execution Performance */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="border border-white/8 bg-[#0B0F17] rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-sky-300">
                1. Signal Performance (Signals Only / AI Queue)
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                {perf?.totalSignals ?? signalHistory.length} Total Signals
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 font-mono tabular-nums text-xs">
              <div className="p-2.5 rounded bg-[#111722] border border-white/6">
                <div className="text-[10px] text-slate-400">AI Approved / Wait / Rej</div>
                <div className="mt-1 font-bold text-slate-100">
                  <span className="text-emerald-400">{perf?.approvedSignals ?? 0}</span> /{' '}
                  <span className="text-amber-300">{perf?.waitingSignals ?? 0}</span> /{' '}
                  <span className="text-red-400">{perf?.rejectedSignals ?? 0}</span>
                </div>
              </div>
              <div className="p-2.5 rounded bg-[#111722] border border-white/6">
                <div className="text-[10px] text-slate-400">Signal Win Rate</div>
                <div className="mt-1 font-bold text-sky-300">
                  {perf?.signalOnlyStats.count ? `${perf.signalOnlyStats.winRatePct.toFixed(1)}%` : '—'}
                </div>
              </div>
              <div className="p-2.5 rounded bg-[#111722] border border-white/6">
                <div className="text-[10px] text-slate-400">Signal Net P&amp;L</div>
                <div className="mt-1 font-bold text-slate-100">
                  {(perf?.signalOnlyStats.theoreticalNetDollars ?? 0) >= 0
                    ? `+$${(perf?.signalOnlyStats.theoreticalNetDollars ?? 0).toFixed(2)}`
                    : `-$${Math.abs(perf?.signalOnlyStats.theoreticalNetDollars ?? 0).toFixed(2)}`}
                </div>
              </div>
            </div>
          </div>

          <div className="border border-white/8 bg-[#0B0F17] rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                2. Actual Execution Performance (Filled Orders)
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                {perf?.actualExecutionStats.count ?? closedTrades.length} Executed Trades
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 font-mono tabular-nums text-xs">
              <div className="p-2.5 rounded bg-[#111722] border border-white/6">
                <div className="text-[10px] text-slate-400">Actual Win Rate</div>
                <div className="mt-1 font-bold text-emerald-300">
                  {closedTrades.length > 0
                    ? `${(perf?.actualExecutionStats.winRatePct ?? winRate).toFixed(1)}%`
                    : '—'}
                </div>
              </div>
              <div className="p-2.5 rounded bg-[#111722] border border-white/6">
                <div className="text-[10px] text-slate-400">Profit Factor / Avg RR</div>
                <div className="mt-1 font-bold text-[#E5B85C]">
                  {(perf?.profitFactor ?? 0).toFixed(2)} · {(perf?.averageRr ?? 0).toFixed(2)}R
                </div>
              </div>
              <div className="p-2.5 rounded bg-[#111722] border border-white/6">
                <div className="text-[10px] text-slate-400">Realized Net P&amp;L</div>
                <div
                  className={`mt-1 font-bold ${
                    (perf?.actualExecutionStats.netDollars ?? netPnl) >= 0
                      ? 'text-emerald-400'
                      : 'text-red-400'
                  }`}
                >
                  {(perf?.actualExecutionStats.netDollars ?? netPnl) >= 0
                    ? `+$${(perf?.actualExecutionStats.netDollars ?? netPnl).toFixed(2)}`
                    : `-$${Math.abs(perf?.actualExecutionStats.netDollars ?? netPnl).toFixed(2)}`}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Extended Metrics & Session/Condition Breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono tabular-nums text-xs">
          <div className="p-3 rounded border border-white/8 bg-[#0B0F17]">
            <div className="text-[10px] font-sans text-slate-400">Gross Profit</div>
            <div className="mt-1 font-bold text-emerald-400">+${(perf?.grossProfit ?? 0).toFixed(2)}</div>
          </div>
          <div className="p-3 rounded border border-white/8 bg-[#0B0F17]">
            <div className="text-[10px] font-sans text-slate-400">Gross Loss</div>
            <div className="mt-1 font-bold text-red-400">-${(perf?.grossLoss ?? 0).toFixed(2)}</div>
          </div>
          <div className="p-3 rounded border border-white/8 bg-[#0B0F17]">
            <div className="text-[10px] font-sans text-slate-400">Max Drawdown</div>
            <div className="mt-1 font-bold text-amber-300">{(perf?.maxDrawdownPct ?? 0).toFixed(2)}%</div>
          </div>
          <div className="p-3 rounded border border-white/8 bg-[#0B0F17]">
            <div className="text-[10px] font-sans text-slate-400">Avg Duration</div>
            <div className="mt-1 font-bold text-slate-100">{(perf?.avgTradeDurationMins ?? 0).toFixed(1)}m</div>
          </div>
          <div className="p-3 rounded border border-white/8 bg-[#0B0F17]">
            <div className="text-[10px] font-sans text-slate-400">Session Net (AS/LD/NY/OP)</div>
            <div className="mt-1 font-bold text-slate-200 text-[11px]">
              ${(perf?.bySession.ASIAN_SESSION.netProfit ?? 0).toFixed(0)} / $
              {(perf?.bySession.LONDON_SESSION.netProfit ?? 0).toFixed(0)} / $
              {(perf?.bySession.NEW_YORK_SESSION?.netProfit ?? 0).toFixed(0)} / $
              {(perf?.bySession.ALL_SESSIONS?.netProfit ?? 0).toFixed(0)}
            </div>
          </div>
          <div className="p-3 rounded border border-white/8 bg-[#0B0F17]">
            <div className="text-[10px] font-sans text-slate-400">Comm + Swap</div>
            <div className="mt-1 font-bold text-slate-300">
              ${((perf?.totalCommission ?? 0) + (perf?.totalSwap ?? 0)).toFixed(2)}
            </div>
          </div>
        </div>
      </section>

      {/* Quick Manual Trade Logger */}
      <form
        onSubmit={handleManualAdd}
        className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4"
      >
        <div className="flex items-center justify-between border-b border-white/8 pb-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-[#D4A853]" />
            <h2 className="text-sm font-semibold text-slate-100">
              Log EMA STOCHASTIC PRO Trade Execution
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-400">
            {liveBid !== null && liveAsk !== null
              ? `Bid $${liveBid.toFixed(priceDigits)} · Ask $${liveAsk.toFixed(priceDigits)}`
              : `Live Ref: ${livePrice > 0 ? `$${livePrice.toFixed(priceDigits)}` : '—'}`}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-3">
          <label className="block text-xs">
            <span className="text-slate-400">Session</span>
            <select
              value={session}
              onChange={(e) => setSession(e.target.value as TradingSessionTag)}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-100 focus:outline-none focus:border-[#D4A853]"
            >
              <option value="ASIAN_SESSION">Asian (03–11)</option>
              <option value="LONDON_SESSION">London (11–19)</option>
              <option value="NEW_YORK_SESSION">New York (19–00)</option>
              <option value="ALL_SESSIONS">Off-Peak (00–03)</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-slate-400">Side</span>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-100 focus:outline-none focus:border-[#D4A853]"
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-slate-400">Entry ({side === 'BUY' ? 'Ask' : 'Bid'})</span>
            <input
              type="number"
              step={snapshot.bot?.symbolSpec?.pointSize ?? 0.01}
              placeholder={livePrice > 0 ? livePrice.toFixed(priceDigits) : '3879.00'}
              value={entryInput}
              onChange={(e) => setEntryInput(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-400">Stop Loss</span>
            <input
              type="number"
              step="0.01"
              placeholder="Auto Swing/ATR"
              value={stopInput}
              onChange={(e) => setStopInput(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-400">TP1 (1:1)</span>
            <input
              type="number"
              step="0.01"
              placeholder="Auto 1:1"
              value={tp1Input}
              onChange={(e) => setTp1Input(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-400">TP2 (1:2)</span>
            <input
              type="number"
              step="0.01"
              placeholder="Auto 1:2"
              value={tp2Input}
              onChange={(e) => setTp2Input(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-400">TP3 (1:3)</span>
            <input
              type="number"
              step="0.01"
              placeholder="Auto 1:3"
              value={tp3Input}
              onChange={(e) => setTp3Input(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-400">Lots</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={lotsInput}
              onChange={(e) => setLotsInput(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={isSubmitting || isWeekend}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              {isWeekend ? 'Closed' : 'Add Entry'}
            </button>
          </div>
        </div>

        <input
          type="text"
          placeholder="Optional note (e.g. M5 EMA 9/21 pullback + Stoch cross + Bullish OB)"
          value={notesInput}
          onChange={(e) => setNotesInput(e.target.value)}
          className="w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-200 focus:outline-none focus:border-[#D4A853]"
        />
        {submitNotice && (
          <div
            role="alert"
            className={`px-3 py-2 rounded border text-xs ${
              submitNotice.ok
                ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                : 'border-red-500/45 bg-red-950/35 text-red-200'
            }`}
          >
            {submitNotice.text}
          </div>
        )}
      </form>

      {/* Section Sub-Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap gap-1 p-1 rounded-md border border-white/10 bg-[#0E131D] text-xs">
          <button
            type="button"
            onClick={() => setActiveSectionTab('trades')}
            className={`px-3 py-1.5 rounded font-medium transition-colors ${
              activeSectionTab === 'trades'
                ? 'bg-[#D4A853]/18 text-[#E5B85C] font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Trade Log ({trades.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSectionTab('signals')}
            className={`px-3 py-1.5 rounded font-medium transition-colors ${
              activeSectionTab === 'signals'
                ? 'bg-[#D4A853]/18 text-[#E5B85C] font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Signal Dashboard ({signalHistory.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSectionTab('orders')}
            className={`px-3 py-1.5 rounded font-medium transition-colors ${
              activeSectionTab === 'orders'
                ? 'bg-[#D4A853]/18 text-[#E5B85C] font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            TickerAll Orders ({tradeOrders.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSectionTab('risk')}
            className={`px-3 py-1.5 rounded font-medium transition-colors ${
              activeSectionTab === 'risk'
                ? 'bg-[#D4A853]/18 text-[#E5B85C] font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Risk &amp; Audit ({riskEvents.length + auditLogs.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportJson}
            disabled={trades.length === 0 && signalHistory.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-white/12 bg-[#0E131D] text-slate-300 hover:text-white disabled:opacity-40 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export JSON
          </button>
        </div>
      </div>

      {/* 1. TRADE EXECUTION LOG */}
      {activeSectionTab === 'trades' && (
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/8">
            <h3 className="text-sm font-semibold text-slate-100">
              Trade History &amp; 3-TP Trailing Stop Execution Log
            </h3>
            <button
              type="button"
              onClick={onClearTrades}
              disabled={trades.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-red-500/25 bg-red-950/20 text-red-300 hover:bg-red-950/40 disabled:opacity-40 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Log
            </button>
          </div>

          {trades.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              No trades logged yet. Confirmed signals or manual entries appear here with TP1/TP2/TP3 trailing SL tracking.
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-white/8">
                    <th className="pb-2.5 pr-3 font-medium">Date · Time</th>
                    <th className="pb-2.5 pr-3 font-medium">Exec</th>
                    <th className="pb-2.5 pr-3 font-medium">Session</th>
                    <th className="pb-2.5 pr-3 font-medium">Side</th>
                    <th className="pb-2.5 pr-3 font-medium">Lot</th>
                    <th className="pb-2.5 pr-3 font-medium">Entry</th>
                    <th className="pb-2.5 pr-3 font-medium">SL</th>
                    <th className="pb-2.5 pr-3 font-medium">TP1</th>
                    <th className="pb-2.5 pr-3 font-medium">TP2</th>
                    <th className="pb-2.5 pr-3 font-medium">TP3</th>
                    <th className="pb-2.5 pr-3 font-medium">AI Gate</th>
                    <th className="pb-2.5 pr-3 font-medium">Status</th>
                    <th className="pb-2.5 pr-3 font-medium">Net P&amp;L</th>
                    <th className="pb-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6 font-mono tabular-nums">
                  {trades.map((tr) => (
                    <tr key={tr.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 pr-3 text-slate-300 whitespace-nowrap">
                        {tr.dateLusaka} {tr.timeLusaka}
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                            tr.executionMode === 'AUTO'
                              ? 'border-[#D4A853]/40 bg-[#D4A853]/12 text-[#E5B85C]'
                              : 'border-white/15 bg-white/[0.04] text-slate-300'
                          }`}
                        >
                          {tr.executionStatus ?? tr.executionMode ?? 'MANUAL'}
                        </span>
                      </td>
                      <td className="py-3 pr-3 font-sans text-slate-200 whitespace-nowrap">
                        <div>{formatSessionLabel(tr.session)}</div>
                        <div className="text-[10px] font-mono text-slate-400">{tr.symbol || 'XAUUSD'}</div>
                      </td>
                      <td className="py-3 pr-3">
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[11px] font-semibold ${
                            tr.side === 'BUY'
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                              : 'border-red-500/30 bg-red-500/10 text-red-300'
                          }`}
                        >
                          {tr.side}
                        </span>
                      </td>
                      <td className="py-3 pr-3 text-[#E5B85C] font-semibold">
                        {isNum(tr.lots) ? tr.lots.toFixed(2) : '—'}
                      </td>
                      <td className="py-3 pr-3 text-slate-100">
                        {isNum(tr.entry) ? formatRowPrice(tr.entry, tr.symbol, priceDigits) : '—'}
                      </td>
                      <td className="py-3 pr-3 text-red-300 whitespace-nowrap">
                        {isNum(tr.stop) ? formatRowPrice(tr.stop, tr.symbol, priceDigits) : '—'}
                        {tr.tp2Hit ? ' (TP2 Lock)' : tr.tp1Hit ? ' (TP1 Lock)' : tr.breakevenMoved ? ' (BE)' : ''}
                      </td>
                      <td className="py-3 pr-3 text-sky-300 whitespace-nowrap">
                        {isNum(tr.tp1) ? formatRowPrice(tr.tp1, tr.symbol, priceDigits) : '—'}
                        {tr.tp1Hit ? ' ✓' : ''}
                      </td>
                      <td className="py-3 pr-3 text-emerald-300 whitespace-nowrap">
                        {isNum(tr.tp2) ? formatRowPrice(tr.tp2, tr.symbol, priceDigits) : '—'}
                        {tr.tp2Hit ? ' ✓' : ''}
                      </td>
                      <td className="py-3 pr-3 text-violet-300 whitespace-nowrap">
                        {isNum(tr.tp3)
                          ? formatRowPrice(tr.tp3, tr.symbol, priceDigits)
                          : isNum(tr.target)
                            ? formatRowPrice(tr.target, tr.symbol, priceDigits)
                            : '—'}
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        {tr.aiApproval ? (
                          <span
                            title={tr.aiApproval.summary}
                            className="px-1.5 py-0.5 rounded border border-emerald-500/35 bg-emerald-500/10 text-[10px] font-semibold text-emerald-300"
                          >
                            {tr.aiApproval.confidencePct}%
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-500">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[11px] ${
                            tr.status === 'TP_HIT'
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                              : tr.status === 'SL_HIT'
                                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                                : tr.status === 'OPEN'
                                  ? 'border-[#D4A853]/30 bg-[#D4A853]/10 text-[#E5B85C]'
                                  : 'border-white/15 bg-white/[0.04] text-slate-300'
                          }`}
                        >
                          {tr.status}
                        </span>
                      </td>
                      <td
                        className={`py-3 pr-3 font-semibold ${
                          (tr.pnlDollars ?? 0) > 0
                            ? 'text-emerald-400'
                            : (tr.pnlDollars ?? 0) < 0
                              ? 'text-red-400'
                              : 'text-slate-400'
                        }`}
                      >
                        {isNum(tr.pnlDollars)
                          ? `${tr.pnlDollars >= 0 ? '+' : '-'}$${Math.abs(tr.pnlDollars).toFixed(2)}`
                          : '—'}
                      </td>
                      <td className="py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {tr.status === 'SIGNALED' && (
                            <button
                              type="button"
                              onClick={() => onUpdateTradeStatus(tr.id, 'OPEN')}
                              className="px-2 py-1 rounded border border-[#D4A853]/30 text-[11px] text-[#E5B85C] hover:bg-[#D4A853]/10"
                            >
                              Open
                            </button>
                          )}
                          {(tr.status === 'SIGNALED' || tr.status === 'OPEN') && (
                            <>
                              <button
                                type="button"
                                title="Mark Target Hit"
                                onClick={() =>
                                  onUpdateTradeStatus(tr.id, 'TP_HIT', tr.tp3 ?? tr.tp2 ?? tr.target)
                                }
                                className="p-1 rounded border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                              >
                                <Check className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                title="Mark SL Hit"
                                onClick={() => onUpdateTradeStatus(tr.id, 'SL_HIT', tr.stop)}
                                className="p-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10"
                              >
                                <X className="w-3 h-3" />
                              </button>
                              {livePrice > 0 && (
                                <button
                                  type="button"
                                  onClick={() => onUpdateTradeStatus(tr.id, 'CLOSED', livePrice)}
                                  className="px-2 py-1 rounded border border-white/15 text-[11px] text-slate-300 hover:bg-white/5"
                                >
                                  Close
                                </button>
                              )}
                            </>
                          )}
                          <button
                            type="button"
                            title="Delete entry"
                            onClick={() => onDeleteTrade(tr.id)}
                            className="p-1 text-slate-500 hover:text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 2. SIGNAL DASHBOARD TABLE */}
      {activeSectionTab === 'signals' && (
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/8">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Signal Dashboard (EMA · Stochastic · SMC · AI Confirmation)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Every candidate BUY/SELL signal and blocked/waiting evaluation with full indicator evidence.
              </p>
            </div>
            <button
              type="button"
              onClick={onClearSignals}
              disabled={signalHistory.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-red-500/25 bg-red-950/20 text-red-300 hover:bg-red-950/40 disabled:opacity-40 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Signal History
            </button>
          </div>

          {signalHistory.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              No signals recorded yet for this session.
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-white/8">
                    <th className="pb-2.5 pr-3 font-medium">Signal ID · Time</th>
                    <th className="pb-2.5 pr-3 font-medium">Side</th>
                    <th className="pb-2.5 pr-3 font-medium">Entry</th>
                    <th className="pb-2.5 pr-3 font-medium">SL</th>
                    <th className="pb-2.5 pr-3 font-medium">TP1 / TP2 / TP3</th>
                    <th className="pb-2.5 pr-3 font-medium">EMA &amp; Stoch</th>
                    <th className="pb-2.5 pr-3 font-medium">SMC Evidence</th>
                    <th className="pb-2.5 pr-3 font-medium">AI</th>
                    <th className="pb-2.5 font-medium">Status / Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6 font-mono tabular-nums">
                  {signalHistory.map((sig) => (
                    <tr key={sig.id} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 pr-3 text-slate-300 whitespace-nowrap">
                        <div className="text-[11px] text-slate-200">{sig.lusakaTime}</div>
                        <div className="text-[10px] text-slate-500 truncate max-w-[120px]" title={sig.id}>
                          {sig.id}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[11px] font-semibold ${
                              sig.action === 'BUY'
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : sig.action === 'SELL'
                                  ? 'border-red-500/30 bg-red-500/10 text-red-300'
                                  : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            }`}
                          >
                            {sig.action}
                          </span>
                          {sig.symbol && (
                            <span className="text-[10px] text-slate-400">{sig.symbol}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-100">
                        {isNum(sig.price) ? formatRowPrice(sig.price, sig.symbol, priceDigits) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-red-300">
                        {isNum(sig.stop) ? formatRowPrice(sig.stop, sig.symbol, priceDigits) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-emerald-300 whitespace-nowrap">
                        {isNum(sig.tp1) ? formatRowPrice(sig.tp1, sig.symbol, priceDigits) : '—'} /{' '}
                        {isNum(sig.tp2) ? formatRowPrice(sig.tp2, sig.symbol, priceDigits) : '—'} /{' '}
                        {isNum(sig.tp3) ? formatRowPrice(sig.tp3, sig.symbol, priceDigits) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 font-sans text-[11px] text-slate-300 max-w-[180px] truncate" title={`${sig.emaAlignment || ''} | ${sig.stochReading || ''}`}>
                        {sig.emaAlignment || sig.setupStatus || 'EMA PRO'}
                        {sig.stochReading ? ` · ${sig.stochReading}` : ''}
                      </td>
                      <td className="py-2.5 pr-3 font-sans text-[11px] text-slate-400 max-w-[170px] truncate" title={sig.smcEvidence}>
                        {sig.smcEvidence || '—'}
                      </td>
                      <td className="py-2.5 pr-3">
                        {sig.aiConfidence !== null && sig.aiConfidence !== undefined
                          ? `${sig.aiConfidence}%`
                          : '—'}
                      </td>
                      <td className="py-2.5 font-sans text-slate-300">
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 mr-1.5">
                          {sig.signalStatus ?? sig.action}
                        </span>
                        {sig.blockReason || 'Signal validated'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 3. TICKERALL ORDER EXECUTION ADAPTER LOG */}
      {activeSectionTab === 'orders' && (
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-3">
          <div className="border-b border-white/8 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">
              TickerAll Execution Adapter Orders (Idempotent MT5 Broker Dispatch)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Tracks every automatic execution attempt, idempotency key, adapter used (BROKER_BRIDGE / DEMO_PAPER / NONE), fill price, and broker status.
            </p>
          </div>
          {tradeOrders.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              No execution adapter orders dispatched yet. In SIGNALS ONLY mode no orders are submitted.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono tabular-nums">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-white/8 font-sans">
                    <th className="pb-2.5 pr-3">Time</th>
                    <th className="pb-2.5 pr-3">Signal ID</th>
                    <th className="pb-2.5 pr-3">Env · Adapter</th>
                    <th className="pb-2.5 pr-3">Side · Lots</th>
                    <th className="pb-2.5 pr-3">Req → Fill</th>
                    <th className="pb-2.5 pr-3">Status</th>
                    <th className="pb-2.5">Broker Order / Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {tradeOrders.map((ord) => (
                    <tr key={ord.id}>
                      <td className="py-2.5 pr-3 text-slate-300">{ord.lusakaTime}</td>
                      <td className="py-2.5 pr-3 text-slate-400 truncate max-w-[130px]">{ord.signalId}</td>
                      <td className="py-2.5 pr-3 text-slate-200">
                        {ord.environment} · {ord.adapterUsed}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={ord.side === 'BUY' ? 'text-emerald-300' : 'text-red-300'}>
                          {ord.side}
                        </span>{' '}
                        <span className="text-slate-300">{ord.symbol}</span>{' '}
                        {isNum(ord.lots) ? ord.lots.toFixed(2) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-200">
                        {isNum(ord.requestedEntry) ? formatRowPrice(ord.requestedEntry, ord.symbol, priceDigits) : '—'} →{' '}
                        {isNum(ord.actualFillPrice) ? formatRowPrice(ord.actualFillPrice, ord.symbol, priceDigits) : '—'}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[10px] ${
                            ord.status === 'FILLED' || ord.status === 'DEMO_SIMULATED'
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                          }`}
                        >
                          {ord.status}
                        </span>
                      </td>
                      <td className="py-2.5 font-sans text-slate-400">
                        {ord.brokerOrderId || ord.errorMessage || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 4. RISK EVENTS & SETTINGS AUDIT LOG */}
      {activeSectionTab === 'risk' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-3">
            <div className="flex items-center gap-2 border-b border-white/8 pb-3">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-slate-100">Risk Events &amp; Guards</h3>
            </div>
            {riskEvents.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-400">No risk limit triggers recorded.</p>
            ) : (
              <div className="space-y-2 max-h-[380px] overflow-y-auto">
                {riskEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className="p-3 rounded border border-white/8 bg-[#0B0F17] text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between font-mono">
                      <span
                        className={`font-semibold ${
                          ev.severity === 'CRITICAL'
                            ? 'text-red-400'
                            : ev.severity === 'WARNING'
                              ? 'text-amber-300'
                              : 'text-sky-300'
                        }`}
                      >
                        {ev.category}
                      </span>
                      <span className="text-slate-400">{ev.lusakaTime}</span>
                    </div>
                    <p className="text-slate-300">{ev.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-3">
            <div className="flex items-center gap-2 border-b border-white/8 pb-3">
              <FileText className="w-4 h-4 text-[#E5B85C]" />
              <h3 className="text-sm font-semibold text-slate-100">Settings &amp; Control Audit Log</h3>
            </div>
            {auditLogs.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-400">No settings or control audit entries yet.</p>
            ) : (
              <div className="space-y-2 max-h-[380px] overflow-y-auto">
                {auditLogs.map((aud) => (
                  <div
                    key={aud.id}
                    className="p-3 rounded border border-white/8 bg-[#0B0F17] text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span className="text-[#E5B85C] font-semibold">
                        v{aud.version} · {aud.action}
                      </span>
                      <span className="text-slate-400">
                        {new Date(aud.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-slate-300">{aud.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
