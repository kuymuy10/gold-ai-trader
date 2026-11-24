import { useState, useEffect, useRef } from 'react';
import {
  Save,
  RotateCcw,
  Plus,
  Trash2,
  SlidersHorizontal,
  CalendarClock,
  Crosshair,
  CheckCircle2,
  ShieldCheck,
  History,
} from 'lucide-react';
import type {
  ConnectionSnapshot,
  DaySessionLevels,
  EmaStochasticProConfig,
  SpreadSensitivity,
  StrategySettings,
  TradingMode,
  UsdNewsEvent,
} from '../types/connectivity';
import { DEFAULT_STRATEGY_SETTINGS } from '../utils/strategyEngine';
import {
  DEFAULT_EMA_PRO_CONFIG,
  mergeEmaProConfig,
} from '../utils/emaStochasticPro';

interface StrategySettingsViewProps {
  snapshot: ConnectionSnapshot;
  onSaveSettings: (
    settings: StrategySettings
  ) => Promise<{ ok: boolean; error?: string } | void>;
  onSaveLevels: (
    payload: Partial<DaySessionLevels> & { reset?: boolean }
  ) => Promise<{ ok: boolean; error?: string } | void>;
}

function hydrateSettings(src: StrategySettings): StrategySettings {
  return {
    ...DEFAULT_STRATEGY_SETTINGS,
    ...src,
    strategyMode: 'EMA_STOCHASTIC_PRO',
    emaPro: mergeEmaProConfig(src.emaPro),
  };
}

function settingsSignature(s: StrategySettings): string {
  return JSON.stringify(hydrateSettings(s));
}

function levelsSignature(l?: DaySessionLevels | null): string {
  if (!l) return '';
  return `${l.pdh ?? ''}|${l.pdl ?? ''}|${l.prevDayDate ?? ''}`;
}

export function StrategySettingsView({
  snapshot,
  onSaveSettings,
  onSaveLevels,
}: StrategySettingsViewProps) {
  const serverSettings = snapshot.bot?.settings ?? DEFAULT_STRATEGY_SETTINGS;
  const serverLevels = snapshot.bot?.levels;

  const [form, setForm] = useState<StrategySettings>(() => hydrateSettings(serverSettings));
  const [pdhInput, setPdhInput] = useState(
    serverLevels?.pdh !== null && serverLevels?.pdh !== undefined
      ? String(serverLevels.pdh)
      : ''
  );
  const [pdlInput, setPdlInput] = useState(
    serverLevels?.pdl !== null && serverLevels?.pdl !== undefined
      ? String(serverLevels.pdl)
      : ''
  );
  const [prevDayDateInput, setPrevDayDateInput] = useState(
    serverLevels?.prevDayDate ?? ''
  );

  const [formDirty, setFormDirty] = useState(false);
  const [levelsDirty, setLevelsDirty] = useState(false);
  const lastServerSigRef = useRef<string>(settingsSignature(serverSettings));
  const lastLevelsSigRef = useRef<string>(levelsSignature(serverLevels));

  const [newNewsTitle, setNewNewsTitle] = useState('');
  const [newNewsTime, setNewNewsTime] = useState('15:30');
  const [newNewsImpact, setNewNewsImpact] = useState<'HIGH' | 'MEDIUM'>('HIGH');

  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingLevels, setIsSavingLevels] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const nextSig = settingsSignature(serverSettings);
    if (!formDirty && nextSig !== lastServerSigRef.current) {
      setForm(hydrateSettings(serverSettings));
      lastServerSigRef.current = nextSig;
    }
  }, [serverSettings, formDirty]);

  useEffect(() => {
    if (!serverLevels) return;
    const nextSig = levelsSignature(serverLevels);
    if (!levelsDirty && nextSig !== lastLevelsSigRef.current) {
      setPdhInput(serverLevels.pdh !== null ? String(serverLevels.pdh) : '');
      setPdlInput(serverLevels.pdl !== null ? String(serverLevels.pdl) : '');
      setPrevDayDateInput(serverLevels.prevDayDate ?? '');
      lastLevelsSigRef.current = nextSig;
    }
  }, [serverLevels, levelsDirty]);

  const emaPro = mergeEmaProConfig(form.emaPro);
  const enabledNewsCount = form.newsEvents.filter((ev) => ev.enabled).length;
  const auditLogs = snapshot.bot?.auditLogs ?? [];

  const handleNumChange = (key: keyof StrategySettings, raw: string) => {
    const val = Number(raw);
    setFormDirty(true);
    setForm((prev) => ({
      ...prev,
      [key]: Number.isFinite(val) ? val : 0,
    }));
  };

  const handleEmaNumChange = (key: keyof EmaStochasticProConfig, raw: string) => {
    const val = Number(raw);
    setFormDirty(true);
    setForm((prev) => ({
      ...prev,
      emaPro: {
        ...mergeEmaProConfig(prev.emaPro),
        [key]: Number.isFinite(val) ? val : 0,
      },
    }));
  };

  const handleEmaField = <K extends keyof EmaStochasticProConfig>(
    key: K,
    value: EmaStochasticProConfig[K]
  ) => {
    setFormDirty(true);
    setForm((prev) => ({
      ...prev,
      emaPro: {
        ...mergeEmaProConfig(prev.emaPro),
        [key]: value,
      },
    }));
  };

  const handleSaveAllSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingSettings(true);
    setSavedNotice(null);
    setSaveError(null);
    try {
      const payload: StrategySettings = {
        ...form,
        strategyMode: 'EMA_STOCHASTIC_PRO',
        emaPro,
      };
      const result = await onSaveSettings(payload);
      if (result && result.ok === false) {
        setSaveError(result.error || 'Failed to save strategy settings.');
        return;
      }
      lastServerSigRef.current = settingsSignature(payload);
      setFormDirty(false);
      setSavedNotice('EMA STOCHASTIC PRO rules & risk limits saved and synced live.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unable to save strategy settings.');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleResetDefaults = async () => {
    const defaults: StrategySettings = {
      ...DEFAULT_STRATEGY_SETTINGS,
      strategyMode: 'EMA_STOCHASTIC_PRO',
      emaPro: { ...DEFAULT_EMA_PRO_CONFIG },
      newsEvents: DEFAULT_STRATEGY_SETTINGS.newsEvents.map((ev) => ({ ...ev })),
    };
    setIsSavingSettings(true);
    setSavedNotice(null);
    setSaveError(null);
    try {
      const result = await onSaveSettings(defaults);
      if (result && result.ok === false) {
        setSaveError(result.error || 'Failed to restore default settings.');
        return;
      }
      setForm(defaults);
      lastServerSigRef.current = settingsSignature(defaults);
      setFormDirty(false);
      setSavedNotice('Restored default strategy & risk parameters.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unable to restore default settings.');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleAddNewsEvent = () => {
    if (!newNewsTitle.trim()) return;
    const item: UsdNewsEvent = {
      id: `usd-${Date.now()}`,
      title: newNewsTitle.trim(),
      timeLusaka: newNewsTime || '15:30',
      impact: newNewsImpact,
      enabled: true,
    };
    setFormDirty(true);
    setForm((prev) => ({
      ...prev,
      newsEvents: [item, ...prev.newsEvents],
    }));
    setNewNewsTitle('');
  };

  const handleToggleNews = (id: string) => {
    setFormDirty(true);
    setForm((prev) => ({
      ...prev,
      newsEvents: prev.newsEvents.map((ev) =>
        ev.id === id ? { ...ev, enabled: !ev.enabled } : ev
      ),
    }));
  };

  const handleDeleteNews = (id: string) => {
    setFormDirty(true);
    setForm((prev) => ({
      ...prev,
      newsEvents: prev.newsEvents.filter((ev) => ev.id !== id),
    }));
  };

  const handleApplyLevels = async () => {
    setSavedNotice(null);
    setSaveError(null);
    const parsedPdh = pdhInput.trim() ? Number(pdhInput) : null;
    const parsedPdl = pdlInput.trim() ? Number(pdlInput) : null;
    if (
      (parsedPdh !== null && (!Number.isFinite(parsedPdh) || parsedPdh <= 0)) ||
      (parsedPdl !== null && (!Number.isFinite(parsedPdl) || parsedPdl <= 0))
    ) {
      setSaveError('PDH and PDL must be positive valid numbers.');
      return;
    }
    if (parsedPdh !== null && parsedPdl !== null && parsedPdh <= parsedPdl) {
      setSaveError('Previous Day High (PDH) must be higher than Previous Day Low (PDL).');
      return;
    }
    setIsSavingLevels(true);
    try {
      const result = await onSaveLevels({
        pdh: parsedPdh,
        pdl: parsedPdl,
        prevDayDate: prevDayDateInput.trim() || 'Manual',
        manualOverride: true,
      });
      if (result && result.ok === false) {
        setSaveError(result.error || 'Failed to calibrate D1 PDH / PDL levels.');
        return;
      }
      setLevelsDirty(false);
      setSavedNotice('D1 PDH / PDL levels calibrated for today.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unable to save D1 levels.');
    } finally {
      setIsSavingLevels(false);
    }
  };

  const handleResetLevels = async () => {
    setIsSavingLevels(true);
    setSavedNotice(null);
    setSaveError(null);
    try {
      const result = await onSaveLevels({ reset: true });
      if (result && result.ok === false) {
        setSaveError(result.error || 'Failed to reset D1 levels.');
        return;
      }
      setLevelsDirty(false);
      setSavedNotice('Today D1 levels reset to auto-derive from D1 history.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unable to reset D1 levels.');
    } finally {
      setIsSavingLevels(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border border-white/8 bg-[#111722] rounded-lg p-5">
        <div>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[#D4A853]" />
            <h1 className="text-base font-display font-bold text-slate-50">
              GOLD AI TRADER · Strategy &amp; Risk Configuration
            </h1>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Active Engine: EMA STOCHASTIC PRO (H1/M15/M5 + SMC + Gemini AI) · Broker Feed: TickerAll MT5 + Multi-Broker Bridge · Settings v{emaPro.settingsVersion}
          </p>
        </div>

        {savedNotice && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {savedNotice}
          </div>
        )}
        {saveError && (
          <div
            role="alert"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-red-500/35 bg-red-950/30 text-xs text-red-200"
          >
            {saveError}
          </div>
        )}
      </div>

      <form onSubmit={handleSaveAllSettings} className="space-y-6">
        {/* 1. Strategy Module, Execution Mode & Safety Lock */}
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-[#E5B85C]">
                1. Strategy Engine, Trading Mode &amp; Execution Environment
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Configure active strategy engine, TickerAll symbol mapping, execution mode, and Demo/Live safety controls.
              </p>
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              Version v{emaPro.settingsVersion}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="block text-xs">
              <span className="text-slate-400">Active Strategy Module</span>
              <div className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-[#D4A853]/35 text-[#E5B85C] font-mono text-xs font-semibold">
                EMA STOCHASTIC PRO
              </div>
            </div>

            <label className="block text-xs">
              <span className="text-slate-400">Trading Mode</span>
              <select
                value={emaPro.tradingMode}
                onChange={(e) => handleEmaField('tradingMode', e.target.value as TradingMode)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              >
                <option value="SIGNALS_ONLY">SIGNALS_ONLY</option>
                <option value="AUTOMATIC_TRADING">AUTOMATIC_TRADING</option>
                <option value="BOTH">BOTH</option>
              </select>
            </label>

            <label className="block text-xs">
              <span className="text-slate-400">MT5 Broker Symbol Mapping</span>
              <input
                type="text"
                value={emaPro.xauusdSymbol}
                onChange={(e) => handleEmaField('xauusdSymbol', e.target.value.toUpperCase())}
                placeholder="XAUUSD, XAUUSDm, or XAUUSDc"
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>

            <label className="block text-xs">
              <span className="text-slate-400">AI Confidence Threshold (/100)</span>
              <input
                type="number"
                step="1"
                min="40"
                max="99"
                value={emaPro.aiConfidenceThreshold}
                onChange={(e) => handleEmaNumChange('aiConfidenceThreshold', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-200 cursor-pointer">
              <span>Allow BUY Signals</span>
              <input
                type="checkbox"
                checked={emaPro.allowBuy}
                onChange={(e) => handleEmaField('allowBuy', e.target.checked)}
                className="accent-[#D4A853]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-200 cursor-pointer">
              <span>Allow SELL Signals</span>
              <input
                type="checkbox"
                checked={emaPro.allowSell}
                onChange={(e) => handleEmaField('allowSell', e.target.checked)}
                className="accent-[#D4A853]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded bg-[#0B0F17] border border-sky-500/30 text-xs text-sky-200 cursor-pointer">
              <span>Demo-Only Safety Lock</span>
              <input
                type="checkbox"
                checked={emaPro.demoOnlyMode}
                onChange={(e) => handleEmaField('demoOnlyMode', e.target.checked)}
                className="accent-sky-400"
              />
            </label>
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded bg-[#0B0F17] border border-amber-500/35 text-xs text-amber-200 cursor-pointer">
              <span>Authorize Live Trading</span>
              <input
                type="checkbox"
                checked={emaPro.liveTradingAuthorized}
                onChange={(e) => handleEmaField('liveTradingAuthorized', e.target.checked)}
                className="accent-amber-400"
              />
            </label>
          </div>

          {emaPro.liveTradingAuthorized && (
            <div className="p-2.5 rounded border border-amber-500/40 bg-amber-950/25 text-[11px] text-amber-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              Live Trading Authorization enabled: real MT5 bridge orders can execute whenever Demo-Only Safety Lock is unchecked or account is verified Live.
            </div>
          )}
        </div>

        {/* 2. EMA + Stochastic + SMC + ATR Parameters */}
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4">
          <div className="border-b border-white/8 pb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                2. EMA, Stochastic, SMC &amp; ATR Engine Parameters
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Multi-timeframe EMA (9/21/50/200), Stochastic (14,3,3), SMC swing lookback, ATR SL buffer, and M1 entry refinement.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-200 cursor-pointer">
              <span>M1 Entry Refinement</span>
              <input
                type="checkbox"
                checked={emaPro.m1RefinementEnabled}
                onChange={(e) => handleEmaField('m1RefinementEnabled', e.target.checked)}
                className="accent-[#D4A853]"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <label className="block text-xs">
              <span className="text-slate-400">EMA Fast</span>
              <input
                type="number"
                min="2"
                max="50"
                value={emaPro.emaFast}
                onChange={(e) => handleEmaNumChange('emaFast', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">EMA Mid</span>
              <input
                type="number"
                min="5"
                max="100"
                value={emaPro.emaMid}
                onChange={(e) => handleEmaNumChange('emaMid', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">EMA Intermediate</span>
              <input
                type="number"
                min="10"
                max="200"
                value={emaPro.emaIntermediate}
                onChange={(e) => handleEmaNumChange('emaIntermediate', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">EMA Major</span>
              <input
                type="number"
                min="50"
                max="400"
                value={emaPro.emaMajor}
                onChange={(e) => handleEmaNumChange('emaMajor', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Stoch %K</span>
              <input
                type="number"
                min="3"
                max="50"
                value={emaPro.stochK}
                onChange={(e) => handleEmaNumChange('stochK', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Stoch %D / Slow</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={emaPro.stochD}
                  onChange={(e) => handleEmaNumChange('stochD', e.target.value)}
                  className="w-full px-2 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={emaPro.stochSlowing}
                  onChange={(e) => handleEmaNumChange('stochSlowing', e.target.value)}
                  className="w-full px-2 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </div>
            </label>

            <label className="block text-xs">
              <span className="text-slate-400">Overbought / Oversold</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                <input
                  type="number"
                  min="60"
                  max="95"
                  value={emaPro.stochOverbought}
                  onChange={(e) => handleEmaNumChange('stochOverbought', e.target.value)}
                  className="w-full px-2 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
                <input
                  type="number"
                  min="5"
                  max="40"
                  value={emaPro.stochOversold}
                  onChange={(e) => handleEmaNumChange('stochOversold', e.target.value)}
                  className="w-full px-2 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </div>
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">ATR Period</span>
              <input
                type="number"
                min="5"
                max="50"
                value={emaPro.atrPeriod}
                onChange={(e) => handleEmaNumChange('atrPeriod', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">ATR SL Multiplier</span>
              <input
                type="number"
                step="0.1"
                min="0.5"
                max="4.0"
                value={emaPro.atrSlMultiplier}
                onChange={(e) => handleEmaNumChange('atrSlMultiplier', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">SMC Lookback Bars</span>
              <input
                type="number"
                min="30"
                max="250"
                value={emaPro.smcLookbackBars}
                onChange={(e) => handleEmaNumChange('smcLookbackBars', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Swing Strength</span>
              <input
                type="number"
                min="1"
                max="5"
                value={emaPro.swingStrength}
                onChange={(e) => handleEmaNumChange('swingStrength', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Stoch Midpoint</span>
              <input
                type="number"
                min="30"
                max="70"
                value={emaPro.stochMidpoint}
                onChange={(e) => handleEmaNumChange('stochMidpoint', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
          </div>
        </div>

        {/* 3. Trading Sessions & 3-TP Trailing Rules */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4">
            <div className="border-b border-white/8 pb-3">
              <h2 className="text-sm font-semibold text-slate-100">
                3. All-Session Schedule &amp; Reference Windows (Lusaka / GMT+2)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                All open XM XAUUSD weekday sessions execute (Asian, London, New York &amp; Off-Peak). Windows below track per-session metrics only; closed weekends only.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs">
                <span className="text-slate-400">Asian Start (Lusaka)</span>
                <input
                  type="time"
                  value={form.asianStart}
                  onChange={(e) => {
                    setFormDirty(true);
                    setForm({ ...form, asianStart: e.target.value });
                  }}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">Asian End (Lusaka)</span>
                <input
                  type="time"
                  value={form.asianEnd}
                  onChange={(e) => {
                    setFormDirty(true);
                    setForm({ ...form, asianEnd: e.target.value });
                  }}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">London Start (Lusaka)</span>
                <input
                  type="time"
                  value={form.londonStart}
                  onChange={(e) => {
                    setFormDirty(true);
                    setForm({ ...form, londonStart: e.target.value });
                  }}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">London End / Cutoff</span>
                <input
                  type="time"
                  value={form.londonEnd}
                  onChange={(e) => {
                    setFormDirty(true);
                    setForm({ ...form, londonEnd: e.target.value });
                  }}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
            </div>
          </div>

          <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4">
            <div className="border-b border-white/8 pb-3">
              <h2 className="text-sm font-semibold text-[#E5B85C]">
                4. 3-TP Targets, Trailing SL &amp; Entry Slippage Guards
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                TP1 = 1:1 (moves SL to TP1), TP2 = 1:2 (moves SL to TP2), TP3 = 1:3 runner. Never widens SL.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="block text-xs">
                <span className="text-slate-400">Min R:R Ratio</span>
                <input
                  type="number"
                  step="0.1"
                  min="1.0"
                  max="5.0"
                  value={emaPro.minRewardRisk}
                  onChange={(e) => handleEmaNumChange('minRewardRisk', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">TP1 R:R</span>
                <input
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="3.0"
                  value={emaPro.tp1Rr}
                  onChange={(e) => handleEmaNumChange('tp1Rr', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">TP2 R:R</span>
                <input
                  type="number"
                  step="0.1"
                  min="1.0"
                  max="5.0"
                  value={emaPro.tp2Rr}
                  onChange={(e) => handleEmaNumChange('tp2Rr', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">TP3 R:R</span>
                <input
                  type="number"
                  step="0.1"
                  min="1.5"
                  max="10.0"
                  value={emaPro.tp3Rr}
                  onChange={(e) => handleEmaNumChange('tp3Rr', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="block text-xs">
                <span className="text-slate-400">Max Spread Ceiling (Pts)</span>
                <input
                  type="number"
                  min="10"
                  max="500"
                  value={emaPro.maxSpreadPips}
                  onChange={(e) => handleEmaNumChange('maxSpreadPips', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">Spread Sensitivity</span>
                <select
                  value={emaPro.spreadSensitivity}
                  onChange={(e) =>
                    handleEmaField('spreadSensitivity', e.target.value as SpreadSensitivity)
                  }
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                >
                  <option value="CONSERVATIVE">CONSERVATIVE</option>
                  <option value="BALANCED">BALANCED</option>
                  <option value="AGGRESSIVE">AGGRESSIVE</option>
                </select>
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">Min Net R:R (After Costs)</span>
                <input
                  type="number"
                  step="0.1"
                  min="0.8"
                  max="5.0"
                  value={emaPro.minNetRewardRisk}
                  onChange={(e) => handleEmaNumChange('minNetRewardRisk', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">Max Quote Age (s)</span>
                <input
                  type="number"
                  min="2"
                  max="120"
                  value={emaPro.maxQuoteAgeSeconds}
                  onChange={(e) => handleEmaNumChange('maxQuoteAgeSeconds', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="block text-xs">
                <span className="text-slate-400">Commission ($/Lot)</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  max="50"
                  value={emaPro.commissionPerLot}
                  onChange={(e) => handleEmaNumChange('commissionPerLot', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">Est. Slippage (Pts)</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  max="50"
                  value={emaPro.estimatedSlippagePoints}
                  onChange={(e) => handleEmaNumChange('estimatedSlippagePoints', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">Signal Expiry (Min)</span>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={emaPro.signalExpiryMinutes}
                  onChange={(e) => handleEmaNumChange('signalExpiryMinutes', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-400">Max Deviation (Pts)</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={emaPro.maxEntryDeviationPips}
                  onChange={(e) => handleEmaNumChange('maxEntryDeviationPips', e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-1">
              <label className="flex items-center justify-between gap-2 px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-[11px] text-slate-200 cursor-pointer">
                <span>Allow HIGH Spread (Strong)</span>
                <input
                  type="checkbox"
                  checked={emaPro.allowHighSpreadTrades}
                  onChange={(e) => handleEmaField('allowHighSpreadTrades', e.target.checked)}
                  className="accent-[#D4A853]"
                />
              </label>
              <label className="flex items-center justify-between gap-2 px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-[11px] text-slate-200 cursor-pointer">
                <span>Partial Profit</span>
                <input
                  type="checkbox"
                  checked={emaPro.partialProfitEnabled}
                  onChange={(e) => handleEmaField('partialProfitEnabled', e.target.checked)}
                  className="accent-[#D4A853]"
                />
              </label>
              <label className="flex items-center justify-between gap-2 px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-[11px] text-slate-200 cursor-pointer">
                <span>TP1 Hit → SL to TP1</span>
                <input
                  type="checkbox"
                  checked={emaPro.moveSlToTp1OnTp1}
                  onChange={(e) => handleEmaField('moveSlToTp1OnTp1', e.target.checked)}
                  className="accent-[#D4A853]"
                />
              </label>
              <label className="flex items-center justify-between gap-2 px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-[11px] text-slate-200 cursor-pointer">
                <span>TP2 Hit → SL to TP2</span>
                <input
                  type="checkbox"
                  checked={emaPro.moveSlToTp2OnTp2}
                  onChange={(e) => handleEmaField('moveSlToTp2OnTp2', e.target.checked)}
                  className="accent-[#D4A853]"
                />
              </label>
            </div>
          </div>
        </div>

        {/* 5. Hard Risk Management & Daily Caps */}
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-100 pb-3 border-b border-white/8">
            5. Risk Management &amp; Hard Safety Guards
          </h2>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
            <label className="block text-xs">
              <span className="text-slate-400">Risk % / Trade (0.5%)</span>
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={form.riskPercent ?? 0.5}
                onChange={(e) => handleNumChange('riskPercent', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Max Risk Cap % (1.0%)</span>
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={emaPro.maxRiskPercent}
                onChange={(e) => handleEmaNumChange('maxRiskPercent', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Max Open Positions</span>
              <input
                type="number"
                step="1"
                min="1"
                max="10"
                value={emaPro.maxSimultaneousPositions}
                onChange={(e) => handleEmaNumChange('maxSimultaneousPositions', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Max Trades / Day (10)</span>
              <input
                type="number"
                step="1"
                min="1"
                max="30"
                value={form.maxTradesPerDay ?? 10}
                onChange={(e) => handleNumChange('maxTradesPerDay', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Max / Session (5)</span>
              <input
                type="number"
                step="1"
                min="1"
                max="20"
                value={emaPro.maxTradesPerSession}
                onChange={(e) => handleEmaNumChange('maxTradesPerSession', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Max Daily Loss % (5%)</span>
              <input
                type="number"
                step="0.5"
                min="0.5"
                max="25"
                value={form.dailyGuardPct ?? 5.0}
                onChange={(e) => handleNumChange('dailyGuardPct', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>

            <label className="block text-xs">
              <span className="text-slate-400">Pause Consecutive Losses (3)</span>
              <input
                type="number"
                step="1"
                min="1"
                max="10"
                value={form.maxConsecutiveLosses ?? 3}
                onChange={(e) => handleNumChange('maxConsecutiveLosses', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Max Auto Lot Cap</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="50.0"
                value={form.maxAutoLotCap ?? 0.5}
                onChange={(e) => handleNumChange('maxAutoLotCap', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">USD News Window (±m)</span>
              <input
                type="number"
                step="5"
                min="0"
                value={form.newsClearanceMins ?? 60}
                onChange={(e) => handleNumChange('newsClearanceMins', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Manual SL Buffer (Pips)</span>
              <input
                type="number"
                step="1"
                min="5"
                max="100"
                value={form.slPips ?? 15}
                onChange={(e) => handleNumChange('slPips', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Manual Max SL Cap (Pips)</span>
              <input
                type="number"
                step="1"
                min="15"
                max="150"
                value={form.maxSlPips ?? 25}
                onChange={(e) => handleNumChange('maxSlPips', e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <div className="flex items-end">
              <label
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs ${
                  snapshot.bot?.isWeekend
                    ? 'text-slate-500 cursor-not-allowed'
                    : 'text-slate-200 cursor-pointer'
                }`}
              >
                <span>{snapshot.bot?.isWeekend ? 'AUTO (Closed)' : 'Auto-Log Signals'}</span>
                <input
                  type="checkbox"
                  disabled={Boolean(snapshot.bot?.isWeekend)}
                  checked={Boolean(form.autoLogSignals && !snapshot.bot?.isWeekend)}
                  onChange={(e) => {
                    setFormDirty(true);
                    setForm({ ...form, autoLogSignals: e.target.checked });
                  }}
                  className="accent-[#D4A853] disabled:opacity-40"
                />
              </label>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-white/8 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-100">
                Gemini AI Trade Confirmation Gate (Threshold {emaPro.aiConfidenceThreshold}%)
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Independent AI gate audits all 14 EMA, Stochastic, SMC, volatility, spread, news, and R:R conditions before approval. Never overrides hard risk limits.
              </div>
            </div>
            <label className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-100 cursor-pointer shrink-0">
              <span>{form.aiApproverEnabled !== false ? 'Enabled (Required Gate)' : 'Disabled'}</span>
              <input
                type="checkbox"
                checked={form.aiApproverEnabled !== false}
                onChange={(e) => {
                  setFormDirty(true);
                  setForm({ ...form, aiApproverEnabled: e.target.checked });
                }}
                className="accent-[#D4A853]"
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 pt-4 border-t border-white/8">
            <button
              type="button"
              onClick={handleResetDefaults}
              disabled={isSavingSettings}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-white/15 bg-[#0E131D] text-slate-300 hover:text-white transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Defaults
            </button>
            <button
              type="submit"
              disabled={isSavingSettings}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] disabled:opacity-50 transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              {isSavingSettings ? 'Saving...' : 'Save Strategy Settings'}
            </button>
          </div>
        </div>
      </form>

      {/* USD High-Impact News Calendar + D1 PDH / PDL Calibration */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-[#D4A853]" />
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  High-Impact USD News Filter (±{form.newsClearanceMins}m Before &amp; After)
                </h2>
                <p className="text-xs text-slate-400">
                  Manual / configured USD economic event blackout windows (CPI, NFP, FOMC, Rate, GDP, Retail, PPI).
                </p>
              </div>
            </div>
            <span
              className={`px-2 py-0.5 rounded border text-[10px] font-mono ${
                enabledNewsCount > 0
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
              }`}
            >
              {enabledNewsCount > 0 ? `${enabledNewsCount} ACTIVE` : 'NEWS_DATA_UNAVAILABLE'}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              placeholder="e.g. US CPI / NFP / FOMC / PPI"
              value={newNewsTitle}
              onChange={(e) => setNewNewsTitle(e.target.value)}
              className="flex-1 min-w-[160px] px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
            <input
              type="time"
              value={newNewsTime}
              onChange={(e) => setNewNewsTime(e.target.value)}
              className="px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4A853]"
            />
            <select
              value={newNewsImpact}
              onChange={(e) => setNewNewsImpact(e.target.value as 'HIGH' | 'MEDIUM')}
              className="px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-xs text-slate-100 focus:outline-none focus:border-[#D4A853]"
            >
              <option value="HIGH">HIGH (Red Folder)</option>
              <option value="MEDIUM">MEDIUM</option>
            </select>
            <button
              type="button"
              onClick={handleAddNewsEvent}
              className="inline-flex items-center gap-1 px-3 py-2 rounded bg-white/10 hover:bg-white/15 text-xs font-medium text-slate-100 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>

          <div className="space-y-2 max-h-[240px] overflow-y-auto">
            {form.newsEvents.length === 0 ? (
              <p className="text-xs text-amber-200/80 font-mono py-3">
                NEWS_DATA_UNAVAILABLE — No live economic calendar feed wired. Add USD events above and click Save Strategy Settings.
              </p>
            ) : (
              form.newsEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-white/8 bg-[#0B0F17]"
                >
                  <label className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ev.enabled}
                      onChange={() => handleToggleNews(ev.id)}
                      className="accent-[#D4A853]"
                    />
                    <span className="font-mono text-xs text-[#E5B85C] shrink-0">
                      {ev.timeLusaka}
                    </span>
                    <span className="text-xs text-slate-200 truncate">
                      {ev.title}
                    </span>
                  </label>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${
                        ev.impact === 'HIGH'
                          ? 'border-red-500/30 bg-red-500/10 text-red-300'
                          : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                      }`}
                    >
                      {ev.impact}
                    </span>
                    <button
                      type="button"
                      aria-label="Delete news event"
                      onClick={() => handleDeleteNews(ev.id)}
                      className="p-1 text-slate-500 hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            Click &quot;Save Strategy Settings&quot; above after adding or toggling news events so the live evaluator updates immediately.
          </p>
        </div>

        {/* Manual D1 PDH / PDL Level Calibration (Liquidity Reference) */}
        <div className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-white/8 pb-3">
            <Crosshair className="w-4 h-4 text-[#D4A853]" />
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Daily D1 Level Calibration (PDH &amp; PDL — Liquidity Reference)
              </h2>
              <p className="text-xs text-slate-400">
                Auto-derived from OANDA/TickerAll D1 candles when available, or set Previous Day High &amp; Low manually here.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-xs">
              <span className="text-slate-400">PDH — Prev Day High ($)</span>
              <input
                type="number"
                step="0.01"
                placeholder="e.g. 3892.50"
                value={pdhInput}
                onChange={(e) => {
                  setLevelsDirty(true);
                  setPdhInput(e.target.value);
                }}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">PDL — Prev Day Low ($)</span>
              <input
                type="number"
                step="0.01"
                placeholder="e.g. 3864.20"
                value={pdlInput}
                onChange={(e) => {
                  setLevelsDirty(true);
                  setPdlInput(e.target.value);
                }}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Prev D1 Date</span>
              <input
                type="text"
                placeholder="YYYY-MM-DD"
                value={prevDayDateInput}
                onChange={(e) => {
                  setLevelsDirty(true);
                  setPrevDayDateInput(e.target.value);
                }}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono text-xs focus:outline-none focus:border-[#D4A853]"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleResetLevels}
              disabled={isSavingLevels}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-white/15 bg-[#0E131D] text-slate-300 hover:text-white transition-colors"
            >
              Auto-Derive D1
            </button>
            <button
              type="button"
              onClick={handleApplyLevels}
              disabled={isSavingLevels}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] disabled:opacity-50 transition-colors"
            >
              Apply PDH / PDL
            </button>
          </div>
        </div>
      </div>

      {/* Settings Audit Trail */}
      <section className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-3">
        <div className="flex items-center gap-2 border-b border-white/8 pb-3">
          <History className="w-4 h-4 text-[#D4A853]" />
          <h2 className="text-sm font-semibold text-slate-100">
            Settings &amp; Control Audit Log ({auditLogs.length})
          </h2>
        </div>
        {auditLogs.length === 0 ? (
          <p className="text-xs text-slate-500 font-mono">
            No settings revisions recorded yet.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-[220px] overflow-y-auto">
            {auditLogs.slice(0, 20).map((log) => (
              <div
                key={log.id}
                className="px-3 py-2 rounded border border-white/6 bg-[#0B0F17] flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-1.5 py-0.5 rounded bg-[#D4A853]/15 text-[#E5B85C] text-[10px]">
                    v{log.version}
                  </span>
                  <span className="text-slate-100 font-semibold">{log.action}</span>
                  <span className="text-slate-400 truncate">{log.detail}</span>
                </div>
                <span className="text-[11px] text-slate-500 shrink-0">
                  {log.actor} · {new Date(log.timestamp).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
