import { useState } from 'react';
import type {
  EmaStochasticProConfig,
  EmaStochasticProSnapshot,
  M15Candle,
  TradeSignal,
} from '../types/connectivity';

interface M15StrategyChartProps {
  symbol: string;
  priceDigits?: number;
  closedCandles: M15Candle[];
  currentCandle: M15Candle | null;
  closedM5Candles?: M15Candle[];
  currentM5Candle?: M15Candle | null;
  emaPro?: EmaStochasticProSnapshot | null;
  emaConfig?: EmaStochasticProConfig | null;
  activeSignal?: TradeSignal;
}

function computeEmaSeries(candles: M15Candle[], period: number): Array<number | null> {
  if (candles.length < period || period < 1) return candles.map(() => null);
  const out: Array<number | null> = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    sum += candles[i].close;
  }
  let ema = sum / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < candles.length; i += 1) {
    ema = (candles[i].close - ema) * k + ema;
    out[i] = ema;
  }
  return out;
}

export function M15StrategyChart({
  symbol,
  priceDigits = 2,
  closedCandles,
  currentCandle,
  closedM5Candles = [],
  currentM5Candle = null,
  emaPro,
  emaConfig,
  activeSignal,
}: M15StrategyChartProps) {
  const [selectedTf, setSelectedTf] = useState<'M5' | 'M15'>(
    closedM5Candles.length > 0 ? 'M5' : 'M15'
  );

  const activeTf =
    selectedTf === 'M5' && (closedM5Candles.length > 0 || currentM5Candle)
      ? 'M5'
      : 'M15';

  const baseClosed = activeTf === 'M5' ? closedM5Candles : closedCandles;
  const baseCurrent = activeTf === 'M5' ? currentM5Candle : currentCandle;

  const closedAsc = [...baseClosed].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const candlesAll = baseCurrent
    ? [...closedAsc.filter((c) => c.openTimeMs !== baseCurrent.openTimeMs), baseCurrent].sort(
        (a, b) => a.openTimeMs - b.openTimeMs
      )
    : closedAsc;

  // Keep enough bars prior to visible slice so EMAs are warm
  const emaHistorySlice = candlesAll.slice(-260);
  const visibleStartIdx = Math.max(0, emaHistorySlice.length - 50);
  const visibleCandles = emaHistorySlice.slice(visibleStartIdx);

  const emaFastP = emaConfig?.emaFast ?? 9;
  const emaMidP = emaConfig?.emaMid ?? 21;
  const emaIntP = emaConfig?.emaIntermediate ?? 50;
  const emaMajorP = emaConfig?.emaMajor ?? 200;

  const ema9All = computeEmaSeries(emaHistorySlice, emaFastP);
  const ema21All = computeEmaSeries(emaHistorySlice, emaMidP);
  const ema50All = computeEmaSeries(emaHistorySlice, emaIntP);
  const ema200All = computeEmaSeries(emaHistorySlice, emaMajorP);

  const ema9Vis = ema9All.slice(visibleStartIdx);
  const ema21Vis = ema21All.slice(visibleStartIdx);
  const ema50Vis = ema50All.slice(visibleStartIdx);
  const ema200Vis = ema200All.slice(visibleStartIdx);

  const width = 820;
  const height = 305;
  const padLeft = 64;
  const padRight = 18;
  const padTop = 22;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const renderChartBody = () => {
    if (visibleCandles.length === 0) {
      return (
        <div className="h-[280px] flex flex-col items-center justify-center border border-white/6 bg-[#0B0F17]/60 rounded text-center px-6">
          <p className="text-xs font-medium text-slate-200">
            EMA STOCHASTIC PRO Chart Ready ({symbol} · {activeTf})
          </p>
          <p className="mt-1 text-xs text-slate-400 max-w-md">
            Waiting for incoming XAUUSD TickerAll candles to plot EMA 9/21/50/200, SMC Order Blocks, FVGs, and BUY/SELL entry levels.
          </p>
        </div>
      );
    }

    const values: number[] = [];
    for (const c of visibleCandles) {
      values.push(c.low, c.high);
    }
    for (const v of [...ema9Vis, ...ema21Vis, ...ema50Vis]) {
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
    if (typeof activeSignal?.entry === 'number' && Number.isFinite(activeSignal.entry)) values.push(activeSignal.entry);
    if (typeof activeSignal?.stop === 'number' && Number.isFinite(activeSignal.stop)) values.push(activeSignal.stop);
    if (typeof activeSignal?.tp1 === 'number' && Number.isFinite(activeSignal.tp1)) values.push(activeSignal.tp1);
    if (typeof activeSignal?.tp2 === 'number' && Number.isFinite(activeSignal.tp2)) values.push(activeSignal.tp2);
    if (typeof activeSignal?.tp3 === 'number' && Number.isFinite(activeSignal.tp3)) values.push(activeSignal.tp3);

    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const span = rawMax - rawMin;
    const pad = span > 0 ? span * 0.14 : Math.max(1.0, rawMax * 0.001);
    const minVal = rawMin - pad;
    const maxVal = rawMax + pad;
    const range = maxVal - minVal || 1;

    const n = visibleCandles.length;
    const stepX = n > 1 ? plotW / n : plotW;
    const xForIndex = (i: number) =>
      n === 1 ? padLeft + plotW / 2 : padLeft + stepX * (i + 0.5);
    const yForPrice = (p: number) =>
      padTop + plotH - ((p - minVal) / range) * plotH;

    const candleBodyW = Math.max(4, Math.min(14, stepX * 0.62));

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => {
      const val = minVal + r * range;
      return { val, y: yForPrice(val) };
    });

    const buildLinePath = (series: Array<number | null>): string => {
      let path = '';
      for (let i = 0; i < series.length; i += 1) {
        const val = series[i];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < minVal || val > maxVal) continue;
        const cmd = path === '' ? 'M' : 'L';
        path += `${cmd} ${xForIndex(i).toFixed(1)} ${yForPrice(val).toFixed(1)} `;
      }
      return path.trim();
    };

    const hasSignalLines =
      activeSignal &&
      activeSignal.action !== 'WAIT' &&
      typeof activeSignal.entry === 'number' &&
      Number.isFinite(activeSignal.entry) &&
      typeof activeSignal.stop === 'number' &&
      Number.isFinite(activeSignal.stop) &&
      typeof activeSignal.tp1 === 'number' &&
      Number.isFinite(activeSignal.tp1) &&
      typeof activeSignal.tp2 === 'number' &&
      Number.isFinite(activeSignal.tp2);

    const activeSmc = activeTf === 'M15' && emaPro?.m15Smc ? emaPro.m15Smc : emaPro?.smc;
    const bullObs = (activeSmc?.activeBullishObs ?? []).slice(0, 2);
    const bearObs = (activeSmc?.activeBearishObs ?? []).slice(0, 2);
    const bullFvgs = (activeSmc?.activeBullishFvgs ?? []).slice(0, 2);
    const bearFvgs = (activeSmc?.activeBearishFvgs ?? []).slice(0, 2);

    return (
      <div className="w-full overflow-hidden">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[285px] select-none">
          {/* Y-Axis Grid */}
          {yTicks.map((t, idx) => (
            <g key={`grid-${idx}`}>
              <line
                x1={padLeft}
                y1={t.y}
                x2={width - padRight}
                y2={t.y}
                stroke="rgba(255,255,255,0.06)"
                strokeDasharray="3 3"
              />
              <text
                x={padLeft - 8}
                y={t.y + 3}
                textAnchor="end"
                fill="#94A3B8"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                {t.val.toFixed(priceDigits)}
              </text>
            </g>
          ))}

          {/* SMC Order Block & FVG Zones */}
          {bullObs.map((ob, idx) => {
            if (ob.high < minVal || ob.low > maxVal) return null;
            const yTop = Math.max(padTop, yForPrice(ob.high));
            const yBot = Math.min(padTop + plotH, yForPrice(ob.low));
            const h = Math.max(3, yBot - yTop);
            return (
              <g key={`bob-${idx}`}>
                <rect
                  x={padLeft}
                  y={yTop}
                  width={plotW}
                  height={h}
                  fill="rgba(16, 185, 129, 0.08)"
                  stroke="rgba(16, 185, 129, 0.25)"
                  strokeDasharray="2 2"
                />
                <text
                  x={padLeft + 4}
                  y={yTop + 10}
                  fill="#34D399"
                  fontSize="8.5"
                  fontFamily="JetBrains Mono, monospace"
                >
                  Bull OB ${ob.low.toFixed(priceDigits)}–${ob.high.toFixed(priceDigits)}
                </text>
              </g>
            );
          })}

          {bearObs.map((ob, idx) => {
            if (ob.high < minVal || ob.low > maxVal) return null;
            const yTop = Math.max(padTop, yForPrice(ob.high));
            const yBot = Math.min(padTop + plotH, yForPrice(ob.low));
            const h = Math.max(3, yBot - yTop);
            return (
              <g key={`beob-${idx}`}>
                <rect
                  x={padLeft}
                  y={yTop}
                  width={plotW}
                  height={h}
                  fill="rgba(239, 68, 68, 0.08)"
                  stroke="rgba(239, 68, 68, 0.25)"
                  strokeDasharray="2 2"
                />
                <text
                  x={padLeft + 4}
                  y={yTop + 10}
                  fill="#F87171"
                  fontSize="8.5"
                  fontFamily="JetBrains Mono, monospace"
                >
                  Bear OB ${ob.low.toFixed(priceDigits)}–${ob.high.toFixed(priceDigits)}
                </text>
              </g>
            );
          })}

          {[...bullFvgs, ...bearFvgs].map((fvg, idx) => {
            if (fvg.top < minVal || fvg.bottom > maxVal) return null;
            const yTop = Math.max(padTop, yForPrice(fvg.top));
            const yBot = Math.min(padTop + plotH, yForPrice(fvg.bottom));
            const h = Math.max(2, yBot - yTop);
            return (
              <rect
                key={`fvg-${idx}`}
                x={padLeft}
                y={yTop}
                width={plotW}
                height={h}
                fill={
                  fvg.direction === 'BULLISH'
                    ? 'rgba(56, 189, 248, 0.08)'
                    : 'rgba(251, 146, 60, 0.08)'
                }
              />
            );
          })}

          {/* Active Signal Entry / SL / TP1 / TP2 / TP3 Lines */}
          {hasSignalLines && activeSignal && (
            <g>
              <line
                x1={padLeft}
                y1={yForPrice(activeSignal.entry!)}
                x2={width - padRight}
                y2={yForPrice(activeSignal.entry!)}
                stroke="#E5B85C"
                strokeWidth="1.2"
                strokeDasharray="2 2"
              />
              <text
                x={width - padRight - 4}
                y={yForPrice(activeSignal.entry!) - 4}
                textAnchor="end"
                fill="#E5B85C"
                fontSize="9"
                fontFamily="JetBrains Mono, monospace"
              >
                Entry ${activeSignal.entry!.toFixed(priceDigits)}
              </text>

              <line
                x1={padLeft}
                y1={yForPrice(activeSignal.stop!)}
                x2={width - padRight}
                y2={yForPrice(activeSignal.stop!)}
                stroke="#EF4444"
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />
              <text
                x={width - padRight - 4}
                y={yForPrice(activeSignal.stop!) - 4}
                textAnchor="end"
                fill="#FCA5A5"
                fontSize="9"
                fontFamily="JetBrains Mono, monospace"
              >
                SL ${activeSignal.stop!.toFixed(priceDigits)}
              </text>

              <line
                x1={padLeft}
                y1={yForPrice(activeSignal.tp1!)}
                x2={width - padRight}
                y2={yForPrice(activeSignal.tp1!)}
                stroke="#38BDF8"
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />
              <text
                x={width - padRight - 4}
                y={yForPrice(activeSignal.tp1!) - 4}
                textAnchor="end"
                fill="#7DD3FC"
                fontSize="9"
                fontFamily="JetBrains Mono, monospace"
              >
                TP1 ${activeSignal.tp1!.toFixed(priceDigits)}
              </text>

              <line
                x1={padLeft}
                y1={yForPrice(activeSignal.tp2!)}
                x2={width - padRight}
                y2={yForPrice(activeSignal.tp2!)}
                stroke="#34D399"
                strokeWidth="1.1"
                strokeDasharray="3 3"
              />
              <text
                x={width - padRight - 4}
                y={yForPrice(activeSignal.tp2!) - 4}
                textAnchor="end"
                fill="#6EE7B7"
                fontSize="9"
                fontFamily="JetBrains Mono, monospace"
              >
                TP2 ${activeSignal.tp2!.toFixed(priceDigits)}
              </text>

              {typeof activeSignal.tp3 === 'number' && Number.isFinite(activeSignal.tp3) && (
                <>
                  <line
                    x1={padLeft}
                    y1={yForPrice(activeSignal.tp3)}
                    x2={width - padRight}
                    y2={yForPrice(activeSignal.tp3)}
                    stroke="#A78BFA"
                    strokeWidth="1.1"
                    strokeDasharray="4 3"
                  />
                  <text
                    x={width - padRight - 4}
                    y={yForPrice(activeSignal.tp3) - 4}
                    textAnchor="end"
                    fill="#C4B5FD"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    TP3 ${activeSignal.tp3.toFixed(priceDigits)}
                  </text>
                </>
              )}
            </g>
          )}

          {/* Candlesticks */}
          {visibleCandles.map((c, i) => {
            const cx = xForIndex(i);
            const bull = c.close >= c.open;
            const color = bull ? '#22C55E' : '#EF4444';
            const topY = yForPrice(Math.max(c.open, c.close));
            const botY = yForPrice(Math.min(c.open, c.close));
            const bodyH = Math.max(2, botY - topY);
            const highY = yForPrice(c.high);
            const lowY = yForPrice(c.low);
            return (
              <g key={`candle-${c.openTimeMs}`}>
                <line
                  x1={cx}
                  y1={highY}
                  x2={cx}
                  y2={lowY}
                  stroke={color}
                  strokeWidth="1.2"
                />
                <rect
                  x={cx - candleBodyW / 2}
                  y={topY}
                  width={candleBodyW}
                  height={bodyH}
                  fill={bull ? 'rgba(34, 197, 94, 0.85)' : 'rgba(239, 68, 68, 0.85)'}
                  stroke={color}
                  strokeWidth="1"
                />
              </g>
            );
          })}

          {/* EMA 9 / 21 / 50 / 200 Overlays */}
          <g>
            {buildLinePath(ema200Vis) && (
              <path
                d={buildLinePath(ema200Vis)}
                fill="none"
                stroke="#FB7185"
                strokeWidth="1.6"
                strokeOpacity="0.85"
              />
            )}
            {buildLinePath(ema50Vis) && (
              <path
                d={buildLinePath(ema50Vis)}
                fill="none"
                stroke="#A78BFA"
                strokeWidth="1.5"
                strokeOpacity="0.9"
              />
            )}
            {buildLinePath(ema21Vis) && (
              <path
                d={buildLinePath(ema21Vis)}
                fill="none"
                stroke="#FBBF24"
                strokeWidth="1.5"
                strokeOpacity="0.95"
              />
            )}
            {buildLinePath(ema9Vis) && (
              <path
                d={buildLinePath(ema9Vis)}
                fill="none"
                stroke="#38BDF8"
                strokeWidth="1.5"
                strokeOpacity="0.95"
              />
            )}
          </g>

          {/* X-axis window endpoints */}
          <text
            x={padLeft}
            y={height - 8}
            fill="#64748B"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {visibleCandles[0].openTimeLusaka}
          </text>
          <text
            x={width - padRight}
            y={height - 8}
            textAnchor="end"
            fill="#64748B"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {visibleCandles[visibleCandles.length - 1].closeTimeLusaka} Lusaka
          </text>
        </svg>
      </div>
    );
  };

  return (
    <div className="border border-white/8 bg-[#111722] rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/8">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold text-slate-100">
            {`${symbol} ${activeTf} Chart · EMA ${emaFastP}/${emaMidP}/${emaIntP}/${emaMajorP} + SMC`}
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span
            className={`font-mono font-semibold ${
              emaPro?.overallTrend === 'BULLISH'
                ? 'text-emerald-400'
                : emaPro?.overallTrend === 'BEARISH'
                  ? 'text-red-400'
                  : 'text-amber-300'
            }`}
          >
            {emaPro?.overallTrend ?? 'ANALYZING'} · {emaPro?.marketCondition ?? 'WAIT'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono tabular-nums text-slate-400">
          <div className="inline-flex items-center rounded border border-white/12 bg-[#0B0F17] overflow-hidden">
            <button
              type="button"
              onClick={() => setSelectedTf('M5')}
              className={`px-2 py-0.5 transition-colors ${
                activeTf === 'M5'
                  ? 'bg-[#D4A853]/20 text-[#E5B85C] font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              M5 Entry
            </button>
            <button
              type="button"
              onClick={() => setSelectedTf('M15')}
              className={`px-2 py-0.5 transition-colors ${
                activeTf === 'M15'
                  ? 'bg-[#D4A853]/20 text-[#E5B85C] font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              M15 Structure
            </button>
          </div>
          <span className="text-sky-400">EMA {emaFastP}</span>
          <span className="text-amber-400">EMA {emaMidP}</span>
          <span className="text-violet-400">EMA {emaIntP}</span>
          <span className="text-rose-400">EMA {emaMajorP}</span>
        </div>
      </div>

      {renderChartBody()}
    </div>
  );
}
