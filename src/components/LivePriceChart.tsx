import { useState } from 'react';
import type { NormalizedTick } from '../types/connectivity';

interface LivePriceChartProps {
  ticks: NormalizedTick[];
  symbol: string;
  onRunProbe: () => void;
  isProbing: boolean;
}

export function LivePriceChart({
  ticks,
  symbol,
  onRunProbe,
  isProbing,
}: LivePriceChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Reverse so chronological left-to-right
  const ordered = [...ticks].reverse();

  if (ordered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[260px] border border-white/8 bg-[#0E131D] rounded-lg px-6 text-center">
        <p className="text-sm font-medium text-slate-200">
          No market ticks captured for {symbol}
        </p>
        <p className="mt-1.5 text-xs text-slate-400 max-w-md">
          Run a single endpoint handshake probe or start the live feed stream to plot real-time bid, ask, and mid-price telemetry.
        </p>
        <button
          type="button"
          onClick={onRunProbe}
          disabled={isProbing}
          className="mt-4 px-4 py-2 text-xs font-medium rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          {isProbing ? 'Probing Endpoint...' : 'Run First Probe'}
        </button>
      </div>
    );
  }

  const width = 760;
  const height = 240;
  const padLeft = 56;
  const padRight = 16;
  const padTop = 20;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues = ordered.flatMap((t) => [t.bid, t.ask, t.last]);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const span = rawMax - rawMin;
  const padding = span > 0 ? span * 0.18 : Math.max(1, rawMax * 0.001);
  const minVal = rawMin - padding;
  const maxVal = rawMax + padding;
  const range = maxVal - minVal || 1;

  const xFor = (i: number) => {
    if (ordered.length === 1) return padLeft + plotW / 2;
    return padLeft + (i / (ordered.length - 1)) * plotW;
  };
  const yFor = (val: number) =>
    padTop + plotH - ((val - minVal) / range) * plotH;

  const linePoints = ordered
    .map((t, i) => `${xFor(i).toFixed(1)},${yFor(t.last).toFixed(1)}`)
    .join(' ');

  const areaPath =
    ordered.length > 1
      ? `M ${xFor(0).toFixed(1)},${(padTop + plotH).toFixed(1)} ` +
        ordered.map((t, i) => `L ${xFor(i).toFixed(1)},${yFor(t.last).toFixed(1)}`).join(' ') +
        ` L ${xFor(ordered.length - 1).toFixed(1)},${(padTop + plotH).toFixed(1)} Z`
      : '';

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const val = minVal + ratio * range;
    return { val, y: yFor(val) };
  });

  const activeTick =
    hoverIndex !== null && ordered[hoverIndex]
      ? ordered[hoverIndex]
      : ordered[ordered.length - 1];

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const tickDigits = activeTick.digits ?? 2;

  return (
    <div className="border border-white/8 bg-[#0E131D] rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-white/6">
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="font-medium text-slate-200">{symbol} Feed Curve</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums text-slate-300">
            Last{' '}
            {typeof activeTick.last === 'number' && Number.isFinite(activeTick.last)
              ? `$${activeTick.last.toLocaleString(undefined, { minimumFractionDigits: tickDigits, maximumFractionDigits: tickDigits })}`
              : '—'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            Spread{' '}
            {typeof activeTick.spread === 'number' && Number.isFinite(activeTick.spread)
              ? `$${activeTick.spread.toFixed(tickDigits)}`
              : '—'}{' '}
            (
            {typeof activeTick.spreadBps === 'number' && Number.isFinite(activeTick.spreadBps)
              ? `${activeTick.spreadBps.toFixed(1)} bps`
              : '—'}
            )
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-400">
          <span>Packet #{activeTick.seq}</span>
          <span aria-hidden="true">·</span>
          <span>{formatTime(activeTick.receivedAt)}</span>
        </div>
      </div>

      <div className="mt-3 w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-[220px] select-none"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="goldAreaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#D4A853" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#D4A853" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {yTicks.map((tick, idx) => (
            <g key={idx}>
              <line
                x1={padLeft}
                y1={tick.y}
                x2={width - padRight}
                y2={tick.y}
                stroke="rgba(255,255,255,0.06)"
                strokeDasharray="3 3"
              />
              <text
                x={padLeft - 8}
                y={tick.y + 3}
                textAnchor="end"
                fill="#94A3B8"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                {Number.isFinite(tick.val) ? tick.val.toFixed(tickDigits) : '—'}
              </text>
            </g>
          ))}

          {areaPath && <path d={areaPath} fill="url(#goldAreaFill)" />}

          {ordered.length > 1 && (
            <polyline
              fill="none"
              stroke="#D4A853"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={linePoints}
            />
          )}

          {ordered.map((t, i) => {
            const cx = xFor(i);
            const cy = yFor(t.last);
            const isHovered = hoverIndex === i;
            const isLast = i === ordered.length - 1 && hoverIndex === null;
            return (
              <g key={`chart-tick-${t.seq}-${t.receivedAt}-${i}`}>
                {(isHovered || isLast || ordered.length === 1) && (
                  <>
                    <line
                      x1={cx}
                      y1={padTop}
                      x2={cx}
                      y2={padTop + plotH}
                      stroke="rgba(212, 168, 83, 0.3)"
                      strokeWidth="1"
                    />
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isHovered ? 4.5 : 3.5}
                      fill="#D4A853"
                      stroke="#0B0F17"
                      strokeWidth="1.5"
                    />
                  </>
                )}
                <rect
                  x={cx - Math.max(8, plotW / Math.max(ordered.length, 1) / 2)}
                  y={padTop}
                  width={Math.max(16, plotW / Math.max(ordered.length, 1))}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIndex(i)}
                  className="cursor-crosshair"
                />
              </g>
            );
          })}

          {/* X-axis endpoints */}
          <text
            x={padLeft}
            y={height - 6}
            fill="#64748B"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {formatTime(ordered[0].receivedAt)}
          </text>
          <text
            x={width - padRight}
            y={height - 6}
            textAnchor="end"
            fill="#64748B"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {formatTime(ordered[ordered.length - 1].receivedAt)}
          </text>
        </svg>
      </div>
    </div>
  );
}
