import type {
  M15Candle,
  SignalHistoryEntry,
  StrategySettings,
  TradeLogEntry,
} from '../types/connectivity.ts';
import { DEFAULT_STRATEGY_SETTINGS } from './strategyEngine.ts';

const SETTINGS_STORAGE_KEY = 'goldai.strategySettings.v1';
const TRADES_STORAGE_KEY = 'goldai.tradeLog.v1';
const SIGNAL_HISTORY_STORAGE_KEY = 'goldai.signalHistory.v1';
const M15_CANDLES_STORAGE_KEY = 'goldai.m15Candles.v1';

export function loadSavedStrategySettings(): StrategySettings {
  if (typeof window === 'undefined') return { ...DEFAULT_STRATEGY_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STRATEGY_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<StrategySettings>;
    return {
      ...DEFAULT_STRATEGY_SETTINGS,
      ...parsed,
      newsEvents: Array.isArray(parsed.newsEvents)
        ? parsed.newsEvents
        : DEFAULT_STRATEGY_SETTINGS.newsEvents,
    };
  } catch {
    return { ...DEFAULT_STRATEGY_SETTINGS };
  }
}

export function saveStrategySettings(settings: StrategySettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadSavedTradeLog(): TradeLogEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TRADES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TradeLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveTradeLog(entries: TradeLogEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TRADES_STORAGE_KEY, JSON.stringify(entries.slice(0, 200)));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadSavedSignalHistory(): SignalHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SIGNAL_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SignalHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveSignalHistory(entries: SignalHistoryEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIGNAL_HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, 120)));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadSavedM15Candles(): M15Candle[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(M15_CANDLES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as M15Candle[]) : [];
  } catch {
    return [];
  }
}

export function saveM15Candles(candles: M15Candle[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      M15_CANDLES_STORAGE_KEY,
      JSON.stringify(candles.slice(0, 500))
    );
  } catch {
    // Ignore storage quota errors
  }
}
