import fs from 'node:fs';
import path from 'node:path';
import type { AuthHeaderMode, M15Candle } from '../src/types/connectivity.ts';
import { getLusakaClock, round2 } from '../src/utils/strategyEngine.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const HISTORY_CACHE_PATH = path.join(DATA_DIR, 'tickerall-history-cache.json');

export interface TickerAllHistoryCache {
  symbol: string;
  m1Candles: M15Candle[];
  m5Candles: M15Candle[];
  m15Candles: M15Candle[];
  h1Candles: M15Candle[];
  lastUpdatedAt: string | null;
  lastFetchError: string | null;
}

const MAX_M1_CACHE = 5_000;
const MAX_M5_CACHE = 30_000;
const MAX_M15_CACHE = 20_000; // ~208 trading days of M15 bars
const MAX_H1_CACHE = 6_000;

let liveOpenM1: M15Candle | null = null;
let liveOpenM5: M15Candle | null = null;
let liveOpenM15: M15Candle | null = null;
let liveOpenH1: M15Candle | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch {
    // Ignore directory creation errors
  }
}

function isRealTickerAllCandle(c: unknown): c is M15Candle {
  if (!c || typeof c !== 'object') return false;
  const candle = c as M15Candle;
  return (
    (candle.source === 'tickerall' || candle.source === 'history') &&
    Number.isFinite(candle.openTimeMs) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    candle.open > 0 &&
    candle.high > 0 &&
    candle.low > 0 &&
    candle.close > 0
  );
}

function loadHistoryCacheFromDisk(): TickerAllHistoryCache {
  ensureDataDir();
  if (!fs.existsSync(HISTORY_CACHE_PATH)) {
    return {
      symbol: 'GOLD',
      m1Candles: [],
      m5Candles: [],
      m15Candles: [],
      h1Candles: [],
      lastUpdatedAt: null,
      lastFetchError: null,
    };
  }
  try {
    const raw = fs.readFileSync(HISTORY_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TickerAllHistoryCache>;
    const m1 = Array.isArray(parsed.m1Candles)
      ? parsed.m1Candles.filter(isRealTickerAllCandle).sort((a, b) => a.openTimeMs - b.openTimeMs)
      : [];
    const m5 = Array.isArray(parsed.m5Candles)
      ? parsed.m5Candles.filter(isRealTickerAllCandle).sort((a, b) => a.openTimeMs - b.openTimeMs)
      : [];
    const m15 = Array.isArray(parsed.m15Candles)
      ? parsed.m15Candles.filter(isRealTickerAllCandle).sort((a, b) => a.openTimeMs - b.openTimeMs)
      : [];
    const h1 = Array.isArray(parsed.h1Candles)
      ? parsed.h1Candles.filter(isRealTickerAllCandle).sort((a, b) => a.openTimeMs - b.openTimeMs)
      : [];
    return {
      symbol: 'GOLD',
      m1Candles: m1.slice(-MAX_M1_CACHE),
      m5Candles: m5.slice(-MAX_M5_CACHE),
      m15Candles: m15.slice(-MAX_M15_CACHE),
      h1Candles: h1.slice(-MAX_H1_CACHE),
      lastUpdatedAt: typeof parsed.lastUpdatedAt === 'string' ? parsed.lastUpdatedAt : null,
      lastFetchError: typeof parsed.lastFetchError === 'string' ? parsed.lastFetchError : null,
    };
  } catch {
    return {
      symbol: 'GOLD',
      m1Candles: [],
      m5Candles: [],
      m15Candles: [],
      h1Candles: [],
      lastUpdatedAt: null,
      lastFetchError: null,
    };
  }
}

const cacheState: TickerAllHistoryCache = loadHistoryCacheFromDisk();

export function saveHistoryCacheNow(): void {
  ensureDataDir();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    fs.writeFileSync(HISTORY_CACHE_PATH, JSON.stringify(cacheState, null, 2));
  } catch {
    // Ignore disk write failures
  }
}

function scheduleCacheSave(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    saveHistoryCacheNow();
  }, 1500);
}

function mergeCandlesAsc(existing: M15Candle[], incoming: M15Candle[], maxLen: number): M15Candle[] {
  const byTime = new Map<number, M15Candle>();
  for (const c of existing) {
    if (isRealTickerAllCandle(c)) byTime.set(c.openTimeMs, c);
  }
  for (const c of incoming) {
    if (isRealTickerAllCandle(c)) byTime.set(c.openTimeMs, c);
  }
  return Array.from(byTime.values())
    .sort((a, b) => a.openTimeMs - b.openTimeMs)
    .slice(-maxLen);
}

function deriveTfFromFiner(barsAsc: M15Candle[], stepMs: number): M15Candle[] {
  const buckets = new Map<number, M15Candle[]>();
  for (const bar of barsAsc) {
    if (!bar.closed) continue;
    const start = Math.floor(bar.openTimeMs / stepMs) * stepMs;
    const group = buckets.get(start) ?? [];
    group.push(bar);
    buckets.set(start, group);
  }
  const out: M15Candle[] = [];
  const now = Date.now();
  for (const [start, bars] of buckets.entries()) {
    if (bars.length === 0) continue;
    bars.sort((a, b) => a.openTimeMs - b.openTimeMs);
    const openClock = getLusakaClock(start);
    const closeClock = getLusakaClock(start + stepMs);
    out.push({
      openTimeMs: start,
      openTimeLusaka: openClock.hhmm,
      closeTimeLusaka: closeClock.hhmm,
      open: bars[0].open,
      high: round2(Math.max(...bars.map((b) => b.high))),
      low: round2(Math.min(...bars.map((b) => b.low))),
      close: bars[bars.length - 1].close,
      ticksCount: bars.reduce((acc, b) => acc + (b.ticksCount || 1), 0),
      closed: start + stepMs <= now,
      source: 'history',
    });
  }
  return out.filter((c) => c.closed).sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function getTickerAllHistorySnapshot(): {
  m1Candles: M15Candle[];
  m5Candles: M15Candle[];
  m15Candles: M15Candle[];
  h1Candles: M15Candle[];
  lastUpdatedAt: string | null;
  lastFetchError: string | null;
} {
  return {
    m1Candles: cacheState.m1Candles,
    m5Candles: cacheState.m5Candles,
    m15Candles: cacheState.m15Candles,
    h1Candles: cacheState.h1Candles,
    lastUpdatedAt: cacheState.lastUpdatedAt,
    lastFetchError: cacheState.lastFetchError,
  };
}

function updateLiveBar(
  current: M15Candle | null,
  bucketMs: number,
  stepMs: number,
  price: number
): { next: M15Candle; closed: M15Candle | null } {
  if (!current || current.openTimeMs !== bucketMs) {
    const closed =
      current && current.openTimeMs < bucketMs
        ? { ...current, closed: true, source: 'tickerall' as const }
        : null;
    const openClock = getLusakaClock(bucketMs);
    const closeClock = getLusakaClock(bucketMs + stepMs);
    return {
      closed,
      next: {
        openTimeMs: bucketMs,
        openTimeLusaka: openClock.hhmm,
        closeTimeLusaka: closeClock.hhmm,
        open: round2(price),
        high: round2(price),
        low: round2(price),
        close: round2(price),
        ticksCount: 1,
        closed: false,
        source: 'tickerall',
      },
    };
  }
  current.high = round2(Math.max(current.high, price));
  current.low = round2(Math.min(current.low, price));
  current.close = round2(price);
  current.ticksCount += 1;
  return { next: current, closed: null };
}

// Record ONLY genuine TickerAll primary stream ticks (NEVER fallback ticks!)
export function recordPrimaryTickerAllTick(price: number, nowMs = Date.now()): void {
  if (!Number.isFinite(price) || price <= 0) return;

  let dirty = false;

  const m1Res = updateLiveBar(liveOpenM1, Math.floor(nowMs / 60_000) * 60_000, 60_000, price);
  liveOpenM1 = m1Res.next;
  if (m1Res.closed) {
    cacheState.m1Candles = mergeCandlesAsc(cacheState.m1Candles, [m1Res.closed], MAX_M1_CACHE);
    cacheState.lastUpdatedAt = new Date(nowMs).toISOString();
    dirty = true;
  }

  const m5Res = updateLiveBar(liveOpenM5, Math.floor(nowMs / 300_000) * 300_000, 300_000, price);
  liveOpenM5 = m5Res.next;
  if (m5Res.closed) {
    cacheState.m5Candles = mergeCandlesAsc(cacheState.m5Candles, [m5Res.closed], MAX_M5_CACHE);
    cacheState.lastUpdatedAt = new Date(nowMs).toISOString();
    dirty = true;
  }

  const m15Res = updateLiveBar(liveOpenM15, Math.floor(nowMs / 900_000) * 900_000, 900_000, price);
  liveOpenM15 = m15Res.next;
  if (m15Res.closed) {
    cacheState.m15Candles = mergeCandlesAsc(cacheState.m15Candles, [m15Res.closed], MAX_M15_CACHE);
    cacheState.lastUpdatedAt = new Date(nowMs).toISOString();
    dirty = true;
  }

  const h1Res = updateLiveBar(liveOpenH1, Math.floor(nowMs / 3_600_000) * 3_600_000, 3_600_000, price);
  liveOpenH1 = h1Res.next;
  if (h1Res.closed) {
    cacheState.h1Candles = mergeCandlesAsc(cacheState.h1Candles, [h1Res.closed], MAX_H1_CACHE);
    cacheState.lastUpdatedAt = new Date(nowMs).toISOString();
    dirty = true;
  }

  if (dirty) {
    scheduleCacheSave();
  }
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseTimestampMs(rawTs: unknown): number | null {
  if (typeof rawTs === 'number' && Number.isFinite(rawTs)) {
    return rawTs > 1e12 ? rawTs : rawTs * 1000;
  }
  if (typeof rawTs === 'string' && rawTs.trim()) {
    const num = Number(rawTs);
    if (Number.isFinite(num) && /^\d+(\.\d+)?$/.test(rawTs.trim())) {
      return num > 1e12 ? num : num * 1000;
    }
    const parsed = Date.parse(rawTs);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function extractBarsFromTickerAllPayload(
  payload: unknown,
  timeframe: 'M1' | 'M5' | 'M15' | 'H1'
): M15Candle[] {
  if (!payload || typeof payload !== 'object') return [];
  const stepMs =
    timeframe === 'H1'
      ? 3_600_000
      : timeframe === 'M15'
        ? 900_000
        : timeframe === 'M5'
          ? 300_000
          : 60_000;
  const now = Date.now();
  const lists: unknown[][] = [];

  if (Array.isArray(payload)) {
    lists.push(payload);
  } else {
    const rec = payload as Record<string, unknown>;
    const dataObj =
      rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
        ? (rec.data as Record<string, unknown>)
        : null;
    const resultObj =
      rec.result && typeof rec.result === 'object' && !Array.isArray(rec.result)
        ? (rec.result as Record<string, unknown>)
        : null;

    for (const candidate of [
      rec.bars,
      rec.candles,
      rec.history,
      rec.items,
      rec.data,
      dataObj?.bars,
      dataObj?.candles,
      dataObj?.history,
      dataObj?.items,
      resultObj?.bars,
      resultObj?.candles,
      resultObj?.history,
    ]) {
      if (Array.isArray(candidate) && candidate.length > 0) {
        lists.push(candidate);
      }
    }
  }

  const out: M15Candle[] = [];
  for (const list of lists) {
    for (const rawItem of list) {
      let open: number | null = null;
      let high: number | null = null;
      let low: number | null = null;
      let close: number | null = null;
      let tsMs: number | null = null;

      if (Array.isArray(rawItem) && rawItem.length >= 5) {
        // [time, open, high, low, close]
        tsMs = parseTimestampMs(rawItem[0]);
        open = toNum(rawItem[1]);
        high = toNum(rawItem[2]);
        low = toNum(rawItem[3]);
        close = toNum(rawItem[4]);
      } else if (rawItem && typeof rawItem === 'object') {
        const item = rawItem as Record<string, unknown>;
        open = toNum(item.open ?? item.o ?? item.openPrice);
        high = toNum(item.high ?? item.h ?? item.highPrice ?? open);
        low = toNum(item.low ?? item.l ?? item.lowPrice ?? open);
        close = toNum(item.close ?? item.c ?? item.closePrice ?? item.price ?? open);
        tsMs = parseTimestampMs(
          item.time ?? item.timestamp ?? item.ts ?? item.t ?? item.openTime ?? item.date
        );
      }

      if (
        tsMs === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0
      ) {
        continue;
      }

      const bucketMs = Math.floor(tsMs / stepMs) * stepMs;
      const openClock = getLusakaClock(bucketMs);
      const closeClock = getLusakaClock(bucketMs + stepMs);
      const closed = bucketMs + stepMs <= now;
      if (!closed) continue;

      out.push({
        openTimeMs: bucketMs,
        openTimeLusaka: openClock.hhmm,
        closeTimeLusaka: closeClock.hhmm,
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(close),
        ticksCount: 1,
        closed: true,
        source: 'history',
      });
    }
  }

  return out;
}

export function ingestRealTickerAllHistoryCandles(
  bars: M15Candle[],
  timeframe: 'M1' | 'M5' | 'M15' | 'H1' = 'M15'
): number {
  const realBars = bars.filter(isRealTickerAllCandle);
  if (realBars.length === 0) return 0;

  if (timeframe === 'H1') {
    cacheState.h1Candles = mergeCandlesAsc(cacheState.h1Candles, realBars, MAX_H1_CACHE);
  } else if (timeframe === 'M1') {
    cacheState.m1Candles = mergeCandlesAsc(cacheState.m1Candles, realBars, MAX_M1_CACHE);
  } else if (timeframe === 'M5') {
    cacheState.m5Candles = mergeCandlesAsc(cacheState.m5Candles, realBars, MAX_M5_CACHE);
    const derivedM15 = deriveTfFromFiner(cacheState.m5Candles, 900_000);
    if (derivedM15.length > 0) {
      cacheState.m15Candles = mergeCandlesAsc(cacheState.m15Candles, derivedM15, MAX_M15_CACHE);
    }
    const derivedH1 = deriveTfFromFiner(cacheState.m5Candles, 3_600_000);
    if (derivedH1.length > 0) {
      cacheState.h1Candles = mergeCandlesAsc(cacheState.h1Candles, derivedH1, MAX_H1_CACHE);
    }
  } else {
    cacheState.m15Candles = mergeCandlesAsc(cacheState.m15Candles, realBars, MAX_M15_CACHE);
    const derivedH1 = deriveTfFromFiner(cacheState.m15Candles, 3_600_000);
    if (derivedH1.length > 0) {
      cacheState.h1Candles = mergeCandlesAsc(cacheState.h1Candles, derivedH1, MAX_H1_CACHE);
    }
  }

  cacheState.lastUpdatedAt = new Date().toISOString();
  cacheState.lastFetchError = null;
  saveHistoryCacheNow();
  return realBars.length;
}

export async function fetchRealTickerAllHistoricalCandles(params: {
  baseUrl: string;
  apiKey: string;
  authHeaderMode: AuthHeaderMode;
  sessionId: string | null;
  accountId: string | null;
  timeoutMs: number;
  periodDays: 30 | 90 | 180;
  onQuotaUsed?: (count: number) => void;
}): Promise<{
  ok: boolean;
  m5Added: number;
  m15Added: number;
  h1Added: number;
  error?: string;
}> {
  const {
    baseUrl,
    apiKey,
    authHeaderMode,
    sessionId,
    accountId,
    timeoutMs,
    periodDays,
    onQuotaUsed,
  } = params;

  if (!apiKey) {
    return { ok: false, m5Added: 0, m15Added: 0, h1Added: 0, error: 'Master TickerAll API key not configured' };
  }

  const base = baseUrl.replace(/\/+$/, '');
  const toMs = Date.now();
  const fromMs = toMs - periodDays * 86_400_000;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'GoldAITrader/1.0',
  };
  if (authHeaderMode === 'x-api-key') {
    headers['X-API-Key'] = apiKey;
  } else if (authHeaderMode !== 'query-param') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const effectiveAccountId = accountId || sessionId || '';
  const symbols = ['GOLD', 'XAUUSD'];
  const timeframes: Array<{ tf: 'M5' | 'M15' | 'H1'; aliases: string[] }> = [
    { tf: 'M5', aliases: ['M5', '5m'] },
    { tf: 'M15', aliases: ['M15', '15m'] },
    { tf: 'H1', aliases: ['H1', '1h'] },
  ];

  let m5Added = 0;
  let m15Added = 0;
  let h1Added = 0;
  let lastHttpErr: string | null = null;

  for (const { tf, aliases } of timeframes) {
    let fetchedForTf = false;
    for (const sym of symbols) {
      if (fetchedForTf) break;
      for (const tfAlias of aliases) {
        if (fetchedForTf) break;
        const candidatePaths: string[] = [];
        if (effectiveAccountId) {
          const encAcct = encodeURIComponent(effectiveAccountId);
          candidatePaths.push(
            `/v1/accounts/${encAcct}/candles?symbol=${sym}&timeframe=${tfAlias}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
            `/v1/accounts/${encAcct}/history?symbol=${sym}&timeframe=${tfAlias}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
          );
        }
        candidatePaths.push(
          `/v1/candles?symbol=${sym}&timeframe=${tfAlias}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
          `/v1/history?symbol=${sym}&timeframe=${tfAlias}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        );

        for (const p of candidatePaths) {
          try {
            const urlObj = new URL(`${base}${p}`);
            if (authHeaderMode === 'query-param') {
              urlObj.searchParams.set('apikey', apiKey);
            }
            onQuotaUsed?.(1);
            const res = await fetch(urlObj.toString(), {
              method: 'GET',
              headers,
              signal: AbortSignal.timeout(Math.max(2000, Math.min(timeoutMs, 10000))),
            });
            const text = await res.text();
            if (!res.ok) {
              lastHttpErr = `HTTP ${res.status}`;
              continue;
            }
            let jsonPayload: unknown = null;
            try {
              jsonPayload = text ? JSON.parse(text) : null;
            } catch {
              jsonPayload = null;
            }
            if (!jsonPayload) continue;
            const extracted = extractBarsFromTickerAllPayload(jsonPayload, tf);
            if (extracted.length > 0) {
              const added = ingestRealTickerAllHistoryCandles(extracted, tf);
              if (tf === 'M5') m5Added += added;
              else if (tf === 'M15') m15Added += added;
              else h1Added += added;
              fetchedForTf = true;
              break;
            }
          } catch (err) {
            lastHttpErr = err instanceof Error ? err.message : 'Network error';
          }
        }
      }
    }
  }

  if (m5Added === 0 && m15Added === 0 && h1Added === 0) {
    cacheState.lastFetchError =
      lastHttpErr || 'TickerAll did not return historical candles for this period';
    saveHistoryCacheNow();
    return {
      ok: false,
      m5Added: 0,
      m15Added: 0,
      h1Added: 0,
      error: cacheState.lastFetchError,
    };
  }

  return { ok: true, m5Added, m15Added, h1Added };
}
