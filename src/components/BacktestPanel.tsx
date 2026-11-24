import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Clock,
  Download,
  History,
  RefreshCw,
} from 'lucide-react';
import type {
  BacktestEquityPoint,
  BacktestSummary,
  BacktestTradeResult,
  StrategySettings,
} from '../types/connectivity';

interface BacktestPanelProps {
  settings: StrategySettings;
  isWeekend: boolean;
  m15HistoryCount: number;
  startingBalance?: number;
  masterFeedLive?: boolean;
}

const PERIOD_OPTIONS: Array<{ days: 30 | 90 | 180; label: string }> = [
  { days: 30, label: 'Last 30 Days' },
  { days: 90, label: 'Last 90 Days' },
  { days: 180, label: 'Last 6 Months' },
];

const BALANCE_PRESETS: Array<100 | 138 | 200 | 500> = [100, 138, 200, 500];

function csvEscape(val: string | number | null | undefined): string {
  const str = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function RealEquityCurveChart({
  points,
  startingBalance,
}: {
  points: BacktestEquityPoint[];
  startingBalance: number;
}) {
  if (!points || points.length < 2) {
    return (
      <div className="border border-white/8 bg-[#0B0F17] rounded-lg p-4 text-xs text-slate-400 font-mono">
        0 executed EMA STOCHASTIC PRO trades on real TickerAll candles — Real Equity Curve remains flat at $
        {startingBalance.toFixed(2)}.
      </div>
    );
  }

  const width = 760;
  const height = 190;
  const padX = 44;
  const padY = 20;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const balances = points.map((p) => p.balance);
  const minBal = Math.min(...balances, startingBalance);
  const maxBal = Math.max(...balances, startingBalance);
  const span = Math.max(1, maxBal - minBal);

  const coords = points.map((pt, idx) => {
    const x =
      points.length === 1
        ? padX
        : padX + (idx / (points.length - 1)) * innerW;
    const y = padY + (1 - (pt.balance - minBal) / span) * innerH;
    return { x, y, pt };
  });

  const linePath = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(padY + innerH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padY + innerH).toFixed(1)} Z`;

  const lastBal = points[points.length - 1].balance;
  const isPositive = lastBal >= startingBalance;
  const strokeColor = isPositive ? '#34D399' : '#F87171';

  const startY = padY + (1 - (startingBalance - minBal) / span) * innerH;

  return (
    <div className="border border-white/8 bg-[#0B0F17] rounded-lg p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-slate-200">
          Real EMA STOCHASTIC PRO Equity Curve (From Real TickerAll Trades Only)
        </span>
        <span className="font-mono tabular-nums text-slate-400">
          Start ${startingBalance.toFixed(2)} → End{' '}
          <strong className={isPositive ? 'text-emerald-400' : 'text-red-400'}>
            ${lastBal.toFixed(2)}
          </strong>
        </span>
      </div>
      <div className="w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-44 select-none"
          role="img"
          aria-label="Real Equity Curve Chart"
        >
          <defs>
            <linearGradient id="realEqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          <line
            x1={padX}
            x2={width - padX}
            y1={startY}
            y2={startY}
            stroke="rgba(255,255,255,0.16)"
            strokeDasharray="4 4"
            strokeWidth="1"
          />

          <text
            x={padX - 6}
            y={padY + 4}
            textAnchor="end"
            fill="#94a3b8"
            fontSize="10"
            fontFamily="monospace"
          >
            ${maxBal.toFixed(0)}
          </text>
          <text
            x={padX - 6}
            y={padY + innerH}
            textAnchor="end"
            fill="#94a3b8"
            fontSize="10"
            fontFamily="monospace"
          >
            ${minBal.toFixed(0)}
          </text>

          <path d={areaPath} fill="url(#realEqGrad)" />
          <path
            d={linePath}
            fill="none"
            stroke={strokeColor}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {coords.map((c) => (
            <circle
              key={`${c.pt.index}-${c.pt.timestampMs}`}
              cx={c.x}
              cy={c.y}
              r="3"
              fill={strokeColor}
            >
              <title>
                {`${c.pt.dateLusaka} ${c.pt.timeLusaka} | $${c.pt.balance.toFixed(2)} (${c.pt.label})`}
              </title>
            </circle>
          ))}
        </svg>
      </div>
    </div>
  );
}

export function BacktestPanel({
  settings,
  isWeekend,
  m15HistoryCount,
  startingBalance = 138,
  masterFeedLive = false,
}: BacktestPanelProps) {
  const defaultPreset: 100 | 138 | 200 | 500 =
    startingBalance >= 450
      ? 500
      : startingBalance >= 180
        ? 200
        : startingBalance >= 120
          ? 138
          : 100;

  const [periodDays, setPeriodDays] = useState<30 | 90 | 180>(30);
  const [selectedStartBal, setSelectedStartBal] = useState<number>(defaultPreset);
  const [listFilter, setListFilter] = useState<'ALL' | 'EXECUTED' | 'BLOCKED'>('ALL');
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const runRealBacktest = useCallback(
    async (mode: 'run' | 'refresh', nextPeriod = periodDays, nextBal = selectedStartBal) => {
      if (mode === 'refresh') {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setFetchError(null);
      try {
        const endpoint = mode === 'refresh' ? '/api/backtest/refresh' : '/api/backtest/run';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            periodDays: nextPeriod,
            startingBalance: nextBal,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          summary?: BacktestSummary;
          error?: string;
        };
        if (!res.ok || !data.summary) {
          setSummary(null);
          setFetchError(data.error || 'No Real Data - Connect Master Feed First');
        } else {
          setSummary(data.summary);
        }
      } catch {
        setSummary(null);
        setFetchError('No Real Data - Connect Master Feed First');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [periodDays, selectedStartBal]
  );

  useEffect(() => {
    void runRealBacktest('run', periodDays, selectedStartBal);
  }, [runRealBacktest, periodDays, selectedStartBal]);

  const visibleRows: BacktestTradeResult[] =
    summary && summary.hasRealData
      ? listFilter === 'EXECUTED'
        ? summary.trades
        : listFilter === 'BLOCKED'
          ? summary.blockedEntries
          : summary.allEntries
      : [];

  const handleExportCsv = () => {
    if (!summary || !summary.hasRealData) return;
    const headers = [
      'Date_Lusaka',
      'Time_Lusaka',
      'Session',
      'Side',
      'Status',
      'Lot_Used',
      'Bal_Before',
      'Bal_After',
      'PnL_USD',
      'Entry_Real',
      'Stop_Loss',
      'TP1',
      'TP2',
      'TP3',
      'Exit',
      'Outcome',
      'Result_R',
      'Setup_Status',
      'Reason',
    ];

    const lines = [
      headers.join(','),
      ...summary.allEntries.map((row) =>
        [
          row.dateLusaka,
          row.timeLusaka,
          row.session,
          row.side,
          row.status,
          row.lotsUsed.toFixed(2),
          row.balanceBefore.toFixed(2),
          row.balanceAfter.toFixed(2),
          row.pnlDollars.toFixed(2),
          row.entry.toFixed(2),
          row.stop.toFixed(2),
          row.tp1.toFixed(2),
          row.tp2.toFixed(2),
          row.tp3 !== undefined ? row.tp3.toFixed(2) : '',
          row.exit.toFixed(2),
          row.outcome,
          row.pnlR.toFixed(2),
          row.setupStatus,
          row.reason || row.blockReason,
        ]
          .map(csvEscape)
          .join(',')
      ),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gold-ai-trader-ema-pro-backtest-${summary.periodDays}d.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const lastUpdatedLabel = summary?.lastUpdatedAt
    ? new Date(summary.lastUpdatedAt).toLocaleString()
    : 'Not Updated Yet';

  return (
    <section
      aria-label="Real TickerAll Historical Backtest"
      className="border border-[#D4A853]/30 bg-[#111722] rounded-lg p-5 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/8 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-[#E5B85C]" />
            <h2 className="text-base font-display font-bold text-slate-50">
              EMA STOCHASTIC PRO Backtest — Real TickerAll XAUUSD History
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            H1/M15/M5 EMA 9·21·50·200 + Stochastic (14,3,3) + Non-Repainting SMC · Swing+ATR(14) SL · TP1 1:1 / TP2 1:2 / TP3 1:3 Trailing SL · Risk {settings.riskPercent}% · Max {settings.maxTradesPerDay}/day
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={loading || refreshing}
            onClick={() => void runRealBacktest('refresh', periodDays, selectedStartBal)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing from TickerAll...' : 'Refresh Real Backtest'}
          </button>

          <button
            type="button"
            disabled={!summary || !summary.hasRealData}
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-white/12 bg-[#161E2E] text-slate-100 hover:border-[#D4A853]/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5 text-[#E5B85C]" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Period Selector (30D / 90D / 6M) + Starting Balance ($100 / $138 / $200 / $500) */}
      <div className="p-3.5 rounded-md border border-white/8 bg-[#0B0F17] flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400">Timeframe:</span>
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              onClick={() => setPeriodDays(opt.days)}
              className={`px-3 py-1.5 rounded text-xs font-mono transition-colors whitespace-nowrap shrink-0 border ${
                periodDays === opt.days
                  ? 'border-[#D4A853]/60 bg-[#D4A853]/15 text-[#E5B85C] font-semibold'
                  : 'border-white/10 bg-[#111722] text-slate-400 hover:text-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400">Starting Balance:</span>
          {BALANCE_PRESETS.map((bal) => (
            <button
              key={bal}
              type="button"
              onClick={() => setSelectedStartBal(bal)}
              className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors whitespace-nowrap shrink-0 border ${
                selectedStartBal === bal
                  ? 'border-[#D4A853]/60 bg-[#D4A853]/15 text-[#E5B85C] font-semibold'
                  : 'border-white/10 bg-[#111722] text-slate-400 hover:text-slate-200'
              }`}
            >
              ${bal}
            </button>
          ))}
        </div>
      </div>

      {/* Required Timestamp & Source Stamp */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 rounded-md border border-white/8 bg-[#0B0F17] text-xs font-mono tabular-nums">
        <div className="flex items-center gap-2 text-slate-200">
          <Clock className="w-3.5 h-3.5 text-[#D4A853]" />
          <span>Data Source: TickerAll LIVE Feed - Last Updated: {lastUpdatedLabel}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <History className="w-3.5 h-3.5 text-[#D4A853]" />
            {summary?.m5CandlesCount ? `M5: ${summary.m5CandlesCount} · ` : ''}
            M15: {summary?.m15CandlesCount ?? m15HistoryCount} · H1: {summary?.h1CandlesCount ?? 0}
          </span>
          {summary?.assumptions && (
            <span className="text-slate-400">
              Spread {summary.assumptions.spreadPips}p · Slip {summary.assumptions.slippagePips}p · Comm ${summary.assumptions.commissionPerLot}/lot
            </span>
          )}
          <span className={masterFeedLive ? 'text-emerald-400' : 'text-amber-300'}>
            {isWeekend ? 'Weekend (Cached History Only)' : masterFeedLive ? 'Feed: Live' : 'Feed Offline'}
          </span>
        </div>
      </div>

      {/* Strict No-Fake-Data Gate */}
      {loading && !summary ? (
        <div className="py-8 text-center text-xs text-slate-300 border border-white/8 rounded-md bg-[#0B0F17]/60">
          Loading real TickerAll historical candles and running EMA STOCHASTIC PRO evaluation...
        </div>
      ) : fetchError || !summary || !summary.hasRealData ? (
        <div
          role="alert"
          className="p-5 border border-amber-500/40 bg-amber-950/20 rounded-md flex items-start gap-3"
        >
          <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="text-sm font-semibold text-amber-200">
              {fetchError || summary?.errorMessage || 'No Real Data - Connect Master Feed First'}
            </div>
            <p className="text-xs text-slate-300">
              Backtest strictly uses real XAUUSD/GOLD candles from the Admin Master TickerAll Feed. No simulated, demo, or random trades will ever be generated.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Real Results Summary KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 border border-white/8 bg-[#0B0F17] rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-white/8 font-mono tabular-nums">
            <div className="p-3.5">
              <div className="text-[11px] font-sans text-slate-400">Total Trades</div>
              <div className="mt-1 text-xl font-bold text-slate-50">
                {summary.totalTrades}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                {summary.tp1PartialsHit} hit TP1
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] font-sans text-slate-400">Wins / Losses / Win %</div>
              <div className="mt-1 text-lg font-bold text-slate-100">
                <span className="text-emerald-400">{summary.wins}</span>
                <span className="text-slate-500"> / </span>
                <span className="text-red-400">{summary.losses}</span>
              </div>
              <div className="text-xs font-semibold text-[#E5B85C] mt-0.5">
                {summary.winRatePct.toFixed(1)}% Win Rate
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] font-sans text-slate-400">Net Profit &amp; PF</div>
              <div className={`mt-1 text-lg font-bold ${summary.netProfitDollars >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {summary.netProfitDollars >= 0
                  ? `+$${summary.netProfitDollars.toFixed(2)}`
                  : `-$${Math.abs(summary.netProfitDollars).toFixed(2)}`}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                PF {(summary.profitFactor ?? 0).toFixed(2)} · Avg {summary.avgRr !== undefined ? `${summary.avgRr.toFixed(2)}R` : '—'}
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] font-sans text-slate-400">Total Loss $</div>
              <div className="mt-1 text-lg font-bold text-red-400">
                -${summary.totalLossDollars.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                Net R: {summary.netR >= 0 ? `+${summary.netR.toFixed(2)}R` : `${summary.netR.toFixed(2)}R`}
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] font-sans text-slate-400">Largest Win / Loss</div>
              <div className="mt-1 text-sm font-bold text-emerald-400">
                +${summary.largestWinDollars.toFixed(2)}
              </div>
              <div className="text-sm font-bold text-red-400">
                -${summary.largestLossDollars.toFixed(2)}
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] font-sans text-slate-400">Max Drawdown %</div>
              <div className="mt-1 text-xl font-bold text-amber-300">
                {summary.maxDrawdownPct.toFixed(2)}%
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                {settings.maxConsecutiveLosses}-Loss Pause
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] font-sans text-slate-400">End Balance</div>
              <div
                className={`mt-1 text-lg font-bold ${
                  summary.endingBalance >= summary.startingBalance
                    ? 'text-emerald-400'
                    : 'text-red-400'
                }`}
              >
                ${summary.endingBalance.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                From ${summary.startingBalance.toFixed(0)} ({summary.balanceGrowthPct >= 0 ? '+' : ''}
                {summary.balanceGrowthPct.toFixed(1)}%)
              </div>
            </div>
          </div>

          {/* Train (60%) / Validation (20%) / Out-of-Sample (20%) Split Comparison */}
          {summary.splits && summary.splits.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {summary.splits.map((sp) => (
                <div
                  key={sp.label}
                  className="border border-white/8 bg-[#0B0F17] rounded-lg p-3.5 font-mono tabular-nums"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-sans font-semibold text-slate-200">{sp.label}</span>
                    <span className="text-[11px] text-slate-400">{sp.candlesCount} bars</span>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-sm font-bold text-slate-100">
                      {sp.trades} trades · {sp.winRatePct.toFixed(1)}%
                    </span>
                    <span
                      className={`text-sm font-bold ${
                        sp.netProfitDollars >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {sp.netProfitDollars >= 0
                        ? `+$${sp.netProfitDollars.toFixed(2)}`
                        : `-$${Math.abs(sp.netProfitDollars).toFixed(2)}`}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                    <span>PF {sp.profitFactor.toFixed(2)}</span>
                    <span>Max DD {sp.maxDrawdownPct.toFixed(2)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Legacy Rigid 45-Point vs All-Session Dynamic Spread Filter Comparison */}
          {summary.spreadComparison && (
            <div className="border border-[#D4A853]/30 bg-[#0B0F17] rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#E5B85C]">
                    Spread Filter Comparison: Legacy Rigid 45-Point vs All-Session Dynamic
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {summary.spreadComparison.disclaimer}
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded border border-white/12 bg-[#111722] text-[10px] font-mono text-slate-300">
                  {summary.spreadComparison.dataMode}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-white/8">
                      <th className="py-2 pr-3 font-sans">Filter Model</th>
                      <th className="py-2 pr-3 text-right">Signals</th>
                      <th className="py-2 pr-3 text-right">Rejected (Spread)</th>
                      <th className="py-2 pr-3 text-right">Accepted</th>
                      <th className="py-2 pr-3 text-right">&gt;45p Saved</th>
                      <th className="py-2 pr-3 text-right">Win %</th>
                      <th className="py-2 pr-3 text-right">Net Profit</th>
                      <th className="py-2 pr-3 text-right">Total Costs</th>
                      <th className="py-2 pr-3 text-right">Max DD</th>
                      <th className="py-2 pr-3 text-right">PF</th>
                      <th className="py-2 text-right">Avg Entry Spr</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/6">
                    {[summary.spreadComparison.legacyRigid45, summary.spreadComparison.dynamicAllSession].map(
                      (row, idx) => (
                        <tr
                          key={row.label}
                          className={idx === 1 ? 'bg-emerald-950/15' : 'bg-transparent'}
                        >
                          <td className="py-2.5 pr-3 font-sans font-semibold text-slate-100 whitespace-nowrap">
                            {row.label}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-slate-200">
                            {row.qualifiedOpportunities}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-amber-300">
                            {row.rejectedBySpread}
                          </td>
                          <td className="py-2.5 pr-3 text-right font-semibold text-slate-100">
                            {row.tradesAccepted}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-[#E5B85C]">
                            {row.acceptedAbove45Points}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-slate-200">
                            {row.winRatePct.toFixed(1)}%
                          </td>
                          <td
                            className={`py-2.5 pr-3 text-right font-bold ${
                              row.netProfitDollars >= 0 ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {row.netProfitDollars >= 0
                              ? `+$${row.netProfitDollars.toFixed(2)}`
                              : `-$${Math.abs(row.netProfitDollars).toFixed(2)}`}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-slate-400">
                            ${row.totalCostsDollars.toFixed(2)}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-amber-300">
                            {row.maxDrawdownPct.toFixed(2)}%
                          </td>
                          <td className="py-2.5 pr-3 text-right text-slate-200">
                            {row.profitFactor.toFixed(2)}
                          </td>
                          <td className="py-2.5 text-right text-slate-300">
                            {row.avgSpreadAtEntryPoints.toFixed(1)}p
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Real Equity Curve from Real Trades Only */}
          <RealEquityCurveChart
            points={summary.equityCurve}
            startingBalance={summary.startingBalance}
          />

          {/* Filter Tabs for Real Trade Log */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-white/10 rounded-md text-xs">
              <button
                type="button"
                onClick={() => setListFilter('ALL')}
                className={`px-3 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                  listFilter === 'ALL'
                    ? 'bg-white/10 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All ({summary.allEntries.length})
              </button>
              <button
                type="button"
                onClick={() => setListFilter('EXECUTED')}
                className={`px-3 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                  listFilter === 'EXECUTED'
                    ? 'bg-white/10 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Executed Trades ({summary.trades.length})
              </button>
              <button
                type="button"
                onClick={() => setListFilter('BLOCKED')}
                className={`px-3 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                  listFilter === 'BLOCKED'
                    ? 'bg-amber-500/20 text-amber-200'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Skipped / No-Trade ({summary.blockedEntries.length})
              </button>
            </div>

            <span className="text-xs text-slate-400 font-mono">
              {summary.candlesTested.toLocaleString()} real bars · {summary.skippedSetupsCount} skipped / unconfirmed
            </span>
          </div>

          {/* Real Trade Log Table */}
          {visibleRows.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400 border border-white/8 rounded-md bg-[#0B0F17]">
              No matching setups recorded in the {summary.periodLabel} TickerAll window.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[540px] overflow-y-auto border border-white/8 rounded-md bg-[#0B0F17]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10">
                  <tr className="text-left text-slate-400 border-b border-white/8 bg-[#0E131D]">
                    <th className="py-2.5 px-3 font-medium">Date / Time</th>
                    <th className="py-2.5 px-3 font-medium">Session</th>
                    <th className="py-2.5 px-3 font-medium">Side · Lot</th>
                    <th className="py-2.5 px-3 font-medium">Entry (Real)</th>
                    <th className="py-2.5 px-3 font-medium">SL</th>
                    <th className="py-2.5 px-3 font-medium">TP1</th>
                    <th className="py-2.5 px-3 font-medium">TP2</th>
                    <th className="py-2.5 px-3 font-medium">TP3</th>
                    <th className="py-2.5 px-3 font-medium">Result</th>
                    <th className="py-2.5 px-3 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6 font-mono tabular-nums">
                  {visibleRows.map((tr) => {
                    const isBlocked = tr.status === 'BLOCKED';
                    return (
                      <tr
                        key={tr.id}
                        className={
                          isBlocked
                            ? 'bg-amber-950/10 hover:bg-amber-950/20'
                            : 'hover:bg-white/[0.02]'
                        }
                      >
                        <td className="py-2.5 px-3 text-slate-300 whitespace-nowrap">
                          {tr.dateLusaka} {tr.timeLusaka}
                        </td>
                        <td className="py-2.5 px-3 font-sans text-slate-200 whitespace-nowrap">
                          {tr.session === 'ASIAN_SESSION'
                            ? 'Asian'
                            : tr.session === 'LONDON_SESSION'
                              ? 'London'
                              : tr.session === 'NEW_YORK_SESSION'
                                ? 'New York'
                                : 'Off-Peak'}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span
                            className={`font-semibold ${
                              tr.side === 'BUY' ? 'text-emerald-300' : 'text-red-300'
                            }`}
                          >
                            {tr.side}
                          </span>
                          <span className="ml-1.5 text-[#E5B85C]">{tr.lotsUsed.toFixed(2)}</span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-100">${tr.entry.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-red-300">${tr.stop.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-sky-300">${tr.tp1.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-emerald-300">${tr.tp2.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-violet-300">
                          {tr.tp3 !== undefined ? `$${tr.tp3.toFixed(2)}` : '—'}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {isBlocked ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-200 font-semibold">
                              SKIPPED
                            </span>
                          ) : (
                            <span
                              className={`font-semibold ${
                                tr.outcome === 'WIN' ? 'text-emerald-400' : 'text-red-400'
                              }`}
                            >
                              {tr.outcome} ({tr.pnlDollars >= 0 ? `+$${tr.pnlDollars.toFixed(2)}` : `-$${Math.abs(tr.pnlDollars).toFixed(2)}`})
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-sans">
                          <div
                            className={
                              isBlocked ? 'text-amber-300 font-medium' : 'text-emerald-400/90 font-medium'
                            }
                          >
                            {tr.reason || tr.blockReason}
                          </div>
                          {isBlocked && tr.counterfactualNote && (
                            <div className="text-[11px] font-mono text-slate-400">
                              {tr.counterfactualNote}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
